PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS import_batch (
  id INTEGER PRIMARY KEY, imported_at TEXT NOT NULL, source_filename TEXT,
  source_sha256 TEXT NOT NULL, order_count INTEGER NOT NULL, item_count INTEGER NOT NULL,
  new_order_count INTEGER NOT NULL, duplicate_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grocer_order (
  id TEXT PRIMARY KEY, retailer TEXT NOT NULL DEFAULT 'kroger', store_number TEXT,
  ordered_on TEXT NOT NULL, date_raw TEXT NOT NULL, total_cents INTEGER,
  items_subtotal_cents INTEGER, unattributed_cents INTEGER, url TEXT,
  first_seen_batch INTEGER NOT NULL REFERENCES import_batch(id)
);
CREATE TABLE IF NOT EXISTS order_line_raw (
  id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES grocer_order(id),
  line_index INTEGER NOT NULL, name_raw TEXT NOT NULL, price_raw TEXT NOT NULL,
  qty_raw INTEGER NOT NULL, unit_price_raw TEXT NOT NULL,
  UNIQUE (order_id, line_index)
);
CREATE TABLE IF NOT EXISTS product (
  id INTEGER PRIMARY KEY, name_raw TEXT NOT NULL UNIQUE, name_key TEXT NOT NULL,
  family_key TEXT, brand TEXT, size_qty REAL, size_unit TEXT,
  price_basis TEXT NOT NULL DEFAULT 'unknown'
    CHECK (price_basis IN ('fixed','variable_weight','unknown')),
  category TEXT, first_purchased_on TEXT, last_purchased_on TEXT,
  purchase_count INTEGER NOT NULL DEFAULT 0,
  is_promo_cycling INTEGER NOT NULL DEFAULT 0,
  price_spread_pct REAL
);
CREATE TABLE IF NOT EXISTS price_observation (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES product(id),
  order_id TEXT NOT NULL REFERENCES grocer_order(id),
  line_raw_id INTEGER NOT NULL REFERENCES order_line_raw(id),
  observed_on TEXT NOT NULL, qty INTEGER NOT NULL, line_total_cents INTEGER NOT NULL,
  paid_unit_cents INTEGER NOT NULL,
  page_price_cents INTEGER, page_regular_cents INTEGER, page_promo_flag INTEGER,
  unit_basis TEXT NOT NULL DEFAULT 'package' CHECK (unit_basis IN ('package','weight_each')),
  batch_id INTEGER NOT NULL REFERENCES import_batch(id),
  UNIQUE (line_raw_id)
);
CREATE INDEX IF NOT EXISTS ix_obs_product_date ON price_observation(product_id, observed_on);
CREATE TABLE IF NOT EXISTS price_alert (
  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES product(id),
  observation_id INTEGER NOT NULL REFERENCES price_observation(id),
  batch_id INTEGER NOT NULL REFERENCES import_batch(id), raised_on TEXT NOT NULL,
  paid_unit_cents INTEGER NOT NULL, baseline_cents INTEGER NOT NULL,
  baseline_n INTEGER NOT NULL, delta_pct REAL NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','warn','high')),
  baseline_kind TEXT NOT NULL DEFAULT 'median' CHECK (baseline_kind IN ('median','regular_p75')),
  acknowledged_at TEXT, UNIQUE (observation_id)
);
