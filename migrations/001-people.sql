-- People, their sessions, and sign-ins on their way.
-- Times are written by the site from its own clock, so they are always given, never defaulted.
-- There is no role column: being an admin is email in ADMIN_EMAILS, computed on every request (D12).

CREATE TABLE people (
  id bigserial PRIMARY KEY,
  -- Google's own id for the account (the ID token's sub): what a person is known by.
  google_sub text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  last_sign_in_at timestamptz
);

-- A signed-in browser. The cookie holds a random id (signed with SESSION_SECRET); only its
-- SHA-256 is kept here, so a copy of this table signs nobody in. Revoked or past expires_at: gone.
CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  person_id bigint NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_person ON sessions (person_id);

-- A sign-in sent to Google and not back yet: the state (by its SHA-256), the nonce the ID token
-- must carry, and the PKCE verifier. Used once; ten minutes at most.
CREATE TABLE sign_ins (
  state_hash text PRIMARY KEY,
  nonce text NOT NULL,
  verifier text NOT NULL,
  return_to text NOT NULL,
  created_at timestamptz NOT NULL,
  used_at timestamptz
);
