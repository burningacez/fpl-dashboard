const http = require('http');
const fs = require('fs');
const path = require('path');

const LEAGUE_ID = 619028;
const PORT = process.env.PORT || 3001;

const MOTM_PERIODS = {
    1: [1, 5], 2: [6, 9], 3: [10, 13], 4: [14, 17], 5: [18, 21],
    6: [22, 25], 7: [26, 29], 8: [30, 33], 9: [34, 38]
};

const ALL_CHIPS = ['wildcard', 'freehit', 'bboost', '3xc'];

// Manual overrides for weekly losers (corrections to API data)
const LOSER_OVERRIDES = {
    2: 'Grant Clark',      // GW2: Override Doug Stephenson -> Grant Clark
    12: 'James Armstrong'  // GW12: Override to James Armstrong
};

async function fetchLeagueData() {
    const response = await fetch(`https://fantasy.premierleague.com/api/leagues-classic/${LEAGUE_ID}/standings/`);
    return response.json();
}

async function fetchBootstrap() {
    const response = await fetch('https://fantasy.premierleague.com/api/bootstrap-static/');
    return response.json();
}

async function fetchManagerHistory(entryId) {
    const response = await fetch(`https://fantasy.premierleague.com/api/entry/${entryId}/history/`);
    return response.json();
}

async function fetchStandingsWithTransfers() {
    const leagueData = await fetchLeagueData();
    const managers = leagueData.standings.results;

    const detailedStandings = await Promise.all(
        managers.map(async m => {
            const history = await fetchManagerHistory(m.entry);
            const totalTransferCost = history.current.reduce((sum, gw) => sum + gw.event_transfers_cost, 0);
            const totalTransfers = history.current.reduce((sum, gw) => sum + gw.event_transfers, 0);
            const grossScore = m.total + totalTransferCost;

            return {
                rank: m.rank, name: m.player_name, team: m.entry_name,
                grossScore, totalTransfers, transferCost: totalTransferCost, netScore: m.total
            };
        })
    );

    return { leagueName: leagueData.league.name, standings: detailedStandings };
}

async function fetchWeeklyLosers() {
    const [leagueData, bootstrap] = await Promise.all([fetchLeagueData(), fetchBootstrap()]);
    const completedGameweeks = bootstrap.events.filter(e => e.finished).map(e => e.id);
    const managers = leagueData.standings.results;

    const histories = await Promise.all(
        managers.map(async m => {
            const history = await fetchManagerHistory(m.entry);
            return { name: m.player_name, team: m.entry_name, gameweeks: history.current };
        })
    );

    const weeklyLosers = completedGameweeks.map(gw => {
        let loser = null, lowestPoints = Infinity;
        histories.forEach(manager => {
            const gwData = manager.gameweeks.find(g => g.event === gw);
            if (gwData && gwData.points < lowestPoints) {
                lowestPoints = gwData.points;
                loser = { gameweek: gw, name: manager.name, team: manager.team, points: gwData.points };
            }
        });

        // Apply manual overrides
        if (loser && LOSER_OVERRIDES[gw]) {
            const overrideName = LOSER_OVERRIDES[gw];
            const overrideManager = histories.find(m => m.name === overrideName);
            if (overrideManager) {
                const gwData = overrideManager.gameweeks.find(g => g.event === gw);
                loser = { gameweek: gw, name: overrideManager.name, team: overrideManager.team, points: gwData?.points || loser.points };
            }
        }

        return loser;
    }).filter(Boolean);

    return { leagueName: leagueData.league.name, losers: weeklyLosers };
}

