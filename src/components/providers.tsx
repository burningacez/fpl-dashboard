'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  type MemberIdentity,
  type ManagerRef,
  type Member,
  loadIdentity,
  clearIdentity,
  loadVisitorFlag,
  setVisitorFlag,
  clearVisitorFlag,
  matchesRef,
} from '@/lib/identity';

export type { Member } from '@/lib/identity';

// =============================================================================
// Season selection — replaces legacy season-selector.js.
// Same localStorage key ('fpl-selected-season') for continuity: null = current.
// =============================================================================

const SEASON_STORAGE_KEY = 'fpl-selected-season';

export interface SeasonInfo {
  id: string;
  label: string;
  isCurrent: boolean;
}

interface SeasonContextValue {
  season: string | null; // null = current season
  seasons: SeasonInfo[];
  currentSeason: string | null;
  setSeason: (season: string | null) => void;
  /** Append ?season= to an API path when an archived season is selected. */
  withSeason: (url: string) => string;
}

const SeasonContext = createContext<SeasonContextValue | null>(null);

export function useSeason(): SeasonContextValue {
  const ctx = useContext(SeasonContext);
  if (!ctx) throw new Error('useSeason must be used within <Providers>');
  return ctx;
}

// =============================================================================
// Identity — "who are you?" (identification, not authentication)
// =============================================================================

/** Convenience view of a claimed member/ex-member (used for default-selection). */
export interface Me {
  entryId: number;
  name: string;
  team: string;
  nameKey: string;
}

export type IdentityStatus = 'loading' | 'unclaimed' | 'visitor' | 'member' | 'ex-member';

/** Result of a claim attempt — the modal uses `reason` to explain a refusal. */
export type ClaimResult = { ok: true } | { ok: false; reason?: 'taken' | 'locked' | 'error' };

