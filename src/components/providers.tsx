'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  type StoredIdentity,
  type ManagerRef,
  type Member,
  loadIdentity,
  saveIdentity,
  makeMemberIdentity,
  makeVisitorIdentity,
  matchesRef,
  resolveAgainstMembers,
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

interface IdentityContextValue {
  identity: StoredIdentity | null;
  /** Claimed team, if any (member or ex-member). Null for visitors / unclaimed. */
  me: Me | null;
  status: IdentityStatus;
  /** True once members have loaded and no identity has been claimed yet. */
  needsFirstRun: boolean;
  members: Member[];
  membersLoaded: boolean;
  /** Claimed a team but not in the current league (ex-member). */
  notInLeague: boolean;
  /** Permanently claim a team. No-op once already a member (lock). */
  claimTeam: (member: Member) => void;
  /** Decline to claim — browse as a visitor. */
  becomeVisitor: () => void;
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

  // ---- identity ----
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [status, setStatus] = useState<IdentityStatus>('loading');
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);
  // Latest current season, read inside the members effect without re-running it.
  const currentSeasonRef = useRef<string | null>(null);
  currentSeasonRef.current = currentSeason;

  useEffect(() => {
    const stored = loadIdentity();
    setIdentity(stored);
    fetch('/api/members')
      .then((r) => r.json())
      .then((data) => {
        const list: Member[] = data.members || [];
        setMembers(list);
        setMembersLoaded(true);
        const resolved = resolveAgainstMembers(stored, list, currentSeasonRef.current);
        if (resolved.changed && resolved.identity) saveIdentity(resolved.identity);
        setIdentity(resolved.identity);
        setStatus(resolved.status === 'unclaimed' ? 'unclaimed' : resolved.status);
      })
      .catch((e) => console.error('Failed to fetch members:', e));
  }, []);

  const claimTeam = useCallback((member: Member) => {
    // Lock: once a member, the choice is permanent on this device.
    setIdentity((prev) => {
      if (prev?.status === 'member') {
        console.warn('[identity] already claimed — ignoring re-claim');
        return prev;
      }
      const next = makeMemberIdentity(member, currentSeasonRef.current);
      saveIdentity(next);
      setStatus('member');
      return next;
    });
  }, []);

  const becomeVisitor = useCallback(() => {
    setIdentity((prev) => {
      if (prev?.status === 'member') return prev; // never downgrade a locked member
      const next = makeVisitorIdentity();
      saveIdentity(next);
      setStatus('visitor');
      return next;
    });
  }, []);

  const me = useMemo<Me | null>(
    () =>
      identity?.status === 'member'
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
    () => ({ identity, me, status, needsFirstRun, members, membersLoaded, notInLeague, claimTeam, becomeVisitor }),
    [identity, me, status, needsFirstRun, members, membersLoaded, notInLeague, claimTeam, becomeVisitor],
  );

  return (
    <SeasonContext.Provider value={seasonValue}>
      <IdentityContext.Provider value={identityValue}>{children}</IdentityContext.Provider>
    </SeasonContext.Provider>
  );
}
