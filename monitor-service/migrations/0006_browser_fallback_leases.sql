CREATE TABLE IF NOT EXISTS browser_fallback_leases (
  record_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  leased_at TEXT NOT NULL,
  leased_until TEXT NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(record_id) REFERENCES orders(record_id) ON DELETE CASCADE,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS browser_fallback_leases_expiry_idx
  ON browser_fallback_leases(leased_until);
