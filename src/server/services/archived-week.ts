/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { getSeasonData } from '../data-cache';

/**
 * Serve /api/week and /api/week/history for an archived season from the
 * snapshot's per-GW week history (season-{s}:weeks). No FPL API, no SSE —
 * the payload mirrors the weekHistoryCache shape the week page already
 * renders for past gameweeks, plus archived/availableGWs metadata so the
 * client can bound its GW stepper.
 */
export function getArchivedWeek(season: string, gw?: number | null): any {
  const weekHistory = getSeasonData(season, 'weekHistory');
  if (!weekHistory) {
    return { error: 'Week-by-week data is not archived for this season', archived: true };
  }

  const availableGWs = Object.keys(weekHistory)
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (availableGWs.length === 0) {
    return { error: 'Week-by-week data is not archived for this season', archived: true };
  }

  const finalGW = getSeasonData(season, 'finalGW') ?? availableGWs[availableGWs.length - 1];
  const viewGW = gw ?? finalGW;
  const data = weekHistory[viewGW];
  if (!data) {
    return { error: `Gameweek ${viewGW} is not in the ${season} archive`, archived: true };
  }

  // The cumulative Total + rank are already materialised on each manager
  // (baked when the season was archived / when the snapshot loaded). Serving an
  // archived season is a pure lookup — no summing, no live FPL fetch.
  return {
    ...data,
    managers: data.managers || [],
    archived: true,
    currentGW: finalGW,
    viewingGW: viewGW,
    availableGWs,
  };
}
