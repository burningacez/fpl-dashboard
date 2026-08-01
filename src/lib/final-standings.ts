/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Final-standings ordering — the league table the prizes key off.
 *
 * Until 2026-27 the table was sorted on net total alone and equal totals were
 * left in whatever order they arrived in; the tiebreaker chain existed only on
 * the Rules page. From 2026-27 the chain is real and applied wherever the
 * table is ranked:
 *
 *   net total → most MotM wins → most goals → most assists →
 *   fewest weekly losses → fewest transfers → highest single GW →
 *   highest lowest GW → coin flip
 *
 * Pure and season-agnostic: callers pass `enabled` (from the season config) so
 * a completed season keeps the order it finished with, and pass their own
 * `fallback` so the disabled path is byte-identical to the old behaviour.
 */

import { NO_ATTACKING, addAttacking, type AttackingStats } from './attacking-stats';

/** MotM wins per entry id, counting only periods that actually completed. */
export function countMotmWins(motm: any): Map<number, number> {
  const wins = new Map<number, number>();
  for (const w of motm?.winners ?? []) {
    const entryId = w?.winner?.entryId;
    if (entryId == null) continue; // in-progress period — no winner yet
    wins.set(entryId, (wins.get(entryId) ?? 0) + 1);
  }
  return wins;
}

/** Weekly-loser fines per entry id (overrides included — the losers service
 *  has already applied them, so this counts who actually paid). */
export function countWeeklyLosses(losers: any): Map<number, number> {
  const counts = new Map<number, number>();
  for (const l of losers?.losers ?? []) {
    if (l?.entry == null) continue;
    counts.set(l.entry, (counts.get(l.entry) ?? 0) + 1);
  }
  return counts;
}

/**
 * Season goals/assists per entry id, summed from the losers payload — it
 * already holds every manager's numbers for every completed gameweek, and is
 * persisted, so nothing has to be recomputed or re-fetched here.
 */
export function seasonAttackingFromLosers(losers: any): Map<number, AttackingStats> {
  const totals = new Map<number, AttackingStats>();
  const allGameweeks = losers?.allGameweeks ?? {};
  for (const gw of Object.keys(allGameweeks)) {
    for (const m of allGameweeks[gw]?.managers ?? []) {
      if (m?.entry == null) continue;
      const prev = totals.get(m.entry) ?? NO_ATTACKING;
      totals.set(m.entry, addAttacking(prev, { goals: m.goals || 0, assists: m.assists || 0 }));
    }
  }
  return totals;
}

export interface RankFinalStandingsOptions {
  /** The primary sort value (net season total). */
  score: (row: any) => number;
  /** False for seasons played without the attacking tiebreakers. */
  enabled: boolean;
  /** Losers payload — supplies weekly losses and season goals/assists. */
  losers?: any;
  /** MotM payload — supplies period wins. */
  motm?: any;
  /** Period wins per entry id, when the caller has already counted them. */
  motmWins?: Map<number, number> | null;
  /**
   * Season goals/assists to use instead of the losers-derived totals. The
   * live week table passes these so an in-progress gameweek's goals are
   * already included.
   */
  attacking?: Map<number, AttackingStats> | null;
  /** Persistent per-manager flip; higher ranks first. Omit to skip. */
  coinFlip?: (row: any) => number;
  /** Applied when scores tie and the chain is off (or exhausted). */
  fallback?: (a: any, b: any) => number;
}

/**
 * Sorts `rows` in place, stamps the tiebreak inputs onto each row (so the UI
 * can show them without recomputing), and returns the same array.
 *
 * Ranks are NOT assigned here — callers own their rank field name.
 */
export function rankFinalStandings(rows: any[], opts: RankFinalStandingsOptions): any[] {
  const { score, enabled, fallback } = opts;

  if (enabled) {
    const motmWins = opts.motmWins ?? countMotmWins(opts.motm);
    const weeklyLosses = countWeeklyLosses(opts.losers);
    const attacking = opts.attacking ?? seasonAttackingFromLosers(opts.losers);
    for (const row of rows) {
      const att = attacking.get(row.entryId) ?? NO_ATTACKING;
      row.motmWins = motmWins.get(row.entryId) ?? 0;
      row.weeklyLosses = weeklyLosses.get(row.entryId) ?? 0;
      row.seasonGoals = att.goals;
      row.seasonAssists = att.assists;
    }
  }

  rows.sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    if (!enabled) return fallback ? fallback(a, b) : 0;

    if (b.motmWins !== a.motmWins) return b.motmWins - a.motmWins;
    if (b.seasonGoals !== a.seasonGoals) return b.seasonGoals - a.seasonGoals;
    if (b.seasonAssists !== a.seasonAssists) return b.seasonAssists - a.seasonAssists;
    if (a.weeklyLosses !== b.weeklyLosses) return a.weeklyLosses - b.weeklyLosses;

    const aTrf = a.totalTransfers ?? 0;
    const bTrf = b.totalTransfers ?? 0;
    if (aTrf !== bTrf) return aTrf - bTrf;

    const aHigh = a.highestGW ?? 0;
    const bHigh = b.highestGW ?? 0;
    if (bHigh !== aHigh) return bHigh - aHigh;

    const aLow = a.lowestGW ?? 0;
    const bLow = b.lowestGW ?? 0;
    if (bLow !== aLow) return bLow - aLow;

    if (opts.coinFlip) {
      const flip = opts.coinFlip(b) - opts.coinFlip(a);
      if (flip !== 0) return flip;
    }
    return fallback ? fallback(a, b) : 0;
  });

  return rows;
}
