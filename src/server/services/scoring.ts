/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { scoreSquad } from './scoring-core';

// =============================================================================
// AUTO-SUB POINTS CALCULATION HELPER
// =============================================================================
// Thin wrapper over the shared scoring core (scoring-core.ts). Returns a GROSS
// total (no transfer-hit deduction) including provisional bonus.
export function calculatePointsWithAutoSubs(picks: any, liveData: any, bootstrap: any, gwFixtures: any): any {
    if (!picks?.picks || !liveData?.elements) {
        return { totalPoints: picks?.entry_history?.points || 0, benchPoints: 0 };
    }

    const squad = scoreSquad(picks, liveData, bootstrap, gwFixtures);
    return { totalPoints: squad.totalPoints, benchPoints: squad.benchPoints, players: squad.players };
}

// Count players still to earn points this GW. Mirrors the week.js calc but
// reuses the players array produced by calculatePointsWithAutoSubs (which
// already has subOut/subIn flags set and effective captain multipliers).
export function calculatePlayersLeft(picks: any, gwFixtures: any, bootstrap: any, calcPlayers: any): any {
    if (!picks?.picks) return { playersLeft: 0, activePlayers: 0 };

    const activeChip = picks.active_chip;
    const isBenchBoost = activeChip === 'bboost';
    const isTripleCaptain = activeChip === '3xc';

    const teamRemainingFixtures: any = {};
    const teamActiveFixtures: any = {};
    (gwFixtures || []).forEach((f: any) => {
        const increment = f.started ? 0 : 1;
        teamRemainingFixtures[f.team_h] = (teamRemainingFixtures[f.team_h] || 0) + increment;
        teamRemainingFixtures[f.team_a] = (teamRemainingFixtures[f.team_a] || 0) + increment;
        const active = (f.started && !f.finished_provisional && !f.finished) ? 1 : 0;
        teamActiveFixtures[f.team_h] = (teamActiveFixtures[f.team_h] || 0) + active;
        teamActiveFixtures[f.team_a] = (teamActiveFixtures[f.team_a] || 0) + active;
    });

    const subbedOutIds = new Set();
    const subbedInIds = new Set();
    let effectiveCaptainId: any = null;
    if (calcPlayers) {
        calcPlayers.forEach((p: any) => {
            if (p.subOut) subbedOutIds.add(p.id);
            if (p.subIn) subbedInIds.add(p.id);
            if (p.multiplier >= 2) effectiveCaptainId = p.id;
        });
    }

    let playersLeft = 0;
    let activePlayers = 0;

    picks.picks.forEach((pick: any, idx: number) => {
        const element = bootstrap.elements.find((e: any) => e.id === pick.element);
        if (!element) return;
        const remaining = teamRemainingFixtures[element.team] || 0;
        const activeCount = teamActiveFixtures[element.team] || 0;
        const isOriginalStarter = idx < 11;
        const wasSubbedOut = subbedOutIds.has(pick.element);
        const wasSubbedIn = subbedInIds.has(pick.element);
        const inSquad = isBenchBoost
            || (isOriginalStarter && !wasSubbedOut)
            || wasSubbedIn;
        if (inSquad && remaining > 0) {
            const isCaptain = effectiveCaptainId
                ? (pick.element === effectiveCaptainId)
                : pick.is_captain;
            const multiplier = isCaptain ? (isTripleCaptain ? 3 : 2) : 1;
            playersLeft += remaining * multiplier;
        }
        if (inSquad && activeCount > 0) {
            activePlayers += activeCount;
        }
    });

    return { playersLeft, activePlayers };
}

// =============================================================================
// TINKERING IMPACT CALCULATION
// =============================================================================

/**
 * Calculate what score a previous team would have achieved with current GW's points.
 * Thin wrapper over the shared scoring core — applies the same auto-sub,
 * captaincy and provisional-bonus rules as the actual-score path so the two
 * sides of a tinkering comparison are always symmetric.
 *
 * activeChip controls how the hypothetical score is computed. For tinkering
 * this is the chip the manager actually played in the target GW, not the
 * chip the previousPicks were saved under — the hypothetical is "what would
 * last week's team have scored this week", and the chip applies to this
 * week. Callers that want a no-chip baseline (e.g. Set & Forget) pass null.
 */
export function calculateHypotheticalScore(previousPicks: any, liveData: any, bootstrap: any, gwFixtures: any, activeChip: any = null): any {
    if (!previousPicks?.picks || !liveData?.elements) {
        return { totalPoints: 0, benchPoints: 0, players: [] };
    }

    const squad = scoreSquad(previousPicks, liveData, bootstrap, gwFixtures, { chipOverride: activeChip });
    return { totalPoints: squad.totalPoints, benchPoints: squad.benchPoints, players: squad.players };
}
