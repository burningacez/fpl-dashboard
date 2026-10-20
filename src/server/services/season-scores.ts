/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

import { attackingFromDetailedPicks } from '../../lib/attacking-stats';

/**
 * The single definition of a manager's score for a gameweek.
 *
 * While a gameweek is live it is scored from picks + live data. Once it is
 * complete that result is written into the stored week history
 * (dataCache.weekHistoryCache, one row per manager per GW) and everything
 * season-long reads those rows back: the week page, form, H2H, profiles and
 * the Hall of Fame. Nothing re-derives a completed gameweek from FPL's
 * /entry/{id}/history feed, whose `points` is gross of hits and has been
 * known to miss Bench Boost points — that is how the Hall of Fame used to
 * disagree with the scores table about who won a week.
 */

/** League score for a GW from processed picks: gross incl. provisional bonus, minus hits. */
export function gwScoreFromPicks(processed: any): number {
    return (processed.calculatedPoints || 0)
        + (processed.totalProvisionalBonus || 0)
        - (processed.transfersCost || 0);
}

/** The stored week-history row for one manager, built from their processed picks. */
export function weekRowFromPicks(m: any, cached: any): any {
    // Prefer the originally-selected captain/VC. When the VC inherited the
    // armband, the post-resolve players array has isViceCaptain cleared on the
    // inheriting player, so a `find(p => p.isViceCaptain)` returns nothing —
    // the original names preserved on the cache entry survive.
    const captainName = cached.originalCaptainName
        ?? cached.players?.find((p: any) => p.isCaptain)?.name
        ?? null;
    const viceCaptainName = cached.originalViceCaptainName
        ?? cached.players?.find((p: any) => p.isViceCaptain)?.name
        ?? null;
    // Effective captain (after VC inheritance) and their multiplied points,
    // stored so H2H and the chip awards compare captaincy statically.
    const effCaptain = (cached.players || []).find((p: any) => p.isCaptain);
    const captainPoints = effCaptain ? (effCaptain.points || 0) * (effCaptain.multiplier || 1) : 0;
    const starting11 = (cached.players || []).filter((p: any) => !p.isBench).map((p: any) => p.id);
    const benchPlayerIds = (cached.players || []).filter((p: any) => p.isBench).map((p: any) => p.id);
    const attacking = attackingFromDetailedPicks(cached);

    return {
        name: m.player_name,
        team: m.entry_name,
        entryId: m.entry,
        gwScore: gwScoreFromPicks(cached),
        benchPoints: cached.pointsOnBench || 0,
        activeChip: cached.activeChip || null,
        captainName,
        captainPoints,
        effectiveCaptainName: effCaptain?.name ?? null,
        viceCaptainName,
        starting11,
        benchPlayerIds,
        transferCost: cached.transfersCost || 0,
        transfers: cached.transfers || 0,
        teamValue: cached.teamValue || null,
        gwGoals: attacking.goals,
        gwAssists: attacking.assists,
        autoSubsIn: (cached.autoSubs || []).map((s: any) => s.in?.id).filter(Boolean),
        autoSubsOut: (cached.autoSubs || []).map((s: any) => s.out?.id).filter(Boolean)
    };
}

export interface StoredGameweek {
    event: number;
    /** Net league score: what the scores table shows for the week. */
    score: number;
    transferCost: number;
    transfers: number;
    /** Points left on the bench (under Bench Boost: what the bench scored). */
    benchPoints: number;
    /** Squad value in tenths (1000 = £100.0m), or null when unknown. */
    teamValue: number | null;
    chip: string | null;
    /** Effective captain's points before the multiplier. */
    captainBasePoints: number;
    captainName: string | null;
    goals: number;
    assists: number;
}

export interface StoredManagerSeason {
    entryId: number;
    name: string;
    team: string;
    gameweeks: StoredGameweek[];
}

function toStoredGameweek(gw: number, row: any): StoredGameweek {
    const value = row.teamValue != null ? Math.round(parseFloat(row.teamValue) * 10) : null;
    const captainMultiplier = row.activeChip === '3xc' ? 3 : 2;
    return {
        event: gw,
        score: row.gwScore ?? 0,
        transferCost: row.transferCost ?? 0,
        transfers: row.transfers ?? 0,
        benchPoints: row.benchPoints ?? 0,
        teamValue: Number.isFinite(value) ? value : null,
        chip: row.activeChip ?? null,
        captainBasePoints: (row.captainPoints ?? 0) / captainMultiplier,
        captainName: row.effectiveCaptainName ?? row.captainName ?? null,
        goals: row.gwGoals ?? 0,
        assists: row.gwAssists ?? 0,
    };
}

/**
 * Every manager's completed gameweeks, read from the stored week history.
 * `managers` is the league standings list (seeds everyone, even a manager
 * with no stored rows yet); `completedGWs` limits it to finished weeks.
 */
export function seasonFromWeekHistory(
    weekHistory: Record<string, any> | null | undefined,
    managers: any[],
    completedGWs: number[] | null = null,
): StoredManagerSeason[] {
    const byId = new Map<number, StoredManagerSeason>();
    for (const m of managers || []) {
        byId.set(m.entry, { entryId: m.entry, name: m.player_name, team: m.entry_name, gameweeks: [] });
    }

    const gws = Object.keys(weekHistory || {})
        .map(Number)
        .filter((g) => Number.isFinite(g) && (!completedGWs || completedGWs.includes(g)))
        .sort((a, b) => a - b);

    for (const gw of gws) {
        for (const row of weekHistory![gw]?.managers ?? []) {
            const season = byId.get(row?.entryId);
            if (season) season.gameweeks.push(toStoredGameweek(gw, row));
        }
    }

    return [...byId.values()];
}

/** Season-long figures for one manager from their stored gameweeks. */
export function seasonTotals(gameweeks: StoredGameweek[], throughGW: number = Infinity) {
    const played = gameweeks.filter((g) => g.event <= throughGW);
    const scores = played.map((g) => g.score);
    return {
        netScore: scores.reduce((sum, v) => sum + v, 0),
        transferCost: played.reduce((sum, g) => sum + g.transferCost, 0),
        transfers: played.reduce((sum, g) => sum + g.transfers, 0),
        highestGW: scores.length ? Math.max(...scores) : 0,
        lowestGW: scores.length ? Math.min(...scores) : 0,
        latestTeamValue: [...played].reverse().find((g) => g.teamValue != null)?.teamValue ?? null,
    };
}
