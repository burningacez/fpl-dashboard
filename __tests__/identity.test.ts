import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MY_TEAM_STORAGE_KEY,
  normalizeNameKey,
  matchesRef,
  loadIdentity,
  resolveAgainstMembers,
  makeMemberIdentity,
  makeVisitorIdentity,
  decideClaim,
  applySwitch,
  findClaimForDevice,
  pickCode,
  SWITCH_CODE_ALPHABET,
  type ClaimRegistry,
  type MemberIdentity,
  type Member,
} from '../src/lib/identity';

// Minimal localStorage stub so the client-only helpers run in the node env.
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const mock = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
  vi.stubGlobal('window', { localStorage: mock });
  vi.stubGlobal('localStorage', mock);
}

const member = (over: Partial<MemberIdentity> = {}): MemberIdentity => ({
  v: 2,
  status: 'member',
  entryId: 100,
  name: 'Barry Smith',
  nameKey: 'barry smith',
  team: 'The Barries',
  season: '2025-26',
  claimedAt: '2025-08-01T00:00:00.000Z',
  ...over,
});

describe('normalizeNameKey', () => {
  it('trims, lower-cases, and collapses internal whitespace', () => {
    expect(normalizeNameKey('  Barry   Smith ')).toBe('barry smith');
    expect(normalizeNameKey('BARRY SMITH')).toBe('barry smith');
    expect(normalizeNameKey(null)).toBe('');
    expect(normalizeNameKey(undefined)).toBe('');
  });
});

describe('matchesRef — current season (archived: false)', () => {
  const me = member();
  it('matches on entry id', () => {
    expect(matchesRef(me, { entryId: 100, name: 'Someone Else' }, { archived: false })).toBe(true);
    expect(matchesRef(me, { entry: 100 }, { archived: false })).toBe(true);
    expect(matchesRef(me, { entryId: '100' }, { archived: false })).toBe(true);
  });
  it('does NOT fall through to name when the id mismatches', () => {
    // Same name, different (current-season) id → not me.
    expect(matchesRef(me, { entryId: 999, name: 'Barry Smith' }, { archived: false })).toBe(false);
  });
  it('falls back to name only when the ref carries no id', () => {
    expect(matchesRef(me, { name: 'Barry Smith' }, { archived: false })).toBe(true);
    expect(matchesRef(me, { name: 'barry   smith' }, { archived: false })).toBe(true);
    expect(matchesRef(me, { name: 'Someone Else' }, { archived: false })).toBe(false);
  });
  it('matches a bare string ref by name', () => {
    expect(matchesRef(me, 'Barry Smith', { archived: false })).toBe(true);
    expect(matchesRef(me, 'Nope', { archived: false })).toBe(false);
  });
  it('never matches for a visitor or null identity', () => {
    expect(matchesRef(makeVisitorIdentity(), { entryId: 100 }, { archived: false })).toBe(false);
    expect(matchesRef(null, { entryId: 100 }, { archived: false })).toBe(false);
    expect(matchesRef(me, null, { archived: false })).toBe(false);
  });
});

describe('matchesRef — archived season (archived: true)', () => {
  const me = member();
  it('ignores a stale entry id and matches on name', () => {
    // Archived row carries last season's id (different namespace) but same name.
    expect(matchesRef(me, { entryId: 555, name: 'Barry Smith' }, { archived: true })).toBe(true);
  });
  it('does not match a different manager who happens to reuse my old id', () => {
    expect(matchesRef(me, { entryId: 100, name: 'Other Person' }, { archived: true })).toBe(false);
  });
  it('normalises name for the archived match', () => {
    expect(matchesRef(me, { name: '  BARRY   smith ' }, { archived: true })).toBe(true);
  });
});

describe('loadIdentity — migration', () => {
  beforeEach(() => installLocalStorage());

  it('returns null when nothing is stored', () => {
    expect(loadIdentity()).toBeNull();
  });

  it('migrates a legacy v1 value into a locked member', () => {
    window.localStorage.setItem(
      MY_TEAM_STORAGE_KEY,
      JSON.stringify({ entryId: 42, name: 'Old Timer', team: 'Legends', savedAt: '2024-08-01T00:00:00.000Z' }),
    );
    const loaded = loadIdentity();
    expect(loaded).toMatchObject({
      v: 2,
      status: 'member',
      entryId: 42,
      name: 'Old Timer',
      nameKey: 'old timer',
      team: 'Legends',
      claimedAt: '2024-08-01T00:00:00.000Z',
    });
    // Re-persisted in v2 shape.
    expect(JSON.parse(window.localStorage.getItem(MY_TEAM_STORAGE_KEY)!).v).toBe(2);
  });

  it('loads a stored v2 member and visitor', () => {
    saveRoundTrip(member());
    expect(loadIdentity()).toMatchObject({ status: 'member', entryId: 100 });
    saveRoundTrip(makeVisitorIdentity());
    expect(loadIdentity()).toMatchObject({ status: 'visitor' });
  });

  it('returns null for garbage / partial values', () => {
    window.localStorage.setItem(MY_TEAM_STORAGE_KEY, 'not json');
    expect(loadIdentity()).toBeNull();
    window.localStorage.setItem(MY_TEAM_STORAGE_KEY, JSON.stringify({ foo: 'bar' }));
    expect(loadIdentity()).toBeNull();
  });

  function saveRoundTrip(v: unknown) {
    window.localStorage.setItem(MY_TEAM_STORAGE_KEY, JSON.stringify(v));
  }
});

