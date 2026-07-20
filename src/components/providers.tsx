'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  type MyTeam,
  loadMyTeam,
  saveMyTeam as persistMyTeam,
  clearMyTeam as wipeMyTeam,
} from '@/lib/identity';

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

export interface Member {
  entryId: number;
  name: string;
  team: string;
}

interface IdentityContextValue {
  me: MyTeam | null;
  members: Member[];
  membersLoaded: boolean;
  /** Stored identity no longer matches a current league member. */
  notInLeague: boolean;
  login: (member: Member) => void;
  logout: () => void;
}

const IdentityContext = createContext<IdentityContextValue | null>(null);

export function useMyTeam(): IdentityContextValue {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error('useMyTeam must be used within <Providers>');
  return ctx;
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
  const [me, setMe] = useState<MyTeam | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoaded, setMembersLoaded] = useState(false);

  useEffect(() => {
    const stored = loadMyTeam();
    setMe(stored);
    fetch('/api/members')
      .then((r) => r.json())
      .then((data) => {
        const list: Member[] = data.members || [];
        setMembers(list);
        setMembersLoaded(true);
        // Self-heal: entryId is the stable key — refresh stored name/team if
        // the manager renamed themselves or their FPL team.
        if (stored) {
          const match = list.find((m) => m.entryId === stored.entryId);
          if (match && (match.name !== stored.name || match.team !== stored.team)) {
            setMe(persistMyTeam(match));
          }
        }
      })
      .catch((e) => console.error('Failed to fetch members:', e));
  }, []);

  const login = useCallback((member: Member) => {
    setMe(persistMyTeam(member));
  }, []);

  const logout = useCallback(() => {
    wipeMyTeam();
    setMe(null);
  }, []);

  const notInLeague = useMemo(
    () => Boolean(me && membersLoaded && !members.some((m) => m.entryId === me.entryId)),
    [me, members, membersLoaded],
  );

  const seasonValue = useMemo(
    () => ({ season, seasons, currentSeason, setSeason, withSeason }),
    [season, seasons, currentSeason, setSeason, withSeason],
  );
  const identityValue = useMemo(
    () => ({ me, members, membersLoaded, notInLeague, login, logout }),
    [me, members, membersLoaded, notInLeague, login, logout],
  );

  return (
    <SeasonContext.Provider value={seasonValue}>
      <IdentityContext.Provider value={identityValue}>{children}</IdentityContext.Provider>
    </SeasonContext.Provider>
  );
}
