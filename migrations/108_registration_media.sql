-- Registration media for marketer identity verification.
ALTER TABLE network_agent_applications
  ADD COLUMN IF NOT EXISTS national_id_front_key text,
  ADD COLUMN IF NOT EXISTS national_id_back_key text,
  ADD COLUMN IF NOT EXISTS voice_recording_key text;