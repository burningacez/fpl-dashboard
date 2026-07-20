/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, getCompletedGameweeks } from '../fpl/client';
import { dataCache, rebuildStatus, fetchManagerPicksCached, fetchLiveGWDataCached } from '../data-cache';
import { calculatePointsWithAutoSubs, calculateHypotheticalScore } from '../services/scoring';

export async function calculateTinkeringImpact(entryId: any, gw: any): Promise<any> {
    // GW1 has no previous team to compare
    if (gw <= 1) {
        return {
            available: false,
            reason: 'gw1',
            navigation: { currentGW: gw, minGW: 2, maxGW: gw, hasPrev: false, hasNext: false }
        };
    }

    // Check cache first for completed GWs
    const cacheKey = `${entryId}-${gw}`;
    if (dataCache.tinkeringCache[cacheKey]) {
        // Update navigation with current maxGW (may have changed)
        const cached = dataCache.tinkeringCache[cacheKey];
        const bootstrap = await fetchBootstrap();
        const currentGWEvent = bootstrap.events.find((e: any) => e.is_current);
        const maxGW = currentGWEvent?.id || gw;
        cached.navigation = {
            ...cached.navigation,
            maxGW,
            hasNext: gw < maxGW
        };
        return cached;
    }

    try {
        const [bootstrap, fixtures] = await Promise.all([
            fetchBootstrap(),
            fetchFixtures()
        ]);

        const currentGWEvent = bootstrap.events.find((e: any) => e.is_current);
        const maxGW = currentGWEvent?.id || gw;
        const gwFixtures = fixtures.filter((f: any) => f.event === gw);

        // Check if this GW is completed (for caching)
        const gwEvent = bootstrap.events.find((e: any) => e.id === gw);
        const isGWCompleted = gwEvent?.finished || false;

        // Fetch current GW picks (use cached version for completed GWs)
        const currentPicks: any = await fetchManagerPicksCached(entryId, gw, bootstrap);
        const currentChip = currentPicks.active_chip;

        // Determine which previous GW to compare against
        let compareGW = gw - 1;

        // Handle Free Hit edge case: if PREVIOUS week was Free Hit, go back one more week
        const prevPicks: any = await fetchManagerPicksCached(entryId, compareGW, bootstrap);
        if (prevPicks.active_chip === 'freehit' && compareGW > 1) {
            compareGW = compareGW - 1;
        }

        // Fetch the comparison picks (use cached version for completed GWs)
        const previousPicks: any = compareGW !== gw - 1
            ? await fetchManagerPicksCached(entryId, compareGW, bootstrap)
            : prevPicks;

        // Fetch live data for current GW (use cached version for completed GWs)
        const liveData: any = await fetchLiveGWDataCached(gw, bootstrap);

        // Calculate hypothetical score (what old team would have scored).
        // The hypothetical applies THIS GW's chip — the question is "what would
        // last week's team have scored this week", and the chip the manager
        // played is a property of this week, not the team selection.
        const hypothetical = calculateHypotheticalScore(previousPicks, liveData, bootstrap, gwFixtures, currentChip);

        // Calculate actual score with auto-subs
        const actual = calculatePointsWithAutoSubs(currentPicks, liveData, bootstrap, gwFixtures);

        // Get transfer cost
        const transferCost = currentPicks.entry_history?.event_transfers_cost || 0;

        // Calculate net impact
        const netImpact = actual.totalPoints - hypothetical.totalPoints - transferCost;

        // Identify transfers in/out with TRUE impact (considering bench position & auto-subs)
        const currentPlayerIds = new Set(currentPicks.picks.map((p: any) => p.element));
        const previousPlayerIds = new Set(previousPicks.picks.map((p: any) => p.element));

        const transfersIn: any[] = [];
        const transfersOut: any[] = [];

        // Helper to calculate a player's actual contribution to a team's score
        const getPlayerContribution = (playerId: any, playersArray: any) => {
            const player = playersArray?.find((p: any) => p.id === playerId);
            if (!player) return 0;

            // If player is a starter (not subbed out) or subbed in, they contribute
            // After resolveEffectiveCaptaincy, multiplier is already correct for all players
            if ((!player.isBench && !player.subOut) || player.subIn) {
                return (player.points + (player.provisionalBonus || 0)) * player.multiplier;
            }
            return 0; // Bench player who didn't come on
        };

        // Find players transferred in - calculate their actual contribution to current team
        currentPicks.picks.forEach((pick: any) => {
            if (!previousPlayerIds.has(pick.element)) {
                const element = bootstrap.elements.find((e: any) => e.id === pick.element);
                const liveElement = liveData.elements.find((e: any) => e.id === pick.element);
                const rawPoints = liveElement?.stats?.total_points || 0;
                const actualContribution = getPlayerContribution(pick.element, actual.players);

                transfersIn.push({
                    player: { id: pick.element, name: element?.web_name || 'Unknown' },
                    points: rawPoints,
                    impact: actualContribution, // True contribution to actual score
                    captained: pick.is_captain
                });
            }
        });

        // Find players transferred out - calculate what they would have contributed
        previousPicks.picks.forEach((pick: any) => {
            if (!currentPlayerIds.has(pick.element)) {
                const element = bootstrap.elements.find((e: any) => e.id === pick.element);
                const liveElement = liveData.elements.find((e: any) => e.id === pick.element);
                const rawPoints = liveElement?.stats?.total_points || 0;
                const hypotheticalContribution = getPlayerContribution(pick.element, hypothetical.players);

                transfersOut.push({
                    player: { id: pick.element, name: element?.web_name || 'Unknown' },
                    points: rawPoints,
                    impact: hypotheticalContribution, // What they would have contributed
                    wasCaptain: pick.is_captain
                });
            }
        });

        // Identify captain change
        const oldCaptain = previousPicks.picks.find((p: any) => p.is_captain);
        const newCaptain = currentPicks.picks.find((p: any) => p.is_captain);

        const captainChange: any = {
            changed: oldCaptain?.element !== newCaptain?.element,
            oldCaptain: null,
            newCaptain: null,
            impact: 0
        };

        // Track captain-related flags for use in auto-sub effects computation
        let newCaptainIsTransfer = false;
        let oldCaptainIsTransfer = false;
        let newCaptainChangedPosition = false;
        let oldCaptainChangedPosition = false;

        if (captainChange.changed) {
            const oldCaptainElement = bootstrap.elements.find((e: any) => e.id === oldCaptain?.element);
            const newCaptainElement = bootstrap.elements.find((e: any) => e.id === newCaptain?.element);
            const oldCaptainLive = liveData.elements.find((e: any) => e.id === oldCaptain?.element);
            const newCaptainLive = liveData.elements.find((e: any) => e.id === newCaptain?.element);

            const oldCaptainPts = oldCaptainLive?.stats?.total_points || 0;
            const newCaptainPts = newCaptainLive?.stats?.total_points || 0;

            captainChange.oldCaptain = {
                name: oldCaptainElement?.web_name || 'Unknown',
                points: oldCaptainPts
            };
            captainChange.newCaptain = {
                name: newCaptainElement?.web_name || 'Unknown',
                points: newCaptainPts
            };

            // Calculate captain change impact, avoiding double-counting with transfers AND lineup changes
            // If new captain was transferred in, their captain bonus is already in transfersIn
            // If old captain was transferred out, their captain loss is already in transfersOut
            // If new/old captain changed lineup position (bench <-> starting), their impact is already in lineupChanges
            newCaptainIsTransfer = !previousPlayerIds.has(newCaptain?.element);
            oldCaptainIsTransfer = !currentPlayerIds.has(oldCaptain?.element);

            // Check if captains changed lineup position (bench <-> starting)
            if (!newCaptainIsTransfer) {
                const newCaptainCurrentIdx = currentPicks.picks.findIndex((p: any) => p.element === newCaptain?.element);
                const newCaptainPreviousPick = previousPicks.picks.find((p: any) => p.element === newCaptain?.element);
                const newCaptainPreviousIdx = newCaptainPreviousPick ? previousPicks.picks.indexOf(newCaptainPreviousPick) : -1;
                if (newCaptainPreviousIdx >= 0) {
                    const wasOnBench = newCaptainPreviousIdx >= 11;
                    const isOnBench = newCaptainCurrentIdx >= 11;
                    newCaptainChangedPosition = wasOnBench !== isOnBench;
                }
            }

            if (!oldCaptainIsTransfer) {
                const oldCaptainPreviousIdx = previousPicks.picks.findIndex((p: any) => p.element === oldCaptain?.element);
                const oldCaptainCurrentPick = currentPicks.picks.find((p: any) => p.element === oldCaptain?.element);
                const oldCaptainCurrentIdx = oldCaptainCurrentPick ? currentPicks.picks.indexOf(oldCaptainCurrentPick) : -1;
                if (oldCaptainCurrentIdx >= 0) {
                    const wasOnBench = oldCaptainPreviousIdx >= 11;
                    const isOnBench = oldCaptainCurrentIdx >= 11;
                    oldCaptainChangedPosition = wasOnBench !== isOnBench;
                }
            }

            let impact = 0;
            // Only add new captain's points if they're a kept player who didn't change position
            if (!newCaptainIsTransfer && !newCaptainChangedPosition) {
                impact += newCaptainPts;
            }
            // Only subtract old captain's points if they're a kept player who didn't change position
            if (!oldCaptainIsTransfer && !oldCaptainChangedPosition) {
                impact -= oldCaptainPts;
            }
            captainChange.impact = impact;
        }

        // Identify lineup changes (bench <-> starting XI) with TRUE impact
        const lineupChanges: any = {
            movedToStarting: [],  // Were on bench, now starting
            movedToBench: []      // Were starting, now on bench
        };

        // Check players in both teams for position changes
        currentPicks.picks.forEach((currentPick: any, currentIdx: number) => {
            const previousPick = previousPicks.picks.find((p: any) => p.element === currentPick.element);
            if (previousPick) {
                const previousIdx = previousPicks.picks.indexOf(previousPick);
                const wasOnBench = previousIdx >= 11;
                const isOnBench = currentIdx >= 11;

                const element = bootstrap.elements.find((e: any) => e.id === currentPick.element);
                const liveElement = liveData.elements.find((e: any) => e.id === currentPick.element);
                const playerName = element?.web_name || 'Unknown';
                const points = liveElement?.stats?.total_points || 0;

                // Calculate true impact: difference in contribution between actual and hypothetical
                const actualContrib = getPlayerContribution(currentPick.element, actual.players);
                const hypotheticalContrib = getPlayerContribution(currentPick.element, hypothetical.players);
                const impact = actualContrib - hypotheticalContrib;

                if (wasOnBench && !isOnBench) {
                    lineupChanges.movedToStarting.push({ id: currentPick.element, name: playerName, points, impact });
                } else if (!wasOnBench && isOnBench) {
                    lineupChanges.movedToBench.push({ id: currentPick.element, name: playerName, points, impact });
                }
            }
        });

        // Calculate auto-sub cascade effects for kept players
        // When transfers and lineup changes alter the squad, auto-substitution patterns
        // can differ between the actual and hypothetical teams, affecting kept players
        // who didn't explicitly change position
        const autoSubEffects: any[] = [];
        const lineupChangedIds = new Set([
            ...(lineupChanges.movedToStarting || []).map((p: any) => p.id),
            ...(lineupChanges.movedToBench || []).map((p: any) => p.id)
        ]);

        currentPicks.picks.forEach((currentPick: any) => {
            const playerId = currentPick.element;

            // Skip transferred-in players (already in transfersIn section)
            if (!previousPlayerIds.has(playerId)) return;

            const previousPick = previousPicks.picks.find((p: any) => p.element === playerId);
            if (!previousPick) return;

            // Skip players already in lineup changes section
            if (lineupChangedIds.has(playerId)) return;

            // Calculate this player's actual contribution difference
            const actualContrib = getPlayerContribution(playerId, actual.players);
            const hypotheticalContrib = getPlayerContribution(playerId, hypothetical.players);
            let diff = actualContrib - hypotheticalContrib;

            // Subtract what the captain change section already accounts for
            if (captainChange.changed) {
                if (playerId === newCaptain?.element && !newCaptainIsTransfer && !newCaptainChangedPosition) {
                    const newCaptainPts = liveData.elements.find((e: any) => e.id === playerId)?.stats?.total_points || 0;
                    diff -= newCaptainPts; // Captain section already added +newCaptainPts
                }
                if (playerId === oldCaptain?.element && !oldCaptainIsTransfer && !oldCaptainChangedPosition) {
                    const oldCaptainPts = liveData.elements.find((e: any) => e.id === playerId)?.stats?.total_points || 0;
                    diff += oldCaptainPts; // Captain section already subtracted -oldCaptainPts
                }
            }

            if (diff !== 0) {
                const element = bootstrap.elements.find((e: any) => e.id === playerId);
                autoSubEffects.push({
                    name: element?.web_name || 'Unknown',
                    impact: diff
                });
            }
        });

        // Also check transferred-out players from hypothetical that might have
        // auto-sub effects not captured in transfersOut (shouldn't happen, but for safety)

        // Determine chip badge
        let reason = null;
        if (currentChip === 'freehit') reason = 'freehit';
        else if (currentChip === 'wildcard') reason = 'wildcard';
        else if (currentChip === '3xc') reason = '3xc';
        else if (currentChip === 'bboost') reason = 'bboost';

        // Calculate chip impact (TC and BB)
        const chipImpact: any = {
            active: currentChip === '3xc' || currentChip === 'bboost',
            chip: currentChip,
            tripleCaptain: null,
            benchBoost: null
        };

        if (currentChip === '3xc') {
            // Triple Captain: extra 1x beyond normal 2x captain
            const captain = actual.players.find((p: any) => p.isCaptain);
            if (captain) {
                const captainPts = captain.points + (captain.provisionalBonus || 0);
                chipImpact.tripleCaptain = {
                    playerName: bootstrap.elements.find((e: any) => e.id === captain.id)?.web_name || 'Captain',
                    basePoints: captainPts,
                    bonus: captainPts // The extra 1x from TC
                };
            }
        }

        if (currentChip === 'bboost') {
            // Bench Boost: all bench players' points count
            // Get individual bench player contributions
            const benchPlayers = actual.players
                .filter((p: any) => p.isBench)
                .map((p: any) => ({
                    name: bootstrap.elements.find((e: any) => e.id === p.id)?.web_name || 'Unknown',
                    points: p.points + (p.provisionalBonus || 0)
                }));

            chipImpact.benchBoost = {
                players: benchPlayers,
                totalBonus: actual.benchPoints // Total bench contribution
            };

            // When BB is active, filter out bench position changes from lineup changes
            // since bench players score regardless of position
            lineupChanges.movedToStarting = lineupChanges.movedToStarting.filter(() => {
                // Keep only if the player actually changed their contribution due to position
                // With BB, bench players score anyway, so only formation-based auto-sub effects matter
                return false; // BB means position doesn't matter for scoring
            });
            lineupChanges.movedToBench = lineupChanges.movedToBench.filter(() => {
                return false; // BB means position doesn't matter for scoring
            });
        }

        const result = {
            available: true,
            reason,
            actualScore: actual.totalPoints,
            hypotheticalScore: hypothetical.totalPoints,
            transferCost,
            netImpact,
            transfersIn,
            transfersOut,
            captainChange,
            lineupChanges,
            autoSubEffects,
            chipImpact,
            navigation: {
                currentGW: gw,
                minGW: 2,
                maxGW,
                hasPrev: gw > 2,
                hasNext: gw < maxGW
            }
        };

        // Cache result for completed GWs
        if (isGWCompleted) {
            dataCache.tinkeringCache[cacheKey] = result;
        }

        return result;
    } catch (error: any) {
        console.error(`[Tinkering] Error calculating for entry ${entryId}, GW ${gw}:`, error.message);
        return {
            available: false,
            reason: 'error',
            error: error.message,
            navigation: { currentGW: gw, minGW: 2, maxGW: gw, hasPrev: false, hasNext: false }
        };
    }
}

