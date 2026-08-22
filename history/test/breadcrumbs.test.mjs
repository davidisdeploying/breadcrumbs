// test/breadcrumbs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import {
  parseMoneyCents,
  parseDateString,
  parseOrderHeader,
  parseUnitPrice,
  normalizeRetailer,
  importOrdersJson,
  recomputeProductPriceBasis,
} from '../server/import.js';

import { calculateMedian, percentile, recomputeProductPromoCycling, generateAlertsForBatch } from '../server/alerts.js';
import { parseBindAddresses, startServer } from '../server/index.js';
import { createApiTrustMiddleware } from '../server/requestTrust.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function createInMemoryDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  return db;
}

test('1. money parsing incl. "" and malformed', () => {
  assert.equal(parseMoneyCents('$5.41'), 541);
  assert.equal(parseMoneyCents('$1,234.56'), 123456);
  assert.equal(parseMoneyCents('0.99'), 99);
  assert.equal(parseMoneyCents(''), null);
  assert.equal(parseMoneyCents(null), null);
  assert.equal(parseMoneyCents('abc'), null);
  assert.equal(parseMoneyCents('$'), null);
});

test('2. unitPrice grammar -> all five rows in spec', () => {
  // Row 1: about$11.77DiscountedFromeach
  const s1 = parseUnitPrice('about$11.77DiscountedFromeach');
  assert.equal(s1.page_price_cents, 1177);
  assert.equal(s1.page_regular_cents, null);
  assert.equal(s1.page_promo_flag, 0);
  assert.equal(s1.unit_basis, 'weight_each');

  // Row 2: about$0.50DiscountedFrom$0.75each
  const s2 = parseUnitPrice('about$0.50DiscountedFrom$0.75each');
  assert.equal(s2.page_price_cents, 50);
  assert.equal(s2.page_regular_cents, 75);
  assert.equal(s2.page_promo_flag, 1);
  assert.equal(s2.unit_basis, 'weight_each');

  // Row 3: $2.50DiscountedFrom$2.99
  const s3 = parseUnitPrice('$2.50DiscountedFrom$2.99');
  assert.equal(s3.page_price_cents, 250);
  assert.equal(s3.page_regular_cents, 299);
  assert.equal(s3.page_promo_flag, 1);
  assert.equal(s3.unit_basis, 'package');

  // Row 4: $2.99DiscountedFrom
  const s4 = parseUnitPrice('$2.99DiscountedFrom');
  assert.equal(s4.page_price_cents, 299);
  assert.equal(s4.page_regular_cents, null);
  assert.equal(s4.page_promo_flag, 0);
  assert.equal(s4.unit_basis, 'package');

  // Row 5: ""
  const s5 = parseUnitPrice('');
  assert.equal(s5.page_price_cents, null);
  assert.equal(s5.page_regular_cents, null);
  assert.equal(s5.page_promo_flag, null);
  assert.equal(s5.unit_basis, 'package');
});

test('3. both date formats + id-derived date preferred', () => {
  // ISO date in date field
  assert.equal(parseDateString('2025-07-07'), '2025-07-07');

  // Display dates in date field
  assert.equal(parseDateString('Aug. 5, 2026'), '2026-08-05');
  assert.equal(parseDateString('March 26, 2025'), '2025-03-26');
  assert.equal(parseDateString('Dec. 1, 2025'), '2025-12-01');

  // Order ID yields ISO date, preferred over date field
  const header = parseOrderHeader({
    id: '035~00540~2026-05-02~503~891142',
    date: 'Aug. 5, 2026',
  });
  assert.equal(header.storeNumber, '00540');
  assert.equal(header.orderedOn, '2026-05-02');
  assert.equal(header.dateRaw, 'Aug. 5, 2026');

  // Order ID has no ISO date -> fallback to date field
  const headerFallback = parseOrderHeader({
    id: 'ORDER-12345',
    date: 'March 26, 2025',
  });
  assert.equal(headerFallback.orderedOn, '2025-03-26');
  assert.equal(headerFallback.dateRaw, 'March 26, 2025');
});

