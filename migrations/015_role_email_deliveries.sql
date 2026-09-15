ALTER TABLE scheduling_cases
  ADD COLUMN IF NOT EXISTS role_email_deliveries JSONB NOT NULL DEFAULT '{}'::jsonb;
