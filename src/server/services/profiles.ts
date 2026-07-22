/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

import { fetchBootstrap, fetchManagerPicks, fetchLiveGWData } from '../fpl/client';
import { calculateLeagueRankHistory } from './h2h';

// Pre-calculate all manager profiles using already-fetched data
export async function preCalculateManagerProfiles(leagueData: any, histories: any, losersData: any, motmData: any, chipsData: any = null): Promise<any> {
    const profiles: any = {};
    const managers = leagueData.standings.results;

    // Map per-manager chip status (from fetchChipsData) by entryId so the
    // profile modal can show each manager's chip usage per season half.
    const chipsByEntry: Record<string, any> = {};
    if (chipsData?.managers) {
        chipsData.managers.forEach((m: any) => {
            if (m.entryId != null) chipsByEntry[m.entryId] = m.chips;
        });
    }

    // Calculate league rank history for all managers
    const leagueRankHistory = calculateLeagueRankHistory(histories);

    // Count losses per manager
    const loserCounts: any = {};
    managers.forEach((m: any) => loserCounts[m.player_name] = 0);
    if (losersData?.losers) {
        losersData.losers.forEach((l: any) => {
            if (loserCounts[l.name] !== undefined) {
                loserCounts[l.name]++;
            }
        });
    }

    // Count MotM wins per manager
    const motmCounts: any = {};
    managers.forEach((m: any) => motmCounts[m.player_name] = 0);
    if (motmData?.winners) {
        motmData.winners.forEach((w: any) => {
            if (w.winner?.name && motmCounts[w.winner.name] !== undefined) {
                motmCounts[w.winner.name]++;
            }
        });
    }

    histories.forEach((manager: any) => {
        const gwData = manager.gameweeks;
        if (!gwData || gwData.length === 0) return;

        // Calculate season records from history
        let highest = { points: 0, gw: 0 };
        let lowest = { points: Infinity, gw: 0 };
        let totalPoints = 0;
        let totalTransfers = 0;
        let transferHits = 0;

        gwData.forEach((gw: any) => {
            if (gw.points > highest.points) {
                highest = { points: gw.points, gw: gw.event };
            }
            if (gw.points < lowest.points) {
                lowest = { points: gw.points, gw: gw.event };
            }
            totalPoints += gw.points;
            totalTransfers += gw.event_transfers || 0;
            transferHits += gw.event_transfers_cost || 0;
        });

        if (lowest.points === Infinity) lowest = { points: 0, gw: 0 };

        // Get current league standing
        const standing = managers.find((m: any) => m.entry === manager.entryId);
        const currentLeagueRank = standing?.rank || 0;

        // Get best league rank from history
        const rankHist = leagueRankHistory[manager.entryId] || [];
        const bestLeagueRank = rankHist.length > 0 ? Math.min(...rankHist.map((r: any) => r.rank)) : currentLeagueRank;

        profiles[manager.entryId] = {
            entryId: manager.entryId,
            name: manager.name,
            team: manager.team,
            history: rankHist,
            records: {
                highestGW: highest,
                lowestGW: lowest,
                bestRank: bestLeagueRank,
                currentRank: currentLeagueRank,
                avgScore: Math.round(totalPoints / gwData.length * 10) / 10,
                totalTransfers,
                transferHits
            },
            loserCount: loserCounts[manager.name] || 0,
            motmWins: motmCounts[manager.name] || 0,
            chips: chipsByEntry[manager.entryId] || null
        };
    });

    return profiles;
}

// =============================================================================
// HALL OF FAME DATA (Pre-calculated during refresh)
// =============================================================================
// Note: formatTiedNames, updateRecordWithTies, updateRecordWithTiesLow are imported from lib/utils.js

