CREATE INDEX IF NOT EXISTS monitor_jobs_record_idx
ON monitor_jobs(record_id);

CREATE INDEX IF NOT EXISTS claim_launches_record_idx
ON claim_launches(record_id);

PRAGMA optimize;