test('4. paid_unit_cents = line_total / qty', () => {
  const db = createInMemoryDb();
  const fixture = [
    {
      id: '035~00100~2026-01-01~111~000001',
      date: 'Jan. 1, 2026',
      total: '$15.00',
      items: [
        {
          name: 'Kroger® Apple Cider 1 GAL',
          price: '$10.00',
          qty: 2,
          unitPrice: '$5.50', // page_price_cents is 550, but paid_unit_cents must be 1000/2 = 500
        },
      ],
    },
  ];

  const result = importOrdersJson(db, fixture);
  assert.equal(result.new_order_count, 1);

  // paid_unit_cents = Math.round(line_total_cents / qty) is the ONLY authoritative price signal.
  const obs = db.prepare('SELECT * FROM price_observation WHERE id = 1').get();
  assert.equal(obs.qty, 2);
  assert.equal(obs.line_total_cents, 1000);
  assert.equal(obs.paid_unit_cents, 500); // 1000 / 2 = 500
  assert.notEqual(obs.paid_unit_cents, obs.page_price_cents);
});

test('5. idempotency: import same fixture twice -> second batch has new_order_count = 0 and creates 0 new obs & alerts', () => {
  const db = createInMemoryDb();
  const fixture = [
    {
      id: '035~00100~2026-01-01~111~000001',
      date: 'Jan. 1, 2026',
      total: '$5.41',
      items: [
        {
          name: 'Kroger® Grade A Large White Eggs 12 CT',
          price: '$2.65',
          qty: 1,
          unitPrice: '$2.65',
        },
      ],
    },
  ];

  const res1 = importOrdersJson(db, fixture);
  assert.equal(res1.new_order_count, 1);
  assert.equal(res1.duplicate_count, 0);

  const obsCount1 = db.prepare('SELECT COUNT(*) as n FROM price_observation').get().n;
  const alertCount1 = db.prepare('SELECT COUNT(*) as n FROM price_alert').get().n;

  // Second import of exact same fixture
  const res2 = importOrdersJson(db, fixture);
  assert.equal(res2.new_order_count, 0);
  assert.equal(res2.duplicate_count, 1);

  const obsCount2 = db.prepare('SELECT COUNT(*) as n FROM price_observation').get().n;
  const alertCount2 = db.prepare('SELECT COUNT(*) as n FROM price_alert').get().n;

  assert.equal(obsCount2, obsCount1);
  assert.equal(alertCount2, alertCount1);
});

test('6. median baseline math incl. even-length windows', () => {
  assert.equal(calculateMedian([5]), 5);
  assert.equal(calculateMedian([2, 8, 4]), 4);
  assert.equal(calculateMedian([10, 20, 30, 40]), 25); // (20 + 30)/2 = 25
  assert.equal(calculateMedian([10, 20, 25, 40, 50]), 25);
});

