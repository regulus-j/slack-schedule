ALTER TABLE scheduling_cases
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

CREATE INDEX IF NOT EXISTS idx_scheduling_cases_deleted_at
  ON scheduling_cases(deleted_at);
