ALTER TABLE network_agent_applications
  ADD COLUMN IF NOT EXISTS paper_contract_key text,
  ADD COLUMN IF NOT EXISTS declaration_image_key text;