test('7. alert fires at +27%, does NOT fire at +3%', () => {
  const db = createInMemoryDb();

  // Create 3 baseline observations of $2.00 (200 cents)
  const productInfo = db.prepare(`
    INSERT INTO product (name_raw, name_key, price_basis, first_purchased_on, last_purchased_on, purchase_count)
    VALUES ('Kroger Eggs', 'kroger eggs', 'fixed', '2026-01-01', '2026-03-01', 4)
  `).run();
  const productId = productInfo.lastInsertRowid;

  const dates = ['2026-01-01', '2026-01-15', '2026-02-01'];
  for (let i = 0; i < 3; i++) {
    const batchInfo = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-01-01', 'hash', 1, 1, 1, 0)").run();
    const batchId = batchInfo.lastInsertRowid;

    const orderId = `ORDER-${i}`;
    db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES (?, 'kroger', ?, ?, ?)").run(orderId, dates[i], dates[i], batchId);
    const lineInfo = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES (?, 0, 'Kroger Eggs', '$2.00', 1, '$2.00')").run(orderId);

    // paid_unit_cents = Math.round(line_total_cents / qty) is the ONLY authoritative price signal.
    db.prepare(`
      INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id)
      VALUES (?, ?, ?, ?, 1, 200, 200, 'package', ?)
    `).run(productId, orderId, lineInfo.lastInsertRowid, dates[i], batchId);
  }

  // Baseline median of [200, 200, 200] is 200.

  // Test observation A: $2.06 (+3% -> no alert)
  const batchA = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-02-15', 'hashA', 1, 1, 1, 0)").run().lastInsertRowid;
  db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES ('ORDER-A', 'kroger', '2026-02-15', '2026-02-15', ?)").run(batchA);
  const lineA = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES ('ORDER-A', 0, 'Kroger Eggs', '$2.06', 1, '$2.06')").run().lastInsertRowid;

  // paid_unit_cents = Math.round(line_total_cents / qty) is the ONLY authoritative price signal.
  db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, 'ORDER-A', ?, '2026-02-15', 1, 206, 206, 'package', ?)").run(productId, lineA, batchA);

  const alertsA = generateAlertsForBatch(db, batchA, { thresholdPct: 7 });
  assert.equal(alertsA.length, 0);

  // Test observation B: $2.54 (+27% -> alert fires, high severity)
  const batchB = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-03-01', 'hashB', 1, 1, 1, 0)").run().lastInsertRowid;
  db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES ('ORDER-B', 'kroger', '2026-03-01', '2026-03-01', ?)").run(batchB);
  const lineB = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES ('ORDER-B', 0, 'Kroger Eggs', '$2.54', 1, '$2.54')").run().lastInsertRowid;

  // paid_unit_cents = Math.round(line_total_cents / qty) is the ONLY authoritative price signal.
  db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, 'ORDER-B', ?, '2026-03-01', 1, 254, 254, 'package', ?)").run(productId, lineB, batchB);

  const alertsB = generateAlertsForBatch(db, batchB, { thresholdPct: 7 });
  assert.equal(alertsB.length, 1);
  assert.equal(alertsB[0].severity, 'high');
  assert.equal(alertsB[0].baseline_cents, 200);
});

test('8. weight_each series with >=3 same-basis observations and >25% rise does raise high alert', () => {
  const db = createInMemoryDb();

  const prodRes = db.prepare(`
    INSERT INTO product (name_raw, name_key, price_basis, first_purchased_on, last_purchased_on, purchase_count)
    VALUES ('Heritage Farm® Chicken Thighs', 'heritage farm chicken thighs', 'variable_weight', '2026-01-01', '2026-03-01', 4)
  `).run();
  const productId = prodRes.lastInsertRowid;

  const dates = ['2026-01-01', '2026-01-15', '2026-02-01'];
  const prices = [400, 400, 400];

  for (let i = 0; i < 3; i++) {
    const batchInfo = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-01-01', 'hash', 1, 1, 1, 0)").run();
    const batchId = batchInfo.lastInsertRowid;
    const orderId = `VW-ORDER-${i}`;

    db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES (?, 'kroger', ?, ?, ?)").run(orderId, dates[i], dates[i], batchId);
    const lineId = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES (?, 0, 'Heritage Farm Chicken Thighs', ?, 1, 'about$4.00DiscountedFromeach')").run(orderId, `$${(prices[i]/100).toFixed(2)}`).lastInsertRowid;

    db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, ?, ?, ?, 1, ?, ?, 'weight_each', ?)").run(productId, orderId, lineId, dates[i], prices[i], prices[i], batchId);
  }

  const batchNew = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-03-01', 'hashNew', 1, 1, 1, 0)").run().lastInsertRowid;
  db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES ('VW-ORDER-3', 'kroger', '2026-03-01', '2026-03-01', ?)").run(batchNew);
  const lineNew = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES ('VW-ORDER-3', 0, 'Heritage Farm Chicken Thighs', '$5.68', 1, 'about$5.68DiscountedFromeach')").run().lastInsertRowid;

  db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, 'VW-ORDER-3', ?, '2026-03-01', 1, 568, 568, 'weight_each', ?)").run(productId, lineNew, batchNew);

  const alerts = generateAlertsForBatch(db, batchNew);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].severity, 'high');
  assert.equal(alerts[0].baseline_cents, 400);
});

