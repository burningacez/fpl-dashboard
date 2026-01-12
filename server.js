const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const LEAGUE_ID = 619028;
const PORT = process.env.PORT || 3001;
const ALERT_EMAIL = 'barold13@gmail.com';

// Email configuration - uses environment variables for credentials
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

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

// =============================================================================
// DATA CACHE - Stores fetched data to serve to clients
// =============================================================================
let dataCache = {
    standings: null,
    losers: null,
    motm: null,
    chips: null,
    earnings: null,
    league: null,
    lastRefresh: null,
    lastDataHash: null  // For detecting overnight changes
};

// =============================================================================
// SCHEDULED REFRESH TRACKING
// =============================================================================
let scheduledJobs = [];
let fixturesCache = null;
let lastFixturesFetch = null;

// =============================================================================
// EMAIL TRANSPORTER
// =============================================================================
let emailTransporter = null;

function initEmailTransporter() {
    if (EMAIL_USER && EMAIL_PASS) {
        emailTransporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: EMAIL_USER,
                pass: EMAIL_PASS
            }
        });
        console.log('[Email] Transporter configured for:', EMAIL_USER);
    } else {
        console.log('[Email] No credentials configured - email alerts disabled');
        console.log('[Email] Set EMAIL_USER and EMAIL_PASS environment variables to enable');
    }
}

async function sendEmailAlert(subject, message) {
    if (!emailTransporter) {
        console.log('[Email] Skipping alert - no transporter configured');
        return;
    }

    try {
        await emailTransporter.sendMail({
            from: EMAIL_USER,
            to: ALERT_EMAIL,
            subject: `[FPL Dashboard] ${subject}`,
            text: message,
            html: `<div style="font-family: Arial, sans-serif; padding: 20px;">
                <h2 style="color: #37003c;">${subject}</h2>
                <p>${message.replace(/\n/g, '<br>')}</p>
                <hr style="border: 1px solid #00ff87;">
                <p style="color: #666; font-size: 12px;">FPL Dashboard Alert - barryfpl.site</p>
            </div>`
        });
        console.log('[Email] Alert sent:', subject);
    } catch (error) {
        console.error('[Email] Failed to send alert:', error.message);
    }
}

// =============================================================================
// FPL API FETCH FUNCTIONS
// =============================================================================
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

async function fetchFixtures() {
    const response = await fetch('https://fantasy.premierleague.com/api/fixtures/');
    return response.json();
}

