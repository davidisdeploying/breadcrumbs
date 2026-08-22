import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { recomputeProductPromoCycling, generateAlertsForBatch } from '../server/alerts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.BREADCRUMBS_DB_PATH || path.join(__dirname, '..', 'data', 'breadcrumbs.db');
const BAK_PATH = path.join(__dirname, '..', 'data', 'breadcrumbs.db.pre-promo.bak');

// 1. Back up database first
fs.copyFileSync(DB_PATH, BAK_PATH);
console.log(`Backed up database to ${BAK_PATH}`);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Capture before stats
const beforeOrders = db.prepare('SELECT COUNT(*) AS c FROM grocer_order').get().c;
const beforeProducts = db.prepare('SELECT COUNT(*) AS c FROM product').get().c;
const beforeObs = db.prepare('SELECT COUNT(*) AS c FROM price_observation').get().c;
const beforeLines = db.prepare('SELECT COUNT(*) AS c FROM order_line_raw').get().c;
const beforeBatches = db.prepare('SELECT COUNT(*) AS c FROM import_batch').get().c;

const beforeAlerts = db.prepare('SELECT severity, COUNT(*) AS c FROM price_alert GROUP BY severity').all();
const beforeCounts = { total: 0, high: 0, warn: 0, info: 0 };
beforeAlerts.forEach((row) => {
  beforeCounts[row.severity] = row.c;
  beforeCounts.total += row.c;
});

console.log('\n--- Before Recompute ---');
console.log(`Orders: ${beforeOrders}, Products: ${beforeProducts}, Obs: ${beforeObs}, Batches: ${beforeBatches}`);
console.log(`Alerts Total: ${beforeCounts.total} (high: ${beforeCounts.high}, warn: ${beforeCounts.warn}, info: ${beforeCounts.info})`);

// 2. Recompute is_promo_cycling / price_spread_pct for all products
const products = db.prepare('SELECT id FROM product').all();
for (const p of products) {
  recomputeProductPromoCycling(db, p.id);
}

const promoCyclingCount = db.prepare('SELECT COUNT(*) AS c FROM product WHERE is_promo_cycling = 1').get().c;
console.log(`\nRecomputed ${products.length} products. Promo cycling products count: ${promoCyclingCount}`);

// 3. DELETE FROM price_alert; then regenerate across all batches in observation.id order
db.prepare('DELETE FROM price_alert').run();

const batches = db.prepare('SELECT id FROM import_batch ORDER BY id ASC').all();
for (const b of batches) {
  generateAlertsForBatch(db, b.id);
}

// 4. Capture after stats
const afterOrders = db.prepare('SELECT COUNT(*) AS c FROM grocer_order').get().c;
const afterProducts = db.prepare('SELECT COUNT(*) AS c FROM product').get().c;
const afterObs = db.prepare('SELECT COUNT(*) AS c FROM price_observation').get().c;
const afterLines = db.prepare('SELECT COUNT(*) AS c FROM order_line_raw').get().c;
const afterBatches = db.prepare('SELECT COUNT(*) AS c FROM import_batch').get().c;

const afterAlerts = db.prepare('SELECT severity, COUNT(*) AS c FROM price_alert GROUP BY severity').all();
const afterCounts = { total: 0, high: 0, warn: 0, info: 0 };
afterAlerts.forEach((row) => {
  afterCounts[row.severity] = row.c;
  afterCounts.total += row.c;
});

console.log('\n--- After Recompute ---');
console.log(`Orders: ${afterOrders}, Products: ${afterProducts}, Obs: ${afterObs}, Batches: ${afterBatches}`);
console.log(`Alerts Total: ${afterCounts.total} (high: ${afterCounts.high}, warn: ${afterCounts.warn}, info: ${afterCounts.info})`);

// Verify counts 95 / 445 / 445 / 1
if (beforeOrders !== afterOrders || beforeObs !== afterObs || beforeLines !== afterLines || beforeBatches !== afterBatches) {
  console.error('ERROR: Database row counts changed unexpectedly!');
  process.exit(1);
}