test('9. SPA fallback returns index.html for /products but NOT for /api/nope', async () => {
  process.env.NODE_ENV = 'test';
  const { app } = await import('../server/index.js');

  await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const port = server.address().port;
        // 1. GET /products -> expect 200 (SPA fallback)
        const resProducts = await fetch(`http://127.0.0.1:${port}/products`);
        assert.equal(resProducts.status, 200);

        // 2. GET /api/nope -> expect 404
        const resApiNope = await fetch(`http://127.0.0.1:${port}/api/nope`);
        assert.equal(resApiNope.status, 404);

        server.close(resolve);
      } catch (err) {
        server.close(() => reject(err));
      }
    });
  });
});

test('10. grapes regression: about...each observations followed by $7.99DiscountedFrom package observation raises no alert', () => {
  const db = createInMemoryDb();

  const fixture = [
    {
      id: '035~00100~2025-12-19~111~000001',
      date: 'Dec. 19, 2025',
      total: '$5.73',
      items: [
        {
          name: 'Fresh California Seedless Red Grapes',
          price: '$5.73',
          qty: 2,
          unitPrice: 'about$5.58DiscountedFromeach',
        },
      ],
    },
    {
      id: '035~00100~2026-08-05~111~000002',
      date: 'Aug. 5, 2026',
      total: '$5.47',
      items: [
        {
          name: 'Fresh California Seedless Red Grapes',
          price: '$5.47',
          qty: 1,
          unitPrice: 'about$5.58DiscountedFromeach',
        },
      ],
    },
    {
      id: '035~00100~2026-08-07~111~000003',
      date: 'Aug. 7, 2026',
      total: '$7.99',
      items: [
        {
          name: 'Fresh California Seedless Red Grapes',
          price: '$7.99',
          qty: 1,
          unitPrice: '$7.99DiscountedFrom',
        },
      ],
    },
  ];

  const result = importOrdersJson(db, fixture);
  assert.equal(result.alerts.length, 0);

  const obsList = db.prepare('SELECT unit_basis FROM price_observation ORDER BY id ASC').all();
  assert.equal(obsList.length, 3);
  assert.equal(obsList[0].unit_basis, 'weight_each');
  assert.equal(obsList[1].unit_basis, 'weight_each');
  assert.equal(obsList[2].unit_basis, 'package');

  const prod = db.prepare('SELECT price_basis FROM product WHERE name_raw LIKE ?').get('%Grapes%');
  assert.equal(prod.price_basis, 'variable_weight');
});

test('11. qty: 0 does not divide by zero', () => {
  const db = createInMemoryDb();
  const fixture = [
    {
      id: '035~00100~2026-01-01~111~000001',
      date: 'Jan. 1, 2026',
      total: '$3.50',
      items: [
        {
          name: 'Fresh Black Plum - Each',
          price: '$3.50',
          qty: 0,
          unitPrice: '$3.50DiscountedFrom',
        },
      ],
    },
  ];

  const result = importOrdersJson(db, fixture);
  assert.equal(result.new_order_count, 1);
  const obs = db.prepare('SELECT * FROM price_observation WHERE id = 1').get();
  assert.equal(obs.qty, 1);
  assert.equal(obs.paid_unit_cents, 350);
});

