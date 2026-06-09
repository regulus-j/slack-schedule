ALTER TABLE jazzhr_candidates
  ADD COLUMN IF NOT EXISTS workflow_step_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS workflow_step TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS workflow_category TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS job_status TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recruiter_email TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recruiter_name TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_jazzhr_candidates_workflow_step_id
  ON jazzhr_candidates(workflow_step_id);
