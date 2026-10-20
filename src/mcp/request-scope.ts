/**
 * Per-request source scope narrowing (`X-Gbrain-Source-Scope`).
 *
 * ## Why
 *
 * An OAuth client's read authority (`federated_read` → `AuthInfo.allowedSources`)
 * is fixed at registration. A deployment that fronts one brain with a shared
 * client — gbrain-web does exactly this, one server-side OAuth client for every
 * browser session — therefore has NO way to tell the brain "this request is on
 * behalf of a user who may see only these sources". Every request carries the
 * same client grant, so unqualified reads span the whole grant and leak across
 * users.
 *
 * Upstream's answer for a per-user front end is one client per user. When that
 * is impractical, this header lets a trusted front end narrow the read scope
 * per request instead.
 *
 * ## Safety contract (narrow-only, fail-closed)
 *
 * The header is ATTACKER-CONTROLLED (any HTTP client can send it), so it may
 * only ever *reduce* authority. `narrowAllowedSources`:
 *
 *  - intersects the requested ids with the caller's granted read set, so a
 *    caller can never name a source outside its own grant;
 *  - never widens: an unknown/empty/absent header, or an intersection that
 *    would be larger than the grant, leaves the grant untouched;
 *  - an intersection that comes out EMPTY narrows to the deny-all sentinel
 *    (`NO_SOURCES`), not to "no filter" — a caller naming only sources it
 *    cannot read ends up able to read nothing, never everything.
 *
 * The write axis is deliberately NOT narrowed here: `sourceId` (write
 * authority) keeps coming from the client row. Narrowing a read scope must not
 * silently retarget where a write lands.
 */

import { ALL_SOURCES, NO_SOURCES, isValidSourceId } from '../core/source-id.ts';

/** HTTP header carrying a comma-separated list of source ids to narrow to. */
export const GBRAIN_SOURCE_SCOPE_HEADER = 'X-Gbrain-Source-Scope';

/** Parse the header into a deduped, trimmed id list. Absent/garbage → null. */
export function parseSourceScopeHeader(header: string | null | undefined): string[] | null {
  if (typeof header !== 'string') return null;
  const ids = header
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);
  if (ids.length === 0) return null;
  const unique = [...new Set(ids)];
  // The deny-all / span-all sentinels and real ids are the only acceptable
  // values; anything else is a malformed request. Rejecting (rather than
  // dropping) keeps the fail-closed posture: silence would look like an
  // unqualified read.
  const acceptable = unique.every(id => isValidSourceId(id) || id === NO_SOURCES || id === ALL_SOURCES);
  return acceptable ? unique : null;
}

/**
 * Apply a narrow-only source scope to the caller's granted read set.
 *
 * Returns the new `allowedSources` array, or `undefined` when nothing should
 * change (no header, or the caller has no federated grant to narrow).
 */
export function narrowAllowedSources(
  granted: readonly string[] | undefined,
  header: string | null | undefined,
): string[] | undefined {
  if (granted === undefined) return undefined;
  const requested = parseSourceScopeHeader(header);
  if (requested === null) return undefined;

  // `__all__` means "everything I'm granted" — that IS the unqualified
  // baseline, so it must not change anything (and must never widen past the
  // grant). Same for a list that already covers the grant.
  if (requested.includes(ALL_SOURCES)) return undefined;

  // Deny-all request, or a request naming only sources outside the grant.
  if (requested.includes(NO_SOURCES)) return [NO_SOURCES];
  const intersection = granted.filter(id => requested.includes(id));
  if (intersection.length === 0) return [NO_SOURCES];
  // Never widen: if the request covered the whole grant, nothing to narrow.
  if (intersection.length === granted.length) return undefined;
  return intersection;
}
