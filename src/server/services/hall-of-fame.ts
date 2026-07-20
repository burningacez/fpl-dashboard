/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

import { dataCache } from '../data-cache';
import { formatTiedNames, updateRecordWithTies, updateRecordWithTiesLow } from '../../lib/utils';
import { calculateLeagueRankHistory } from './h2h';
import { calculatePerfectChipUsage } from './profiles';

export async function preCalculateHallOfFame(histories: any, losersData: any, motmData: any, chipsData: any, completedGWs: any = null): Promise<any> {
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
    const leagueRankHistory = calculateLeagueRankHistory(histories);

    // First pass: calculate basic records from history
    histories.forEach((manager: any) => {
        let totalTransfers = 0;
        const scores: any[] = [];
        const rankHist = leagueRankHistory[manager.entryId] || [];

        manager.gameweeks.forEach((gw: any, idx: number) => {
            scores.push(gw.points);

            // Highest/Lowest GW scores
            highestGW = updateRecordWithTies(highestGW, manager.name, gw.points, { gw: gw.event });
            lowestGW = updateRecordWithTiesLow(lowestGW, manager.name, gw.points, { gw: gw.event });

            // Transfers
            totalTransfers += gw.event_transfers || 0;

            // Transfer hits (single GW)
            const hitCost = gw.event_transfers_cost || 0;
            biggestHit = updateRecordWithTies(biggestHit, manager.name, hitCost, { gw: gw.event });

            // Team value tracking (value is in tenths, e.g. 1000 = £100.0m)
            const teamValue = gw.value || 0;
            highestTeamValue = updateRecordWithTies(highestTeamValue, manager.name, teamValue, { gw: gw.event });
            if (teamValue > 0) {
                lowestTeamValue = updateRecordWithTiesLow(lowestTeamValue, manager.name, teamValue, { gw: gw.event });
            }

            // Bench points from history (points_on_bench field if available)
            // Check for BB chip usage - exclude those weeks
            const usedBB = manager.chips?.some((c: any) => c.name === 'bboost' && c.event === gw.event);
            if (!usedBB && gw.points_on_bench !== undefined && gw.points_on_bench > 0) {
                biggestBenchHaul = updateRecordWithTies(biggestBenchHaul, manager.name, gw.points_on_bench, { gw: gw.event });
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
    histories.forEach((m: any) => loserCounts[m.name] = 0);
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
    histories.forEach((m: any) => motmCounts[m.name] = 0);
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
    histories.forEach((m: any) => gwWinCounts[m.name] = 0);

    // Group all managers' scores by GW
    const allGWs = new Set<any>();
    histories.forEach((m: any) => m.gameweeks.forEach((gw: any) => allGWs.add(gw.event)));

    for (const gwNum of allGWs) {
        let maxScore = -Infinity;
        let winners: any[] = [];
        histories.forEach((m: any) => {
            const gw = m.gameweeks.find((g: any) => g.event === gwNum);
            if (!gw) return;
            if (gw.points > maxScore) {
                maxScore = gw.points;
                winners = [m.name];
            } else if (gw.points === maxScore) {
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

    // Pre-build a score lookup: managerName -> { gwNum -> points }
    const scoreByGW: any = {};
    histories.forEach((m: any) => {
        scoreByGW[m.name] = {};
        m.gameweeks.forEach((gw: any) => {
            scoreByGW[m.name][gw.event] = gw.points;
        });
    });

    let longestFormStreak: any = { names: [], value: 0 };
    const managerNames = histories.map((m: any) => m.name);

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
    console.log('[HoF] Calculating perfect chip usage...');
    const chipAwards = await calculatePerfectChipUsage(histories);
    console.log(`[HoF] Found ${chipAwards.perfectBB.length} perfect BB, ${chipAwards.perfectTC.length} perfect TC, worst BB: ${chipAwards.worstBB ? 'yes' : 'no'}, worst TC: ${chipAwards.worstTC ? 'yes' : 'no'}`);

    // Get best/worst tinkering from cache (populated as users browse week modal)
    // This avoids expensive API calls during Hall of Fame calculation
    let bestTinkering: any = { names: [], value: -Infinity, gw: 0 };
    let worstTinkering: any = { names: [], value: Infinity, gw: 0 };

    const entryIdToName: any = {};
    histories.forEach((m: any) => entryIdToName[m.entryId] = m.name);

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
