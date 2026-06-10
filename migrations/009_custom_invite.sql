ALTER TABLE scheduling_cases
  ADD COLUMN IF NOT EXISTS custom_invite JSONB NOT NULL DEFAULT '{}'::jsonb;
