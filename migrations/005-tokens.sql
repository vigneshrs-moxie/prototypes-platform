-- Publish tokens: one admin each, shown once, kept only as a SHA-256, revocable.

CREATE TABLE publish_tokens (
  id bigserial PRIMARY KEY,
  person_id bigint NOT NULL REFERENCES people (id),
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX publish_tokens_person ON publish_tokens (person_id);
