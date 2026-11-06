-- Notes and option picks.
-- A row written by import (publish.py --import-notes) has no site account behind it: person_id is
-- empty and by_label holds the name. Everything else has person_id.

CREATE TABLE notes (
  id bigserial PRIMARY KEY,
  feature_id bigint NOT NULL REFERENCES features (id),
  revision_id bigint NOT NULL REFERENCES revisions (id),
  person_id bigint REFERENCES people (id),
  by_label text,
  screen text NOT NULL,
  device text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('change', 'question', 'idea')),
  text text NOT NULL,
  pin jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  CHECK (person_id IS NOT NULL OR by_label IS NOT NULL)
);
CREATE INDEX notes_feature ON notes (feature_id, updated_at);

CREATE TABLE choices (
  id bigserial PRIMARY KEY,
  feature_id bigint NOT NULL REFERENCES features (id),
  person_id bigint REFERENCES people (id),
  by_label text,
  group_key text NOT NULL,
  choice text NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (person_id IS NOT NULL OR by_label IS NOT NULL)
);
CREATE UNIQUE INDEX choices_person ON choices (feature_id, person_id, group_key) WHERE person_id IS NOT NULL;
CREATE UNIQUE INDEX choices_label ON choices (feature_id, by_label, group_key) WHERE person_id IS NULL;
