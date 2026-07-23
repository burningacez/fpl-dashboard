/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { dataCache } from '../data-cache';
import { fetchBootstrap, fetchFixtures, fetchLeagueData, fetchManagerHistory, getCompletedGameweeks } from '../fpl/client';

/**
 * Form table — league rankings over the last N completed gameweeks.
 *
 * Completed gameweeks are read-only, so the form is served from the
 * materialised week-history cache (each manager's stored per-GW net score,
 * transfer cost and transfer count). This needs no live FPL API and keeps
 * working through the July season reset. Only when nothing has been
 * materialised yet — e.g. the very start of a season, before the first GW is
 * built into the cache — do we fall back to computing it live this once.
 *
 * @param weeks Clamped window size (route parses/clamps the query param)
 * @param asof  Optional GW to end the window at (null when not specified)
 */
export async function fetchFormData(weeks: number, asof: number | null): Promise<any> {
  // Cache key includes asof when specified
  const cacheKey = asof ? `${weeks}_asof${asof}` : weeks;

  // Check server-side cache (60s TTL)
  const cached = dataCache.formResultsCache[cacheKey as any];
  if (cached && Date.now() - cached.ts < 60000) {
    return cached.data;
  }

  // Static path: derive the form purely from the stored per-GW week history.
  const fromCache = formFromWeekHistory(weeks, asof);
  if (fromCache) {
    dataCache.formResultsCache[cacheKey as any] = { data: fromCache, ts: Date.now() };
    return fromCache;
  }

  // Fallback: nothing materialised yet — compute live this once.
  const result = await fetchFormDataLive(weeks, asof);
  dataCache.formResultsCache[cacheKey as any] = { data: result, ts: Date.now() };
  return result;
}

/**
 * Build the form table from the materialised week-history cache. Returns null
 * when the cache holds no completed gameweeks (caller falls back to live).
 */
function formFromWeekHistory(weeks: number, asof: number | null): any | null {
  const cache = dataCache.weekHistoryCache || {};
  let completedGWs = Object.keys(cache)
    .map(Number)
    .filter((g) => Number.isFinite(g))
    .sort((a, b) => a - b);

  if (asof && !isNaN(asof) && asof >= 1) {
    completedGWs = completedGWs.filter((gw) => gw <= asof);
  }
  if (completedGWs.length === 0) return null;

  const leagueName = dataCache.league?.league?.name ?? '';
  const targetGWs = completedGWs.slice(-weeks);

  // Accumulate each manager's net score, transfer cost and transfer count
  // across the window from the stored per-GW rows.
  const byId = new Map<number, any>();
  for (const gw of targetGWs) {
    for (const m of cache[gw]?.managers ?? []) {
      if (m?.entryId == null) continue;
      const row = byId.get(m.entryId) ?? {
        entryId: m.entryId,
        name: m.name,
        team: m.team,
        grossScore: 0,
        transfers: 0,
        transferCost: 0,
        netScore: 0,
      };
      row.netScore += m.gwScore ?? 0;
      row.transferCost += m.transferCost ?? 0;
      row.transfers += m.transfers ?? 0;
      byId.set(m.entryId, row);
    }
  }

  const form = [...byId.values()].map((r) => ({ ...r, grossScore: r.netScore + r.transferCost }));
  form.sort((a, b) => b.netScore - a.netScore);
  form.forEach((m, i) => (m.rank = i + 1));

  return {
    leagueName,
    form,
    weeks,
    totalCompleted: completedGWs.length,
    gwRange: targetGWs,
    asOfGW: asof || null,
  };
}

/**
 * Live computation from the FPL API — the bootstrap path used only before any
 * gameweek has been materialised into the cache. Transliteration of the inline
 * '/api/form' handler from legacy/server.js (:7771-7930).
 */
async function fetchFormDataLive(weeks: number, asof: number | null): Promise<any> {
  const [leagueData, bootstrap, fixtures] = await Promise.all([
    fetchLeagueData(),
    fetchBootstrap(),
    fetchFixtures(),
  ]);

  let completedGWs = getCompletedGameweeks(bootstrap, fixtures);
  if (asof && !isNaN(asof) && asof >= 1) {
    completedGWs = completedGWs.filter((gw) => gw <= asof);
  }

  const leagueName = leagueData?.league?.name ?? '';

  if (completedGWs.length === 0) {
    return { leagueName, form: [], weeks, totalCompleted: 0, gwRange: [], asOfGW: asof || null };
  }

  const targetGWs = completedGWs.slice(-weeks);
  const managers = leagueData?.standings?.results ?? [];
  const firstGWInRange = targetGWs[0];
  const lastGWInRange = targetGWs[targetGWs.length - 1];

  const formData: any[] = await Promise.all(
    managers.map(async (m: any) => {
      // Guard each manager independently: a single failed/absent history must
      // not 500 the whole table — that manager just shows zeroes.
      try {
        const history = await fetchManagerHistory(m.entry);
        const current = history?.current ?? [];
        const gwData = current.filter((gw: any) => targetGWs.includes(gw.event));

        const transfers = gwData.reduce((sum: number, gw: any) => sum + gw.event_transfers, 0);
        const transferCost = gwData.reduce((sum: number, gw: any) => sum + gw.event_transfers_cost, 0);

        // Derive net from FPL's cumulative total_points delta across the window.
        const lastEntry = current.find((h: any) => h.event === lastGWInRange);
        const prevEntry = current.find((h: any) => h.event === firstGWInRange - 1);
        const netScore = (lastEntry?.total_points || 0) - (prevEntry?.total_points || 0);
        const grossScore = netScore + transferCost;

        return { entryId: m.entry, name: m.player_name, team: m.entry_name, grossScore, transfers, transferCost, netScore };
      } catch {
        return { entryId: m.entry, name: m.player_name, team: m.entry_name, grossScore: 0, transfers: 0, transferCost: 0, netScore: 0 };
      }
    }),
  );

  formData.sort((a, b) => b.netScore - a.netScore);
  formData.forEach((m, i) => (m.rank = i + 1));

  return {
    leagueName,
    form: formData,
    weeks,
    totalCompleted: completedGWs.length,
    gwRange: targetGWs,
    asOfGW: asof || null,
  };
}
