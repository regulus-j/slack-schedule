ALTER TABLE scheduling_cases
  ADD COLUMN IF NOT EXISTS interview_window_start_date TEXT,
  ADD COLUMN IF NOT EXISTS interview_window_end_date TEXT,
  ADD COLUMN IF NOT EXISTS interview_timezone TEXT,
  ADD COLUMN IF NOT EXISTS selected_interview_date TEXT,
  ADD COLUMN IF NOT EXISTS selected_interview_time TEXT,
  ADD COLUMN IF NOT EXISTS resume_link TEXT;
