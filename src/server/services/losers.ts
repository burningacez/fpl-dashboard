/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, fetchManagerHistory, fetchLeagueData, getCompletedGameweeks } from '../fpl/client';
import { dataCache, getOrCreateCoinFlip } from '../data-cache';
import { fetchManagerPicksDetailed } from '../services/picks';
import { getActiveSeasonConfig } from '../season-state';
import { getLoserOverrides } from '../loser-overrides';
import { attackingFromDetailedPicks, NO_ATTACKING } from '../../lib/attacking-stats';

export async function fetchWeeklyLosers() {
    // GW → entry id manual corrections (server-only module).
    const seasonConfig = getActiveSeasonConfig();
    const LOSER_OVERRIDES = getLoserOverrides(seasonConfig.id);
    // From 2026-27 a points tie is settled on attacking returns before
    // transfers. Seasons played without that rule keep their original losers.
    const useAttacking = !!seasonConfig.attackingTiebreakers;
    const [leagueData, bootstrap, fixtures] = await Promise.all([fetchLeagueData(), fetchBootstrap(), fetchFixtures()]);
    const completedGameweeks = getCompletedGameweeks(bootstrap, fixtures);
    const managers = leagueData.standings.results;

    // Fetch histories for transfer data (still needed for tiebreakers)
    const histories = await Promise.all(
        managers.map(async (m: any) => {
            const history = await fetchManagerHistory(m.entry);
            return { entry: m.entry, name: m.player_name, team: m.entry_name, gameweeks: history.current };
        })
    );

    // Calculate net points (gross GW score minus transfer cost) using the same
    // method as pitch view. Ranking and display use net so a manager who took
    // hits can be the loser.
    // IMPORTANT: must include totalProvisionalBonus. For a GW that is
    // finished_provisional but not officially finished, live stats.total_points
    // excludes bonus (held separately in totalProvisionalBonus). Once FPL
    // confirms, total_points absorbs bonus and totalProvisionalBonus drops to 0,
    // so adding it is a no-op for fully finalized GWs.
    // Net points plus the goals/assists the same squad returned, so the modal
    // table and the tiebreak chain read from one calculation.
    const getGwStats = async (entryId: any, gw: any) => {
        const netOf = (data: any) =>
            (data.calculatedPoints || 0) + (data.totalProvisionalBonus || 0) - (data.transfersCost || 0);

        // Check cache first
        const cacheKey = `${entryId}-${gw}`;
        const cached: any = dataCache.processedPicksCache[cacheKey];
        if (cached?.calculatedPoints !== undefined) {
            return { points: netOf(cached), ...attackingFromDetailedPicks(cached) };
        }

        // Cache miss - calculate fresh (same as pitch view)
        try {
            const data = await fetchManagerPicksDetailed(entryId, gw, bootstrap);
            // Cache it for future use
            dataCache.processedPicksCache[cacheKey] = data;
            return { points: netOf(data), ...attackingFromDetailedPicks(data) };
        } catch (e) {
            // Fallback to history API if calculation fails.
            // history.current.points is already net of transfer cost.
            // No squad detail means no goals/assists — the chain falls through
            // to transfers, as it did before they were tiebreakers.
            const manager = histories.find(h => h.entry === entryId);
            const gwData = manager?.gameweeks.find((g: any) => g.event === gw);
            return { points: gwData?.points || 0, ...NO_ATTACKING };
        }
    };

    // Build weekly losers data with calculated points
    const weeklyLosers: any[] = [];
    for (const gw of completedGameweeks) {
        // Get all managers' scores for this GW
        const gwScores = await Promise.all(
            histories.map(async manager => {
                const gwData = manager.gameweeks.find((g: any) => g.event === gw);
                const stats = await getGwStats(manager.entry, gw);
                return {
                    name: manager.name,
                    team: manager.team,
                    entry: manager.entry,
                    points: stats.points,
                    goals: stats.goals,
                    assists: stats.assists,
                    transfers: gwData?.event_transfers || 0
                };
            })
        );

        gwScores.sort((a, b) => a.points - b.points);

        if (gwScores.length === 0) continue;

        const lowestPoints = gwScores[0].points;
        const secondLowestPoints = gwScores.find(m => m.points > lowestPoints)?.points || lowestPoints;

        // Find tied managers at lowest score
        const tiedManagers = gwScores.filter(m => m.points === lowestPoints);

        // Check for override - show as "Lost by 1 pt" to match fudged display
        if (LOSER_OVERRIDES[gw]) {
            const overrideEntry = LOSER_OVERRIDES[gw];
            const overrideManager = gwScores.find(m => m.entry === overrideEntry);
            if (overrideManager) {
                weeklyLosers.push({
                    gameweek: gw,
                    name: overrideManager.name,
                    team: overrideManager.team,
                    points: lowestPoints - 1,
                    isOverride: true,
                    context: 'Lost by 1 pt',
                    // entryId added for my-team highlighting (rewrite deviation)
                    entry: overrideManager.entry
                });
                continue;
            }
        }

        if (tiedManagers.length === 0) continue;

        // Determine context
        let context = '';
        let loser;

        if (tiedManagers.length === 1) {
            // Clear loser by points
            const margin = secondLowestPoints - lowestPoints;
            context = `Lost by ${margin} pt${margin !== 1 ? 's' : ''}`;
            loser = tiedManagers[0];
        } else {
            // Tie — the worst attacking week loses first (2026-27 onwards),
            // then the biggest tinkerer, then the persistent coin flip.
            tiedManagers.sort((a, b) => {
                if (useAttacking) {
                    if (a.goals !== b.goals) return a.goals - b.goals;
                    if (a.assists !== b.assists) return a.assists - b.assists;
                }
                if (a.transfers !== b.transfers) return b.transfers - a.transfers;
                // Persistent coin flip: higher value = loser (sorted to front)
                return getOrCreateCoinFlip('losers', gw, b.name) - getOrCreateCoinFlip('losers', gw, a.name);
            });
            loser = tiedManagers[0];

            const [first, second] = tiedManagers;
            if (useAttacking && first.goals < second.goals) {
                context = 'Fewest goals';
            } else if (useAttacking && first.assists < second.assists) {
                context = 'Fewest assists';
            } else if (first.transfers > second.transfers) {
                context = 'More transfers';
            } else {
                context = 'Tiebreaker';
            }
        }

        weeklyLosers.push({
            gameweek: gw,
            name: loser.name,
            team: loser.team,
            points: loser.points,
            context,
            // entryId added for my-team highlighting (rewrite deviation)
            entry: loser.entry
        });
    }

    // Build allGameweeks data for modal display
    const allGameweeks: any = {};
    for (const gw of completedGameweeks) {
        const overrideEntry = LOSER_OVERRIDES[gw];
        const managersData = await Promise.all(
            histories.map(async manager => {
                const gwData = manager.gameweeks.find((g: any) => g.event === gw);
                const stats = await getGwStats(manager.entry, gw);
                return {
                    entry: manager.entry,
                    name: manager.name,
                    team: manager.team,
                    points: stats.points,
                    goals: stats.goals,
                    assists: stats.assists,
                    transfers: gwData?.event_transfers || 0
                };
            })
        );
        allGameweeks[gw] = {
            managers: managersData.sort((a, b) => a.points - b.points),
            // The client fudge keys on the display name in the payload.
            overrideName: managersData.find((m) => m.entry === overrideEntry)?.name ?? null
        };
    }

    return { leagueName: leagueData.league.name, losers: weeklyLosers, allGameweeks };
}
