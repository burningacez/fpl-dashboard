/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, fetchLiveGWData, fetchManagerPicks, fetchLeagueData, getCompletedGameweeks } from '../fpl/client';
import { calculatePointsWithAutoSubs } from '../services/scoring';
import { dataCache, getOrCreateCoinFlip } from '../data-cache';
import { getActiveSeasonConfig } from '../season-state';
import { rankFinalStandings } from '../../lib/final-standings';
import { seasonFromWeekHistory, seasonTotals } from './season-scores';
import { ensureStoredWeeks } from './stored-weeks';

/**
 * Order the league table and (re-)number its ranks, in place.
 *
 * Exported so refreshAllData can re-apply it with the losers/MotM payloads it
 * has just computed — standings, losers and MotM are built in parallel, so the
 * snapshots visible during the build can be one refresh behind.
 */
export function applyFinalStandingsOrder(standings: any[], losers: any, motm: any): any[] {
    const seasonConfig = getActiveSeasonConfig();
    rankFinalStandings(standings, {
        score: (s) => s.netScore,
        enabled: !!seasonConfig.attackingTiebreakers,
        losers,
        motm,
        coinFlip: (s) => getOrCreateCoinFlip('standings', seasonConfig.id, s.name),
    });
    standings.forEach((s, i) => (s.rank = i + 1));
    return standings;
}

export async function fetchStandingsWithTransfers() {
    const [leagueData, bootstrap, fixtures] = await Promise.all([
        fetchLeagueData(),
        fetchBootstrap(),
        fetchFixtures()
    ]);
    const managers = leagueData.standings.results;

    // Check if current GW is live (deadline passed but not finished)
    const currentGWEvent = bootstrap.events.find(e => e.is_current);
    const currentGW = currentGWEvent?.id || 0;
    const now = new Date();
    const gwDeadline = currentGWEvent ? new Date(currentGWEvent.deadline_time) : null;
    const isLive = currentGWEvent && !currentGWEvent.finished && gwDeadline && now > gwDeadline;

    // Fetch live data if GW is in progress
    let liveData: any = null;
    let gwFixtures: any[] = [];
    if (isLive) {
        try {
            liveData = await fetchLiveGWData(currentGW);
            gwFixtures = fixtures.filter(f => f.event === currentGW);
        } catch (e: any) {
            console.error('[Standings] Failed to fetch live data:', e.message);
        }
    }

    // Completed gameweeks come from the stored week rows — the same scores
    // the week page shows. Only an in-progress gameweek is scored live here.
    await ensureStoredWeeks();
    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
    const seasons = new Map(
        seasonFromWeekHistory(dataCache.weekHistoryCache, managers, completedGWs).map((s) => [s.entryId, s]),
    );
    const scoreLiveGW = isLive && liveData && !completedGWs.includes(currentGW);

    const detailedStandings: any[] = await Promise.all(
        managers.map(async (m: any) => {
            const stored = seasons.get(m.entry)?.gameweeks ?? [];
            const season = seasonTotals(stored);
            let { netScore, transferCost, transfers } = season;
            let teamValueTenths = season.latestTeamValue;

            // The in-progress gameweek, from picks + live data, net of its hit.
            if (scoreLiveGW) {
                try {
                    const picks = await fetchManagerPicks(m.entry, currentGW);
                    const calculated = calculatePointsWithAutoSubs(picks, liveData, bootstrap, gwFixtures);
                    const liveTransferCost = picks.entry_history?.event_transfers_cost || 0;
                    // calculated.totalPoints is GROSS (calculatePointsWithAutoSubs
                    // never deducts transfer cost).
                    netScore += calculated.totalPoints - liveTransferCost;
                    transferCost += liveTransferCost;
                    transfers += picks.entry_history?.event_transfers || 0;
                    if (picks.entry_history?.value != null) teamValueTenths = picks.entry_history.value;
                } catch (e) {
                    // Live GW unavailable for this manager — show the stored total
                }
            }

            const grossScore = netScore + transferCost;
            const teamValue = teamValueTenths != null ? (teamValueTenths / 10).toFixed(1) : '100.0';

            // Previous week's net total for rank-movement comparison.
            const prevNetScore = seasonTotals(stored, currentGW - 1).netScore;

            // Best and worst single gameweek for the final-standings chain:
            // completed weeks only, so a half-played week can't be "worst".
            return {
                rank: m.rank, name: m.player_name, team: m.entry_name, entryId: m.entry,
                grossScore, totalTransfers: transfers, transferCost, netScore,
                teamValue, prevNetScore, highestGW: season.highestGW, lowestGW: season.lowestGW
            };
        })
    );

    // Re-sort by net score and update ranks. From 2026-27 an equal net total
    // is settled by the published chain (MotM wins → goals → assists → weekly
    // losses → transfers → best GW → best worst GW → coin flip) instead of
    // being left in league order. The losers/MotM snapshots this reads are
    // whatever the last refresh stored; refreshAllData re-applies the ordering
    // with the freshly-computed pair once both are in hand.
    applyFinalStandingsOrder(detailedStandings, dataCache.losers, dataCache.motm);

    // Calculate previous week's ranks for movement indicators
    if (currentGW > 1) {
        const prevRanks = [...detailedStandings]
            .sort((a, b) => b.prevNetScore - a.prevNetScore)
            .map((s, i) => ({ entryId: s.entryId, prevRank: i + 1 }));

        detailedStandings.forEach(s => {
            const prev = prevRanks.find(p => p.entryId === s.entryId);
            s.prevRank = prev?.prevRank || s.rank;
            s.movement = s.prevRank - s.rank; // positive = moved up, negative = moved down
        });
    } else {
        detailedStandings.forEach(s => {
            s.prevRank = s.rank;
            s.movement = 0;
        });
    }

    return { leagueName: leagueData.league.name, standings: detailedStandings, currentGW };
}
