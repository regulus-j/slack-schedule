-- 004_attendee_scheduling.sql
-- Adds attendee management, stage configuration, and scheduling metadata columns

ALTER TABLE scheduling_cases
  ADD COLUMN IF NOT EXISTS attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS stage_key TEXT,
  ADD COLUMN IF NOT EXISTS stage_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attendance_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS external_attendees JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_availability_check TEXT,
  ADD COLUMN IF NOT EXISTS selected_slot JSONB
