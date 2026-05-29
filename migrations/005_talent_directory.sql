CREATE TABLE IF NOT EXISTS talent_directory (
  id BIGSERIAL PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  designation TEXT,
  department TEXT,
  work_email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_talent_directory_name
  ON talent_directory(first_name, last_name);

CREATE UNIQUE INDEX IF NOT EXISTS idx_talent_directory_work_email
  ON talent_directory(lower(work_email));
