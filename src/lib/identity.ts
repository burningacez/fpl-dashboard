/**
 * "Who are you?" identity — pure matching logic, shared by every view.
 *
 * Login is identification, not authentication: the user picks their team
 * from the league member list (or enters their FPL team ID, validated
 * against the league). Stored client-side in localStorage.
 */

export const MY_TEAM_STORAGE_KEY = 'fpl-my-team';

export interface MyTeam {
  entryId: number;
  name: string; // manager name
  team: string; // fantasy team name
  savedAt: string;
}

export interface ManagerRef {
  entryId?: number | string | null;
  entry?: number | string | null;
  name?: string | null;
}

const norm = (s: string | null | undefined): string => (s || '').trim().toLowerCase();

/**
 * Match a rendered manager reference against the stored identity.
 *
 * Rules:
 * 1. Not logged in → false.
 * 2. Ref carries an entry/entryId → numeric compare and STOP — never fall
 *    through to names when an id exists (prevents duplicate-name false
 *    positives).
 * 3. Name fallback (normalised) — the only path for hall-of-fame records
 *    (name-keyed by design) and archived-season payloads that predate the
 *    entryId fields.
 */
export function isMyTeam(me: MyTeam | null | undefined, ref: ManagerRef | string | null | undefined): boolean {
  if (!me || !ref) return false;
  if (typeof ref === 'string') return norm(ref) === norm(me.name);

  const id = ref.entryId ?? ref.entry;
  if (id !== undefined && id !== null && id !== '') {
    return Number(id) === me.entryId;
  }
  return !!ref.name && norm(ref.name) === norm(me.name);
}

export function loadMyTeam(): MyTeam | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(MY_TEAM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MyTeam;
    if (typeof parsed?.entryId !== 'number' || !parsed?.name) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveMyTeam(team: Pick<MyTeam, 'entryId' | 'name' | 'team'>): MyTeam {
  const value: MyTeam = { ...team, savedAt: new Date().toISOString() };
  window.localStorage.setItem(MY_TEAM_STORAGE_KEY, JSON.stringify(value));
  return value;
}

export function clearMyTeam(): void {
  window.localStorage.removeItem(MY_TEAM_STORAGE_KEY);
}
