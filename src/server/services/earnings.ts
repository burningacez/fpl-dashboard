/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, fetchManagerHistory, fetchLeagueData, getCompletedGameweeks } from '../fpl/client';
import { calculateMotmRankings } from '../services/motm';
import { getActiveSeasonConfig } from '../season-state';
import { motmPeriodCount } from '../../lib/season-config';

export async function fetchProfitLossData() {
    const cfg = getActiveSeasonConfig();
    const LOSER_OVERRIDES = cfg.loserOverrides;
    const [leagueData, bootstrap, fixtures] = await Promise.all([fetchLeagueData(), fetchBootstrap(), fetchFixtures()]);
    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
    const seasonComplete = completedGWs.includes(cfg.totalWeeks);
    const managers = leagueData.standings.results;

    const histories = await Promise.all(
        managers.map(async (m: any) => {
            const history = await fetchManagerHistory(m.entry);
            return {
                name: m.player_name,
                team: m.entry_name,
                rank: m.rank,
                gameweeks: history.current
            };
        })
    );

    const weeklyLoserCounts: any = {};
    managers.forEach((m: any) => weeklyLoserCounts[m.player_name] = 0);

    completedGWs.forEach(gw => {
        let lowestPoints = Infinity;
        let loserName = null;
        histories.forEach(manager => {
            const gwData = manager.gameweeks.find((g: any) => g.event === gw);
            if (gwData && gwData.points < lowestPoints) {
                lowestPoints = gwData.points;
                loserName = manager.name;
            }
        });

        if (LOSER_OVERRIDES[gw]) {
            loserName = LOSER_OVERRIDES[gw];
        }

        if (loserName) weeklyLoserCounts[loserName]++;
    });

    const motmWinCounts: any = {};
    managers.forEach((m: any) => motmWinCounts[m.player_name] = 0);

    for (let p = 1; p <= motmPeriodCount(cfg); p++) {
        const result = calculateMotmRankings(histories, p, completedGWs);
        if (result.periodComplete && result.rankings.length > 0) {
            const winner = result.rankings[0];
            motmWinCounts[winner.name]++;
        }
    }

    const pnlData = managers.map((m: any) => {
        const weeklyLosses = weeklyLoserCounts[m.player_name] || 0;
        const motmWins = motmWinCounts[m.player_name] || 0;

        const weeklyLossesCost = weeklyLosses * cfg.weeklyLoserFine;
        const totalPaid = cfg.entryFee + weeklyLossesCost;

        const motmEarnings = motmWins * cfg.prizes.motmPerPeriod;
        let leagueFinish = 0;
        if (seasonComplete) {
            leagueFinish = cfg.prizes.league[m.rank - 1] || 0;
        }
        const cupWin = 0;
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
