/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { isValidFormation, getEffectiveFormationCounts } from '../../lib/formation';
import { resolveEffectiveCaptaincy } from '../../lib/utils';

// =============================================================================
// AUTO-SUB POINTS CALCULATION HELPER
// =============================================================================
export function calculatePointsWithAutoSubs(picks: any, liveData: any, bootstrap: any, gwFixtures: any): any {
    if (!picks?.picks || !liveData?.elements) {
        return { totalPoints: picks?.entry_history?.points || 0, benchPoints: 0 };
    }

    const activeChip = picks.active_chip;

    // Helper to calculate provisional bonus for a fixture
    function calcProvisionalBonus(fixture: any): any {
        if (!fixture?.stats) return {};
        const bpsStat = fixture.stats.find((s: any) => s.identifier === 'bps');
        if (!bpsStat) return {};

        const allBps = [...(bpsStat.h || []), ...(bpsStat.a || [])]
            .sort((a: any, b: any) => b.value - a.value);

        if (allBps.length === 0) return {};

        const bonusMap: any = {};
        let currentRank = 1;
        let i = 0;

        while (i < allBps.length && currentRank <= 3) {
            const currentBps = (allBps[i] as any).value;
            const tiedPlayers: any[] = [];
            while (i < allBps.length && (allBps[i] as any).value === currentBps) {
                tiedPlayers.push((allBps[i] as any).element);
                i++;
            }
            let bonusForRank = currentRank === 1 ? 3 : currentRank === 2 ? 2 : currentRank === 3 ? 1 : 0;
            if (bonusForRank > 0) {
                tiedPlayers.forEach(elementId => bonusMap[elementId] = bonusForRank);
            }
            currentRank += tiedPlayers.length;
        }
        return bonusMap;
    }

    // Pre-calculate provisional bonus for all live fixtures (started but not finished)
    const provisionalBonusMap: any = {};
    gwFixtures?.forEach((fixture: any) => {
        if (fixture.started && !fixture.finished) {
            Object.assign(provisionalBonusMap, calcProvisionalBonus(fixture));
        }
    });

    // Build player data with live points
    const players = picks.picks.map((pick: any, idx: number) => {
        const element = bootstrap.elements.find((e: any) => e.id === pick.element);
        const liveElement = liveData.elements.find((e: any) => e.id === pick.element);
        const points = liveElement?.stats?.total_points || 0;
        const minutes = liveElement?.stats?.minutes || 0;

        // Get fixture status - handle DGW (multiple fixtures per team)
        const teamFixtures = gwFixtures?.filter((f: any) => f.team_h === element?.team || f.team_a === element?.team) || [];
        const hasNoGame = teamFixtures.length === 0;
        const fixtureStarted = teamFixtures.some((f: any) => f.started);
        const fixtureFinished = teamFixtures.length > 0 && teamFixtures.every((f: any) => f.finished_provisional || f.finished);
        const allFixturesStarted = teamFixtures.length > 0 && teamFixtures.every((f: any) => f.started);

        // Get official bonus - if this is > 0, bonus is already included in total_points
        const officialBonus = liveElement?.stats?.bonus || 0;

        // Show provisional bonus when match has started AND official bonus not yet added
        // Covers both live matches and finished_provisional (FT but bonus not confirmed)
        const provisionalBonus = (fixtureStarted && officialBonus === 0)
            ? (provisionalBonusMap[pick.element] || 0)
            : 0;

        return {
            id: pick.element,
            positionId: element?.element_type,
            points,
            minutes,
            isCaptain: pick.is_captain,
            isViceCaptain: pick.is_vice_captain,
            multiplier: pick.is_captain ? (activeChip === '3xc' ? 3 : 2) : (idx >= 11 ? 0 : 1),
            isBench: idx >= 11,
            benchOrder: idx >= 11 ? idx - 10 : 0,
            hasNoGame,
            fixtureStarted,
            fixtureFinished,
            allFixturesStarted,
            provisionalBonus,
            subOut: false,
            subIn: false
        };
    });

    const starters = players.filter((p: any) => !p.isBench);
    const bench = players.filter((p: any) => p.isBench).sort((a: any, b: any) => a.benchOrder - b.benchOrder);

    // Check if any fixture in the GW has started (needed for blank gameweek auto-subs)
    const gwHasStarted = gwFixtures?.some((f: any) => f.started) || false;

    // Only apply auto-subs if not using Bench Boost
    if (activeChip !== 'bboost') {
        // Step 1: GK auto-sub (processed separately, matches official FPL behaviour)
        const startingGK = starters.find((p: any) => p.positionId === 1);
        const benchGK = bench.find((p: any) => p.positionId === 1);

        if (startingGK && benchGK) {
            // In DGW, only trigger auto-sub when ALL fixtures have started
            // For blank GW (no game), trigger once any GW fixture has started
            const gkNeedsSub = startingGK.minutes === 0 &&
                (startingGK.allFixturesStarted || (startingGK.hasNoGame && gwHasStarted));
            const benchGKAvailable = !(benchGK.minutes === 0 &&
                (benchGK.allFixturesStarted || (benchGK.hasNoGame && gwHasStarted)));

            if (gkNeedsSub && benchGKAvailable) {
                startingGK.subOut = true;
                benchGK.subIn = true;
            }
        }

        // Step 2: Outfield auto-subs (bench priority order, skipping GK bench slot)
        // In DGW, only trigger when ALL fixtures have started (player won't play in any remaining game)
        // For blank GW (no game), trigger once any GW fixture has started
        const outfieldNeedsSub = starters.filter((p: any) =>
            p.positionId !== 1 && !p.subOut &&
            p.minutes === 0 && (p.allFixturesStarted || (p.hasNoGame && gwHasStarted))
        );
        const outfieldBench = bench.filter((p: any) => p.positionId !== 1);

        for (const playerOut of outfieldNeedsSub) {
            for (const benchPlayer of outfieldBench) {
                if (benchPlayer.subIn) continue; // Already used
                if (benchPlayer.minutes === 0 && (benchPlayer.allFixturesStarted || (benchPlayer.hasNoGame && gwHasStarted))) continue;

                // Use effective formation (includes already-subbed-in bench players)
                const testFormation = getEffectiveFormationCounts(players);

                // Adjust for proposed sub
                if (playerOut.positionId === 2) testFormation.DEF--;
                else if (playerOut.positionId === 3) testFormation.MID--;
                else if (playerOut.positionId === 4) testFormation.FWD--;

                if (benchPlayer.positionId === 2) testFormation.DEF++;
                else if (benchPlayer.positionId === 3) testFormation.MID++;
                else if (benchPlayer.positionId === 4) testFormation.FWD++;

                if (isValidFormation(testFormation)) {
                    playerOut.subOut = true;
                    benchPlayer.subIn = true;
                    break;
                }
            }
        }
    }

    // FPL API returns multiplier=0 for bench players. When a bench player is
    // auto-subbed in they should count as a regular starter (multiplier=1).
    players.forEach((p: any) => {
        if (p.subIn && p.multiplier === 0) p.multiplier = 1;
    });

    // If captain was auto-subbed out, vice-captain inherits the multiplier
    resolveEffectiveCaptaincy(players, gwHasStarted);

    // Calculate total points with auto-subs, captaincy, and provisional bonus
    // Provisional bonus DOES get captain multiplier
    let totalPoints = 0;
    let benchPoints = 0;

    players.forEach((p: any) => {
        const multiplier = p.multiplier;
        // Both base points and provisional bonus get the multiplier
        const effectivePoints = (p.points + p.provisionalBonus) * multiplier;

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += (p.points + p.provisionalBonus) * p.multiplier;
        } else if (p.isBench && !p.subIn) {
            benchPoints += p.points + p.provisionalBonus;
        }
    });

    // For Bench Boost, add bench points to total (they all count)
    if (activeChip === 'bboost') {
        totalPoints += benchPoints;
    }

    return { totalPoints, benchPoints, players };
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
 * Calculate what score a previous team would have achieved with current GW's points
 * Applies auto-sub logic to the hypothetical team
 */
