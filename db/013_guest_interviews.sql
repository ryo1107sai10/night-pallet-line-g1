SET search_path = night, pg_catalog;

ALTER TABLE store ADD COLUMN guest_interviews_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE interview_session
  ADD COLUMN audience text NOT NULL DEFAULT 'line' CHECK (audience IN ('line', 'guest'));
ALTER TABLE interview_booking ADD COLUMN guest_email_box text;
