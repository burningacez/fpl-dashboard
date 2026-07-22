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
}

export interface StandingsAsOfGW {
  leagueName: string;
  standings: StandingRow[];
  asOfGW: number;
}

/**
 * Season standings as of the end of a gameweek — the source the Standings view
 * uses for historical cumulative totals. `netScore` anchors to FPL's cumulative
 * `total_points` at that GW (already net of hits); rank is by netScore. Cached
 * for 60s so repeated GW navigation and the week-history enrichment share work.
 */
export async function fetchStandingsAsOfGW(gw: number): Promise<StandingsAsOfGW> {
  const cacheKey = `standingsHistory_${gw}`;
  const cached = (dataCache as any)[cacheKey];
  if (cached && Date.now() - cached.ts < 60000) return cached.data;

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

  const data: StandingsAsOfGW = { leagueName: leagueData.league.name, standings, asOfGW: gw };
  (dataCache as any)[cacheKey] = { data, ts: Date.now() };
  return data;
}
