CREATE TABLE local_migration_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  expected_bytes bigint NOT NULL,
  expected_chunks integer NOT NULL,
  uploaded_by text,
  status text NOT NULL DEFAULT 'receiving' CHECK (status IN ('receiving','staged','processed','aborted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  staged_at timestamptz
);
CREATE TABLE local_migration_upload_chunks (
  upload_id uuid NOT NULL REFERENCES local_migration_uploads(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (upload_id, chunk_index)
);
CREATE INDEX local_migration_uploads_status_idx ON local_migration_uploads(status, created_at DESC);