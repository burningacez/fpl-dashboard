/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

import { calculateLeagueRankHistory } from './h2h';
import type { StoredManagerSeason } from './season-scores';

// Pre-calculate all manager profiles from the stored week rows (completed GWs)
export function preCalculateManagerProfiles(leagueData: any, seasons: StoredManagerSeason[], losersData: any, motmData: any, chipsData: any = null): any {
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
    const leagueRankHistory = calculateLeagueRankHistory(seasons);

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

    seasons.forEach((manager) => {
        const gwData = manager.gameweeks;
        if (!gwData || gwData.length === 0) return;

        // Calculate season records from history
        let highest = { points: -Infinity, gw: 0 };
        let lowest = { points: Infinity, gw: 0 };
        let totalPoints = 0;
        let totalTransfers = 0;
        let transferHits = 0;

        gwData.forEach((gw) => {
            if (gw.score > highest.points) {
                highest = { points: gw.score, gw: gw.event };
            }
            if (gw.score < lowest.points) {
                lowest = { points: gw.score, gw: gw.event };
            }
            totalPoints += gw.score;
            totalTransfers += gw.transfers;
            transferHits += gw.transferCost;
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
