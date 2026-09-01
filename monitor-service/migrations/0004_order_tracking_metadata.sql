ALTER TABLE orders ADD COLUMN order_date TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN tracking_source TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS orders_order_date_idx ON orders(order_date);

PRAGMA optimize;
