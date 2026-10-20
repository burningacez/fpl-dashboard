/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

import { dataCache } from '../data-cache';
import { formatTiedNames, updateRecordWithTies, updateRecordWithTiesLow } from '../../lib/utils';
import { calculateLeagueRankHistory } from './h2h';
import type { StoredManagerSeason } from './season-scores';

/**
 * Counting awards start at zero, and updateRecordWithTies treats an equal
 * value as a tie — so before anyone has won a MotM, taken a hit or lost a
 * week, every manager in the league ties on nothing and gets attributed the
 * award. Drop the names in that case so the card reads "-" until there is a
 * real holder. Only for records where zero genuinely means "hasn't happened".
 */
function clearIfUnearned(record: any): any {
    return record.value > 0 ? record : { ...record, names: [] };
}

/**
 * Bench Boost and Triple Captain verdicts, from the stored week rows. Every
 * use counts (two of each chip per season), the bench figure is what the
 * Bench Boost actually earned, and the captain is the effective one after
 * any vice-captain inheritance — the same numbers the pitch view shows.
 */
export function calculatePerfectChipUsage(seasons: StoredManagerSeason[]): any {
    const perfectBB: any[] = [];
    const perfectTC: any[] = [];
    let worstBB: any = null;
    let worstTC: any = null;

    for (const manager of seasons) {
        const nonBBWeeks = manager.gameweeks.filter((g) => g.chip !== 'bboost');
        const maxNonBBBench = Math.max(0, ...nonBBWeeks.map((g) => g.benchPoints));

        for (const bb of manager.gameweeks.filter((g) => g.chip === 'bboost')) {
            if (bb.benchPoints >= maxNonBBBench && bb.benchPoints > 0) {
                perfectBB.push({ name: manager.name, gw: bb.event, benchPoints: bb.benchPoints, maxOtherBench: maxNonBBBench });
            }
            if (worstBB === null || bb.benchPoints < worstBB.benchPoints) {
                worstBB = { names: [manager.name], benchPoints: bb.benchPoints, gw: bb.event };
            } else if (bb.benchPoints === worstBB.benchPoints && !worstBB.names.includes(manager.name)) {
                worstBB.names.push(manager.name);
            }
        }

        for (const tc of manager.gameweeks.filter((g) => g.chip === '3xc')) {
            const others = manager.gameweeks.filter((g) => g.event !== tc.event);
            const maxOtherCaptain = Math.max(0, ...others.map((g) => g.captainBasePoints));
            const player = tc.captainName || 'Unknown';
            if (tc.captainBasePoints >= maxOtherCaptain && tc.captainBasePoints >= 10) {
                perfectTC.push({ name: manager.name, gw: tc.event, captainPoints: tc.captainBasePoints, player });
            }
            if (worstTC === null || tc.captainBasePoints < worstTC.captainPoints) {
                worstTC = { names: [manager.name], captainPoints: tc.captainBasePoints, gw: tc.event, player };
            } else if (tc.captainBasePoints === worstTC.captainPoints && !worstTC.names.includes(manager.name)) {
                worstTC.names.push(manager.name);
            }
        }
    }

    return { perfectBB, perfectTC, worstBB, worstTC };
}

/**
 * Every record here is read from the stored week rows (seasonFromWeekHistory):
 * the same per-GW net scores, bench points, hits and chips the week page shows.
 * A record can therefore never disagree with the scores table about a week.
 */
