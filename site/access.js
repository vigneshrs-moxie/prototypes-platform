// Who sees what (plan section 4). Every route that returns feature content calls canSee.
//
// `person` comes from the session (person.admin is computed there on every request, D12).
// `feature` comes from loadFeature, which also says whether it is shared with that one person, so
// the answer can't be asked about one person with another person's share.

/** Whether a person is an admin, from the fixed list (D12). */
export const isAdmin = (person, config) => Boolean(person) && config.adminEmails().has(String(person.email).toLowerCase());

/**
 * Whether this person may see this feature, or this document of it.
 *   admin    everything, archived features and admin-only documents included
 *   shared   the feature's people-facing documents, unless it is archived
 *   anyone   nothing: the page offers Request access
 */
export function canSee(person, feature, document = null) {
  if (!person || !feature) return false;
  if (person.admin) return true;
  if (feature.archived_at || !feature.shared) return false;
  return !document || document.audience === 'people';
}

/** The feature at this key, with `shared` answered for this person. Null when there is none. */
export async function loadFeature(db, key, person) {
  const { rows } = await db.query(
    `SELECT f.*, EXISTS (SELECT 1 FROM shares s WHERE s.feature_id = f.id AND s.email = $2 AND s.removed_at IS NULL) AS shared
       FROM features f WHERE f.key = $1`,
    [key, person.email],
  );
  return rows[0] ?? null;
}