// =============================================================================
// DATA PROCESSING FUNCTIONS
// =============================================================================
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
        if (LOSER_OVERRIDES[gw]) {
            const overrideName = LOSER_OVERRIDES[gw];
            const overrideManager = histories.find(m => m.name === overrideName);
            if (overrideManager) {
                const gwData = overrideManager.gameweeks.find(g => g.event === gw);
                return { gameweek: gw, name: overrideManager.name, team: overrideManager.team, points: gwData?.points || 0 };
            }
        }

        let lowestPoints = Infinity;
        histories.forEach(manager => {
            const gwData = manager.gameweeks.find(g => g.event === gw);
            if (gwData && gwData.points < lowestPoints) {
                lowestPoints = gwData.points;
            }
        });

        const tiedManagers = histories.filter(manager => {
            const gwData = manager.gameweeks.find(g => g.event === gw);
            return gwData && gwData.points === lowestPoints;
        }).map(manager => {
            const gwData = manager.gameweeks.find(g => g.event === gw);
            return {
                name: manager.name,
                team: manager.team,
                points: gwData.points,
                transfers: gwData.event_transfers
            };
        });

        if (tiedManagers.length === 0) return null;

        tiedManagers.sort((a, b) => {
            if (a.transfers !== b.transfers) return a.transfers - b.transfers;
            return Math.random() - 0.5;
        });

        const loser = tiedManagers[0];
        return { gameweek: gw, name: loser.name, team: loser.team, points: loser.points };
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

    const CHIP_TYPES = ['wildcard', 'freehit', 'bboost', '3xc'];

    const chipsData = await Promise.all(
        managers.map(async m => {
            const history = await fetchManagerHistory(m.entry);
            const usedChips = history.chips || [];

            const chipStatus = {
                firstHalf: {},
                secondHalf: {}
            };

            CHIP_TYPES.forEach(chipType => {
                const usedFirstHalf = usedChips.find(c => c.name === chipType && c.event <= 19);
                if (usedFirstHalf) {
                    chipStatus.firstHalf[chipType] = { status: 'used', gw: usedFirstHalf.event };
                } else if (currentGW >= 20) {
                    chipStatus.firstHalf[chipType] = { status: 'expired' };
                } else {
                    chipStatus.firstHalf[chipType] = { status: 'available' };
                }

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

        if (LOSER_OVERRIDES[gw]) {
            loserName = LOSER_OVERRIDES[gw];
        }

        if (loserName) weeklyLoserCounts[loserName]++;
    });

    const motmWinCounts = {};
    managers.forEach(m => motmWinCounts[m.player_name] = 0);

    for (let p = 1; p <= 9; p++) {
        const result = calculateMotmRankings(histories, p, completedGWs);
        if (result.periodComplete && result.rankings.length > 0) {
            const winner = result.rankings[0];
            motmWinCounts[winner.name]++;
        }
    }

    const pnlData = managers.map(m => {
        const weeklyLosses = weeklyLoserCounts[m.player_name] || 0;
        const motmWins = motmWinCounts[m.player_name] || 0;

        const weeklyLossesCost = weeklyLosses * 5;
        const totalPaid = 30 + weeklyLossesCost;

        const motmEarnings = motmWins * 30;
        let leagueFinish = 0;
        if (seasonComplete) {
            if (m.rank === 1) leagueFinish = 320;
            else if (m.rank === 2) leagueFinish = 200;
            else if (m.rank === 3) leagueFinish = 120;
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
            netEarnings
        };
    });

    pnlData.sort((a, b) => b.netEarnings - a.netEarnings);

    return {
        leagueName: leagueData.league.name,
        managers: pnlData,
        seasonComplete,
        completedGWs: completedGWs.length
    };
}

// =============================================================================
// DATA CACHING AND REFRESH
// =============================================================================
function generateDataHash(data) {
    // Simple hash for comparison - stringify and create checksum
    return JSON.stringify(data).length + '_' + JSON.stringify(data).slice(0, 1000);
}

async function refreshAllData(reason = 'scheduled') {
    console.log(`[Refresh] Starting data refresh - Reason: ${reason}`);
    const startTime = Date.now();

    try {
        const [standings, losers, motm, chips, earnings, league] = await Promise.all([
            fetchStandingsWithTransfers(),
            fetchWeeklyLosers(),
            fetchMotmData(),
            fetchChipsData(),
            fetchProfitLossData(),
            fetchLeagueData()
        ]);

        const newDataHash = generateDataHash({ standings, losers, motm, chips, earnings });
        const hadChanges = dataCache.lastDataHash && dataCache.lastDataHash !== newDataHash;

        dataCache = {
            standings,
            losers,
            motm,
            chips,
            earnings,
            league,
            lastRefresh: new Date().toISOString(),
            lastDataHash: newDataHash
        };

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Refresh] Complete in ${duration}s - Changes detected: ${hadChanges}`);

        return { success: true, hadChanges };
    } catch (error) {
        console.error('[Refresh] Failed:', error.message);
        return { success: false, error: error.message };
    }
}

async function morningRefreshWithAlert() {
    console.log('[Morning] Starting morning-after gameweek refresh with change detection');

    const oldHash = dataCache.lastDataHash;
    const result = await refreshAllData('morning-after-gameweek');

    if (result.success && result.hadChanges) {
        await sendEmailAlert(
            'Overnight FPL Data Changes Detected',
            `The FPL dashboard data has changed overnight since the last match.\n\n` +
            `This could indicate:\n` +
            `- Bonus points being added\n` +
            `- Score corrections\n` +
            `- Late substitution points\n\n` +
            `Please check the dashboard at barryfpl.site for updates.`
        );
    }
}

// =============================================================================
// FIXTURE TRACKING AND SCHEDULING
// =============================================================================
async function getFixturesForCurrentGW() {
    const now = Date.now();
    // Cache fixtures for 1 hour
    if (fixturesCache && lastFixturesFetch && (now - lastFixturesFetch) < 3600000) {
        return fixturesCache;
    }

    try {
        const [fixtures, bootstrap] = await Promise.all([fetchFixtures(), fetchBootstrap()]);
        const currentGW = bootstrap.events.find(e => e.is_current)?.id || 0;

        fixturesCache = {
            all: fixtures,
            currentGW,
            currentGWFixtures: fixtures.filter(f => f.event === currentGW),
            events: bootstrap.events
        };
        lastFixturesFetch = now;

        return fixturesCache;
    } catch (error) {
        console.error('[Fixtures] Failed to fetch:', error.message);
        return null;
    }
}

function getMatchEndTime(kickoffTime) {
    // Match duration approximately 105 minutes (90 + stoppage + halftime)
    const kickoff = new Date(kickoffTime);
    return new Date(kickoff.getTime() + 105 * 60 * 1000);
}

function getNextFullHour(date) {
    const next = new Date(date);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next;
}

async function scheduleRefreshes() {
    // Clear existing scheduled jobs
    scheduledJobs.forEach(job => job.stop());
    scheduledJobs = [];

    console.log('[Scheduler] Calculating refresh schedule...');

    const fixtureData = await getFixturesForCurrentGW();
    if (!fixtureData) {
        console.log('[Scheduler] No fixture data available - will retry in 1 hour');
        setTimeout(scheduleRefreshes, 3600000);
        return;
    }

    const now = new Date();
    const { currentGWFixtures, currentGW, events } = fixtureData;

    // Get current gameweek info
    const currentEvent = events.find(e => e.id === currentGW);
    const gwDeadline = currentEvent ? new Date(currentEvent.deadline_time) : null;

    console.log(`[Scheduler] Current GW: ${currentGW}`);

    // Group fixtures by day (UK timezone)
    const fixturesByDay = {};
    currentGWFixtures.forEach(fixture => {
        if (!fixture.kickoff_time) return;

        const kickoff = new Date(fixture.kickoff_time);
        const dayKey = kickoff.toISOString().split('T')[0]; // YYYY-MM-DD

        if (!fixturesByDay[dayKey]) {
            fixturesByDay[dayKey] = [];
        }
        fixturesByDay[dayKey].push(fixture);
    });

    // Schedule refresh for next full hour after last match each day
    const scheduledTimes = [];

    Object.entries(fixturesByDay).forEach(([day, fixtures]) => {
        // Find the last match kickoff time for this day
        let lastKickoff = null;
        fixtures.forEach(f => {
            const kickoff = new Date(f.kickoff_time);
            if (!lastKickoff || kickoff > lastKickoff) {
                lastKickoff = kickoff;
            }
        });

        if (lastKickoff) {
            const matchEnd = getMatchEndTime(lastKickoff);
            const refreshTime = getNextFullHour(matchEnd);

            // Only schedule if in the future
            if (refreshTime > now) {
                scheduledTimes.push({
                    day,
                    refreshTime,
                    reason: `after-matches-${day}`
                });
            }
        }
    });

    // Schedule morning-after refresh (8 AM day after last GW match)
    const allKickoffs = currentGWFixtures
        .filter(f => f.kickoff_time)
        .map(f => new Date(f.kickoff_time));

    if (allKickoffs.length > 0) {
        const lastGWKickoff = new Date(Math.max(...allKickoffs));
        const lastMatchEnd = getMatchEndTime(lastGWKickoff);

        // Morning after = 8 AM the day after the last match
        const morningAfter = new Date(lastMatchEnd);
        morningAfter.setDate(morningAfter.getDate() + 1);
        morningAfter.setHours(8, 0, 0, 0);

        if (morningAfter > now) {
            scheduledTimes.push({
                day: morningAfter.toISOString().split('T')[0],
                refreshTime: morningAfter,
                reason: 'morning-after-gameweek',
                isMorningAfter: true
            });
        }
    }

    // Create cron jobs for each scheduled time
    scheduledTimes.forEach(({ refreshTime, reason, isMorningAfter }) => {
        const cronTime = `${refreshTime.getMinutes()} ${refreshTime.getHours()} ${refreshTime.getDate()} ${refreshTime.getMonth() + 1} *`;

        console.log(`[Scheduler] Scheduling refresh at ${refreshTime.toISOString()} - ${reason}`);

        // Use setTimeout for more reliable one-time scheduling
        const delay = refreshTime.getTime() - now.getTime();

        if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) { // Within 7 days
            const timeoutId = setTimeout(async () => {
                if (isMorningAfter) {
                    await morningRefreshWithAlert();
                } else {
                    await refreshAllData(reason);
                }
                // Re-schedule for next gameweek
                setTimeout(scheduleRefreshes, 60000);
            }, delay);

            scheduledJobs.push({ stop: () => clearTimeout(timeoutId) });
        }
    });

    if (scheduledTimes.length === 0) {
        console.log('[Scheduler] No upcoming fixtures - checking again in 6 hours');
        const checkJob = setTimeout(scheduleRefreshes, 6 * 60 * 60 * 1000);
        scheduledJobs.push({ stop: () => clearTimeout(checkJob) });
    }

    // Log schedule summary
    console.log(`[Scheduler] ${scheduledTimes.length} refresh(es) scheduled:`);
    scheduledTimes.forEach(({ refreshTime, reason }) => {
        console.log(`  - ${refreshTime.toLocaleString('en-GB')} (${reason})`);
    });
}

// =============================================================================
// HTTP SERVER
// =============================================================================
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

function serveJSON(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    // API routes - serve from cache, fallback to live fetch
    const apiRoutes = {
        '/api/league': () => dataCache.league || fetchLeagueData(),
        '/api/standings': () => dataCache.standings || fetchStandingsWithTransfers(),
        '/api/losers': () => dataCache.losers || fetchWeeklyLosers(),
        '/api/motm': () => dataCache.motm || fetchMotmData(),
        '/api/chips': () => dataCache.chips || fetchChipsData(),
        '/api/earnings': () => dataCache.earnings || fetchProfitLossData(),
    };

    if (apiRoutes[req.url]) {
        try {
            const data = await apiRoutes[req.url]();
            serveJSON(res, data);
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

// =============================================================================
// STARTUP
// =============================================================================
async function startup() {
    console.log('='.repeat(60));
    console.log('FPL Dashboard Server Starting');
    console.log('='.repeat(60));

    // Initialize email transporter
    initEmailTransporter();

    // Do initial data fetch
    console.log('[Startup] Performing initial data fetch...');
    await refreshAllData('startup');

    // Schedule future refreshes based on fixtures
    await scheduleRefreshes();

    // Start HTTP server
    server.listen(PORT, () => {
        console.log(`[Server] Running at http://localhost:${PORT}`);
        console.log('='.repeat(60));
    });
}

startup();