export function preCalculateHallOfFame(seasons: StoredManagerSeason[], losersData: any, motmData: any, completedGWs: number[] | null = null): any {
    // Nothing has been played yet (pre-season, or before the first gameweek
    // finishes): there are no records to hold. Publishing an all-zero payload
    // would hand out awards for a season that hasn't started, so publish
    // nothing and let /api/hall-of-fame serve its "fills in once gameweeks
    // have been played" empty state instead.
    const hasCompletedGameweeks = seasons.some((m) => m.gameweeks.length > 0);
    if (!hasCompletedGameweeks) {
        console.log('[HoF] No completed gameweeks yet — no records to publish');
        return null;
    }

    // Initialize records with tie support
    let highestGW: any = { names: [], value: 0, gw: 0 };
    let lowestGW: any = { names: [], value: Infinity, gw: 0 };
    let biggestClimb: any = { names: [], value: 0, gw: 0 };
    let biggestDrop: any = { names: [], value: 0, gw: 0 };
    let mostTransfers: any = { names: [], value: 0 };
    let biggestHit: any = { names: [], value: 0, gw: 0 };
    let highestTeamValue: any = { names: [], value: 0, gw: 0 };
    let lowestTeamValue: any = { names: [], value: Infinity, gw: 0 };
    let biggestBenchHaul: any = { names: [], value: 0, gw: 0 };

    // Track scores for consistency calculation
    const managerScoreStats: any = {};
    const managerTransferTotals: any = {};

    // Calculate league rank history for climb/drop calculations
    const leagueRankHistory = calculateLeagueRankHistory(seasons);

    // First pass: calculate basic records from history
    seasons.forEach((manager) => {
        let totalTransfers = 0;
        const scores: number[] = [];
        const rankHist = leagueRankHistory[manager.entryId] || [];

        manager.gameweeks.forEach((gw) => {
            scores.push(gw.score);

            // Highest/Lowest GW scores
            highestGW = updateRecordWithTies(highestGW, manager.name, gw.score, { gw: gw.event });
            lowestGW = updateRecordWithTiesLow(lowestGW, manager.name, gw.score, { gw: gw.event });

            // Transfers
            totalTransfers += gw.transfers;

            // Transfer hits (single GW)
            biggestHit = updateRecordWithTies(biggestHit, manager.name, gw.transferCost, { gw: gw.event });

            // Team value tracking (value is in tenths, e.g. 1000 = £100.0m)
            if (gw.teamValue != null && gw.teamValue > 0) {
                highestTeamValue = updateRecordWithTies(highestTeamValue, manager.name, gw.teamValue, { gw: gw.event });
                lowestTeamValue = updateRecordWithTiesLow(lowestTeamValue, manager.name, gw.teamValue, { gw: gw.event });
            }

            // Points left on the bench. A Bench Boost week's bench counted,
            // so it isn't a haul left behind.
            if (gw.chip !== 'bboost' && gw.benchPoints > 0) {
                biggestBenchHaul = updateRecordWithTies(biggestBenchHaul, manager.name, gw.benchPoints, { gw: gw.event });
            }
        });

        managerTransferTotals[manager.name] = totalTransfers;

        // Rank changes from league rank history
        for (let i = 1; i < rankHist.length; i++) {
            const rankChange = rankHist[i-1].rank - rankHist[i].rank;
            if (rankChange > 0) {
                biggestClimb = updateRecordWithTies(biggestClimb, manager.name, rankChange, { gw: rankHist[i].gw });
            }
            if (rankChange < 0) {
                const ranksLost = -rankChange;
                biggestDrop = updateRecordWithTies(biggestDrop, manager.name, ranksLost, { gw: rankHist[i].gw });
            }
        }

        // Calculate standard deviation for consistency
        if (scores.length > 0) {
            const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
            const variance = scores.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / scores.length;
            managerScoreStats[manager.name] = {
                stdDev: Math.sqrt(variance),
                avg
            };
        }
    });

    // Process total transfers (needs separate pass after collecting all)
    Object.entries(managerTransferTotals).forEach(([name, count]: [string, any]) => {
        mostTransfers = updateRecordWithTies(mostTransfers, name, count, {});
    });

    // Most consistent (lowest std dev) - with tie support
    let mostConsistent: any = { names: [], value: Infinity };
    Object.entries(managerScoreStats).forEach(([name, stats]: [string, any]) => {
        const rounded = Math.round(stats.stdDev * 10) / 10;
        mostConsistent = updateRecordWithTiesLow(mostConsistent, name, rounded, {});
    });

    // Get losers count with tie support
    const loserCounts: any = {};
    seasons.forEach((m) => loserCounts[m.name] = 0);
    if (losersData?.losers) {
        losersData.losers.forEach((l: any) => {
            if (loserCounts[l.name] !== undefined) {
                loserCounts[l.name]++;
            }
        });
    }

    let mostLosses: any = { names: [], value: 0 };
    Object.entries(loserCounts).forEach(([name, count]: [string, any]) => {
        mostLosses = updateRecordWithTies(mostLosses, name, count, {});
    });

    // Get MotM wins with tie support
    const motmCounts: any = {};
    seasons.forEach((m) => motmCounts[m.name] = 0);
    if (motmData?.winners) {
        motmData.winners.forEach((w: any) => {
            if (w.winner?.name && motmCounts[w.winner.name] !== undefined) {
                motmCounts[w.winner.name]++;
            }
        });
    }

    let mostMotM: any = { names: [], value: 0 };
    Object.entries(motmCounts).forEach(([name, count]: [string, any]) => {
        mostMotM = updateRecordWithTies(mostMotM, name, count, {});
    });

    // Most weekly wins: count how many GWs each manager scored highest
    const gwWinCounts: any = {};
    seasons.forEach((m) => gwWinCounts[m.name] = 0);

    // Group all managers' scores by GW
    const allGWs = new Set<number>();
    seasons.forEach((m) => m.gameweeks.forEach((gw) => allGWs.add(gw.event)));

    for (const gwNum of allGWs) {
        let maxScore = -Infinity;
        let winners: any[] = [];
        seasons.forEach((m) => {
            const gw = m.gameweeks.find((g) => g.event === gwNum);
            if (!gw) return;
            if (gw.score > maxScore) {
                maxScore = gw.score;
                winners = [m.name];
            } else if (gw.score === maxScore) {
                winners.push(m.name);
            }
        });
        // Award a win to each winner (even shared weeks count)
        winners.forEach(name => gwWinCounts[name]++);
    }

    let mostWeeklyWins: any = { names: [], value: 0 };
    Object.entries(gwWinCounts).forEach(([name, count]: [string, any]) => {
        mostWeeklyWins = updateRecordWithTies(mostWeeklyWins, name, count, {});
    });

    // Longest form chart dominance: at each gameweek endpoint G, check
    // rolling windows of size 1, 2, 3, ... For each window size N, who has
    // the highest total over the last N GWs? The streak is how many
    // consecutive window sizes (starting from 1) the same manager leads.
    // The award goes to whoever has the longest such streak across all GWs.
    const sortedGWs = [...allGWs].sort((a, b) => a - b);

    // Pre-build a score lookup: managerName -> { gwNum -> net points }
    const scoreByGW: any = {};
    seasons.forEach((m) => {
        scoreByGW[m.name] = {};
        m.gameweeks.forEach((gw) => {
            scoreByGW[m.name][gw.event] = gw.score;
        });
    });

    let longestFormStreak: any = { names: [], value: 0 };
    const managerNames = seasons.map((m) => m.name);

    for (let gIdx = 0; gIdx < sortedGWs.length; gIdx++) {
        const endGW = sortedGWs[gIdx];
        // Running totals for each manager over expanding window
        const runningTotals: any = {};
        managerNames.forEach((name: any) => runningTotals[name] = 0);

        let streakManager: any = null;
        let streakLen = 0;

        // Expand window: N=1 means just endGW, N=2 means endGW and previous, etc.
        for (let w = 0; w <= gIdx; w++) {
            const gwNum = sortedGWs[gIdx - w];
            // Add this GW's scores to running totals
            managerNames.forEach((name: any) => {
                runningTotals[name] += scoreByGW[name][gwNum] || 0;
            });

            // Find leader for this window size (w+1 weeks)
            let maxTotal = -Infinity;
            let leaders: any[] = [];
            managerNames.forEach((name: any) => {
                if (runningTotals[name] > maxTotal) {
                    maxTotal = runningTotals[name];
                    leaders = [name];
                } else if (runningTotals[name] === maxTotal) {
                    leaders.push(name);
                }
            });

            // For streak: single leader must match previous window's leader
            if (leaders.length === 1) {
                if (w === 0 || leaders[0] === streakManager) {
                    streakManager = leaders[0];
                    streakLen = w + 1;
                } else {
                    break; // Different leader, streak from window 1 is broken
                }
            } else {
                break; // Tied at top, streak broken
            }
        }

        if (streakLen > 0) {
            longestFormStreak = updateRecordWithTies(longestFormStreak, streakManager, streakLen, {});
        }
    }

    // Awards nobody has earned yet keep their card, but without a name on it.
    mostMotM = clearIfUnearned(mostMotM);
    mostLosses = clearIfUnearned(mostLosses);
    mostTransfers = clearIfUnearned(mostTransfers);
    mostWeeklyWins = clearIfUnearned(mostWeeklyWins);
    biggestHit = clearIfUnearned(biggestHit);

    // Fix defaults for records with no data
    if (lowestGW.value === Infinity) {
        lowestGW = { names: ['-'], value: 0, gw: 0 };
    }
    if (lowestTeamValue.value === Infinity) {
        lowestTeamValue = { names: ['-'], value: 1000, gw: 0 };
    }
    if (mostConsistent.value === Infinity) {
        mostConsistent = { names: ['-'], value: 0 };
    }

    // Calculate perfect chip usage (BB and TC)
    const chipAwards = calculatePerfectChipUsage(seasons);
    console.log(`[HoF] Found ${chipAwards.perfectBB.length} perfect BB, ${chipAwards.perfectTC.length} perfect TC, worst BB: ${chipAwards.worstBB ? 'yes' : 'no'}, worst TC: ${chipAwards.worstTC ? 'yes' : 'no'}`);

    // Get best/worst tinkering from cache (populated as users browse week modal)
    // This avoids expensive API calls during Hall of Fame calculation
    let bestTinkering: any = { names: [], value: -Infinity, gw: 0 };
    let worstTinkering: any = { names: [], value: Infinity, gw: 0 };

    const entryIdToName: any = {};
    seasons.forEach((m) => entryIdToName[m.entryId] = m.name);

    Object.entries(dataCache.tinkeringCache || {}).forEach(([key, data]: [string, any]) => {
        if (!data.available || typeof data.netImpact !== 'number') return;

        const [entryId, gw] = key.split('-').map(Number);
        const managerName = entryIdToName[entryId];
        if (!managerName) return;

        // Skip current/unfinished gameweeks
        if (completedGWs && !completedGWs.includes(gw)) return;

        if (data.netImpact > bestTinkering.value) {
            bestTinkering = { names: [managerName], value: data.netImpact, gw };
        } else if (data.netImpact === bestTinkering.value && !bestTinkering.names.includes(managerName)) {
            bestTinkering.names.push(managerName);
        }

        if (data.netImpact < worstTinkering.value) {
            worstTinkering = { names: [managerName], value: data.netImpact, gw };
        } else if (data.netImpact === worstTinkering.value && !worstTinkering.names.includes(managerName)) {
            worstTinkering.names.push(managerName);
        }
    });

    const cacheSize = Object.keys(dataCache.tinkeringCache || {}).length;
    if (cacheSize > 0) {
        console.log(`[HoF] Tinkering records from ${cacheSize} cached entries`);
    }

    // Fix defaults for tinkering if no cached data
    if (bestTinkering.value === -Infinity) {
        bestTinkering = { names: ['-'], value: 0, gw: 0 };
    }
    if (worstTinkering.value === Infinity) {
        worstTinkering = { names: ['-'], value: 0, gw: 0 };
    }

    // Convert to frontend-friendly format
    return {
        highlights: {
            highestGW: {
                name: formatTiedNames(highestGW.names),
                names: highestGW.names,
                score: highestGW.value,
                gw: highestGW.gw
            },
            biggestClimb: {
                name: formatTiedNames(biggestClimb.names),
                names: biggestClimb.names,
                ranksGained: biggestClimb.value,
                gw: biggestClimb.gw
            },
            mostMotM: {
                name: formatTiedNames(mostMotM.names),
                names: mostMotM.names,
                count: mostMotM.value
            },
            mostConsistent: {
                name: formatTiedNames(mostConsistent.names),
                names: mostConsistent.names,
                stdDev: mostConsistent.value
            },
            highestTeamValue: {
                name: formatTiedNames(highestTeamValue.names),
                names: highestTeamValue.names,
                value: (highestTeamValue.value / 10).toFixed(1),
                gw: highestTeamValue.gw
            },
            bestTinkering: {
                name: formatTiedNames(bestTinkering.names),
                names: bestTinkering.names,
                impact: bestTinkering.value,
                gw: bestTinkering.gw
            },
            mostWeeklyWins: {
                name: formatTiedNames(mostWeeklyWins.names),
                names: mostWeeklyWins.names,
                count: mostWeeklyWins.value
            },
            longestFormStreak: {
                name: formatTiedNames(longestFormStreak.names),
                names: longestFormStreak.names,
                count: longestFormStreak.value
            }
        },
        lowlights: {
            lowestGW: {
                name: formatTiedNames(lowestGW.names),
                names: lowestGW.names,
                score: lowestGW.value,
                gw: lowestGW.gw
            },
            mostLosses: {
                name: formatTiedNames(mostLosses.names),
                names: mostLosses.names,
                count: mostLosses.value
            },
            biggestHit: {
                name: formatTiedNames(biggestHit.names),
                names: biggestHit.names,
                cost: biggestHit.value,
                gw: biggestHit.gw
            },
            biggestDrop: {
                name: formatTiedNames(biggestDrop.names),
                names: biggestDrop.names,
                ranksLost: biggestDrop.value,
                gw: biggestDrop.gw
            },
            mostTransfers: {
                name: formatTiedNames(mostTransfers.names),
                names: mostTransfers.names,
                count: mostTransfers.value
            },
            lowestTeamValue: {
                name: formatTiedNames(lowestTeamValue.names),
                names: lowestTeamValue.names,
                value: (lowestTeamValue.value / 10).toFixed(1),
                gw: lowestTeamValue.gw
            },
            biggestBenchHaul: {
                name: formatTiedNames(biggestBenchHaul.names),
                names: biggestBenchHaul.names,
                points: biggestBenchHaul.value,
                gw: biggestBenchHaul.gw
            },
            worstTinkering: {
                name: formatTiedNames(worstTinkering.names),
                names: worstTinkering.names,
                impact: worstTinkering.value,
                gw: worstTinkering.gw
            }
        },
        chipAwards: {
            perfectBB: chipAwards.perfectBB,
            perfectTC: chipAwards.perfectTC,
            worstBB: chipAwards.worstBB ? {
                name: formatTiedNames(chipAwards.worstBB.names),
                names: chipAwards.worstBB.names,
                benchPoints: chipAwards.worstBB.benchPoints,
                gw: chipAwards.worstBB.gw
            } : null,
            worstTC: chipAwards.worstTC ? {
                name: formatTiedNames(chipAwards.worstTC.names),
                names: chipAwards.worstTC.names,
                captainPoints: chipAwards.worstTC.captainPoints,
                player: chipAwards.worstTC.player,
                gw: chipAwards.worstTC.gw
            } : null
        }
    };
}
