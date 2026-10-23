ALTER TABLE network_agent_applications
  ADD COLUMN IF NOT EXISTS registration_mode text NOT NULL DEFAULT 'offline';

-- Existing applications with only the three online documents are classified safely.
UPDATE network_agent_applications
SET registration_mode = 'online'
WHERE registration_mode = 'offline'
  AND paper_contract_key IS NULL
  AND voice_recording_key IS NULL
  AND national_id_front_key IS NOT NULL
  AND national_id_back_key IS NOT NULL
  AND declaration_image_key IS NOT NULL;

ALTER TABLE network_agent_applications
  ADD CONSTRAINT network_agent_applications_registration_mode_check
  CHECK (registration_mode IN ('online', 'offline')) NOT VALID;

ALTER TABLE network_agent_applications
  VALIDATE CONSTRAINT network_agent_applications_registration_mode_check;