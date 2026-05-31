ALTER TABLE jazzhr_candidates
  ADD COLUMN IF NOT EXISTS candidate_key TEXT,
  ADD COLUMN IF NOT EXISTS jazzhr_job_id TEXT NOT NULL DEFAULT '';

UPDATE jazzhr_candidates
SET candidate_key = jazzhr_application_id
WHERE candidate_key IS NULL OR candidate_key = '';

DO $$
DECLARE
  primary_key_name TEXT;
BEGIN
  SELECT conname INTO primary_key_name
  FROM pg_constraint
  WHERE conrelid = 'jazzhr_candidates'::regclass
    AND contype = 'p';

  IF primary_key_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE jazzhr_candidates DROP CONSTRAINT %I', primary_key_name);
  END IF;
END $$;

ALTER TABLE jazzhr_candidates
  ALTER COLUMN candidate_key SET NOT NULL,
  ADD PRIMARY KEY (candidate_key);

CREATE INDEX IF NOT EXISTS idx_jazzhr_candidates_application_id ON jazzhr_candidates(jazzhr_application_id);
CREATE INDEX IF NOT EXISTS idx_jazzhr_candidates_job_id ON jazzhr_candidates(jazzhr_job_id);