// Calculate perfect chip usage for BB and TC
export async function calculatePerfectChipUsage(histories: any): Promise<any> {
    const perfectBB: any[] = [];
    const perfectTC: any[] = [];
    let worstBB: any = null;
    let worstTC: any = null;

    // Get bootstrap for player data
    let bootstrap: any;
    try {
        bootstrap = await fetchBootstrap();
    } catch (e: any) {
        console.error('[HoF] Failed to fetch bootstrap for chip calc:', e.message);
        return { perfectBB, perfectTC, worstBB, worstTC };
    }

    for (const manager of histories) {
        const bbChip = manager.chips?.find((c: any) => c.name === 'bboost');
        const tcChip = manager.chips?.find((c: any) => c.name === '3xc');

        // Calculate Perfect BB
        if (bbChip) {
            try {
                // Get the manager's bench points for non-BB weeks
                const nonBBWeeks = manager.gameweeks.filter((gw: any) => gw.event !== bbChip.event);
                const maxNonBBBench = Math.max(...nonBBWeeks.map((gw: any) => gw.points_on_bench || 0));

                // Fetch picks for BB week to calculate what bench scored
                const bbPicks: any = await fetchManagerPicks(manager.entryId, bbChip.event);
                if (bbPicks?.picks) {
                    // Get bench players (positions 12-15)
                    const benchPlayers = bbPicks.picks.slice(11);

                    // Fetch live data for that GW to get their points
                    const liveData: any = await fetchLiveGWData(bbChip.event);

                    let bbBenchPoints = 0;
                    benchPlayers.forEach((pick: any) => {
                        const liveEl = liveData?.elements?.find((e: any) => e.id === pick.element);
                        bbBenchPoints += liveEl?.stats?.total_points || 0;
                    });

                    // If BB week bench >= max other week's bench, it was a perfect use
                    if (bbBenchPoints >= maxNonBBBench && bbBenchPoints > 0) {
                        perfectBB.push({
                            name: manager.name,
                            gw: bbChip.event,
                            benchPoints: bbBenchPoints,
                            maxOtherBench: maxNonBBBench
                        });
                    }

                    // Track worst BB usage (lowest bench points on BB week)
                    if (worstBB === null || bbBenchPoints < worstBB.benchPoints) {
                        worstBB = { names: [manager.name], benchPoints: bbBenchPoints, gw: bbChip.event };
                    } else if (bbBenchPoints === worstBB.benchPoints) {
                        if (!worstBB.names.includes(manager.name)) worstBB.names.push(manager.name);
                    }
                }
            } catch (e: any) {
                console.error(`[HoF] BB calc error for ${manager.name}:`, e.message);
            }
        }

        // Calculate Perfect TC
        if (tcChip) {
            try {
                // Fetch picks for TC week
                const tcPicks: any = await fetchManagerPicks(manager.entryId, tcChip.event);
                if (tcPicks?.picks) {
                    const captain = tcPicks.picks.find((p: any) => p.is_captain);
                    if (captain) {
                        // Get captain's points
                        const liveData: any = await fetchLiveGWData(tcChip.event);
                        const captainLive = liveData?.elements?.find((e: any) => e.id === captain.element);
                        const tcCaptainPoints = captainLive?.stats?.total_points || 0;

                        // Compare to captain points from other weeks
                        // We need to fetch picks for other weeks to compare captain performance
                        // This is expensive, so we'll only compare to a sample of weeks
                        const completedGWs = manager.gameweeks.map((gw: any) => gw.event).filter((e: any) => e !== tcChip.event);

                        // Sample 5 random GWs to check captain performance
                        const sampleGWs = completedGWs.sort(() => 0.5 - Math.random()).slice(0, 5);

                        let maxOtherCaptainPts = 0;
                        for (const gw of sampleGWs) {
                            try {
                                const gwPicks: any = await fetchManagerPicks(manager.entryId, gw);
                                const gwCaptain = gwPicks?.picks?.find((p: any) => p.is_captain);
                                if (gwCaptain) {
                                    const gwLive: any = await fetchLiveGWData(gw);
                                    const gwCaptainLive = gwLive?.elements?.find((e: any) => e.id === gwCaptain.element);
                                    const pts = gwCaptainLive?.stats?.total_points || 0;
                                    if (pts > maxOtherCaptainPts) maxOtherCaptainPts = pts;
                                }
                            } catch (e) {
                                // Skip failed weeks
                            }
                        }

                        // If TC captain scored >= max sampled captain, likely a good use
                        if (tcCaptainPoints >= maxOtherCaptainPts && tcCaptainPoints >= 10) {
                            perfectTC.push({
                                name: manager.name,
                                gw: tcChip.event,
                                captainPoints: tcCaptainPoints,
                                player: bootstrap.elements?.find((e: any) => e.id === captain.element)?.web_name || 'Unknown'
                            });
                        }

                        // Track worst TC usage (lowest captain points on TC week)
                        const tcPlayerName = bootstrap.elements?.find((e: any) => e.id === captain.element)?.web_name || 'Unknown';
                        if (worstTC === null || tcCaptainPoints < worstTC.captainPoints) {
                            worstTC = { names: [manager.name], captainPoints: tcCaptainPoints, gw: tcChip.event, player: tcPlayerName };
                        } else if (tcCaptainPoints === worstTC.captainPoints) {
                            if (!worstTC.names.includes(manager.name)) worstTC.names.push(manager.name);
                        }
                    }
                }
            } catch (e: any) {
                console.error(`[HoF] TC calc error for ${manager.name}:`, e.message);
            }
        }
    }

    return { perfectBB, perfectTC, worstBB, worstTC };
}