describe('resolveAgainstMembers', () => {
  const members: Member[] = [
    { entryId: 100, name: 'Barry Smith', team: 'The Barries' },
    { entryId: 200, name: 'Jane Doe', team: 'Doe Ray Me' },
  ];

  it('unclaimed when no identity', () => {
    expect(resolveAgainstMembers(null, members, '2025-26')).toMatchObject({ status: 'unclaimed', changed: false });
  });

  it('passes a visitor through unchanged', () => {
    const v = makeVisitorIdentity();
    expect(resolveAgainstMembers(v, members, '2025-26')).toMatchObject({ status: 'visitor', changed: false });
  });

  it('matches by entry id and refreshes a renamed team/name', () => {
    const me = member({ entryId: 100, name: 'Barry Smith', team: 'Old Name' });
    const res = resolveAgainstMembers(me, members, '2025-26');
    expect(res.status).toBe('member');
    expect(res.changed).toBe(true);
    expect((res.identity as MemberIdentity).team).toBe('The Barries');
  });

  it('season rollover: no id hit, unique name match adopts the new entry id', () => {
    // Stored id is last season's; this season Barry has a new id.
    const me = member({ entryId: 999, name: 'Barry Smith', nameKey: 'barry smith' });
    const res = resolveAgainstMembers(me, members, '2026-27');
    expect(res.status).toBe('member');
    expect(res.changed).toBe(true);
    expect((res.identity as MemberIdentity).entryId).toBe(100);
    expect((res.identity as MemberIdentity).season).toBe('2026-27');
  });

  it('ex-member when no id and no name match; identity left untouched', () => {
    const me = member({ entryId: 999, name: 'Gone Fishing', nameKey: 'gone fishing' });
    const res = resolveAgainstMembers(me, members, '2026-27');
    expect(res.status).toBe('ex-member');
    expect(res.changed).toBe(false);
    expect(res.identity).toBe(me);
  });

  it('ex-member (not re-assigned) when the name is ambiguous', () => {
    const dupes: Member[] = [
      { entryId: 300, name: 'Sam Twin', team: 'A' },
      { entryId: 301, name: 'Sam Twin', team: 'B' },
    ];
    const me = member({ entryId: 999, name: 'Sam Twin', nameKey: 'sam twin' });
    const res = resolveAgainstMembers(me, dupes, '2026-27');
    expect(res.status).toBe('ex-member');
    expect(res.changed).toBe(false);
  });
});

describe('makeMemberIdentity', () => {
  it('derives nameKey and records the season', () => {
    const id = makeMemberIdentity({ entryId: 7, name: 'New Player', team: 'FC New' }, '2025-26');
    expect(id).toMatchObject({ v: 2, status: 'member', entryId: 7, nameKey: 'new player', season: '2025-26' });
  });
});

describe('decideClaim', () => {
  const barry: Member = { entryId: 100, name: 'Barry Smith', team: 'The Barries' };
  const jane: Member = { entryId: 200, name: 'Jane Doe', team: 'Doe Ray Me' };

  it('records a claim on an empty registry', () => {
    const res = decideClaim({}, 'dev-1', barry, '2025-26');
    expect(res.ok).toBe(true);
    expect(res.registry['barry smith']).toMatchObject({ entryId: 100, deviceToken: 'dev-1', nameKey: 'barry smith' });
    expect(res.record?.team).toBe('The Barries');
  });

  it('refuses "taken" when another device holds the team', () => {
    const reg: ClaimRegistry = decideClaim({}, 'dev-1', barry, '2025-26').registry;
    const res = decideClaim(reg, 'dev-2', barry, '2025-26');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('taken');
    expect(res.registry).toBe(reg); // unchanged
  });

  it('refuses "locked" when this device already holds a different team', () => {
    const reg = decideClaim({}, 'dev-1', barry, '2025-26').registry;
    const res = decideClaim(reg, 'dev-1', jane, '2025-26');
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('locked');
  });

  it('is idempotent when the same device re-claims its own team', () => {
    const reg = decideClaim({}, 'dev-1', barry, '2025-26').registry;
    const res = decideClaim(reg, 'dev-1', barry, '2025-26');
    // Same device, same team → not "taken"; it holds a claim so it's "locked".
    expect(res.reason).toBe('locked');
  });
});

describe('applySwitch / findClaimForDevice', () => {
  const barry: Member = { entryId: 100, name: 'Barry Smith', team: 'The Barries' };

  it('releases the device’s claim and reports what was freed', () => {
    const reg = decideClaim({}, 'dev-1', barry, '2025-26').registry;
    expect(findClaimForDevice(reg, 'dev-1')?.nameKey).toBe('barry smith');
    const res = applySwitch(reg, 'dev-1');
    expect(res.released).toBe('barry smith');
    expect(res.registry['barry smith']).toBeUndefined();
    expect(findClaimForDevice(res.registry, 'dev-1')).toBeNull();
  });

  it('is a no-op when the device holds nothing', () => {
    const res = applySwitch({}, 'dev-x');
    expect(res.released).toBeNull();
  });
});

describe('pickCode', () => {
  it('produces a code of the requested length from the alphabet', () => {
    const code = pickCode(() => 0, 6);
    expect(code).toBe('AAAAAA');
    expect(code).toHaveLength(6);
  });

  it('only ever emits unambiguous characters', () => {
    let i = 0;
    const code = pickCode((max) => i++ % max, 32);
    expect([...code].every((c) => SWITCH_CODE_ALPHABET.includes(c))).toBe(true);
    expect(/[O0I1]/.test(SWITCH_CODE_ALPHABET)).toBe(false);
  });
});
