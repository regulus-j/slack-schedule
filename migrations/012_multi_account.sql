-- Add account_key to jazzhr_candidates for multi-account JazzHR support
ALTER TABLE jazzhr_candidates
  ADD COLUMN IF NOT EXISTS account_key TEXT NOT NULL DEFAULT '';

-- Update any lingering empty account_key values to 'default'
UPDATE jazzhr_candidates SET account_key = 'default' WHERE account_key = '';

-- Index for per-account lookups
CREATE INDEX IF NOT EXISTS idx_jazzhr_candidates_account
  ON jazzhr_candidates(account_key);
