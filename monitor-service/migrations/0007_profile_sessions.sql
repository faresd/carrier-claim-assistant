-- Additive opaque profile-session storage.
-- Runtime remains disabled until a separately reviewed rollout imports the vault.
CREATE TABLE IF NOT EXISTS carrier_profile_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  browser_digest TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  session_ciphertext TEXT NOT NULL,
  metadata_ciphertext TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_carrier_profile_sessions_browser
  ON carrier_profile_sessions(browser_digest, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_carrier_profile_sessions_expiry
  ON carrier_profile_sessions(expires_at);