export async function preCalculateTinkeringData(managers: any): Promise<void> {
    console.log('[Tinkering] Pre-calculating tinkering data for all managers...');
    const startTime = Date.now();

    try {
        const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
        const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
        const tinkeringGWs = completedGWs.filter((gw: any) => gw >= 2); // Skip GW1

        if (tinkeringGWs.length === 0) {
            console.log('[Tinkering] No completed GWs to calculate');
            return;
        }

        let calculated = 0;
        let skipped = 0;
        const totalTinkering = managers.length * tinkeringGWs.length;

        for (const manager of managers) {
            for (const gw of tinkeringGWs) {
                const cacheKey = `${manager.entry}-${gw}`;

                // Skip if already cached
                if (dataCache.tinkeringCache[cacheKey]) {
                    skipped++;
                    continue;
                }

                try {
                    const result = await calculateTinkeringImpact(manager.entry, gw);
                    // Result is automatically cached by calculateTinkeringImpact for completed GWs
                    calculated++;
                    // Update rebuild status if in progress
                    if (rebuildStatus.inProgress && calculated % 10 === 0) {
                        rebuildStatus.phase = 'tinkering';
                        rebuildStatus.progress = `Calculating tinkering: ${calculated + skipped}/${totalTinkering}`;
                    }
                } catch (e) {
                    // Skip failed calculations
                }
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Tinkering] Pre-calculation complete in ${duration}s - ${calculated} new, ${skipped} cached`);
    } catch (error: any) {
        console.error('[Tinkering] Pre-calculation failed:', error.message);
    }
}