export function calculateHypotheticalScore(previousPicks: any, liveData: any, bootstrap: any, gwFixtures: any, activeChip: any = null): any {
    if (!previousPicks?.picks || !liveData?.elements) {
        return { totalPoints: 0, benchPoints: 0, players: [] };
    }

    // activeChip controls how the hypothetical score is computed. For tinkering
    // this is the chip the manager actually played in the target GW, not the
    // chip the previousPicks were saved under — the hypothetical is "what would
    // last week's team have scored this week", and the chip applies to this
    // week. Callers that want a no-chip baseline (e.g. Set & Forget) pass null.
    const isTripleCaptain = activeChip === '3xc';
    const isBenchBoost = activeChip === 'bboost';

    // Check if any fixture in the GW has started (needed for blank gameweek auto-subs)
    const gwHasStarted = gwFixtures?.some((f: any) => f.started) || false;

    // Build player data with current GW's live points applied to previous team
    const players = previousPicks.picks.map((pick: any, idx: number) => {
        const element = bootstrap.elements.find((e: any) => e.id === pick.element);
        const liveElement = liveData.elements.find((e: any) => e.id === pick.element);
        const points = liveElement?.stats?.total_points || 0;
        const minutes = liveElement?.stats?.minutes || 0;

        // Get fixture status - handle DGW (multiple fixtures per team)
        const teamFixtures = gwFixtures?.filter((f: any) => f.team_h === element?.team || f.team_a === element?.team) || [];
        const hasNoGame = teamFixtures.length === 0;
        const fixtureStarted = teamFixtures.some((f: any) => f.started);
        const fixtureFinished = teamFixtures.length > 0 && teamFixtures.every((f: any) => f.finished_provisional || f.finished);
        const allFixturesStarted = teamFixtures.length > 0 && teamFixtures.every((f: any) => f.started);

        return {
            id: pick.element,
            name: element?.web_name || 'Unknown',
            positionId: element?.element_type,
            points,
            minutes,
            isCaptain: pick.is_captain,
            isViceCaptain: pick.is_vice_captain,
            multiplier: pick.is_captain ? (isTripleCaptain ? 3 : 2) : (idx >= 11 ? 0 : 1),
            isBench: idx >= 11,
            benchOrder: idx >= 11 ? idx - 10 : 0,
            hasNoGame,
            fixtureStarted,
            fixtureFinished,
            allFixturesStarted,
            subOut: false,
            subIn: false
        };
    });

    const starters = players.filter((p: any) => !p.isBench);
    const bench = players.filter((p: any) => p.isBench).sort((a: any, b: any) => a.benchOrder - b.benchOrder);

    // Bench Boost disables auto-subs (all 15 players count, no replacements needed)
    if (!isBenchBoost) {
        // Step 1: GK auto-sub (processed separately, matches official FPL behaviour)
        const startingGK = starters.find((p: any) => p.positionId === 1);
        const benchGK = bench.find((p: any) => p.positionId === 1);

        if (startingGK && benchGK) {
            // In DGW, only trigger auto-sub when ALL fixtures have started
            // For blank GW (no game), trigger once any GW fixture has started
            const gkNeedsSub = startingGK.minutes === 0 &&
                (startingGK.allFixturesStarted || (startingGK.hasNoGame && gwHasStarted));
            const benchGKAvailable = !(benchGK.minutes === 0 &&
                (benchGK.allFixturesStarted || (benchGK.hasNoGame && gwHasStarted)));

            if (gkNeedsSub && benchGKAvailable) {
                startingGK.subOut = true;
                benchGK.subIn = true;
            }
        }

        // Step 2: Outfield auto-subs (bench priority order, skipping GK bench slot)
        // In DGW, only trigger when ALL fixtures have started (player won't play in any remaining game)
        // For blank GW (no game), trigger once any GW fixture has started
        const outfieldNeedsSub = starters.filter((p: any) =>
            p.positionId !== 1 && !p.subOut &&
            p.minutes === 0 && (p.allFixturesStarted || (p.hasNoGame && gwHasStarted))
        );
        const outfieldBench = bench.filter((p: any) => p.positionId !== 1);

        for (const playerOut of outfieldNeedsSub) {
            for (const benchPlayer of outfieldBench) {
                if (benchPlayer.subIn) continue;
                if (benchPlayer.minutes === 0 && (benchPlayer.allFixturesStarted || (benchPlayer.hasNoGame && gwHasStarted))) continue;

                // Use effective formation (includes already-subbed-in bench players)
                const testFormation = getEffectiveFormationCounts(players);

                // Adjust for proposed sub
                if (playerOut.positionId === 2) testFormation.DEF--;
                else if (playerOut.positionId === 3) testFormation.MID--;
                else if (playerOut.positionId === 4) testFormation.FWD--;

                if (benchPlayer.positionId === 2) testFormation.DEF++;
                else if (benchPlayer.positionId === 3) testFormation.MID++;
                else if (benchPlayer.positionId === 4) testFormation.FWD++;

                if (isValidFormation(testFormation)) {
                    playerOut.subOut = true;
                    benchPlayer.subIn = true;
                    break;
                }
            }
        }
    }

    // FPL API returns multiplier=0 for bench players. When a bench player is
    // auto-subbed in they should count as a regular starter (multiplier=1).
    players.forEach((p: any) => {
        if (p.subIn && p.multiplier === 0) p.multiplier = 1;
    });

    // If captain was auto-subbed out, vice-captain inherits the multiplier
    resolveEffectiveCaptaincy(players, gwHasStarted);

    // Calculate total points with auto-subs and captaincy
    let totalPoints = 0;
    let benchPoints = 0;

    players.forEach((p: any) => {
        const effectivePoints = p.points * p.multiplier;

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += p.points * p.multiplier;
        } else if (p.isBench && !p.subIn) {
            benchPoints += p.points;
        }
    });

    // Bench Boost: all 15 players count, so add bench points to total
    if (isBenchBoost) {
        totalPoints += benchPoints;
    }

    return { totalPoints, benchPoints, players };
}
