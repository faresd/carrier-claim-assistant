CREATE TABLE IF NOT EXISTS deleted_orders (
  account_id TEXT NOT NULL,
  marketplace_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  record_id TEXT NOT NULL UNIQUE,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY(account_id, marketplace_id, order_id)
);

CREATE INDEX IF NOT EXISTS deleted_orders_order_idx
ON deleted_orders(order_id, marketplace_id);

PRAGMA optimize;
