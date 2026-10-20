/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';

import { fetchBootstrap, fetchFixtures, fetchLeagueData, getCompletedGameweeks } from '../fpl/client';
import { dataCache } from '../data-cache';
import { bakeOverallTotals, bakeAttackingTotals } from '../../lib/overall-totals';
import { fetchManagerPicksDetailed } from './picks';
import { weekRowFromPicks } from './season-scores';

/**
 * Write one completed gameweek's stored rows (dataCache.weekHistoryCache[gw])
 * from the processed picks cache. This is the record every season-long view
 * reads: the week page, standings, earnings, MotM, form, H2H, profiles and
 * the Hall of Fame. `noEntry` lists managers FPL has no team for that week
 * (joined later in the season) so they aren't fetched again every refresh.
 *
 * Callers bake the running totals once they have stored every GW they touch.
 */
export function storeGameweek(gw: number, managers: any[], bootstrap: any, leagueName: string, noEntry: number[] = []): boolean {
    const weekManagers: any[] = [];
    for (const m of managers) {
        const cached = dataCache.processedPicksCache[`${m.entry}-${gw}`];
        if (cached) weekManagers.push(weekRowFromPicks(m, cached));
    }
    if (weekManagers.length === 0) return false;

    weekManagers.sort((a, b) => b.gwScore - a.gwScore);
    weekManagers.forEach((m, i) => m.gwRank = i + 1);

    const plTeams = bootstrap.teams.map((t: any) => ({
        id: t.id, name: t.name, shortName: t.short_name
    })).sort((a: any, b: any) => a.name.localeCompare(b.name));

    const elementsById: any = {};
    bootstrap.elements.forEach((e: any) => { elementsById[e.id] = e; });

    // Squad players map for the highlight feature
    const squadPlayers: any = {};
    weekManagers.forEach(m => {
        [...(m.starting11 || []), ...(m.benchPlayerIds || [])].forEach(elementId => {
            if (!squadPlayers[elementId]) {
                const element = elementsById[elementId];
                if (element) {
                    squadPlayers[elementId] = {
                        name: element.web_name,
                        positionId: element.element_type,
                        teamId: element.team
                    };
                }
            }
        });
    });

    dataCache.weekHistoryCache[gw] = {
        leagueName,
        viewingGW: gw,
        managers: weekManagers,
        squadPlayers,
        plTeams,
        noEntry,
    };
    return true;
}

/** Materialise the cumulative Total + rank and running goals/assists onto every stored GW. */
export function bakeStoredTotals(): void {
    bakeOverallTotals(dataCache.weekHistoryCache);
    bakeAttackingTotals(dataCache.weekHistoryCache);
}

let ensureInFlight: Promise<void> | null = null;

/**
 * Make sure every completed gameweek has a stored row for every manager who
 * played it, fetching whatever processed picks are missing (a newly completed
 * GW, or one invalidated for FPL's bonus/defcon corrections).
 *
 * The rows are then rebuilt from the processed picks every time — a pure,
 * cheap transform with no fetching — so a stored row can never lag the picks
 * it came from (the live week page rewrites the current GW's picks while a
 * provisionally-finished week settles).
 *
 * Throws when a row can't be stored, so callers fail and keep their last good
 * payload rather than publish a season total with a gameweek missing.
 */
export function ensureStoredWeeks(): Promise<void> {
    // Standings, losers, MotM and earnings are built in parallel and each
    // calls this — share one pass instead of fetching the same picks 4 times.
    if (!ensureInFlight) {
        ensureInFlight = ensureStoredWeeksInner().finally(() => { ensureInFlight = null; });
    }
    return ensureInFlight;
}

async function ensureStoredWeeksInner(): Promise<void> {
    const [bootstrap, fixtures, league]: [any, any, any] = await Promise.all([fetchBootstrap(), fetchFixtures(), fetchLeagueData()]);
    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
    const managers = league.standings?.results || [];
    const leagueName = league.league?.name || '';

    const failures: string[] = [];
    let fetched = 0;

    for (const gw of completedGWs) {
        const noEntry = new Set<number>(dataCache.weekHistoryCache[gw]?.noEntry ?? []);
        const failuresBefore = failures.length;

        // Sequential, like the other completed-GW builders, to stay inside
        // FPL's rate limits when a whole gameweek needs fetching.
        for (const m of managers) {
            const key = `${m.entry}-${gw}`;
            if (dataCache.processedPicksCache[key] || noEntry.has(m.entry)) continue;
            try {
                dataCache.processedPicksCache[key] = await fetchManagerPicksDetailed(m.entry, gw, bootstrap);
                fetched++;
            } catch (e: any) {
                if (e?.status === 404) {
                    // No team that week (joined later): scores nothing, by FPL's rules too.
                    noEntry.add(m.entry);
                } else {
                    failures.push(`${m.player_name} GW${gw}: ${e.message}`);
                }
            }
        }

        // A manager's picks couldn't be fetched: keep the GW's last stored
        // rows rather than overwrite them with that manager missing.
        if (failures.length === failuresBefore) {
            storeGameweek(gw, managers, bootstrap, leagueName, [...noEntry]);
        }
    }

    if (completedGWs.length > 0) bakeStoredTotals();
    if (fetched > 0) console.log(`[StoredWeeks] Fetched ${fetched} missing pick set(s)`);
    if (failures.length > 0) {
        throw new Error(`Stored gameweek scores incomplete (${failures.length}): ${failures.slice(0, 3).join('; ')}`);
    }
}
