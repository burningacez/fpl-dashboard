/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, fetchLeagueData, getCompletedGameweeks } from '../fpl/client';
import { dataCache, getOrCreateCoinFlip } from '../data-cache';
import { seasonFromWeekHistory, type StoredGameweek } from './season-scores';
import { ensureStoredWeeks } from './stored-weeks';
import { getActiveSeasonConfig } from '../season-state';
import { getLoserOverrides } from '../loser-overrides';

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

    // Every completed gameweek from the stored week rows: net points, the
    // goals/assists the attacking tiebreak uses and the transfer count, all
    // as the week page shows them. A manager with no team that week (joined
    // later) has no stored row and scores 0, as FPL scores them.
    await ensureStoredWeeks();
    const seasons = seasonFromWeekHistory(dataCache.weekHistoryCache, managers, completedGameweeks);
    const gwStats = (gameweeks: StoredGameweek[], gw: number) => {
        const row = gameweeks.find((g) => g.event === gw);
        return { points: row?.score ?? 0, goals: row?.goals ?? 0, assists: row?.assists ?? 0, transfers: row?.transfers ?? 0 };
    };

    // Build weekly losers data with calculated points
    const weeklyLosers: any[] = [];
    for (const gw of completedGameweeks) {
        // Get all managers' scores for this GW
        const gwScores = seasons.map((manager) => ({
            name: manager.name,
            team: manager.team,
            entry: manager.entryId,
            ...gwStats(manager.gameweeks, gw),
        }));

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
        const managersData = seasons.map((manager) => ({
            entry: manager.entryId,
            name: manager.name,
            team: manager.team,
            ...gwStats(manager.gameweeks, gw),
        }));
        allGameweeks[gw] = {
            managers: managersData.sort((a, b) => a.points - b.points),
            // The client fudge keys on the display name in the payload.
            overrideName: managersData.find((m) => m.entry === overrideEntry)?.name ?? null
        };
    }

    return { leagueName: leagueData.league.name, losers: weeklyLosers, allGameweeks };
}