function calculateMotmRankings(managers, periodNum, completedGWs) {
    const [startGW, endGW] = MOTM_PERIODS[periodNum];
    const periodGWs = [];
    for (let gw = startGW; gw <= endGW; gw++) {
        if (completedGWs.includes(gw)) periodGWs.push(gw);
    }

    if (periodGWs.length === 0) {
        return { rankings: [], periodComplete: false, periodGWs: [], startGW, endGW };
    }

    const rankings = managers.map(manager => {
        const periodData = manager.gameweeks.filter(g => periodGWs.includes(g.event));
        const grossScore = periodData.reduce((sum, g) => sum + g.points, 0);
        const transferCost = periodData.reduce((sum, g) => sum + g.event_transfers_cost, 0);
        const transfers = periodData.reduce((sum, g) => sum + g.event_transfers, 0);
        const netScore = grossScore - transferCost;
        const gwScores = periodData.map(g => g.points).sort((a, b) => b - a);
        const highestGW = gwScores[0] || 0;
        const sortedAsc = [...gwScores].sort((a, b) => a - b);
        const lowestTwo = sortedAsc.slice(0, 2);

        return { name: manager.name, team: manager.team, netScore, grossScore, transfers, transferCost, highestGW, lowestTwo, coinFlip: Math.random() };
    });

    rankings.sort((a, b) => {
        if (b.netScore !== a.netScore) return b.netScore - a.netScore;
        if (a.transfers !== b.transfers) return a.transfers - b.transfers;
        if (b.highestGW !== a.highestGW) return b.highestGW - a.highestGW;
        for (let i = 0; i < Math.max(a.lowestTwo.length, b.lowestTwo.length); i++) {
            const aVal = a.lowestTwo[i] || 0, bVal = b.lowestTwo[i] || 0;
            if (bVal !== aVal) return bVal - aVal;
        }
        return b.coinFlip - a.coinFlip;
    });

    rankings.forEach((r, i) => r.rank = i + 1);
    const periodComplete = periodGWs.length === (endGW - startGW + 1);
    return { rankings, periodComplete, periodGWs, startGW, endGW };
}

async function fetchMotmData() {
    const [leagueData, bootstrap] = await Promise.all([fetchLeagueData(), fetchBootstrap()]);
    const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);
    const managers = leagueData.standings.results;

    const histories = await Promise.all(
        managers.map(async m => {
            const history = await fetchManagerHistory(m.entry);
            return { name: m.player_name, team: m.entry_name, gameweeks: history.current };
        })
    );

    const periods = {}, winners = [];
    for (let p = 1; p <= 9; p++) {
        const result = calculateMotmRankings(histories, p, completedGWs);
        periods[p] = result;
        if (result.rankings.length > 0 && result.periodComplete) {
            winners.push({ period: p, gwRange: `GW ${result.startGW}-${result.endGW}`, winner: result.rankings[0] });
        } else if (result.rankings.length > 0) {
            winners.push({ period: p, gwRange: `GW ${result.startGW}-${result.endGW}`, winner: null, inProgress: result.periodGWs.length > 0, completedGWs: result.periodGWs.length, totalGWs: result.endGW - result.startGW + 1 });
        }
    }

    return { leagueName: leagueData.league.name, periods, winners, completedGWs };
}

async function fetchChipsData() {
    const [leagueData, bootstrap] = await Promise.all([fetchLeagueData(), fetchBootstrap()]);
    const currentGW = bootstrap.events.find(e => e.is_current)?.id || 0;
    const managers = leagueData.standings.results;

    // 25/26 season: All 4 chips available GW1-19, then refresh for GW20-38
    const CHIP_TYPES = ['wildcard', 'freehit', 'bboost', '3xc'];

    const chipsData = await Promise.all(
        managers.map(async m => {
            const history = await fetchManagerHistory(m.entry);
            const usedChips = history.chips || [];

            const chipStatus = {
                firstHalf: {},  // GW 1-19
                secondHalf: {}  // GW 20-38
            };

            CHIP_TYPES.forEach(chipType => {
                // First half (GW 1-19)
                const usedFirstHalf = usedChips.find(c => c.name === chipType && c.event <= 19);
                if (usedFirstHalf) {
                    chipStatus.firstHalf[chipType] = { status: 'used', gw: usedFirstHalf.event };
                } else if (currentGW >= 20) {
                    chipStatus.firstHalf[chipType] = { status: 'expired' };
                } else {
                    chipStatus.firstHalf[chipType] = { status: 'available' };
                }

                // Second half (GW 20-38)
                const usedSecondHalf = usedChips.find(c => c.name === chipType && c.event >= 20);
                if (usedSecondHalf) {
                    chipStatus.secondHalf[chipType] = { status: 'used', gw: usedSecondHalf.event };
                } else if (currentGW >= 20) {
                    chipStatus.secondHalf[chipType] = { status: 'available' };
                } else {
                    chipStatus.secondHalf[chipType] = { status: 'locked' };
                }
            });

            return {
                name: m.player_name,
                team: m.entry_name,
                chips: chipStatus
            };
        })
    );

    return { leagueName: leagueData.league.name, managers: chipsData, currentGW };
}

