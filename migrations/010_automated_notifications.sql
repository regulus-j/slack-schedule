ALTER TABLE scheduling_cases
  ADD COLUMN IF NOT EXISTS resume_file JSONB,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_by TEXT,
  ADD COLUMN IF NOT EXISTS feedback_email JSONB,
  ADD COLUMN IF NOT EXISTS feedback_email_status TEXT;

CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES scheduling_cases(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  schedule_version INTEGER NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (case_id, type, schedule_version)
);

CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
  ON notification_jobs(status, due_at);

CREATE INDEX IF NOT EXISTS idx_notification_jobs_case
  ON notification_jobs(case_id);
