// server/queries.js
import { calculateMedian } from './alerts.js';

export function getSummary(db) {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(po.paid_unit_cents * po.qty), 0) AS total_spend_cents,
      (SELECT COUNT(*) FROM grocer_order) AS order_count,
      (SELECT COUNT(*) FROM product) AS product_count,
      (SELECT COUNT(*) FROM price_observation) AS obs_count,
      (SELECT MIN(ordered_on) FROM grocer_order) AS min_date,
      (SELECT MAX(ordered_on) FROM grocer_order) AS max_date
    FROM price_observation po
  `).get();

  const spendByMonth = db.prepare(`
    SELECT strftime('%Y-%m', observed_on) AS month, SUM(paid_unit_cents * qty) AS total_cents
    FROM price_observation
    WHERE month IS NOT NULL
    GROUP BY month
    ORDER BY month ASC
  `).all();

  const topProductsSpend = db.prepare(`
    SELECT p.id, p.name_raw, p.price_basis, SUM(po.paid_unit_cents * po.qty) AS total_spend_cents, COUNT(po.id) AS purchase_count
    FROM product p
    JOIN price_observation po ON p.id = po.product_id
    GROUP BY p.id
    ORDER BY total_spend_cents DESC
    LIMIT 10
  `).all();

  const topProductsFreq = db.prepare(`
    SELECT p.id, p.name_raw, p.price_basis, COUNT(po.id) AS purchase_count
    FROM product p
    JOIN price_observation po ON p.id = po.product_id
    GROUP BY p.id
    ORDER BY purchase_count DESC
    LIMIT 10
  `).all();

  return {
    ...totals,
    spend_by_month: spendByMonth,
    top_products_spend: topProductsSpend,
    top_products_freq: topProductsFreq,
  };
}

export function getProducts(db, { sort = 'purchases', search = '' } = {}) {
  let query = `
    SELECT p.*,
      COUNT(po.id) AS obs_count
    FROM product p
    LEFT JOIN price_observation po ON p.id = po.product_id
  `;
  const params = [];

  if (search && search.trim()) {
    query += ' WHERE p.name_raw LIKE ? ';
    params.push(`%${search.trim()}%`);
  }

  query += ' GROUP BY p.id ';

  const products = db.prepare(query).all(...params);

  // Compute stats for each product
  const getObsStmt = db.prepare(`
    SELECT paid_unit_cents, observed_on, id
    FROM price_observation
    WHERE product_id = ?
    ORDER BY observed_on ASC, id ASC
  `);

  const results = products.map((p) => {
    const obs = getObsStmt.all(p.id);
    if (obs.length === 0) {
      return {
        ...p,
        obs_count: 0,
        latest_paid_unit_cents: null,
        min_paid_unit_cents: null,
        max_paid_unit_cents: null,
        median_paid_unit_cents: null,
        trend_pct: 0,
      };
    }

    // paid_unit_cents = Math.round(line_total_cents / qty) is the ONLY authoritative price signal.
    const prices = obs.map((o) => o.paid_unit_cents);
    const min_paid_unit_cents = Math.min(...prices);
    const max_paid_unit_cents = Math.max(...prices);
    const median_paid_unit_cents = calculateMedian(prices);

    const firstPaid = obs[0].paid_unit_cents;
    const latestPaid = obs[obs.length - 1].paid_unit_cents;

    let trend_pct = 0;
    if (obs.length >= 2 && firstPaid > 0) {
      trend_pct = ((latestPaid - firstPaid) / firstPaid) * 100;
    }

    return {
      ...p,
      obs_count: obs.length,
      latest_paid_unit_cents: latestPaid,
      min_paid_unit_cents,
      max_paid_unit_cents,
      median_paid_unit_cents,
      trend_pct,
    };
  });

  // Apply sorting
  if (sort === 'name') {
    results.sort((a, b) => a.name_raw.localeCompare(b.name_raw));
  } else if (sort === 'latest_price') {
    results.sort((a, b) => (b.latest_paid_unit_cents || 0) - (a.latest_paid_unit_cents || 0));
  } else if (sort === 'trend') {
    results.sort((a, b) => b.trend_pct - a.trend_pct);
  } else {
    // default 'purchases'
    results.sort((a, b) => b.obs_count - a.obs_count);
  }

  return results;
}

export function getProductById(db, id) {
  const product = db.prepare('SELECT * FROM product WHERE id = ?').get(id);
  if (!product) return null;

  const observations = db.prepare(`
    SELECT po.*, go.ordered_on, go.store_number, go.url AS order_url, olr.name_raw, olr.unit_price_raw
    FROM price_observation po
    JOIN grocer_order go ON po.order_id = go.id
    JOIN order_line_raw olr ON po.line_raw_id = olr.id
    WHERE po.product_id = ?
    ORDER BY po.observed_on ASC, po.id ASC
  `).all(id);

  // paid_unit_cents = Math.round(line_total_cents / qty) is the ONLY authoritative price signal.
  const prices = observations.map((o) => o.paid_unit_cents);
  const min_paid_unit_cents = prices.length > 0 ? Math.min(...prices) : null;
  const max_paid_unit_cents = prices.length > 0 ? Math.max(...prices) : null;
  const median_paid_unit_cents = prices.length > 0 ? calculateMedian(prices) : null;

  const alerts = db.prepare(`
    SELECT pa.*
    FROM price_alert pa
    WHERE pa.product_id = ?
    ORDER BY pa.id DESC
  `).all(id);

  return {
    product: {
      ...product,
      obs_count: observations.length,
      min_paid_unit_cents,
      max_paid_unit_cents,
      median_paid_unit_cents,
    },
    observations,
    alerts,
  };
}

export function getAlerts(db, { since, unacknowledged } = {}) {
  let sql = `
    SELECT pa.*, p.name_raw, p.name_key, p.price_basis
    FROM price_alert pa
    JOIN product p ON pa.product_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (unacknowledged === 'true' || unacknowledged === true) {
    sql += ' AND pa.acknowledged_at IS NULL ';
  }

  if (since) {
    sql += ' AND pa.raised_on >= ? ';
    params.push(since);
  }

  sql += ' ORDER BY pa.id DESC ';

  return db.prepare(sql).all(...params);
}

export function ackAlert(db, alertId) {
  const res = db.prepare(`
    UPDATE price_alert
    SET acknowledged_at = datetime('now')
    WHERE id = ? AND acknowledged_at IS NULL
  `).run(alertId);

  return res.changes > 0;
}

export function getOrders(db) {
  return db.prepare(`
    SELECT go.*, COUNT(po.id) AS item_count
    FROM grocer_order go
    LEFT JOIN price_observation po ON go.id = po.order_id
    GROUP BY go.id
    ORDER BY go.ordered_on DESC
  `).all();
}

export function getOrderById(db, orderId) {
  const order = db.prepare('SELECT * FROM grocer_order WHERE id = ?').get(orderId);
  if (!order) return null;

  const lines = db.prepare(`
    SELECT olr.*, po.paid_unit_cents, po.page_price_cents, po.page_regular_cents, po.page_promo_flag, p.name_raw AS product_name, p.id AS product_id
    FROM order_line_raw olr
    LEFT JOIN price_observation po ON olr.id = po.line_raw_id
    LEFT JOIN product p ON po.product_id = p.id
    WHERE olr.order_id = ?
    ORDER BY olr.line_index ASC
  `).all(orderId);

  return {
    order,
    lines,
  };
}
