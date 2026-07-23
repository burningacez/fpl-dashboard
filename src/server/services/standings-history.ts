/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { dataCache } from '@/server/data-cache';
import { fetchLeagueData, fetchManagerHistory } from '@/server/fpl/client';

export interface StandingRow {
  entryId: number;
  name: string;
  team: string;
  grossScore: number;
  totalTransfers: number;
  transferCost: number;
  netScore: number;
  teamValue: string;
  rank: number;
  /** Rank change vs the previous GW (positive = up). Only set by the cache path. */
  movement?: number;
}

export interface StandingsAsOfGW {
  leagueName: string;
  standings: StandingRow[];
  asOfGW: number;
}

/**
 * Standings as of a gameweek built purely from the materialised week-history
 * cache — completed gameweeks are read-only, so this is a static lookup with no
 * FPL API call. Returns null when the GW isn't in the cache (caller falls back
 * to the live computation for a not-yet-materialised gameweek).
 *
 * netScore/rank come from the baked cumulative Total; grossScore, transfers and
 * cost are the running sums of the stored per-GW values; teamValue is that GW's
 * stored squad value; movement compares the baked rank against the prior GW.
 */
function standingsAsOfGWFromCache(gw: number): StandingsAsOfGW | null {
  const cache = dataCache.weekHistoryCache || {};
  if (!cache[gw]?.managers?.length) return null;

  const gws = Object.keys(cache)
    .map(Number)
    .filter((g) => Number.isFinite(g) && g <= gw)
    .sort((a, b) => a - b);

  const acc = new Map<number, any>();
  for (const g of gws) {
    for (const m of cache[g]?.managers ?? []) {
      if (m?.entryId == null) continue;
      const row = acc.get(m.entryId) ?? {
        entryId: m.entryId,
        name: m.name,
        team: m.team,
        grossScore: 0,
        totalTransfers: 0,
        transferCost: 0,
        netScore: 0,
        teamValue: '100.0',
        rank: 0,
      };
      row.transferCost += m.transferCost ?? 0;
      row.totalTransfers += m.transfers ?? 0;
      if (g === gw) {
        // Values from the requested GW: cumulative Total (baked) and that GW's
        // squad value and rank.
        row.netScore = m.overallPoints ?? 0;
        row.rank = m.overallRank ?? 0;
        row.prevRank = cache[gw - 1]?.managers?.find((x: any) => x.entryId === m.entryId)?.overallRank;
        if (m.teamValue) row.teamValue = m.teamValue;
      }
      acc.set(m.entryId, row);
    }
  }

  const standings: StandingRow[] = [...acc.values()].map((r) => {
    r.grossScore = r.netScore + r.transferCost;
    // Legacy sign convention: positive = moved up the table.
    r.movement = r.prevRank != null ? r.prevRank - r.rank : 0;
    return r;
  });
  standings.sort((a, b) => a.rank - b.rank);

  const leagueName = dataCache.league?.league?.name ?? '';
  return { leagueName, standings, asOfGW: gw };
}

/**
 * Season standings as of the end of a gameweek — the source the Standings view
 * uses for historical cumulative totals. Served from the materialised cache
 * (static, no API) for completed gameweeks; only a gameweek not yet in the
 * cache falls through to the live computation below.
 */
export async function fetchStandingsAsOfGW(gw: number): Promise<StandingsAsOfGW> {
  const cacheKey = `standingsHistory_${gw}`;
  const cached = (dataCache as any)[cacheKey];
  if (cached && Date.now() - cached.ts < 60000) return cached.data;

  const fromCache = standingsAsOfGWFromCache(gw);
  if (fromCache) {
    (dataCache as any)[cacheKey] = { data: fromCache, ts: Date.now() };
    return fromCache;
  }

  const leagueData = await fetchLeagueData();
  const managers = leagueData.standings.results;

  const standings: StandingRow[] = await Promise.all(
    managers.map(async (m: any) => {
      const history = await fetchManagerHistory(m.entry);
      const gwData = history.current.filter((h: any) => h.event <= gw);
      const totalTransfers = gwData.reduce((sum: number, h: any) => sum + h.event_transfers, 0);
      const transferCost = gwData.reduce((sum: number, h: any) => sum + h.event_transfers_cost, 0);

      // Anchor to FPL's cumulative total_points at the requested GW (always net
      // of hits) rather than summing gw.points and re-subtracting cost.
      const gwEntry = gwData[gwData.length - 1];
      const netScore = gwEntry?.total_points || 0;
      const grossScore = netScore + transferCost;
      const teamValue = gwEntry ? (gwEntry.value / 10).toFixed(1) : '100.0';

      return {
        entryId: m.entry,
        name: m.player_name,
        team: m.entry_name,
        grossScore,
        totalTransfers,
        transferCost,
        netScore,
        teamValue,
        rank: 0,
      };
    }),
  );

  standings.sort((a, b) => b.netScore - a.netScore);
  standings.forEach((s, i) => (s.rank = i + 1));

  const data: StandingsAsOfGW = { leagueName: leagueData?.league?.name ?? '', standings, asOfGW: gw };
  (dataCache as any)[cacheKey] = { data, ts: Date.now() };
  return data;
}
