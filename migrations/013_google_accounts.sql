-- 013: Google multi-account support
ALTER TABLE encrypted_google_tokens ADD COLUMN IF NOT EXISTS label TEXT;
ALTER TABLE encrypted_google_tokens ADD COLUMN IF NOT EXISTS account_email TEXT;
ALTER TABLE scheduling_cases ADD COLUMN IF NOT EXISTS google_account_id TEXT;
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS account_email TEXT DEFAULT '';
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS account_label TEXT DEFAULT '';
