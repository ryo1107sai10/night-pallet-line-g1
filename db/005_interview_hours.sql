SET search_path = night, pg_catalog;

ALTER TABLE store
  ADD COLUMN interview_open_minute integer NOT NULL DEFAULT 1080,
  ADD COLUMN interview_close_minute integer NOT NULL DEFAULT 1440,
  ADD COLUMN interview_hours_revision integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT interview_hours_valid CHECK (
    interview_open_minute >= 0 AND interview_close_minute <= 1440
    AND interview_open_minute < interview_close_minute
    AND interview_open_minute % 30 = 0 AND interview_close_minute % 30 = 0
  );