async function fetchProfitLossData() {
    const [leagueData, bootstrap] = await Promise.all([fetchLeagueData(), fetchBootstrap()]);
    const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);
    const seasonComplete = completedGWs.includes(38);
    const managers = leagueData.standings.results;

    const histories = await Promise.all(
        managers.map(async m => {
            const history = await fetchManagerHistory(m.entry);
            return {
                name: m.player_name,
                team: m.entry_name,
                rank: m.rank,
                gameweeks: history.current
            };
        })
    );

    // Calculate weekly losers (with overrides)
    const weeklyLoserCounts = {};
    managers.forEach(m => weeklyLoserCounts[m.player_name] = 0);

    completedGWs.forEach(gw => {
        let lowestPoints = Infinity;
        let loserName = null;
        histories.forEach(manager => {
            const gwData = manager.gameweeks.find(g => g.event === gw);
            if (gwData && gwData.points < lowestPoints) {
                lowestPoints = gwData.points;
                loserName = manager.name;
            }
        });

        // Apply manual overrides
        if (LOSER_OVERRIDES[gw]) {
            loserName = LOSER_OVERRIDES[gw];
        }

        if (loserName) weeklyLoserCounts[loserName]++;
    });

    // Calculate MotM wins
    const motmWinCounts = {};
    managers.forEach(m => motmWinCounts[m.player_name] = 0);

    for (let p = 1; p <= 9; p++) {
        const result = calculateMotmRankings(histories, p, completedGWs);
        if (result.periodComplete && result.rankings.length > 0) {
            const winner = result.rankings[0];
            motmWinCounts[winner.name]++;
        }
    }

    // Build P&L data for each manager
    const pnlData = managers.map(m => {
        const weeklyLosses = weeklyLoserCounts[m.player_name] || 0;
        const motmWins = motmWinCounts[m.player_name] || 0;

        // Costs
        const weeklyLossesCost = weeklyLosses * 5;
        const totalPaid = 30 + weeklyLossesCost;

        // Earnings
        const motmEarnings = motmWins * 30;
        let leagueFinish = 0;
        if (seasonComplete) {
            if (m.rank === 1) leagueFinish = 320;
            else if (m.rank === 2) leagueFinish = 200;
            else if (m.rank === 3) leagueFinish = 120;
        }
        const cupWin = 0; // To be implemented later
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
            netEarnings
        };
    });

    // Sort by net earnings descending
    pnlData.sort((a, b) => b.netEarnings - a.netEarnings);

    return {
        leagueName: leagueData.league.name,
        managers: pnlData,
        seasonComplete,
        completedGWs: completedGWs.length
    };
}

function serveFile(res, filename, contentType = 'text/html') {
    try {
        const content = fs.readFileSync(path.join(__dirname, filename), 'utf8');
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    }
}

const server = http.createServer(async (req, res) => {
    const routes = {
        '/api/league': () => fetchLeagueData(),
        '/api/standings': () => fetchStandingsWithTransfers(),
        '/api/losers': () => fetchWeeklyLosers(),
        '/api/motm': () => fetchMotmData(),
        '/api/chips': () => fetchChipsData(),
        '/api/earnings': () => fetchProfitLossData(),
    };

    if (routes[req.url]) {
        try {
            const data = await routes[req.url]();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    } else if (req.url === '/styles.css') {
        serveFile(res, 'styles.css', 'text/css');
    } else if (req.url === '/favicon.svg') {
        serveFile(res, 'favicon.svg', 'image/svg+xml');
    } else if (req.url === '/standings') {
        serveFile(res, 'standings.html');
    } else if (req.url === '/losers') {
        serveFile(res, 'losers.html');
    } else if (req.url === '/motm') {
        serveFile(res, 'motm.html');
    } else if (req.url === '/chips') {
        serveFile(res, 'chips.html');
    } else if (req.url === '/earnings') {
        serveFile(res, 'earnings.html');
    } else if (req.url === '/rules') {
        serveFile(res, 'rules.html');
    } else {
        serveFile(res, 'index.html');
    }
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
