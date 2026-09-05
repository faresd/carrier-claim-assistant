-- Current carrier summary is not historical evidence. Keep it separately so a
-- generic "delivered" event can be distinguished from delivery back to sender.
ALTER TABLE orders ADD COLUMN status_current_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN tracking_classifier_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS orders_classifier_version_idx ON orders(tracking_classifier_version);
