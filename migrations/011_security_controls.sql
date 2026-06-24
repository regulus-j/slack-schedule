ALTER TABLE scheduling_cases
  ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE encrypted_google_tokens
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  team_id TEXT NOT NULL DEFAULT '',
  token_owner_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'slack',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry
  ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  user_id TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, bucket, window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_window
  ON rate_limit_counters(window_started_at);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = 'audit_events_case_id_fkey'
      AND table_name = 'audit_events'
  ) THEN
    ALTER TABLE audit_events DROP CONSTRAINT audit_events_case_id_fkey;
  END IF;
END $$;

ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_case_id_fkey
  FOREIGN KEY (case_id) REFERENCES scheduling_cases(id) ON DELETE CASCADE;
