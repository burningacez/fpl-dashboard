/**
 * "Who are you?" identity — pure matching logic, shared by every view.
 *
 * Login is identification, not authentication: on first visit the user picks
 * their team from the CURRENT season's league members (or enters their FPL
 * team ID, validated against the league). The choice is permanent on this
 * device — there is no re-pick UI once claimed. Visitors can decline and claim
 * a team later. Stored client-side in localStorage.
 *
 * Cross-season identity keys on the normalised manager NAME (`nameKey`), not
 * the FPL entry id — the entry id is re-assigned every season, so it is only a
 * reliable key WITHIN a season (current tables, self-heal). `nameKey` is what
 * ties a person to their rows in archived seasons and to future career stats.
 */

export const MY_TEAM_STORAGE_KEY = 'fpl-my-team';

/** Member identity — the user has claimed a team. Permanent on this device. */
export interface MemberIdentity {
  v: 2;
  status: 'member';
  entryId: number; // current-season entry id; refreshed on rollover
  name: string; // manager name, as last seen in /api/members
  nameKey: string; // normalizeNameKey(name) — the stable cross-season key
  team: string; // fantasy team name
  season: string; // season when claimed / last re-matched ('' if unknown)
  claimedAt: string; // ISO timestamp
}

/** Visitor identity — the user declined to claim a team. */
export interface VisitorIdentity {
  v: 2;
  status: 'visitor';
  since: string; // ISO timestamp
}

export type StoredIdentity = MemberIdentity | VisitorIdentity;

/** A minimal current-season league member, as served by /api/members. */
export interface Member {
  entryId: number;
  name: string;
  team: string;
}

export interface ManagerRef {
  entryId?: number | string | null;
  entry?: number | string | null;
  name?: string | null;
}

/**
 * Stable, normalised key for a manager name: trimmed, lower-cased, internal
 * whitespace collapsed. Shared by client matching and the server-side archive
 * roster so both sides key identically.
 */
export function normalizeNameKey(s: string | null | undefined): string {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Match a rendered manager reference against the stored identity.
 *
 * Only a claimed member (or an ex-member, which is stored as a member) can
 * match; visitors never do. Matching is season-aware:
 *
 * - Current season (`archived: false`): id-first — a ref carrying an
 *   entry/entryId does a numeric compare and STOPS, never falling through to
 *   names (prevents duplicate-name false positives). Name fallback only when
 *   the ref carries no id.
 * - Archived season (`archived: true`): NAME ONLY. Archived rows carry the
 *   entry ids of a different season, so comparing them to the current entry id
 *   is meaningless — match on `nameKey` instead.
 */
export function matchesRef(
  identity: StoredIdentity | null | undefined,
  ref: ManagerRef | string | null | undefined,
  opts: { archived: boolean },
): boolean {
  if (!identity || identity.status !== 'member' || !ref) return false;

  if (typeof ref === 'string') {
    return normalizeNameKey(ref) === identity.nameKey;
  }

  if (!opts.archived) {
    const id = ref.entryId ?? ref.entry;
    if (id !== undefined && id !== null && id !== '') {
      return Number(id) === identity.entryId;
    }
  }

  return !!ref.name && normalizeNameKey(ref.name) === identity.nameKey;
}

/**
 * Load the stored identity, migrating the legacy v1 shape in place.
 *
 * v1 was `{ entryId, name, team, savedAt }` with no `v` field. Those users
 * already picked a team, so they are grandfathered into a locked v2 member.
 * Anything unrecognisable returns null (treated as first-run).
 */
export function loadIdentity(): StoredIdentity | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(MY_TEAM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    if (parsed?.v === 2) {
      if (parsed.status === 'visitor' && typeof parsed.since === 'string') {
        return parsed as unknown as VisitorIdentity;
      }
      if (
        parsed.status === 'member' &&
        typeof parsed.entryId === 'number' &&
        typeof parsed.name === 'string' &&
        typeof parsed.nameKey === 'string'
      ) {
        return parsed as unknown as MemberIdentity;
      }
      return null;
    }

    // Legacy v1 → migrate to a locked member.
    if (typeof parsed?.entryId === 'number' && typeof parsed?.name === 'string') {
      const migrated: MemberIdentity = {
        v: 2,
        status: 'member',
        entryId: parsed.entryId as number,
        name: parsed.name as string,
        nameKey: normalizeNameKey(parsed.name as string),
        team: typeof parsed.team === 'string' ? (parsed.team as string) : '',
        season: '',
        claimedAt: typeof parsed.savedAt === 'string' ? (parsed.savedAt as string) : new Date().toISOString(),
      };
      saveIdentity(migrated);
      return migrated;
    }

    return null;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: StoredIdentity): StoredIdentity {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(MY_TEAM_STORAGE_KEY, JSON.stringify(identity));
  }
  return identity;
}

/** Build (but do not persist) a member identity from a league member. */
export function makeMemberIdentity(member: Member, season: string | null): MemberIdentity {
  return {
    v: 2,
    status: 'member',
    entryId: member.entryId,
    name: member.name,
    nameKey: normalizeNameKey(member.name),
    team: member.team,
    season: season || '',
    claimedAt: new Date().toISOString(),
  };
}

/** Build (but do not persist) a visitor identity. */
export function makeVisitorIdentity(): VisitorIdentity {
  return { v: 2, status: 'visitor', since: new Date().toISOString() };
}

export function clearIdentity(): void {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(MY_TEAM_STORAGE_KEY);
  }
}

export type ResolvedStatus = 'member' | 'ex-member' | 'visitor';

/**
 * Reconcile a stored identity against the current-season member list. Pure so
 * it can be unit-tested; the provider persists the result when `changed`.
 *
 * - Member found by entry id → refresh name/team/nameKey if they renamed.
 * - Member not found by id but a UNIQUE name match exists → season rollover:
 *   adopt the new entry id (and name/team). This is how an identity from
 *   season N heals into season N+1, where everyone has new entry ids.
 * - Zero or ambiguous (2+) name matches → ex-member: leave the identity
 *   untouched so archived tables still highlight them, but they are not a
 *   current member and get no current-season highlight. Never re-assign on
 *   ambiguity.
 */
export function resolveAgainstMembers(
  identity: StoredIdentity | null,
  members: Member[],
  currentSeason: string | null,
): { identity: StoredIdentity | null; status: ResolvedStatus | 'unclaimed'; changed: boolean } {
  if (!identity) return { identity: null, status: 'unclaimed', changed: false };
  if (identity.status === 'visitor') return { identity, status: 'visitor', changed: false };

  const byId = members.find((m) => m.entryId === identity.entryId);
  if (byId) {
    const nameKey = normalizeNameKey(byId.name);
    const season = currentSeason || identity.season;
    const changed =
      byId.name !== identity.name ||
      byId.team !== identity.team ||
      nameKey !== identity.nameKey ||
      season !== identity.season;
    const next: MemberIdentity = { ...identity, name: byId.name, team: byId.team, nameKey, season };
    return { identity: next, status: 'member', changed };
  }

  const nameMatches = members.filter((m) => normalizeNameKey(m.name) === identity.nameKey);
  if (nameMatches.length === 1) {
    const m = nameMatches[0];
    const next: MemberIdentity = {
      ...identity,
      entryId: m.entryId,
      name: m.name,
      team: m.team,
      nameKey: normalizeNameKey(m.name),
      season: currentSeason || identity.season,
    };
    return { identity: next, status: 'member', changed: true };
  }

  return { identity, status: 'ex-member', changed: false };
}