interface IdentityContextValue {
  /**
   * Member-shaped identity for highlighting (present for member AND ex-member,
   * so archived tables still highlight ex-members by name). Null otherwise.
   */
  identity: MemberIdentity | null;
  /** Claimed team, if any (member or ex-member). Null for visitors / unclaimed. */
  me: Me | null;
  status: IdentityStatus;
  /** True once members have loaded and no identity has been claimed yet. */
  needsFirstRun: boolean;
  members: Member[];
  membersLoaded: boolean;
  /** Claimed a team but not in the current league (ex-member). */
  notInLeague: boolean;
  /** Claim a team (server-enforced single ownership). */
  claimTeam: (member: Member) => Promise<ClaimResult>;
  /** Decline to claim — browse as a visitor (client-side dismissal). */
  becomeVisitor: () => void;
  /** Enter the rotating admin code to release this device's claim and re-pick. */
  switchIdentity: (code: string) => Promise<boolean>;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function useMyTeam(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error('useMyTeam must be used within <Providers>');
  return ctx;
}

/**
 * Season-aware "is this me?" predicate. Returns a matcher that keys off the
 * currently-selected season: current season uses id-first matching, archived
 * seasons match by name (see matchesRef). Use this everywhere instead of
 * calling matchesRef directly so highlighting follows the season dropdown.
 */
export function useIsMe(): (ref: ManagerRef | string | null | undefined) => boolean {
  const { identity } = useMyTeam();
  const { season } = useSeason();
  return useCallback(
    (ref: ManagerRef | string | null | undefined) => matchesRef(identity, ref, { archived: season !== null }),
    [identity, season],
  );
}

// ---- server identity helpers (shape of /api/identity/me & /claim) ----

interface ServerIdentity {
  status: 'member' | 'ex-member' | 'unclaimed';
  entryId?: number;
  name?: string;
  team?: string;
  nameKey?: string;
  season?: string;
}

/** Build the member-shaped identity used for highlighting from a server reply. */
function toIdentity(r: ServerIdentity): MemberIdentity {
  return {
    v: 2,
    status: 'member',
    entryId: r.entryId ?? 0,
    name: r.name ?? '',
    nameKey: r.nameKey ?? '',
    team: r.team ?? '',
    season: r.season ?? '',
    claimedAt: '',
  };
}

type PostClaimResult =
  | { ok: true; body: ServerIdentity }
  | { ok: false; reason?: 'taken' | 'locked' | 'error' };

async function postClaim(entryId: number): Promise<PostClaimResult> {
  try {
    const r = await fetch('/api/identity/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryId }),
    });
    if (r.ok) return { ok: true, body: (await r.json()) as ServerIdentity };
    const data = await r.json().catch(() => ({}));
    return { ok: false, reason: (data.reason as 'taken' | 'locked') ?? 'error' };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

// =============================================================================
// Provider tree
// =============================================================================

export function Providers({ children }: { children: React.ReactNode }) {
  // ---- season ----
  const [season, setSeasonState] = useState<string | null>(null);
  const [seasons, setSeasons] = useState<SeasonInfo[]>([]);
  const [currentSeason, setCurrentSeason] = useState<string | null>(null);

  useEffect(() => {
    setSeasonState(window.localStorage.getItem(SEASON_STORAGE_KEY) || null);
    fetch('/api/seasons')
      .then((r) => r.json())
      .then((data) => {
        setSeasons(data.seasons || []);
        setCurrentSeason(data.currentSeason || null);
      })
      .catch((e) => console.error('Failed to fetch seasons:', e));
  }, []);

  const setSeason = useCallback((next: string | null) => {
    if (next) window.localStorage.setItem(SEASON_STORAGE_KEY, next);
    else window.localStorage.removeItem(SEASON_STORAGE_KEY);
    setSeasonState(next);
  }, []);

  const withSeason = useCallback(
    (url: string) => {
      if (!season) return url;
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}season=${season}`;
    },
    [season],
  );

  // ---- identity (server-enforced; see /api/identity/*) ----
  const [identity, setIdentity] = useState<MemberIdentity | null>(null);
  const [status, setStatus] = useState<IdentityStatus>('loading');
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);

  // Apply a /api/identity/me-shaped response to local state.
  const applyServerIdentity = useCallback((r: ServerIdentity): IdentityStatus => {
    if (r.status === 'member' || r.status === 'ex-member') {
      setIdentity(toIdentity(r));
      setStatus(r.status);
      return r.status;
    }
    setIdentity(null);
    // Unclaimed: honour a prior "just visiting" dismissal so we don't re-prompt.
    const visitor = loadVisitorFlag();
    setStatus(visitor ? 'visitor' : 'unclaimed');
    return visitor ? 'visitor' : 'unclaimed';
  }, []);

  useEffect(() => {
    // Members list (for the picker) and server identity load independently.
    fetch('/api/members')
      .then((r) => r.json())
      .then((data) => {
        setMembers(data.members || []);
        setMembersLoaded(true);
      })
      .catch((e) => console.error('Failed to fetch members:', e));

    (async () => {
      try {
        const r: ServerIdentity = await fetch('/api/identity/me').then((x) => x.json());
        const applied = applyServerIdentity(r);
        // One-time migration: grandfather a pre-existing localStorage identity
        // (from before server enforcement) into a server claim. First device to
        // do so wins; a conflict just leaves them unclaimed.
        if (applied === 'unclaimed') {
          const legacy = loadIdentity();
          if (legacy?.status === 'member') {
            const res = await postClaim(legacy.entryId);
            if (res.ok) applyServerIdentity(res.body);
            clearIdentity(); // consumed — the server is now the source of truth
          }
        }
      } catch (e) {
        console.error('Failed to load identity:', e);
        setStatus('unclaimed');
      }
    })();
  }, [applyServerIdentity]);

  const claimTeam = useCallback(
    async (member: Member): Promise<ClaimResult> => {
      const res = await postClaim(member.entryId);
      if (res.ok) {
        clearVisitorFlag();
        applyServerIdentity(res.body);
        return { ok: true };
      }
      return { ok: false, reason: res.reason };
    },
    [applyServerIdentity],
  );

  const becomeVisitor = useCallback(() => {
    setVisitorFlag();
    setIdentity(null);
    setStatus('visitor');
  }, []);

  const switchIdentity = useCallback(async (code: string): Promise<boolean> => {
    const r = await fetch('/api/identity/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!r.ok) return false;
    // Claim released + code rotated server-side. Drop to unclaimed so the
    // picker reopens for a fresh selection.
    clearVisitorFlag();
    setIdentity(null);
    setStatus('unclaimed');
    return true;
  }, []);

  const me = useMemo<Me | null>(
    () =>
      identity
        ? { entryId: identity.entryId, name: identity.name, team: identity.team, nameKey: identity.nameKey }
        : null,
    [identity],
  );
  const notInLeague = status === 'ex-member';
  const needsFirstRun = membersLoaded && status === 'unclaimed';

  const seasonValue = useMemo(
    () => ({ season, seasons, currentSeason, setSeason, withSeason }),
    [season, seasons, currentSeason, setSeason, withSeason],
  );
  const identityValue = useMemo(
    () => ({
      identity,
      me,
      status,
      needsFirstRun,
      members,
      membersLoaded,
      notInLeague,
      claimTeam,
      becomeVisitor,
      switchIdentity,
    }),
    [identity, me, status, needsFirstRun, members, membersLoaded, notInLeague, claimTeam, becomeVisitor, switchIdentity],
  );

  return (
    <SeasonContext.Provider value={seasonValue}>
      <IdentityContext.Provider value={identityValue}>{children}</IdentityContext.Provider>
    </SeasonContext.Provider>
  );
}
