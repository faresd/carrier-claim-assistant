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


CREATE UNIQUE INDEX IF NOT EXISTS ux_carrier_profile_sessions_active_browser_subject ON carrier_profile_sessions(browser_digest, subject_digest) WHERE revoked_at IS NULL;
CREATE TRIGGER IF NOT EXISTS trg_carrier_profile_sessions_active_cap BEFORE INSERT ON carrier_profile_sessions
WHEN NOT EXISTS (SELECT 1 FROM carrier_profile_sessions existing WHERE existing.browser_digest = NEW.browser_digest AND existing.subject_digest = NEW.subject_digest AND existing.revoked_at IS NULL)
AND (SELECT COUNT(*) FROM carrier_profile_sessions active WHERE active.browser_digest = NEW.browser_digest AND active.revoked_at IS NULL AND active.expires_at > NEW.created_at) >= 5
BEGIN
  SELECT RAISE(ABORT, 'profile_limit_reached');
END;
