// server/alerts.js

export function calculateMedian(numbers) {
  if (!numbers || numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[mid];
  }
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function percentile(values, q) {
  if (!values || values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const k = (s.length - 1) * q, f = Math.floor(k);
  return f + 1 >= s.length ? s[f] : s[f] + (s[f + 1] - s[f]) * (k - f);
}

export function recomputeProductPromoCycling(db, productId) {
  const promoGate = Number(process.env.BREADCRUMBS_PROMO_GATE ?? 0.25);

  const obs = db.prepare(`
    SELECT paid_unit_cents, unit_basis
    FROM price_observation
    WHERE product_id = ?
  `).all(productId);

  const byUb = {};
  for (const o of obs) {
    byUb[o.unit_basis] = byUb[o.unit_basis] || [];
    byUb[o.unit_basis].push(o.paid_unit_cents);
  }

  let isPromo = 0;
  let maxSpreadPct = null;

  for (const [ub, prices] of Object.entries(byUb)) {
    if (prices.length >= 3) {
      const p75 = percentile(prices, 0.75);
      const p25 = percentile(prices, 0.25);
      if (p75 > 0) {
        const spreadPct = ((p75 - p25) / p75) * 100;
        if (maxSpreadPct === null || spreadPct > maxSpreadPct) {
          maxSpreadPct = spreadPct;
        }
        if (spreadPct / 100 >= promoGate) {
          isPromo = 1;
        }
      }
    }
  }

  db.prepare(`
    UPDATE product
    SET is_promo_cycling = ?, price_spread_pct = ?
    WHERE id = ?
  `).run(isPromo, maxSpreadPct, productId);

  return { is_promo_cycling: isPromo, price_spread_pct: maxSpreadPct };
}

export function generateAlertsForBatch(db, batchId, options = {}) {
  const thresholdPct = Number(
    options.thresholdPct ?? process.env.BREADCRUMBS_ALERT_THRESHOLD_PCT ?? 7
  );
  const windowSize = Number(
    options.windowSize ?? process.env.BREADCRUMBS_ALERT_WINDOW ?? 12
  );

  const newObs = db.prepare(`
    SELECT po.*, p.price_basis, p.is_promo_cycling
    FROM price_observation po
    JOIN product p ON po.product_id = p.id
    WHERE po.batch_id = ?
    ORDER BY po.id ASC
  `).all(batchId);

  const createdAlerts = [];

  const checkStmt = db.prepare(`
    SELECT paid_unit_cents
    FROM price_observation
    WHERE product_id = ?
      AND unit_basis = ?
      AND (observed_on < ? OR (observed_on = ? AND id < ?))
    ORDER BY observed_on DESC, id DESC
    LIMIT ?
  `);

  const insertAlertStmt = db.prepare(`
    INSERT OR IGNORE INTO price_alert (
      product_id, observation_id, batch_id, raised_on,
      paid_unit_cents, baseline_cents, baseline_n, delta_pct,
      severity, baseline_kind, acknowledged_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);

  for (const obs of newObs) {
    // Trailing window of up to windowSize observations prior to obs sharing the same unit_basis
    const windowRows = checkStmt.all(
      obs.product_id,
      obs.unit_basis,
      obs.observed_on,
      obs.observed_on,
      obs.id,
      windowSize
    );

    if (windowRows.length < 3) {
      continue;
    }

    // paid_unit_cents = Math.round(line_total_cents / qty) is the ONLY authoritative price signal.
    const windowPaidCents = windowRows.map((r) => r.paid_unit_cents);
    const baselineKind = obs.is_promo_cycling ? 'regular_p75' : 'median';
    const baselineCentsRaw = obs.is_promo_cycling
      ? percentile(windowPaidCents, 0.75)
      : calculateMedian(windowPaidCents);
    const baselineCents = Math.round(baselineCentsRaw);

    if (baselineCents <= 0) continue;

    // 4. Alert when paid_unit_cents > baseline_cents * (1 + thresholdPct / 100)
    const paidUnitCents = obs.paid_unit_cents;
    const thresholdCents = baselineCents * (1 + thresholdPct / 100);

    if (paidUnitCents > thresholdCents) {
      const deltaPct = ((paidUnitCents - baselineCents) / baselineCents) * 100;
      let severity = 'info';
      if (deltaPct >= 25) {
        severity = 'high';
      } else if (deltaPct >= 15) {
        severity = 'warn';
      }

      const res = insertAlertStmt.run(
        obs.product_id,
        obs.id,
        batchId,
        obs.observed_on,
        paidUnitCents,
        baselineCents,
        windowRows.length,
        deltaPct,
        severity,
        baselineKind
      );

      if (res.changes > 0) {
        const alertRow = db.prepare('SELECT * FROM price_alert WHERE id = ?').get(res.lastInsertRowid);
        createdAlerts.push(alertRow);
      }
    }
  }

  return createdAlerts;
}
