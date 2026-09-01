CREATE TABLE IF NOT EXISTS orders (
  record_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  marketplace_id TEXT NOT NULL DEFAULT '',
  order_id TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  carrier_id TEXT NOT NULL DEFAULT '',
  carrier_label TEXT NOT NULL DEFAULT '',
  amazon_url TEXT NOT NULL DEFAULT '',
  ship_date TEXT NOT NULL DEFAULT '',
  deliver_by TEXT NOT NULL DEFAULT '',
  item_value TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL DEFAULT '',
  recipient_name TEXT NOT NULL DEFAULT '',
  recipient_address1 TEXT NOT NULL DEFAULT '',
  recipient_address2 TEXT NOT NULL DEFAULT '',
  recipient_city TEXT NOT NULL DEFAULT '',
  recipient_postal_code TEXT NOT NULL DEFAULT '',
  recipient_country TEXT NOT NULL DEFAULT '',
  tracking_state TEXT NOT NULL DEFAULT 'unknown',
  status_text TEXT NOT NULL DEFAULT '',
  status_summary TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT '',
  next_check_at TEXT NOT NULL DEFAULT '',
  claim_recommended INTEGER NOT NULL DEFAULT 0,
  claim_reason TEXT NOT NULL DEFAULT 'none',
  claim_title TEXT NOT NULL DEFAULT '',
  claim_status TEXT NOT NULL DEFAULT 'none',
  claim_reference TEXT NOT NULL DEFAULT '',
  claim_submitted_at TEXT NOT NULL DEFAULT '',
  claim_payload TEXT NOT NULL DEFAULT '{}',
  pickup_notified_at TEXT NOT NULL DEFAULT '',
  pickup_ack_at TEXT NOT NULL DEFAULT '',
  resolved_at TEXT NOT NULL DEFAULT '',
  resolution_previous_state TEXT NOT NULL DEFAULT '',
  resolution_note TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS orders_tracking_state_idx ON orders(tracking_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS orders_tracking_number_idx ON orders(tracking_number);
CREATE INDEX IF NOT EXISTS orders_checked_at_idx ON orders(checked_at);
CREATE INDEX IF NOT EXISTS orders_account_idx ON orders(account_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS orders_account_order_idx ON orders(account_id, marketplace_id, order_id);

CREATE TABLE IF NOT EXISTS seller_accounts (
  account_id TEXT NOT NULL,
  account_name TEXT NOT NULL DEFAULT '',
  marketplace_id TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(account_id, marketplace_id)
);

CREATE TABLE IF NOT EXISTS tracking_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL,
  tracking_state TEXT NOT NULL,
  status_text TEXT NOT NULL DEFAULT '',
  event_at TEXT NOT NULL DEFAULT '',
  observed_at TEXT NOT NULL,
  raw_code TEXT NOT NULL DEFAULT '',
  UNIQUE(record_id, tracking_state, status_text, event_at),
  FOREIGN KEY(record_id) REFERENCES orders(record_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS tracking_events_order_idx ON tracking_events(record_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS monitor_runs (
  run_date TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL DEFAULT '',
  queued_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  checked_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS monitor_jobs (
  run_date TEXT NOT NULL,
  record_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_date, record_id),
  FOREIGN KEY(run_date) REFERENCES monitor_runs(run_date) ON DELETE CASCADE,
  FOREIGN KEY(record_id) REFERENCES orders(record_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS monitor_jobs_status_idx ON monitor_jobs(run_date, status);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  device_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pairing_attempts (
  attempt_key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_launches (
  token_hash TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(record_id) REFERENCES orders(record_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS claim_launches_expiry_idx ON claim_launches(expires_at);

CREATE TABLE IF NOT EXISTS notification_receipts (
  record_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  last_notified_at TEXT NOT NULL,
  PRIMARY KEY(record_id, device_id),
  FOREIGN KEY(record_id) REFERENCES orders(record_id) ON DELETE CASCADE
);
