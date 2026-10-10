// server/import.js
import crypto from 'node:crypto';
import { generateAlertsForBatch, recomputeProductPromoCycling } from './alerts.js';

export function parseMoneyCents(val) {
  if (val === null || val === undefined) return null;
  const str = String(val).replace(/\$/g, '').replace(/,/g, '').trim();
  if (str === '' || isNaN(str)) return null;
  const num = parseFloat(str);
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

export function parseDateString(str) {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const cleanStr = trimmed.replace(/\./g, '');
  const d = new Date(cleanStr);
  if (isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function normalizeRetailer(value) {
  const retailer = value === undefined || value === null || String(value).trim() === ''
    ? 'kroger'
    : String(value).trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(retailer)) {
    throw new Error(`Invalid retailer: ${String(value)}`);
  }
  return retailer;
}

export function parseOrderHeader(order) {
  let storeNumber = null;
  let orderedOn = null;

  if (order.id && typeof order.id === 'string') {
    const parts = order.id.split('~');
    if (parts.length >= 2 && parts[1]) {
      storeNumber = parts[1].trim();
    }
    if (parts.length >= 3 && /^\d{4}-\d{2}-\d{2}$/.test(parts[2].trim())) {
      orderedOn = parts[2].trim();
    }
  }

  const dateRaw = order.date ? String(order.date).trim() : '';
  if (!orderedOn) {
    orderedOn = parseDateString(dateRaw);
  }

  return { storeNumber, orderedOn, dateRaw };
}

export function parseUnitPrice(unitPriceStr) {
  if (unitPriceStr === null || unitPriceStr === undefined || String(unitPriceStr).trim() === '') {
    return { page_price_cents: null, page_regular_cents: null, page_promo_flag: null, unit_basis: 'package' };
  }

  let str = String(unitPriceStr).trim();
  let unit_basis = 'package';

  if (/^\s*about/i.test(str)) {
    unit_basis = 'weight_each';
    str = str.replace(/^\s*about/i, '').trim();
  }

  if (/each$/i.test(str)) {
    str = str.replace(/each$/i, '').trim();
  }

  const parts = str.split('DiscountedFrom');
  const page_price_cents = parseMoneyCents(parts[0]);

  if (parts.length > 1) {
    const rightSide = parts[1].trim();
    if (rightSide !== '') {
      const page_regular_cents = parseMoneyCents(rightSide);
      return {
        page_price_cents,
        page_regular_cents,
        page_promo_flag: 1,
        unit_basis,
      };
    }
    return {
      page_price_cents,
      page_regular_cents: null,
      page_promo_flag: 0,
      unit_basis,
    };
  }

  return {
    page_price_cents,
    page_regular_cents: null,
    page_promo_flag: 0,
    unit_basis,
  };
}

export function normalizeProductName(nameRaw) {
  if (!nameRaw) return { nameKey: '', familyKey: '', sizeQty: null, sizeUnit: null };

  const nameKey = String(nameRaw)
    .toLowerCase()
    .replace(/[®™]/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  const sizeRegex = /(\d+(?:\.\d+)?)\s*-?\s*(LB|OZ|PT|QT|CT|PK|GAL)\b/i;
  const match = nameKey.match(sizeRegex);

  let sizeQty = null;
  let sizeUnit = null;
  let familyKey = nameKey;

  if (match) {
    sizeQty = parseFloat(match[1]);
    sizeUnit = match[2].toUpperCase();
    familyKey = nameKey.replace(match[0], '').replace(/\s+/g, ' ').trim();
  }

  return { nameKey, familyKey, sizeQty, sizeUnit };
}

export function recomputeProductPriceBasis(db, productId) {
  const obs = db.prepare(`
    SELECT unit_basis
    FROM price_observation
    WHERE product_id = ?
  `).all(productId);

  let newBasis = 'unknown';
  if (obs.some((o) => o.unit_basis === 'weight_each')) {
    newBasis = 'variable_weight';
  } else if (obs.length >= 3) {
    newBasis = 'fixed';
  }

  db.prepare('UPDATE product SET price_basis = ? WHERE id = ?').run(newBasis, productId);
  return newBasis;
}

export function importOrdersJson(db, jsonInput, filename = 'breadcrumbs-orders.json') {
  const rawContent = typeof jsonInput === 'string' ? jsonInput : JSON.stringify(jsonInput);
  const orders = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;

  if (!Array.isArray(orders)) {
    throw new Error('Input JSON must be an array of orders');
  }

  const existingOrderStmt = db.prepare('SELECT retailer FROM grocer_order WHERE id = ?');
  for (const order of orders) {
    const orderId = String(order?.id || '').trim();
    if (!orderId) continue;
    const retailer = normalizeRetailer(order.retailer);
    const existing = existingOrderStmt.get(orderId);
    if (existing && existing.retailer !== retailer) {
      throw new Error(`Order id ${orderId} already belongs to retailer ${existing.retailer}, not ${retailer}`);
    }
  }

  const sourceSha256 = crypto.createHash('sha256').update(rawContent).digest('hex');
  const importedAt = new Date().toISOString();

  // Create batch record
  const batchInfo = db.prepare(`
    INSERT INTO import_batch (
      imported_at, source_filename, source_sha256, order_count,
      item_count, new_order_count, duplicate_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(importedAt, filename, sourceSha256, orders.length, 0, 0, 0);

  const batchId = batchInfo.lastInsertRowid;

  let totalItemCount = 0;
  let duplicateCount = 0;
  const newOrderIds = new Set();
  const touchedProductIds = new Set();

  const insertOrderStmt = db.prepare(`
    INSERT OR IGNORE INTO grocer_order (
      id, retailer, store_number, ordered_on, date_raw,
      total_cents, items_subtotal_cents, unattributed_cents, url, first_seen_batch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertLineRawStmt = db.prepare(`
    INSERT OR IGNORE INTO order_line_raw (
      order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);

  const selectProductStmt = db.prepare('SELECT id, first_purchased_on, last_purchased_on, purchase_count FROM product WHERE name_raw = ?');

  const insertProductStmt = db.prepare(`
    INSERT INTO product (
      name_raw, name_key, family_key, size_qty, size_unit,
      price_basis, first_purchased_on, last_purchased_on, purchase_count
    ) VALUES (?, ?, ?, ?, ?, 'unknown', ?, ?, 1)
  `);

  const updateProductStmt = db.prepare(`
    UPDATE product
    SET last_purchased_on = CASE WHEN ? > last_purchased_on THEN ? ELSE last_purchased_on END,
        purchase_count = purchase_count + 1
    WHERE id = ?
  `);

  const insertObsStmt = db.prepare(`
    INSERT INTO price_observation (
      product_id, order_id, line_raw_id, observed_on, qty,
      line_total_cents, paid_unit_cents, page_price_cents,
      page_regular_cents, page_promo_flag, unit_basis, batch_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const executeImportTx = db.transaction(() => {
    for (const order of orders) {
      const orderId = String(order.id || '').trim();
      if (!orderId) continue;
      const retailer = normalizeRetailer(order.retailer);

      const { storeNumber, orderedOn, dateRaw } = parseOrderHeader(order);
      const items = Array.isArray(order.items) ? order.items : [];
      const totalCents = parseMoneyCents(order.total);

      let itemsSubtotalCents = 0;
      for (const item of items) {
        const linePriceCents = parseMoneyCents(item.price) || 0;
        itemsSubtotalCents += linePriceCents;
      }

      const unattributedCents = totalCents !== null ? totalCents - itemsSubtotalCents : null;

      insertOrderStmt.run(
        orderId,
        retailer,
        storeNumber,
        orderedOn || dateRaw,
        dateRaw,
        totalCents,
        itemsSubtotalCents,
        unattributedCents,
        order.url || null,
        batchId
      );

      items.forEach((item, index) => {
        totalItemCount += 1;

        const nameRaw = String(item.name || '');
        const priceRaw = item.price !== undefined && item.price !== null ? String(item.price) : '';
        const qtyRaw = typeof item.qty === 'number' ? item.qty : parseInt(item.qty || 1, 10) || 1;
        const unitPriceRaw = item.unitPrice !== undefined && item.unitPrice !== null ? String(item.unitPrice) : '';

        const lineRes = insertLineRawStmt.run(
          orderId,
          index,
          nameRaw,
          priceRaw,
          qtyRaw,
          unitPriceRaw
        );

        if (lineRes.changes === 0) {
          // Line already existed (duplicate)
          duplicateCount += 1;
        } else {
          // New line item inserted
          const lineRawId = lineRes.lastInsertRowid;
          newOrderIds.add(orderId);

          const lineTotalCents = parseMoneyCents(item.price) || 0;
          let qty = qtyRaw > 0 ? qtyRaw : 1;

          // paid_unit_cents = Math.round(line_total_cents / qty) is the ONLY authoritative price signal.
          const paidUnitCents = Math.round(lineTotalCents / qty);

          const { page_price_cents, page_regular_cents, page_promo_flag, unit_basis } = parseUnitPrice(unitPriceRaw);

          // Product lookup / insert
          let product = selectProductStmt.get(nameRaw);
          let productId;

          const observedOn = orderedOn || dateRaw;

          if (product) {
            productId = product.id;
            updateProductStmt.run(observedOn, observedOn, productId);
          } else {
            const { nameKey, familyKey, sizeQty, sizeUnit } = normalizeProductName(nameRaw);
            const prodRes = insertProductStmt.run(
              nameRaw,
              nameKey,
              familyKey,
              sizeQty,
              sizeUnit,
              observedOn,
              observedOn
            );
            productId = prodRes.lastInsertRowid;
          }

          touchedProductIds.add(productId);

          insertObsStmt.run(
            productId,
            orderId,
            lineRawId,
            observedOn,
            qty,
            lineTotalCents,
            paidUnitCents,
            page_price_cents,
            page_regular_cents,
            page_promo_flag,
            unit_basis,
            batchId
          );
        }
      });
    }

    // Recompute price_basis and promo_cycling for touched products
    for (const pid of touchedProductIds) {
      recomputeProductPriceBasis(db, pid);
      recomputeProductPromoCycling(db, pid);
    }
  });

  executeImportTx();

  // Generate alerts for new observations in this batch
  const alerts = generateAlertsForBatch(db, batchId);

  // Update import batch statistics
  const newOrderCount = newOrderIds.size;
  db.prepare(`
    UPDATE import_batch
    SET order_count = ?, item_count = ?, new_order_count = ?, duplicate_count = ?
    WHERE id = ?
  `).run(orders.length, totalItemCount, newOrderCount, duplicateCount, batchId);

  return {
    batch_id: batchId,
    order_count: orders.length,
    item_count: totalItemCount,
    new_order_count: newOrderCount,
    duplicate_count: duplicateCount,
    alerts,
  };
}
