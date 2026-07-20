/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { dataCache } from '../data-cache';
import { fetchBootstrap, fetchFixtures, fetchLeagueData, fetchManagerHistory, getCompletedGameweeks } from '../fpl/client';

/**
 * Form table — league rankings over last N completed gameweeks.
 * Transliteration of the inline '/api/form' handler from
 * legacy/server.js (:7771-7930), including its formResultsCache
 * usage on dataCache (60s TTL).
 *
 * @param weeks Clamped window size (route parses/clamps the query param)
 * @param asof  Optional GW to end the window at (null when not specified)
 */
export async function fetchFormData(weeks: number, asof: number | null): Promise<any> {
  // Cache key includes asof when specified
  const cacheKey = asof ? `${weeks}_asof${asof}` : weeks;

  // Check server-side cache (60s TTL)
  const cached = dataCache.formResultsCache[cacheKey as any];
  if (cached && (Date.now() - cached.ts) < 60000) {
    return cached.data;
  }

  const [leagueData, bootstrap, fixtures] = await Promise.all([
    fetchLeagueData(),
    fetchBootstrap(),
    fetchFixtures(),
  ]);

  let completedGWs = getCompletedGameweeks(bootstrap, fixtures);

  // If asof is specified, only consider GWs up to and including that GW
  if (asof && !isNaN(asof) && asof >= 1) {
    completedGWs = completedGWs.filter((gw) => gw <= asof);
  }

  if (completedGWs.length === 0) {
    const result = { leagueName: leagueData.league.name, form: [], weeks, totalCompleted: 0, gwRange: [], asOfGW: asof || null };
    dataCache.formResultsCache[cacheKey as any] = { data: result, ts: Date.now() };
    return result;
  }

  // Take the last N completed gameweeks (ending at asof if specified)
  const targetGWs = completedGWs.slice(-weeks);
  const managers = leagueData.standings.results;

  const firstGWInRange = targetGWs[0];
  const lastGWInRange = targetGWs[targetGWs.length - 1];

  const formData: any[] = await Promise.all(
    managers.map(async (m: any) => {
      const history = await fetchManagerHistory(m.entry);
      const gwData = history.current.filter((gw: any) => targetGWs.includes(gw.event));

      const transfers = gwData.reduce((sum: number, gw: any) => sum + gw.event_transfers, 0);
      const transferCost = gwData.reduce((sum: number, gw: any) => sum + gw.event_transfers_cost, 0);

      // Derive net from FPL's cumulative total_points delta across
      // the window. total_points is always net of hits, so this
      // doesn't rely on whether gw.points is gross or net.
      const lastEntry = history.current.find((h: any) => h.event === lastGWInRange);
      const prevEntry = history.current.find((h: any) => h.event === firstGWInRange - 1);
      const netScore = (lastEntry?.total_points || 0) - (prevEntry?.total_points || 0);
      const grossScore = netScore + transferCost;

      return {
        entryId: m.entry,
        name: m.player_name,
        team: m.entry_name,
        grossScore,
        transfers,
        transferCost,
        netScore,
      };
    }),
  );

  // Rank by net score descending
  formData.sort((a, b) => b.netScore - a.netScore);
  formData.forEach((m, i) => (m.rank = i + 1));

  const result = {
    leagueName: leagueData.league.name,
    form: formData,
    weeks,
    totalCompleted: completedGWs.length,
    gwRange: targetGWs,
    asOfGW: asof || null,
  };

  // Store in server-side cache
  dataCache.formResultsCache[cacheKey as any] = { data: result, ts: Date.now() };

  return result;
}
