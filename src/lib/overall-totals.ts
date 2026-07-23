/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Cumulative "Total" (overall points) + rank for the week-by-week views.
 *
 * These values are MATERIALISED once — when a gameweek concludes and its week
 * history is built, and as a one-time backfill when an older snapshot loads —
 * then stored statically in the cache/archive. Past-week reads are pure
 * lookups: the app never re-sums or re-fetches a completed gameweek at request
 * time. That's why this lives in lib with no server/data-cache dependencies:
 * it operates purely on the plain week-history object it's handed.
 */

/**
 * Write each manager's running season total + rank onto every gameweek in a
 * week-history map, IN PLACE.
 *
 * The total is the running sum of each manager's net `gwScore` — the same value
 * the GW column already shows — so the Total column is self-consistent and
 * needs no live FPL data (it survives the July API reset). When
 * `opts.finalStandings` is provided, the final gameweek is overridden with the
 * authoritative end-of-season standings (what the league table and prizes key
 * off), still stored as a static value.
 *
 * `weekHistory` maps GW number → { managers: [{ entryId, gwScore }] } — the
 * shape of dataCache.weekHistoryCache and the season archive's weekHistory.
 * Returns true if it wrote anything (so callers can persist a backfill once).
 */
export function bakeOverallTotals(
  weekHistory: Record<string, any> | null | undefined,
  opts: { finalGW?: number | null; finalStandings?: any[] | null } = {},
): boolean {
  if (!weekHistory) return false;

  const gws = Object.keys(weekHistory)
    .map(Number)
    .filter((g) => Number.isFinite(g))
    .sort((a, b) => a - b);
  if (gws.length === 0) return false;

  const finalGW = opts.finalGW ?? gws[gws.length - 1];
  const finalById = new Map<number, any>(
    (opts.finalStandings ?? []).map((s: any) => [s.entryId, s]),
  );

  const running = new Map<number, number>();
  let wrote = false;

  for (const g of gws) {
    const managers: any[] = weekHistory[g]?.managers ?? [];
    for (const m of managers) {
      if (m?.entryId == null) continue;
      running.set(m.entryId, (running.get(m.entryId) ?? 0) + (m.gwScore ?? 0));
    }

    // Rank this GW's managers by their running total (desc).
    const rankById = new Map<number, number>();
    [...managers]
      .filter((m) => m?.entryId != null)
      .sort((a, b) => (running.get(b.entryId) ?? 0) - (running.get(a.entryId) ?? 0))
      .forEach((m, i) => rankById.set(m.entryId, i + 1));

    for (const m of managers) {
      if (m?.entryId == null) continue;
      const final = g === finalGW ? finalById.get(m.entryId) : null;
      m.overallPoints = final ? final.netScore : running.get(m.entryId) ?? 0;
      m.overallRank = final ? final.rank : rankById.get(m.entryId) ?? 0;
      wrote = true;
    }
  }

  return wrote;
}
