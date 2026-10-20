/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, fetchLeagueData, fetchCupMatches, getCompletedGameweeks } from '../fpl/client';
import { calculateMotmRankings, storedRankingHistories } from '../services/motm';
import { fetchWeeklyLosers } from '../services/losers';
import { getActiveSeasonConfig } from '../season-state';
import { motmPeriodCount } from '../../lib/season-config';
import { rankFinalStandings } from '../../lib/final-standings';
import { dataCache, getOrCreateCoinFlip } from '../data-cache';
import { seasonFromWeekHistory, seasonTotals } from './season-scores';
import { ensureStoredWeeks } from './stored-weeks';

export async function fetchProfitLossData() {
    const cfg = getActiveSeasonConfig();
    const [leagueData, bootstrap, fixtures] = await Promise.all([fetchLeagueData(), fetchBootstrap(), fetchFixtures()]);
    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
    const seasonComplete = completedGWs.includes(cfg.totalWeeks);
    const managers = leagueData.standings.results;

    // Completed gameweeks from the stored week rows — the scores the week
    // page, standings and MotM page all show. The same ranking rows feed the
    // MotM prizes below, so the winner paid is the one the MotM page shows.
    await ensureStoredWeeks();
    const histories = storedRankingHistories(managers, completedGWs);
    const seasons = new Map(
        seasonFromWeekHistory(dataCache.weekHistoryCache, managers, completedGWs).map((s) => [s.entryId, s]),
    );

    // Weekly loser fines come from the Losers page's own computation so the two
    // can never disagree: calculated (auto-sub/bonus-aware) net points, the
    // most-transfers tiebreak, the persistent coin flip and loserOverrides are
    // all applied there. Count per entry id, falling back to name for archived
    // rows that predate entry ids in the payload.
    const losersData = await fetchWeeklyLosers();
    const weeklyLoserCounts: Record<string, number> = {};
    managers.forEach((m: any) => (weeklyLoserCounts[m.entry] = 0));
    losersData.losers.forEach((l: any) => {
        const key = l.entry ?? managers.find((m: any) => m.player_name === l.name)?.entry;
        if (key != null) weeklyLoserCounts[key] = (weeklyLoserCounts[key] || 0) + 1;
    });

    // The mini-league cup is an FPL-hosted H2H sub-league (league.cup_league).
    // The final is the last round's single match; once its gameweek completes,
    // that match's winner takes the cup prize.
    let cupWinnerEntry: number | null = null;
    try {
        const cupLeagueId = (leagueData as any)?.league?.cup_league;
        if (cupLeagueId) {
            const matches = await fetchCupMatches(cupLeagueId);
            const finalEvent = matches.reduce((max: number, m: any) => Math.max(max, m.event), 0);
            const finalMatches = matches.filter((m: any) => m.event === finalEvent);
            if (finalMatches.length === 1 && completedGWs.includes(finalEvent)) {
                cupWinnerEntry = finalMatches[0].winner;
            }
        }
    } catch {
        // Cup data unavailable — leave the prize unawarded rather than fail the page.
    }

    const motmWinCounts: any = {};
    managers.forEach((m: any) => motmWinCounts[m.player_name] = 0);

    for (let p = 1; p <= motmPeriodCount(cfg); p++) {
        const result = calculateMotmRankings(histories, p, completedGWs);
        if (result.periodComplete && result.rankings.length > 0) {
            const winner = result.rankings[0];
            motmWinCounts[winner.name]++;
        }
    }

    // League prize money follows the final standings, so from 2026-27 it has to
    // follow the published tiebreak chain rather than FPL's raw league rank
    // (which settles equal totals arbitrarily). Built here from data this
    // service already holds — the same inputs the standings table ranks on.
    // Seasons without the chain keep paying out on m.rank, untouched.
    const finalRankByEntry = new Map<number, number>();
    if (cfg.attackingTiebreakers) {
        const rows = managers.map((m: any) => {
            const totals = seasonTotals(seasons.get(m.entry)?.gameweeks ?? []);
            return {
                entryId: m.entry,
                name: m.player_name,
                netScore: totals.netScore,
                totalTransfers: totals.transfers,
                highestGW: totals.highestGW,
                lowestGW: totals.lowestGW,
            };
        });
        rankFinalStandings(rows, {
            score: (r) => r.netScore,
            enabled: true,
            losers: losersData,
            // Wins are already counted above, per period, from the same
            // calculateMotmRankings call that decides the MotM prizes.
            motmWins: new Map(managers.map((m: any) => [m.entry, motmWinCounts[m.player_name] || 0])),
            coinFlip: (r) => getOrCreateCoinFlip('standings', cfg.id, r.name),
        });
        rows.forEach((r: any, i: number) => finalRankByEntry.set(r.entryId, i + 1));
    }

    const pnlData = managers.map((m: any) => {
        const weeklyLosses = weeklyLoserCounts[m.entry] || 0;
        const motmWins = motmWinCounts[m.player_name] || 0;

        const weeklyLossesCost = weeklyLosses * cfg.weeklyLoserFine;
        const totalPaid = cfg.entryFee + weeklyLossesCost;

        const motmEarnings = motmWins * cfg.prizes.motmPerPeriod;
        let leagueFinish = 0;
        if (seasonComplete) {
            const finishPosition = finalRankByEntry.get(m.entry) ?? m.rank;
            leagueFinish = cfg.prizes.league[finishPosition - 1] || 0;
        }
        const cupWin = cupWinnerEntry !== null && m.entry === cupWinnerEntry ? cfg.prizes.cup : 0;
        const totalEarnings = leagueFinish + cupWin + motmEarnings;
        const netEarnings = totalEarnings - totalPaid;

        return {
            name: m.player_name,
            team: m.entry_name,
            weeklyLosses,
            weeklyLossesCost,
            motmWins,
            motmEarnings,
            leagueFinish,
            cupWin,
            totalPaid,
            totalEarnings,
            netEarnings,
            // entryId added for my-team highlighting (rewrite deviation)
            entryId: m.entry
        };
    });

    pnlData.sort((a: any, b: any) => b.netEarnings - a.netEarnings);

    return {
        leagueName: leagueData.league.name,
        managers: pnlData,
        seasonComplete,
        completedGWs: completedGWs.length
    };
}
