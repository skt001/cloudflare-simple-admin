CREATE TABLE files (
  id TEXT PRIMARY KEY NOT NULL,
  file_no INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  comment TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  download_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready'))
) STRICT;

CREATE INDEX files_status_file_no ON files (status, file_no DESC);

CREATE TABLE file_chunks (
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, chunk_index)
) STRICT;

ALTER TABLE files ADD COLUMN download_password_hash TEXT;
ALTER TABLE files ADD COLUMN delete_key_hash TEXT;

CREATE TABLE file_download_tokens (
  token_hash TEXT PRIMARY KEY NOT NULL,
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX file_download_tokens_expires ON file_download_tokens (expires_at);

CREATE TABLE file_auth_attempts (
  file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('download', 'delete')),
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (file_id, purpose)
) STRICT;

ALTER TABLE files ADD COLUMN api_upload_token_hash TEXT;
ALTER TABLE files ADD COLUMN api_upload_expires_at INTEGER;

