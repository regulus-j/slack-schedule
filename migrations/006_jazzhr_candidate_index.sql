CREATE TABLE IF NOT EXISTS jazzhr_candidates (
  jazzhr_application_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  job_title TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  recruiter_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'jazzhr',
  applied_at TIMESTAMPTZ,
  source_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jazzhr_candidates_full_name ON jazzhr_candidates (lower(full_name));
CREATE INDEX IF NOT EXISTS idx_jazzhr_candidates_applied_at ON jazzhr_candidates(applied_at DESC NULLS LAST, source_order ASC);
