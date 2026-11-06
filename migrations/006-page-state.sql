-- What the prototype page keeps on the site that the first tables had no place for.

-- The one-line reason from the Decisions panel.
ALTER TABLE choices ADD COLUMN why text NOT NULL DEFAULT '';

-- Where a note was written, so a reader can be put back there: { path, role, options, edited }.
ALTER TABLE notes ADD COLUMN place jsonb;

-- A person's settings on one feature's page: theme, device, tab, side panel.
CREATE TABLE views (
  feature_id bigint NOT NULL REFERENCES features (id),
  person_id bigint NOT NULL REFERENCES people (id),
  view jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (feature_id, person_id)
);