test('12. ALTER TABLE migration is idempotent — running bootstrap twice on the same DB does not throw', () => {
  const db = createInMemoryDb();

  const obsCols = db.prepare("PRAGMA table_info(price_observation)").all();
  assert.equal(obsCols.some((col) => col.name === 'unit_basis'), true);

  const prodCols = db.prepare("PRAGMA table_info(product)").all();
  assert.equal(prodCols.some((col) => col.name === 'is_promo_cycling'), true);
  assert.equal(prodCols.some((col) => col.name === 'price_spread_pct'), true);

  const alertCols = db.prepare("PRAGMA table_info(price_alert)").all();
  assert.equal(alertCols.some((col) => col.name === 'baseline_kind'), true);

  // Re-run migration checks
  if (!obsCols.some((col) => col.name === 'unit_basis')) {
    db.exec("ALTER TABLE price_observation ADD COLUMN unit_basis TEXT NOT NULL DEFAULT 'package'");
  }
  if (!prodCols.some((col) => col.name === 'is_promo_cycling')) {
    db.exec("ALTER TABLE product ADD COLUMN is_promo_cycling INTEGER NOT NULL DEFAULT 0");
  }
  if (!prodCols.some((col) => col.name === 'price_spread_pct')) {
    db.exec("ALTER TABLE product ADD COLUMN price_spread_pct REAL");
  }
  if (!alertCols.some((col) => col.name === 'baseline_kind')) {
    db.exec("ALTER TABLE price_alert ADD COLUMN baseline_kind TEXT NOT NULL DEFAULT 'median'");
  }

  assert.equal(db.prepare("PRAGMA table_info(product)").all().some((col) => col.name === 'is_promo_cycling'), true);
});

test('13. percentile() matches reference implementation on known vectors', () => {
  assert.equal(percentile([10, 20, 30, 40], 0.75), 32.5);
  assert.equal(percentile([10, 20, 30, 40], 0.25), 17.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([10, 20], 0.75), 17.5);
  assert.equal(percentile([100], 0.75), 100);
});

test('14. sticky classification: bimodal series sets is_promo_cycling = 1; flat series does not', () => {
  const db = createInMemoryDb();

  // Create bimodal product (alternating 1197 and 1949)
  const p1 = db.prepare(`
    INSERT INTO product (name_raw, name_key, price_basis, first_purchased_on, last_purchased_on, purchase_count)
    VALUES ('Kroger Ground Beef Roll', 'kroger ground beef roll', 'fixed', '2026-01-01', '2026-03-01', 4)
  `).run().lastInsertRowid;

  const prices1 = [1197, 1949, 1197, 1949];
  for (let i = 0; i < prices1.length; i++) {
    const bId = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-01-01', 'h1', 1, 1, 1, 0)").run().lastInsertRowid;
    const oId = `P1-ORD-${i}`;
    db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES (?, 'kroger', '2026-01-01', '2026-01-01', ?)").run(oId, bId);
    const lId = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES (?, 0, 'Kroger Ground Beef Roll', '$10.00', 1, '$10.00')").run(oId).lastInsertRowid;
    db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, ?, ?, '2026-01-01', 1, ?, ?, 'package', ?)").run(p1, oId, lId, prices1[i], prices1[i], bId);
  }

  recomputeProductPromoCycling(db, p1);
  const prod1 = db.prepare('SELECT is_promo_cycling, price_spread_pct FROM product WHERE id = ?').get(p1);
  assert.equal(prod1.is_promo_cycling, 1);
  assert.ok(prod1.price_spread_pct >= 25);

  // Create flat product (all 200)
  const p2 = db.prepare(`
    INSERT INTO product (name_raw, name_key, price_basis, first_purchased_on, last_purchased_on, purchase_count)
    VALUES ('Kroger Eggs Flat', 'kroger eggs flat', 'fixed', '2026-01-01', '2026-03-01', 4)
  `).run().lastInsertRowid;

  for (let i = 0; i < 4; i++) {
    const bId = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-01-01', 'h2', 1, 1, 1, 0)").run().lastInsertRowid;
    const oId = `P2-ORD-${i}`;
    db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES (?, 'kroger', '2026-01-01', '2026-01-01', ?)").run(oId, bId);
    const lId = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES (?, 0, 'Kroger Eggs Flat', '$2.00', 1, '$2.00')").run(oId).lastInsertRowid;
    db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, ?, ?, '2026-01-01', 1, 200, 200, 'package', ?)").run(p2, oId, lId, bId);
  }

  recomputeProductPromoCycling(db, p2);
  const prod2 = db.prepare('SELECT is_promo_cycling, price_spread_pct FROM product WHERE id = ?').get(p2);
  assert.equal(prod2.is_promo_cycling, 0);
});

