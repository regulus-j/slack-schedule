ALTER TABLE scheduling_cases
  ADD COLUMN IF NOT EXISTS schedule_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reschedule_status TEXT NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS reschedule_reason TEXT,
  ADD COLUMN IF NOT EXISTS previous_schedule JSONB,
  ADD COLUMN IF NOT EXISTS current_schedule JSONB,
  ADD COLUMN IF NOT EXISTS schedule_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_calendar_update_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_schedule_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reminder_status TEXT,
  ADD COLUMN IF NOT EXISTS reminder_email JSONB,
  ADD COLUMN IF NOT EXISTS pending_reschedule JSONB,
  ADD COLUMN IF NOT EXISTS reschedule_email JSONB,
  ADD COLUMN IF NOT EXISTS reschedule_email_status TEXT,
  ADD COLUMN IF NOT EXISTS action_lock JSONB,
  ADD COLUMN IF NOT EXISTS last_action_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_action_by TEXT;

CREATE INDEX IF NOT EXISTS idx_scheduling_cases_reschedule_status
  ON scheduling_cases(reschedule_status);

CREATE INDEX IF NOT EXISTS idx_scheduling_cases_calendar_event
  ON scheduling_cases(calendar_event_id);
