import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.BREADCRUMBS_DB_PATH || path.join(__dirname, '..', 'data', 'breadcrumbs.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schemaSql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
db.exec(schemaSql);

const obsColumns = db.prepare("PRAGMA table_info(price_observation)").all();
const hasUnitBasis = obsColumns.some((col) => col.name === 'unit_basis');
if (!hasUnitBasis) {
  db.exec("ALTER TABLE price_observation ADD COLUMN unit_basis TEXT NOT NULL DEFAULT 'package'");
}

const productColumns = db.prepare("PRAGMA table_info(product)").all();
if (!productColumns.some((col) => col.name === 'is_promo_cycling')) {
  db.exec("ALTER TABLE product ADD COLUMN is_promo_cycling INTEGER NOT NULL DEFAULT 0");
}
if (!productColumns.some((col) => col.name === 'price_spread_pct')) {
  db.exec("ALTER TABLE product ADD COLUMN price_spread_pct REAL");
}

const alertColumns = db.prepare("PRAGMA table_info(price_alert)").all();
if (!alertColumns.some((col) => col.name === 'baseline_kind')) {
  db.exec("ALTER TABLE price_alert ADD COLUMN baseline_kind TEXT NOT NULL DEFAULT 'median'");
}

export { DB_PATH };