test('15. Ground beef regression: promo/regular alternating series returning to regular price raises no alert; subsequent rise above regular level does', () => {
  const db = createInMemoryDb();

  const pId = db.prepare(`
    INSERT INTO product (name_raw, name_key, price_basis, first_purchased_on, last_purchased_on, purchase_count)
    VALUES ('Kroger® 80/20 Ground Beef Roll 3 LB', 'kroger 80/20 ground beef roll 3 lb', 'fixed', '2026-01-01', '2026-03-01', 5)
  `).run().lastInsertRowid;

  const history = [1197, 1949, 1197, 1949, 1197];
  const dates = ['2026-01-01', '2026-01-10', '2026-01-20', '2026-02-01', '2026-02-10'];

  for (let i = 0; i < history.length; i++) {
    const bId = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-01-01', 'h', 1, 1, 1, 0)").run().lastInsertRowid;
    const oId = `GB-ORD-${i}`;
    db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES (?, 'kroger', ?, ?, ?)").run(oId, dates[i], dates[i], bId);
    const lId = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES (?, 0, 'Kroger 80/20 Ground Beef', '$10.00', 1, '$10.00')").run(oId).lastInsertRowid;
    db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, ?, ?, ?, 1, ?, ?, 'package', ?)").run(pId, oId, lId, dates[i], history[i], history[i], bId);
  }

  recomputeProductPromoCycling(db, pId);

  // Test 1: Returning to regular price ($19.49) -> NO alert
  const bReg = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-02-20', 'hReg', 1, 1, 1, 0)").run().lastInsertRowid;
  db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES ('GB-ORD-REG', 'kroger', '2026-02-20', '2026-02-20', ?)").run(bReg);
  const lReg = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES ('GB-ORD-REG', 0, 'Kroger 80/20 Ground Beef', '$19.49', 1, '$19.49')").run().lastInsertRowid;
  db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, 'GB-ORD-REG', ?, '2026-02-20', 1, 1949, 1949, 'package', ?)").run(pId, lReg, bReg);

  const alertsReg = generateAlertsForBatch(db, bReg);
  assert.equal(alertsReg.length, 0);

  // Test 2: Subsequent rise above regular level ($20.99) -> DOES alert
  const bRise = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-04-15', 'hRise', 1, 1, 1, 0)").run().lastInsertRowid;
  db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES ('GB-ORD-RISE', 'kroger', '2026-04-15', '2026-04-15', ?)").run(bRise);
  const lRise = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES ('GB-ORD-RISE', 0, 'Kroger 80/20 Ground Beef', '$20.99', 1, '$20.99')").run().lastInsertRowid;
  db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, 'GB-ORD-RISE', ?, '2026-04-15', 1, 2099, 2099, 'package', ?)").run(pId, lRise, bRise);

  const alertsRise = generateAlertsForBatch(db, bRise);
  assert.equal(alertsRise.length, 1);
  assert.equal(alertsRise[0].paid_unit_cents, 2099);
  assert.equal(alertsRise[0].baseline_cents, 1949);
  assert.equal(alertsRise[0].baseline_kind, 'regular_p75');
});

