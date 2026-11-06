-- Features, the documents each one has, and every publish of a document.

-- A feature's folder. key is its address (D18): written once, never renamed.
CREATE TABLE features (
  id bigserial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  title text NOT NULL,
  ticket_key text,
  ticket_url text,
  job_slug text,
  created_by bigint REFERENCES people (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  archived_at timestamptz
);

-- A kind of document a feature has. New types are admin-only unless someone says otherwise (D19).
CREATE TABLE documents (
  id bigserial PRIMARY KEY,
  feature_id bigint NOT NULL REFERENCES features (id),
  type text NOT NULL,
  audience text NOT NULL DEFAULT 'admin' CHECK (audience IN ('people', 'admin')),
  created_at timestamptz NOT NULL,
  UNIQUE (feature_id, type)
);

-- One publish of one document. n is the prototype's revision number; a requirements or decisions
-- revision carries the number of the publish it came with, so "as of r3" is always answerable.
-- Files are named here and live in private Blob storage.
CREATE TABLE revisions (
  id bigserial PRIMARY KEY,
  document_id bigint NOT NULL REFERENCES documents (id),
  n integer NOT NULL,
  page_blob text,
  pdf_blob text,
  manifest jsonb,
  body text,
  changes text,
  page_version integer,
  published_by bigint REFERENCES people (id),
  -- Which token published it: the hourly limit counts these.
  token_id bigint,
  published_at timestamptz NOT NULL,
  UNIQUE (document_id, n)
);
CREATE INDEX revisions_token_time ON revisions (token_id, published_at);
