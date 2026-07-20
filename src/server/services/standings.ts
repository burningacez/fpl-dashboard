/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, fetchLiveGWData, fetchManagerPicks, fetchManagerHistory, fetchLeagueData } from '../fpl/client';
import { calculatePointsWithAutoSubs } from '../services/scoring';

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

    const detailedStandings: any[] = await Promise.all(
        managers.map(async (m: any) => {
            const history = await fetchManagerHistory(m.entry);
            const totalTransferCost = history.current.reduce((sum: number, gw: any) => sum + gw.event_transfers_cost, 0);
            const totalTransfers = history.current.reduce((sum: number, gw: any) => sum + gw.event_transfers, 0);

            // FPL's per-manager /entry/{id}/history/ is the canonical source
            // for the season net total. Unlike the classic-league standings
            // endpoint (m.total), which rebuilds on a slow schedule and can lag
            // by an hour+ behind bonus/defcon corrections, the per-manager
            // endpoint reflects each correction as soon as FPL applies it.
            const latestEntry = history.current[history.current.length - 1];
            let netScore = latestEntry?.total_points ?? m.total ?? 0;

            // While the current GW is live, FPL hasn't computed its final
            // contribution yet. Recompute it from picks + live data, deducting
            // the hit, and substitute that for the latest entry's stale total.
            if (isLive && liveData && latestEntry?.event === currentGW) {
                try {
                    const picks = await fetchManagerPicks(m.entry, currentGW);
                    const calculated = calculatePointsWithAutoSubs(picks, liveData, bootstrap, gwFixtures);
                    const liveTransferCost = picks.entry_history?.event_transfers_cost || 0;
                    // calculated.totalPoints is GROSS (calculatePointsWithAutoSubs
                    // never deducts transfer cost). Convert to NET before adding
                    // it on top of the prior GW's net cumulative.
                    const netGWPoints = calculated.totalPoints - liveTransferCost;
                    const priorEntry = currentGW > 1
                        ? history.current.find((h: any) => h.event === currentGW - 1)
                        : null;
                    const priorTotal = priorEntry?.total_points || 0;
                    netScore = priorTotal + netGWPoints;
                } catch (e) {
                    // Keep history.total_points fallback
                }
            }

            const grossScore = netScore + totalTransferCost;

            // Get team value from the most recent gameweek
            const latestGW = history.current[history.current.length - 1];
            const teamValue = latestGW ? (latestGW.value / 10).toFixed(1) : '100.0';

            // Previous week's net total for rank-movement comparison. Use
            // total_points at the prior GW directly (always net of hits) instead
            // of summing h.points and re-subtracting cost.
            const prevGW = currentGW > 1 ? history.current.find((h: any) => h.event === currentGW - 1) : null;
            const prevNetScore = prevGW?.total_points || 0;

            return {
                rank: m.rank, name: m.player_name, team: m.entry_name, entryId: m.entry,
                grossScore, totalTransfers, transferCost: totalTransferCost, netScore,
                teamValue, prevNetScore
            };
        })
    );

    // Re-sort by net score and update ranks
    detailedStandings.sort((a, b) => b.netScore - a.netScore);
    detailedStandings.forEach((s, i) => s.rank = i + 1);

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