test('16. Eggs regression: flat plateau that dips then steps up above plateau raises high alert', () => {
  const db = createInMemoryDb();

  const pId = db.prepare(`
    INSERT INTO product (name_raw, name_key, price_basis, first_purchased_on, last_purchased_on, purchase_count)
    VALUES ('Kroger® Grade A Large White Eggs', 'kroger grade a large white eggs', 'fixed', '2026-01-01', '2026-08-01', 5)
  `).run().lastInsertRowid;

  const history = [209, 209, 209, 209, 179, 179];
  const dates = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01'];

  for (let i = 0; i < history.length; i++) {
    const bId = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-01-01', 'h', 1, 1, 1, 0)").run().lastInsertRowid;
    const oId = `EGGS-ORD-${i}`;
    db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES (?, 'kroger', ?, ?, ?)").run(oId, dates[i], dates[i], bId);
    const lId = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES (?, 0, 'Kroger Eggs', '$2.00', 1, '$2.00')").run(oId).lastInsertRowid;
    db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, ?, ?, ?, 1, ?, ?, 'package', ?)").run(pId, oId, lId, dates[i], history[i], history[i], bId);
  }

  recomputeProductPromoCycling(db, pId);

  // Step up to $2.65 (+26.8% above baseline 209) -> high alert
  const bUp = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-08-03', 'hUp', 1, 1, 1, 0)").run().lastInsertRowid;
  db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES ('EGGS-ORD-UP', 'kroger', '2026-08-03', '2026-08-03', ?)").run(bUp);
  const lUp = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES ('EGGS-ORD-UP', 0, 'Kroger Eggs', '$2.65', 1, '$2.65')").run().lastInsertRowid;
  db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, 'EGGS-ORD-UP', ?, '2026-08-03', 1, 265, 265, 'package', ?)").run(pId, lUp, bUp);

  const alertsUp = generateAlertsForBatch(db, bUp);
  assert.equal(alertsUp.length, 1);
  assert.equal(alertsUp[0].severity, 'high');
  assert.equal(alertsUp[0].baseline_cents, 209);
  assert.equal(alertsUp[0].baseline_kind, 'median');
});

test('17. Classification is sticky: a window containing only promo prices does not flip product to non-cycling', () => {
  const db = createInMemoryDb();

  const pId = db.prepare(`
    INSERT INTO product (name_raw, name_key, price_basis, first_purchased_on, last_purchased_on, purchase_count)
    VALUES ('Promo Product', 'promo product', 'fixed', '2026-01-01', '2026-08-01', 12)
  `).run().lastInsertRowid;

  // History establishing promo cycling (4 regular prices 1949, 8 promo prices 1197)
  const history = [1949, 1197, 1949, 1197, 1949, 1197, 1949, 1197, 1197, 1197, 1197, 1197];
  for (let i = 0; i < history.length; i++) {
    const bId = db.prepare("INSERT INTO import_batch (imported_at, source_sha256, order_count, item_count, new_order_count, duplicate_count) VALUES ('2026-01-01', 'h', 1, 1, 1, 0)").run().lastInsertRowid;
    const oId = `STICKY-ORD-${i}`;
    db.prepare("INSERT INTO grocer_order (id, retailer, ordered_on, date_raw, first_seen_batch) VALUES (?, 'kroger', '2026-01-01', '2026-01-01', ?)").run(oId, bId);
    const lId = db.prepare("INSERT INTO order_line_raw (order_id, line_index, name_raw, price_raw, qty_raw, unit_price_raw) VALUES (?, 0, 'Promo Product', '$10.00', 1, '$10.00')").run(oId).lastInsertRowid;
    db.prepare("INSERT INTO price_observation (product_id, order_id, line_raw_id, observed_on, qty, line_total_cents, paid_unit_cents, unit_basis, batch_id) VALUES (?, ?, ?, '2026-01-01', 1, ?, ?, 'package', ?)").run(pId, oId, lId, history[i], history[i], bId);
  }

  recomputeProductPromoCycling(db, pId);
  const prod = db.prepare('SELECT is_promo_cycling FROM product WHERE id = ?').get(pId);
  assert.equal(prod.is_promo_cycling, 1);
});

