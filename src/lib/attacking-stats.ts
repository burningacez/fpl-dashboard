/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Goals and assists scored by a manager's counting players.
 *
 * From 2026-27 these are tiebreakers on all three money paths (weekly loser,
 * MotM, final standings) and badges on the scores table, so one definition of
 * "what counts" lives here rather than three:
 *
 *  - the effective XI only — auto-subs in, subbed-out starters out, and all 15
 *    under Bench Boost (the same `counts` rule the scoring core applies);
 *  - raw event counts, never multiplied — a captain's goal counts once;
 *  - doubles included: a DGW player's two goals both count.
 *
 * Two readers, because the two callers hold different data. Completed
 * gameweeks come from the processed-picks payload (persisted, so it survives
 * the July API reset); a live gameweek comes from the scoring core's players
 * plus the live element map (aggregated per GW by FPL, so DGW-safe).
 */

export interface AttackingStats {
  goals: number;
  assists: number;
}

export const NO_ATTACKING: AttackingStats = { goals: 0, assists: 0 };

export function addAttacking(a: AttackingStats, b: AttackingStats): AttackingStats {
  return { goals: a.goals + b.goals, assists: a.assists + b.assists };
}

export function sumAttacking(items: Iterable<AttackingStats>): AttackingStats {
  let goals = 0;
  let assists = 0;
  for (const item of items) {
    goals += item?.goals || 0;
    assists += item?.assists || 0;
  }
  return { goals, assists };
}

/**
 * Does this player's return count towards the manager's gameweek score?
 *
 * Mirrors scoreSquad's `counts` flag. The enriched picks payload doesn't carry
 * that flag (it rebuilds its own player objects), but it does carry the three
 * inputs it's derived from — isBench, subIn/subOut and the active chip.
 */
function counts(player: any, isBenchBoost: boolean): boolean {
  const benchNotSubbedIn = !!player.isBench && !player.subIn;
  return (!player.isBench && !player.subOut) || !!player.subIn || (isBenchBoost && benchNotSubbedIn);
}

/**
 * Goals and assists from a fetchManagerPicksDetailed payload.
 *
 * pointsBreakdown carries one entry per stat *per fixture* (FPL's explain
 * array is fixture-keyed), so entries are summed rather than found — a double
 * gameweek would otherwise report only the first fixture's goals.
 */
export function attackingFromDetailedPicks(detailed: any): AttackingStats {
  const players: any[] = detailed?.players ?? [];
  if (players.length === 0) return { ...NO_ATTACKING };
  const isBenchBoost = detailed?.activeChip === 'bboost';

  let goals = 0;
  let assists = 0;
  for (const player of players) {
    if (!counts(player, isBenchBoost)) continue;
    for (const item of player.pointsBreakdown ?? []) {
      if (typeof item?.value !== 'number') continue;
      if (item.identifier === 'goals_scored') goals += item.value;
      else if (item.identifier === 'assists') assists += item.value;
    }
  }
  return { goals, assists };
}

/**
 * Goals and assists for an in-progress gameweek, from the scoring core's
 * players (which carry the resolved `counts` flag) and FPL's live element
 * list. Live element stats are already aggregated across a DGW's fixtures.
 */
export function attackingFromLive(scoredPlayers: any[] | null | undefined, liveData: any): AttackingStats {
  const elements: any[] = liveData?.elements ?? [];
  if (!scoredPlayers?.length || elements.length === 0) return { ...NO_ATTACKING };

  const statsById = new Map<number, any>();
  for (const el of elements) statsById.set(el.id, el.stats);

  let goals = 0;
  let assists = 0;
  for (const player of scoredPlayers) {
    // scoreSquad resolves `counts` itself; fall back to the derived rule for
    // callers that hand over enriched (picks-shaped) players instead.
    const included = player.counts !== undefined ? !!player.counts : counts(player, false);
    if (!included) continue;
    const stats = statsById.get(player.id);
    if (!stats) continue;
    goals += stats.goals_scored || 0;
    assists += stats.assists || 0;
  }
  return { goals, assists };
}
