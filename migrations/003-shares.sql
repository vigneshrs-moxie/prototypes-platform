-- Who a feature is shared with, and who has asked.

-- By email, not person, so a feature can be shared with someone who has never signed in. Admins
-- never appear here. A removed share keeps its row: the site deletes nothing.
CREATE TABLE shares (
  id bigserial PRIMARY KEY,
  feature_id bigint NOT NULL REFERENCES features (id),
  email text NOT NULL,
  added_by bigint REFERENCES people (id),
  added_at timestamptz NOT NULL,
  removed_by bigint REFERENCES people (id),
  removed_at timestamptz
);
CREATE UNIQUE INDEX shares_live ON shares (feature_id, email) WHERE removed_at IS NULL;
CREATE INDEX shares_email ON shares (email) WHERE removed_at IS NULL;

-- A Request access press. One open request per person per feature.
CREATE TABLE access_requests (
  id bigserial PRIMARY KEY,
  feature_id bigint NOT NULL REFERENCES features (id),
  person_id bigint NOT NULL REFERENCES people (id),
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  resolved_by bigint REFERENCES people (id)
);
CREATE UNIQUE INDEX access_requests_open ON access_requests (feature_id, person_id) WHERE resolved_at IS NULL;