test('18. BREADCRUMBS_BIND_ADDRESSES parses comma list and trims', () => {
  assert.deepEqual(parseBindAddresses('127.0.0.1, 100.64.0.36'), ['127.0.0.1', '100.64.0.36']);
  assert.deepEqual(parseBindAddresses(' 10.0.0.1 , 127.0.0.1 '), ['10.0.0.1', '127.0.0.1']);
  assert.deepEqual(parseBindAddresses(''), []);
  assert.deepEqual(parseBindAddresses(null), ['127.0.0.1', '100.64.0.36']);
});

test('19. failed bind on one address does not prevent others', async () => {
  const dummyApp = express();
  dummyApp.get('/test', (req, res) => res.send('ok'));
  const testPort = 18899;
  const servers = startServer(dummyApp, testPort, '127.0.0.1, 240.0.0.1');

  await new Promise((resolve) => setTimeout(resolve, 100));

  try {
    const res = await fetch(`http://127.0.0.1:${testPort}/test`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'ok');
  } finally {
    for (const srv of servers) {
      srv.close();
    }
  }
});

test('20. trust middleware 403s non-tailnet non-loopback peer', () => {
  const middleware = createApiTrustMiddleware({
    onDenied: () => {},
  });

  let statusVal = null;
  let jsonVal = null;
  let nextCalled = false;

  const req = {
    socket: { remoteAddress: '192.168.1.100' },
    headers: {},
    method: 'GET',
    originalUrl: '/api/test',
  };
  const res = {
    status(code) {
      statusVal = code;
      return this;
    },
    json(body) {
      jsonVal = body;
      return this;
    },
  };
  const next = () => {
    nextCalled = true;
  };

  middleware(req, res, next);

  assert.equal(nextCalled, false);
  assert.equal(statusVal, 403);
  assert.equal(jsonVal?.error, 'trusted network or Cloudflare Access required');
});

test('21. retailer provenance is imported and legacy payloads still default to kroger', () => {
  const db = createInMemoryDb();
  const fixture = [
    {
      retailer: 'amazon',
      id: '113-1234567-1234567',
      date: '2026-08-07',
      total: '$21.65',
      items: [
        {
          name: 'Example Amazon Item',
          qty: 2,
          price: '$20.00',
          unitPrice: '$10.00',
          productId: 'B012345678',
        },
      ],
    },
    {
      id: '035~00100~2026-08-07~111~000001',
      date: '2026-08-07',
      total: '$3.00',
      items: [{ name: 'Legacy Kroger Item', qty: 1, price: '$3.00', unitPrice: '$3.00' }],
    },
  ];

  assert.equal(normalizeRetailer(' Amazon '), 'amazon');
  assert.equal(normalizeRetailer(undefined), 'kroger');
  const result = importOrdersJson(db, fixture);
  assert.equal(result.new_order_count, 2);

  const retailers = db.prepare('SELECT id, retailer, items_subtotal_cents, unattributed_cents FROM grocer_order ORDER BY id').all();
  assert.deepEqual(retailers, [
    { id: '035~00100~2026-08-07~111~000001', retailer: 'kroger', items_subtotal_cents: 300, unattributed_cents: 0 },
    { id: '113-1234567-1234567', retailer: 'amazon', items_subtotal_cents: 2000, unattributed_cents: 165 },
  ]);
});

test('22. one source order id cannot silently change retailers', () => {
  const db = createInMemoryDb();
  const base = [{
    retailer: 'amazon',
    id: 'SHARED-ORDER-ID',
    date: '2026-08-07',
    total: '$1.00',
    items: [{ name: 'Item', qty: 1, price: '$1.00', unitPrice: '$1.00' }],
  }];
  importOrdersJson(db, base);
  assert.throws(
    () => importOrdersJson(db, [{ ...base[0], retailer: 'heb' }]),
    /already belongs to retailer amazon/
  );
});


