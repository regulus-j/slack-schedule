CREATE TABLE IF NOT EXISTS scheduling_cases (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  owner_slack_user_id TEXT NOT NULL,
  channel_id TEXT,
  applicant JSONB NOT NULL DEFAULT '{}'::jsonb,
  recruiter JSONB NOT NULL DEFAULT '{}'::jsonb,
  hiring_manager JSONB NOT NULL DEFAULT '{}'::jsonb,
  template_id TEXT,
  notes TEXT,
  autofill JSONB NOT NULL DEFAULT '{}'::jsonb,
  approvals JSONB NOT NULL DEFAULT '[]'::jsonb,
  guests JSONB NOT NULL DEFAULT '[]'::jsonb,
  candidate_email JSONB,
  sms_copy TEXT,
  hm_message TEXT,
  hm_availability TEXT,
  calendar_event_id TEXT,
  calendar_event_draft JSONB,
  gmail_send_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  case_id TEXT REFERENCES scheduling_cases(id),
  actor_slack_user_id TEXT,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS encrypted_google_tokens (
  id TEXT PRIMARY KEY,
  recruiter_id TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduling_cases_owner ON scheduling_cases(owner_slack_user_id);
CREATE INDEX IF NOT EXISTS idx_scheduling_cases_status ON scheduling_cases(status);
CREATE INDEX IF NOT EXISTS idx_audit_events_case ON audit_events(case_id);
