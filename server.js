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
    week: null,
    lastRefresh: null,
    lastWeekRefresh: null,  // Separate timestamp for live week data
    lastDataHash: null  // For detecting overnight changes
};

// =============================================================================
// VISITOR STATS - Persistent analytics tracking
// =============================================================================
const STATS_FILE = path.join(__dirname, 'visitor-stats.json');

let visitorStats = {
    totalVisits: 0,
    uniqueVisitors: [],  // Array for JSON serialization
    uniqueVisitorsSet: new Set(),  // Set for fast lookups
    startTime: new Date().toISOString(),
    dailyStats: {}  // { "2024-01-15": { visits: 10, visitors: 5 } }
};

function loadVisitorStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
            visitorStats.totalVisits = data.totalVisits || 0;
            visitorStats.uniqueVisitors = data.uniqueVisitors || [];
            visitorStats.uniqueVisitorsSet = new Set(visitorStats.uniqueVisitors);
            visitorStats.startTime = data.startTime || new Date().toISOString();
            visitorStats.dailyStats = data.dailyStats || {};
            console.log(`[Stats] Loaded: ${visitorStats.totalVisits} visits, ${visitorStats.uniqueVisitorsSet.size} unique visitors`);
        }
    } catch (error) {
        console.error('[Stats] Error loading stats:', error.message);
    }
}

function saveVisitorStats() {
    try {
        const data = {
            totalVisits: visitorStats.totalVisits,
            uniqueVisitors: Array.from(visitorStats.uniqueVisitorsSet),
            startTime: visitorStats.startTime,
            dailyStats: visitorStats.dailyStats
        };
        fs.writeFileSync(STATS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('[Stats] Error saving stats:', error.message);
    }
}

function trackVisitor(req) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    const page = req.url.split('?')[0];

    // Only track HTML pages, not API calls or assets
    if (page.startsWith('/api/') || page.includes('.')) return;

    const today = new Date().toISOString().split('T')[0];
    const isNewVisitor = !visitorStats.uniqueVisitorsSet.has(ip);

    // Update totals
    visitorStats.totalVisits++;
    visitorStats.uniqueVisitorsSet.add(ip);

    // Update daily stats
    if (!visitorStats.dailyStats[today]) {
        visitorStats.dailyStats[today] = { visits: 0, visitors: new Set() };
    }
    // Handle both Set (runtime) and Array (loaded from JSON)
    if (Array.isArray(visitorStats.dailyStats[today].visitors)) {
        visitorStats.dailyStats[today].visitors = new Set(visitorStats.dailyStats[today].visitors);
    }
    visitorStats.dailyStats[today].visits++;
    visitorStats.dailyStats[today].visitors.add(ip);
}

// Save stats every 5 minutes and on shutdown
setInterval(saveVisitorStats, 5 * 60 * 1000);
process.on('SIGTERM', () => { saveVisitorStats(); process.exit(0); });
process.on('SIGINT', () => { saveVisitorStats(); process.exit(0); });

// Load stats on startup
loadVisitorStats();

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

async function fetchLiveGWData(gw) {
    const response = await fetch(`https://fantasy.premierleague.com/api/event/${gw}/live/`);
    return response.json();
}

async function fetchManagerPicks(entryId, gw) {
    const response = await fetch(`https://fantasy.premierleague.com/api/entry/${entryId}/event/${gw}/picks/`);
    return response.json();
}

async function fetchManagerData(entryId) {
    const response = await fetch(`https://fantasy.premierleague.com/api/entry/${entryId}/`);
    return response.json();
}

// =============================================================================
// AUTO-SUB POINTS CALCULATION HELPER
// =============================================================================
function calculatePointsWithAutoSubs(picks, liveData, bootstrap, gwFixtures) {
    if (!picks?.picks || !liveData?.elements) {
        return { totalPoints: picks?.entry_history?.points || 0, benchPoints: 0 };
    }

    const activeChip = picks.active_chip;

    // Build player data with live points
    const players = picks.picks.map((pick, idx) => {
        const element = bootstrap.elements.find(e => e.id === pick.element);
        const liveElement = liveData.elements.find(e => e.id === pick.element);
        const points = liveElement?.stats?.total_points || 0;
        const minutes = liveElement?.stats?.minutes || 0;

        // Get fixture status
        const fixture = gwFixtures?.find(f => f.team_h === element?.team || f.team_a === element?.team);
        const fixtureStarted = fixture?.started || false;
        const fixtureFinished = fixture?.finished || false;

        return {
            id: pick.element,
            positionId: element?.element_type,
            points,
            minutes,
            isCaptain: pick.is_captain,
            isViceCaptain: pick.is_vice_captain,
            multiplier: pick.multiplier,
            isBench: idx >= 11,
            benchOrder: idx >= 11 ? idx - 10 : 0,
            fixtureStarted,
            fixtureFinished,
            subOut: false,
            subIn: false
        };
    });

    const starters = players.filter(p => !p.isBench);
    const bench = players.filter(p => p.isBench).sort((a, b) => a.benchOrder - b.benchOrder);

    // Only apply auto-subs if not using Bench Boost
    if (activeChip !== 'bboost') {
        // Formation validation helpers
        const getFormationCounts = (lineup) => ({
            GKP: lineup.filter(p => p.positionId === 1 && !p.subOut).length,
            DEF: lineup.filter(p => p.positionId === 2 && !p.subOut).length,
            MID: lineup.filter(p => p.positionId === 3 && !p.subOut).length,
            FWD: lineup.filter(p => p.positionId === 4 && !p.subOut).length
        });

        const isValidFormation = (counts) => {
            return counts.GKP >= 1 && counts.DEF >= 3 && counts.MID >= 2 && counts.FWD >= 1;
        };

        // Find starters needing subs (0 mins and fixture done/in progress)
        const needsSub = starters.filter(p =>
            (p.fixtureFinished || (p.fixtureStarted && p.minutes === 0)) && p.minutes === 0
        );

        // Process each player needing a sub
        for (const playerOut of needsSub) {
            for (const benchPlayer of bench) {
                if (benchPlayer.subIn) continue; // Already used
                if (benchPlayer.minutes === 0 && (benchPlayer.fixtureFinished || benchPlayer.fixtureStarted)) continue;

                // Check if sub would result in valid formation
                const testFormation = getFormationCounts(starters);

                // Decrease count for player going out
                if (playerOut.positionId === 1) testFormation.GKP--;
                else if (playerOut.positionId === 2) testFormation.DEF--;
                else if (playerOut.positionId === 3) testFormation.MID--;
                else if (playerOut.positionId === 4) testFormation.FWD--;

                // Increase count for player coming in
                if (benchPlayer.positionId === 1) testFormation.GKP++;
                else if (benchPlayer.positionId === 2) testFormation.DEF++;
                else if (benchPlayer.positionId === 3) testFormation.MID++;
                else if (benchPlayer.positionId === 4) testFormation.FWD++;

                // GK can only be subbed by GK
                if (playerOut.positionId === 1 && benchPlayer.positionId !== 1) continue;
                if (playerOut.positionId !== 1 && benchPlayer.positionId === 1) continue;

                if (isValidFormation(testFormation)) {
                    playerOut.subOut = true;
                    benchPlayer.subIn = true;
                    break;
                }
            }
        }
    }

    // Calculate total points with auto-subs and captaincy
    let totalPoints = 0;
    let benchPoints = 0;

    players.forEach(p => {
        const effectivePoints = p.points * (p.isCaptain ? 2 : p.multiplier);

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += p.points; // Subs don't get captain bonus
        } else if (p.isBench && !p.subIn) {
            benchPoints += p.points;
        }
    });

    return { totalPoints, benchPoints };
}

// =============================================================================
// DATA PROCESSING FUNCTIONS
// =============================================================================
async function fetchStandingsWithTransfers() {
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
    let liveData = null;
    let gwFixtures = [];
    if (isLive) {
        try {
            liveData = await fetchLiveGWData(currentGW);
            gwFixtures = fixtures.filter(f => f.event === currentGW);
        } catch (e) {
            console.error('[Standings] Failed to fetch live data:', e.message);
        }
    }

    const detailedStandings = await Promise.all(
        managers.map(async m => {
            const history = await fetchManagerHistory(m.entry);
            const totalTransferCost = history.current.reduce((sum, gw) => sum + gw.event_transfers_cost, 0);
            const totalTransfers = history.current.reduce((sum, gw) => sum + gw.event_transfers, 0);

            let netScore = m.total;

            // If live, calculate auto-sub adjusted points for current GW
            if (isLive && liveData) {
                try {
                    const picks = await fetchManagerPicks(m.entry, currentGW);
                    const calculated = calculatePointsWithAutoSubs(picks, liveData, bootstrap, gwFixtures);
                    const apiCurrentGWPoints = picks.entry_history?.points || 0;

                    // Add the difference between calculated and API points (auto-sub bonus)
                    const autoSubBonus = calculated.totalPoints - apiCurrentGWPoints;
                    if (autoSubBonus > 0) {
                        netScore += autoSubBonus;
                    }
                } catch (e) {
                    // If picks fetch fails, use API total
                }
            }

            const grossScore = netScore + totalTransferCost;

            // Get team value from the most recent gameweek
            const latestGW = history.current[history.current.length - 1];
            const teamValue = latestGW ? (latestGW.value / 10).toFixed(1) : '100.0';

            return {
                rank: m.rank, name: m.player_name, team: m.entry_name, entryId: m.entry,
                grossScore, totalTransfers, transferCost: totalTransferCost, netScore,
                teamValue
            };
        })
    );

    // Re-sort by net score and update ranks
    detailedStandings.sort((a, b) => b.netScore - a.netScore);
    detailedStandings.forEach((s, i) => s.rank = i + 1);

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
        // Get all managers' scores for this GW
        const gwScores = histories.map(manager => {
            const gwData = manager.gameweeks.find(g => g.event === gw);
            return {
                name: manager.name,
                team: manager.team,
                points: gwData?.points || 0,
                transfers: gwData?.event_transfers || 0
            };
        }).sort((a, b) => a.points - b.points);

        if (gwScores.length === 0) return null;

        const lowestPoints = gwScores[0].points;
        const secondLowestPoints = gwScores.find(m => m.points > lowestPoints)?.points || lowestPoints;

        // Find tied managers at lowest score
        const tiedManagers = gwScores.filter(m => m.points === lowestPoints);

        // Check for override - show as "Lost by 1 pt" to match fudged display
        if (LOSER_OVERRIDES[gw]) {
            const overrideName = LOSER_OVERRIDES[gw];
            const overrideManager = gwScores.find(m => m.name === overrideName);
            if (overrideManager) {
                return {
                    gameweek: gw,
                    name: overrideManager.name,
                    team: overrideManager.team,
                    points: lowestPoints - 1,
                    isOverride: true,
                    context: 'Lost by 1 pt'
                };
            }
        }

        if (tiedManagers.length === 0) return null;

        // Determine context
        let context = '';
        let loser;

        if (tiedManagers.length === 1) {
            // Clear loser by points
            const margin = secondLowestPoints - lowestPoints;
            context = `Lost by ${margin} pt${margin !== 1 ? 's' : ''}`;
            loser = tiedManagers[0];
        } else {
            // Tie - use transfers as tiebreaker
            tiedManagers.sort((a, b) => {
                if (a.transfers !== b.transfers) return a.transfers - b.transfers;
                return 0;
            });
            loser = tiedManagers[0];

            if (tiedManagers[0].transfers < tiedManagers[1].transfers) {
                context = 'Fewer transfers';
            } else {
                context = 'Tiebreaker';
            }
        }

        return {
            gameweek: gw,
            name: loser.name,
            team: loser.team,
            points: loser.points,
            context
        };
    }).filter(Boolean);

    // Build allGameweeks data for modal display
    const allGameweeks = {};
    completedGameweeks.forEach(gw => {
        const overrideName = LOSER_OVERRIDES[gw];
        allGameweeks[gw] = {
            managers: histories.map(manager => {
                const gwData = manager.gameweeks.find(g => g.event === gw);
                return {
                    name: manager.name,
                    team: manager.team,
                    points: gwData?.points || 0
                };
            }).sort((a, b) => a.points - b.points),
            overrideName: overrideName || null
        };
    });

    return { leagueName: leagueData.league.name, losers: weeklyLosers, allGameweeks };
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
    const currentGW = bootstrap.events.find(e => e.is_current);
    const managers = leagueData.standings.results;

    // Check if current GW is in progress (deadline passed but not finished)
    const now = new Date();
    const gwDeadline = currentGW ? new Date(currentGW.deadline_time) : null;
    const isLive = currentGW && !currentGW.finished && gwDeadline && now > gwDeadline;

    const histories = await Promise.all(
        managers.map(async m => {
            const history = await fetchManagerHistory(m.entry);
            return { name: m.player_name, team: m.entry_name, entryId: m.entry, gameweeks: history.current };
        })
    );

    // If there's live data, include current GW in calculations
    let gwsForCalc = [...completedGWs];
    if (isLive && currentGW) {
        gwsForCalc.push(currentGW.id);

        // Fetch live points for current GW with auto-sub calculation
        try {
            const [liveData, fixtures] = await Promise.all([
                fetchLiveGWData(currentGW.id),
                fetchFixtures()
            ]);
            const gwFixtures = fixtures.filter(f => f.event === currentGW.id);

            const livePicksData = await Promise.all(
                managers.map(async m => {
                    const picks = await fetchManagerPicks(m.entry, currentGW.id);
                    // Calculate points with auto-subs for accurate live scoring
                    const calculated = calculatePointsWithAutoSubs(picks, liveData, bootstrap, gwFixtures);
                    return {
                        entryId: m.entry,
                        points: calculated.totalPoints,
                        transferCost: picks.entry_history?.event_transfers_cost || 0
                    };
                })
            );

            // Update live GW data in histories with auto-sub calculated points
            histories.forEach(h => {
                const livePicks = livePicksData.find(p => p.entryId === h.entryId);
                if (livePicks) {
                    const existingGW = h.gameweeks.find(g => g.event === currentGW.id);
                    if (existingGW) {
                        // Update existing GW with calculated points (includes auto-subs)
                        existingGW.points = livePicks.points;
                        existingGW.isLive = true;
                    } else {
                        // Add new GW entry
                        h.gameweeks.push({
                            event: currentGW.id,
                            points: livePicks.points,
                            event_transfers_cost: livePicks.transferCost,
                            event_transfers: 0,
                            isLive: true
                        });
                    }
                }
            });
        } catch (e) {
            console.error('[MotM] Failed to fetch live data:', e.message);
        }
    }

    const periods = {}, winners = [];
    for (let p = 1; p <= 9; p++) {
        const result = calculateMotmRankings(histories, p, gwsForCalc);
        periods[p] = result;
        periods[p].isLive = isLive && currentGW && result.periodGWs.includes(currentGW.id);

        if (result.rankings.length > 0 && result.periodComplete) {
            winners.push({ period: p, gwRange: `GW ${result.startGW}-${result.endGW}`, winner: result.rankings[0] });
        } else if (result.rankings.length > 0) {
            winners.push({
                period: p,
                gwRange: `GW ${result.startGW}-${result.endGW}`,
                winner: null,
                inProgress: result.periodGWs.length > 0,
                isLive: periods[p].isLive,
                completedGWs: result.periodGWs.length,
                totalGWs: result.endGW - result.startGW + 1
            });
        }
    }

    return { leagueName: leagueData.league.name, periods, winners, completedGWs, currentGW: currentGW?.id, isLive };
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

async function fetchWeekData() {
    const [leagueData, bootstrap, fixtures] = await Promise.all([
        fetchLeagueData(),
        fetchBootstrap(),
        fetchFixtures()
    ]);

    const currentGWEvent = bootstrap.events.find(e => e.is_current);
    const currentGW = currentGWEvent?.id || 1;
    const isLive = currentGWEvent && !currentGWEvent.finished;

    const managers = leagueData.standings.results;
    const currentGWFixtures = fixtures.filter(f => f.event === currentGW);

    // Get live element data if available
    let liveData = null;
    if (isLive) {
        try {
            liveData = await fetchLiveGWData(currentGW);
        } catch (e) {
            console.error('[Week] Failed to fetch live data:', e.message);
        }
    }

    const weekData = await Promise.all(
        managers.map(async m => {
            try {
                const [picks, history, managerInfo] = await Promise.all([
                    fetchManagerPicks(m.entry, currentGW),
                    fetchManagerHistory(m.entry),
                    fetchManagerData(m.entry)
                ]);

                const latestGW = history.current[history.current.length - 1];
                const teamValue = latestGW ? (latestGW.value / 10).toFixed(1) : '100.0';
                const bank = latestGW ? (latestGW.bank / 10).toFixed(1) : '0.0';

                // Get active chip
                const activeChip = picks.active_chip;

                // Calculate GW score with auto-subs
                let gwScore = picks.entry_history?.points || 0;
                let benchPoints = 0;

                // Use auto-sub calculation when we have live data
                if (liveData) {
                    const calculated = calculatePointsWithAutoSubs(picks, liveData, bootstrap, currentGWFixtures);
                    gwScore = calculated.totalPoints;
                    benchPoints = calculated.benchPoints;
                }

                // Calculate players who haven't played yet
                const startedFixtures = currentGWFixtures.filter(f => f.started);
                const startedTeamIds = new Set();
                startedFixtures.forEach(f => {
                    startedTeamIds.add(f.team_h);
                    startedTeamIds.add(f.team_a);
                });

                // Count players left
                let playersLeft = 0;
                picks.picks.forEach((pick, idx) => {
                    const element = bootstrap.elements.find(e => e.id === pick.element);
                    if (element) {
                        const teamStarted = startedTeamIds.has(element.team);
                        if (idx < 11 && !teamStarted) {
                            playersLeft++;
                        }
                    }
                });

                // Free transfers (from previous GW)
                const freeTransfers = managerInfo.last_deadline_total_transfers !== undefined
                    ? Math.min(managerInfo.last_deadline_bank !== undefined ? 2 : 1, 2)
                    : 1;

                return {
                    rank: m.rank,
                    name: m.player_name,
                    team: m.entry_name,
                    entryId: m.entry,
                    gwScore,
                    playersLeft,
                    teamValue,
                    bank,
                    benchPoints,
                    activeChip,
                    freeTransfers: picks.entry_history?.event_transfers || 0
                };
            } catch (e) {
                console.error(`[Week] Failed to fetch data for ${m.player_name}:`, e.message);
                return {
                    rank: m.rank,
                    name: m.player_name,
                    team: m.entry_name,
                    entryId: m.entry,
                    gwScore: 0,
                    playersLeft: 11,
                    teamValue: '100.0',
                    bank: '0.0',
                    benchPoints: 0,
                    activeChip: null,
                    freeTransfers: 0
                };
            }
        })
    );

    // Sort by GW score
    weekData.sort((a, b) => b.gwScore - a.gwScore);
    weekData.forEach((m, i) => m.gwRank = i + 1);

    const refreshTime = new Date().toISOString();
    return {
        leagueName: leagueData.league.name,
        currentGW,
        isLive,
        managers: weekData,
        lastUpdated: refreshTime
    };
}

async function refreshWeekData() {
    console.log('[Week] Refreshing week data...');
    const startTime = Date.now();
    try {
        const weekData = await fetchWeekData();
        dataCache.week = weekData;
        dataCache.lastWeekRefresh = weekData.lastUpdated;
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Week] Refresh complete in ${duration}s`);
        return weekData;
    } catch (error) {
        console.error('[Week] Refresh failed:', error.message);
        throw error;
    }
}

async function fetchManagerPicksDetailed(entryId, gw) {
    const [bootstrap, picks, liveData, fixtures] = await Promise.all([
        fetchBootstrap(),
        fetchManagerPicks(entryId, gw),
        fetchLiveGWData(gw),
        fetchFixtures()
    ]);

    const gwFixtures = fixtures.filter(f => f.event === gw);

    // Team colors mapping with short names
    const TEAM_COLORS = {
        1: { primary: '#EF0107', secondary: '#FFFFFF', short: 'ARS' },
        2: { primary: '#670E36', secondary: '#95BFE5', short: 'AVL' },
        3: { primary: '#DA291C', secondary: '#000000', short: 'BOU' },
        4: { primary: '#FFC659', secondary: '#000000', short: 'BRE' },
        5: { primary: '#0057B8', secondary: '#FFFFFF', short: 'BHA' },
        6: { primary: '#034694', secondary: '#FFFFFF', short: 'CHE' },
        7: { primary: '#1B458F', secondary: '#C4122E', short: 'CRY' },
        8: { primary: '#003399', secondary: '#FFFFFF', short: 'EVE' },
        9: { primary: '#000000', secondary: '#FFFFFF', short: 'FUL' },
        10: { primary: '#0044A9', secondary: '#FFFFFF', short: 'IPS' },
        11: { primary: '#003090', secondary: '#FDBE11', short: 'LEI' },
        12: { primary: '#C8102E', secondary: '#FFFFFF', short: 'LIV' },
        13: { primary: '#6CABDD', secondary: '#FFFFFF', short: 'MCI' },
        14: { primary: '#DA291C', secondary: '#FBE122', short: 'MUN' },
        15: { primary: '#241F20', secondary: '#FFFFFF', short: 'NEW' },
        16: { primary: '#DD0000', secondary: '#FFFFFF', short: 'NFO' },
        17: { primary: '#D71920', secondary: '#FFFFFF', short: 'SOU' },
        18: { primary: '#132257', secondary: '#FFFFFF', short: 'TOT' },
        19: { primary: '#7A263A', secondary: '#1BB1E7', short: 'WHU' },
        20: { primary: '#FDB913', secondary: '#231F20', short: 'WOL' }
    };

    // Helper to get opponent info
    function getOpponentInfo(playerTeamId) {
        const fixture = gwFixtures.find(f => f.team_h === playerTeamId || f.team_a === playerTeamId);
        if (!fixture) return null;

        const isHome = fixture.team_h === playerTeamId;
        const oppTeamId = isHome ? fixture.team_a : fixture.team_h;
        const oppTeam = bootstrap.teams.find(t => t.id === oppTeamId);

        return {
            oppTeamId,
            oppName: oppTeam?.short_name || 'UNK',
            isHome,
            fixtureStarted: fixture.started,
            fixtureFinished: fixture.finished,
            kickoffTime: fixture.kickoff_time
        };
    }

    // Build player details
    const players = picks.picks.map((pick, idx) => {
        const element = bootstrap.elements.find(e => e.id === pick.element);
        const liveElement = liveData.elements.find(e => e.id === pick.element);
        const team = bootstrap.teams.find(t => t.id === element?.team);
        const position = bootstrap.element_types.find(et => et.id === element?.element_type);
        const teamInfo = TEAM_COLORS[element?.team] || { primary: '#333', secondary: '#fff', short: 'UNK' };
        const teamCode = team?.code || element?.team; // Team code for shirt images

        // Get fixture/opponent info
        const oppInfo = getOpponentInfo(element?.team);
        const fixtureStarted = oppInfo?.fixtureStarted || false;
        const fixtureFinished = oppInfo?.fixtureFinished || false;
        const minutes = liveElement?.stats?.minutes || 0;

        // Determine play status
        let playStatus = 'not_started'; // fixture hasn't started
        if (fixtureStarted && minutes > 0) {
            playStatus = fixtureFinished ? 'played' : 'playing';
        } else if (fixtureStarted && minutes === 0) {
            playStatus = fixtureFinished ? 'benched' : 'not_played_yet';
        }

        // Get points breakdown from FPL's explain array (includes all stats like defensive contribution)
        const stats = liveElement?.stats || {};
        const posId = element?.element_type; // 1=GK, 2=DEF, 3=MID, 4=FWD

        // FPL provides explain array with exact points breakdown
        const explainData = liveElement?.explain || [];
        const pointsBreakdown = [];

        // Stat identifier to friendly name and icon mapping
        const STAT_INFO = {
            'minutes': { name: 'Minutes played', icon: '⏱️' },
            'goals_scored': { name: 'Goals scored', icon: '⚽' },
            'assists': { name: 'Assists', icon: '👟' },
            'clean_sheets': { name: 'Clean sheet', icon: '🛡️' },
            'goals_conceded': { name: 'Goals conceded', icon: '😞' },
            'own_goals': { name: 'Own goals', icon: '🔴' },
            'penalties_saved': { name: 'Penalties saved', icon: '🧤' },
            'penalties_missed': { name: 'Penalties missed', icon: '❌' },
            'yellow_cards': { name: 'Yellow cards', icon: '🟨' },
            'red_cards': { name: 'Red cards', icon: '🟥' },
            'saves': { name: 'Saves', icon: '✋' },
            'bonus': { name: 'Bonus', icon: '⭐' },
            'bps': { name: 'BPS', icon: '📊' },
            'defensive_contribution': { name: 'Defensive contribution', icon: '🔒' }
        };

        // Process each fixture's explain data
        explainData.forEach(fixture => {
            if (fixture.stats) {
                fixture.stats.forEach(stat => {
                    // Only include stats that have points (positive or negative)
                    if (stat.points !== 0) {
                        const info = STAT_INFO[stat.identifier] || { name: stat.identifier.replace(/_/g, ' '), icon: '📋' };
                        // Format value - for clean sheets show Yes instead of 1
                        let displayValue = stat.value;
                        if (stat.identifier === 'clean_sheets' && stat.value === 1) {
                            displayValue = 'Yes';
                        }
                        pointsBreakdown.push({
                            stat: info.name,
                            icon: info.icon,
                            value: displayValue,
                            points: stat.points,
                            identifier: stat.identifier
                        });
                    }
                });
            }
        });

        // Sort: positive points first (descending), then negative (ascending)
        pointsBreakdown.sort((a, b) => {
            if (a.points >= 0 && b.points < 0) return -1;
            if (a.points < 0 && b.points >= 0) return 1;
            if (a.points >= 0) return b.points - a.points;
            return a.points - b.points;
        });

        // Build event icons from points breakdown (shows what actually scored points)
        const events = [];
        pointsBreakdown.forEach(item => {
            if (item.points > 0 && item.identifier !== 'minutes') {
                // Use the icon from the breakdown
                events.push({
                    icon: item.icon,
                    count: typeof item.value === 'number' ? item.value : 1,
                    label: item.stat
                });
            }
        });
        // Add negative events too (yellow/red cards, etc)
        pointsBreakdown.forEach(item => {
            if (item.points < 0) {
                events.push({
                    icon: item.icon,
                    count: typeof item.value === 'number' ? item.value : 1,
                    label: item.stat,
                    negative: true
                });
            }
        });

        return {
            id: pick.element,
            name: element?.web_name || 'Unknown',
            fullName: `${element?.first_name} ${element?.second_name}`,
            position: position?.singular_name_short || 'UNK',
            positionId: element?.element_type,
            teamId: element?.team,
            teamName: team?.short_name || 'UNK',
            teamCode: teamCode,
            teamColors: teamInfo,
            opponent: oppInfo?.oppName || null,
            isHome: oppInfo?.isHome,
            points: stats.total_points || 0,
            isCaptain: pick.is_captain,
            isViceCaptain: pick.is_vice_captain,
            multiplier: pick.multiplier,
            isBench: idx >= 11,
            benchOrder: idx >= 11 ? idx - 10 : 0,
            pickPosition: idx,
            events,
            pointsBreakdown,
            totalPoints: stats.total_points || 0,
            playStatus,
            minutes,
            fixtureStarted,
            fixtureFinished
        };
    });

    // Auto-subs logic: if a starter has 0 minutes and fixture is finished/in-progress, find valid sub
    const starters = players.filter(p => !p.isBench);
    const bench = players.filter(p => p.isBench).sort((a, b) => a.benchOrder - b.benchOrder);

    // Track who gets subbed
    const autoSubs = [];
    let adjustedPlayers = [...players];

    // Only apply auto-subs if not using Bench Boost
    if (picks.active_chip !== 'bboost') {
        // Count current formation
        const getFormationCounts = (lineup) => ({
            GKP: lineup.filter(p => p.positionId === 1 && !p.subOut).length,
            DEF: lineup.filter(p => p.positionId === 2 && !p.subOut).length,
            MID: lineup.filter(p => p.positionId === 3 && !p.subOut).length,
            FWD: lineup.filter(p => p.positionId === 4 && !p.subOut).length
        });

        // Check if formation is valid (min 1 GK, 3 DEF, 2 MID, 1 FWD)
        const isValidFormation = (counts) => {
            return counts.GKP >= 1 && counts.DEF >= 3 && counts.MID >= 2 && counts.FWD >= 1;
        };

        // Find players needing subs (0 mins and fixture done/in progress)
        const needsSub = starters.filter(p =>
            (p.fixtureFinished || (p.fixtureStarted && p.minutes === 0)) && p.minutes === 0
        );

        // Process each player needing a sub
        for (const playerOut of needsSub) {
            // Find valid bench player
            for (const benchPlayer of bench) {
                if (benchPlayer.subIn) continue; // Already used
                if (benchPlayer.minutes === 0 && (benchPlayer.fixtureFinished || benchPlayer.fixtureStarted)) continue; // Bench player also didn't play

                // Check if sub would result in valid formation
                const testFormation = getFormationCounts(starters);

                // Decrease count for player going out
                if (playerOut.positionId === 1) testFormation.GKP--;
                else if (playerOut.positionId === 2) testFormation.DEF--;
                else if (playerOut.positionId === 3) testFormation.MID--;
                else if (playerOut.positionId === 4) testFormation.FWD--;

                // Increase count for player coming in
                if (benchPlayer.positionId === 1) testFormation.GKP++;
                else if (benchPlayer.positionId === 2) testFormation.DEF++;
                else if (benchPlayer.positionId === 3) testFormation.MID++;
                else if (benchPlayer.positionId === 4) testFormation.FWD++;

                // GK can only be subbed by GK
                if (playerOut.positionId === 1 && benchPlayer.positionId !== 1) continue;
                if (playerOut.positionId !== 1 && benchPlayer.positionId === 1) continue;

                if (isValidFormation(testFormation)) {
                    autoSubs.push({
                        out: { id: playerOut.id, name: playerOut.name },
                        in: { id: benchPlayer.id, name: benchPlayer.name }
                    });

                    // Mark players
                    const pOut = adjustedPlayers.find(p => p.id === playerOut.id);
                    const pIn = adjustedPlayers.find(p => p.id === benchPlayer.id);
                    if (pOut) pOut.subOut = true;
                    if (pIn) pIn.subIn = true;

                    // Mark original bench player as used
                    benchPlayer.subIn = true;
                    break;
                }
            }
        }
    }

    // Calculate actual points with auto-subs and captaincy
    let totalPoints = 0;
    let benchPoints = 0;

    adjustedPlayers.forEach(p => {
        const effectivePoints = p.points * (p.isCaptain ? 2 : p.multiplier);

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += p.points; // Subs don't get captain bonus
        } else if (p.isBench && !p.subIn) {
            benchPoints += p.points;
        }
    });

    // Detect formation from effective starting 11
    const effectiveStarters = adjustedPlayers.filter(p => (!p.isBench && !p.subOut) || p.subIn);
    const formation = {
        GKP: effectiveStarters.filter(p => p.positionId === 1).length,
        DEF: effectiveStarters.filter(p => p.positionId === 2).length,
        MID: effectiveStarters.filter(p => p.positionId === 3).length,
        FWD: effectiveStarters.filter(p => p.positionId === 4).length
    };
    const formationString = `${formation.DEF}-${formation.MID}-${formation.FWD}`;

    return {
        entryId,
        gameweek: gw,
        points: picks.entry_history?.points || 0,
        calculatedPoints: totalPoints,
        pointsOnBench: benchPoints,
        activeChip: picks.active_chip,
        formation: formationString,
        players: adjustedPlayers,
        autoSubs,
        transfersCost: picks.entry_history?.event_transfers_cost || 0
    };
}

// =============================================================================
// MANAGER PROFILE DATA
// =============================================================================
let managerProfileCache = {};

async function fetchAllCaptainPicks(entryId, completedGWs, bootstrap) {
    const captainPicks = [];

    for (const gw of completedGWs) {
        try {
            const picks = await fetchManagerPicks(entryId, gw);
            const captainPick = picks.picks?.find(p => p.is_captain);
            if (captainPick) {
                const element = bootstrap.elements.find(e => e.id === captainPick.element);

                // Get live data for this GW to get captain points
                const liveData = await fetchLiveGWData(gw);
                const liveElement = liveData.elements?.find(e => e.id === captainPick.element);
                const points = liveElement?.stats?.total_points || 0;

                captainPicks.push({
                    gw,
                    elementId: captainPick.element,
                    playerName: element?.web_name || 'Unknown',
                    points: points,
                    captainPoints: points * 2 // Captain doubles points
                });
            }
        } catch (e) {
            // Skip failed GWs
        }
    }

    return captainPicks;
}

async function fetchBenchPoints(entryId, completedGWs, bootstrap) {
    let totalBenchPoints = 0;
    let worstBenchGW = { gw: 0, points: 0 };
    const benchByGW = [];

    for (const gw of completedGWs) {
        try {
            const [picks, liveData, fixtures] = await Promise.all([
                fetchManagerPicks(entryId, gw),
                fetchLiveGWData(gw),
                fetchFixtures()
            ]);

            const gwFixtures = fixtures.filter(f => f.event === gw);
            const calculated = calculatePointsWithAutoSubs(picks, liveData, bootstrap, gwFixtures);
            const benchPoints = calculated.benchPoints || 0;

            totalBenchPoints += benchPoints;
            benchByGW.push({ gw, points: benchPoints });

            if (benchPoints > worstBenchGW.points) {
                worstBenchGW = { gw, points: benchPoints };
            }
        } catch (e) {
            // Skip failed GWs
        }
    }

    return {
        total: totalBenchPoints,
        average: benchByGW.length > 0 ? Math.round(totalBenchPoints / benchByGW.length * 10) / 10 : 0,
        worst: worstBenchGW,
        byGW: benchByGW
    };
}

function calculateSeasonRecords(history) {
    if (!history || history.length === 0) {
        return {
            highestGW: { points: 0, gw: 0 },
            lowestGW: { points: 0, gw: 0 },
            bestRank: 0,
            currentRank: 0,
            avgScore: 0,
            totalTransfers: 0,
            transferHits: 0
        };
    }

    let highest = { points: -Infinity, gw: 0 };
    let lowest = { points: Infinity, gw: 0 };
    let bestRank = Infinity;
    let totalPoints = 0;
    let totalTransfers = 0;
    let transferHits = 0;

    history.forEach(gw => {
        if (gw.points > highest.points) {
            highest = { points: gw.points, gw: gw.event };
        }
        if (gw.points < lowest.points) {
            lowest = { points: gw.points, gw: gw.event };
        }
        if (gw.overall_rank && gw.overall_rank < bestRank) {
            bestRank = gw.overall_rank;
        }
        totalPoints += gw.points;
        totalTransfers += gw.event_transfers || 0;
        transferHits += gw.event_transfers_cost || 0;
    });

    const latestGW = history[history.length - 1];

    return {
        highestGW: highest,
        lowestGW: lowest,
        bestRank: bestRank === Infinity ? null : bestRank,
        currentRank: latestGW?.overall_rank || null,
        avgScore: Math.round(totalPoints / history.length * 10) / 10,
        totalTransfers,
        transferHits
    };
}

async function fetchManagerProfile(entryId) {
    // Check cache first
    if (managerProfileCache[entryId] &&
        Date.now() - managerProfileCache[entryId].timestamp < 5 * 60 * 1000) {
        return managerProfileCache[entryId].data;
    }

    const [bootstrap, history, managerData] = await Promise.all([
        fetchBootstrap(),
        fetchManagerHistory(entryId),
        fetchManagerData(entryId)
    ]);

    const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);

    // Calculate season records
    const records = calculateSeasonRecords(history.current);

    // Get captain picks data
    const captainPicks = await fetchAllCaptainPicks(entryId, completedGWs, bootstrap);

    // Calculate captain stats
    let captainStats = {
        mostCaptained: [],
        totalCaptainPoints: 0,
        bestCaptain: { player: '', points: 0, gw: 0 },
        worstCaptain: { player: '', points: Infinity, gw: 0 },
        avgCaptainPoints: 0
    };

    if (captainPicks.length > 0) {
        // Count captains
        const captainCounts = {};
        let totalCaptainPoints = 0;

        captainPicks.forEach(pick => {
            captainCounts[pick.playerName] = (captainCounts[pick.playerName] || 0) + 1;
            totalCaptainPoints += pick.captainPoints;

            if (pick.points > captainStats.bestCaptain.points) {
                captainStats.bestCaptain = { player: pick.playerName, points: pick.points, gw: pick.gw };
            }
            if (pick.points < captainStats.worstCaptain.points) {
                captainStats.worstCaptain = { player: pick.playerName, points: pick.points, gw: pick.gw };
            }
        });

        // Find most captained
        const maxCount = Math.max(...Object.values(captainCounts));
        captainStats.mostCaptained = Object.entries(captainCounts)
            .filter(([_, count]) => count === maxCount)
            .map(([name, count]) => ({ name, count }));

        captainStats.totalCaptainPoints = totalCaptainPoints;
        captainStats.avgCaptainPoints = Math.round(totalCaptainPoints / captainPicks.length * 10) / 10;
    }

    if (captainStats.worstCaptain.points === Infinity) {
        captainStats.worstCaptain = { player: '-', points: 0, gw: 0 };
    }

    // Get bench points data
    const benchData = await fetchBenchPoints(entryId, completedGWs, bootstrap);

    // Get loser count from cached data
    let loserCount = 0;
    if (dataCache.losers?.losers) {
        loserCount = dataCache.losers.losers.filter(l => {
            // Match by entry ID through standings lookup
            const standingEntry = dataCache.standings?.standings?.find(s => s.name === l.name);
            return standingEntry?.entryId === entryId || l.name === managerData.player_first_name + ' ' + managerData.player_last_name;
        }).length;
    }

    // Also check by name directly
    if (loserCount === 0 && dataCache.losers?.losers) {
        const managerName = managerData.player_first_name + ' ' + managerData.player_last_name;
        loserCount = dataCache.losers.losers.filter(l => l.name === managerName).length;
    }

    // Get MotM wins count
    let motmWins = 0;
    if (dataCache.motm?.winners) {
        const managerName = managerData.player_first_name + ' ' + managerData.player_last_name;
        motmWins = dataCache.motm.winners.filter(w => w.winner?.name === managerName).length;
    }

    // Build rank history for chart (league rank from standings history)
    const rankHistory = history.current.map(gw => ({
        gw: gw.event,
        rank: gw.rank,
        overallRank: gw.overall_rank,
        points: gw.points
    }));

    const profileData = {
        entryId,
        name: managerData.player_first_name + ' ' + managerData.player_last_name,
        team: managerData.name,
        history: rankHistory,
        records,
        captainStats,
        benchPoints: benchData,
        loserCount,
        motmWins
    };

    // Cache the result
    managerProfileCache[entryId] = {
        data: profileData,
        timestamp: Date.now()
    };

    return profileData;
}

// =============================================================================
// HALL OF FAME DATA
// =============================================================================
async function fetchHallOfFameData() {
    const [leagueData, bootstrap] = await Promise.all([fetchLeagueData(), fetchBootstrap()]);
    const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);
    const managers = leagueData.standings.results;

    // Fetch all manager histories
    const histories = await Promise.all(
        managers.map(async m => {
            const history = await fetchManagerHistory(m.entry);
            return {
                name: m.player_name,
                team: m.entry_name,
                entryId: m.entry,
                gameweeks: history.current
            };
        })
    );

    // Calculate highlights
    let highestGW = { name: '', score: 0, gw: 0 };
    let lowestGW = { name: '', score: Infinity, gw: 0 };
    let biggestClimb = { name: '', ranksGained: 0, gw: 0 };
    let biggestDrop = { name: '', ranksLost: 0, gw: 0 };
    let mostTransfers = { name: '', count: 0 };
    let biggestHit = { name: '', cost: 0, gw: 0 };

    // Track scores for consistency calculation
    const managerScoreStats = {};

    histories.forEach(manager => {
        let totalTransfers = 0;
        let prevRank = null;
        const scores = [];

        manager.gameweeks.forEach((gw, idx) => {
            scores.push(gw.points);

            // Highest/Lowest GW scores
            if (gw.points > highestGW.score) {
                highestGW = { name: manager.name, score: gw.points, gw: gw.event };
            }
            if (gw.points < lowestGW.score) {
                lowestGW = { name: manager.name, score: gw.points, gw: gw.event };
            }

            // Rank changes (using league rank)
            if (prevRank !== null && gw.rank) {
                const rankChange = prevRank - gw.rank;
                if (rankChange > biggestClimb.ranksGained) {
                    biggestClimb = { name: manager.name, ranksGained: rankChange, gw: gw.event };
                }
                if (rankChange < -biggestDrop.ranksLost) {
                    biggestDrop = { name: manager.name, ranksLost: -rankChange, gw: gw.event };
                }
            }
            prevRank = gw.rank;

            // Transfers
            totalTransfers += gw.event_transfers || 0;

            // Transfer hits
            if ((gw.event_transfers_cost || 0) > biggestHit.cost) {
                biggestHit = { name: manager.name, cost: gw.event_transfers_cost, gw: gw.event };
            }
        });

        // Total transfers
        if (totalTransfers > mostTransfers.count) {
            mostTransfers = { name: manager.name, count: totalTransfers };
        }

        // Calculate standard deviation for consistency
        if (scores.length > 0) {
            const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
            const variance = scores.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / scores.length;
            managerScoreStats[manager.name] = {
                stdDev: Math.sqrt(variance),
                avg
            };
        }
    });

    // Most consistent (lowest std dev)
    let mostConsistent = { name: '', stdDev: Infinity };
    Object.entries(managerScoreStats).forEach(([name, stats]) => {
        if (stats.stdDev < mostConsistent.stdDev) {
            mostConsistent = { name, stdDev: Math.round(stats.stdDev * 10) / 10 };
        }
    });

    // Get losers count from cached data
    const loserCounts = {};
    managers.forEach(m => loserCounts[m.player_name] = 0);
    if (dataCache.losers?.losers) {
        dataCache.losers.losers.forEach(l => {
            if (loserCounts[l.name] !== undefined) {
                loserCounts[l.name]++;
            }
        });
    }

    let mostLosses = { name: '', count: 0 };
    Object.entries(loserCounts).forEach(([name, count]) => {
        if (count > mostLosses.count) {
            mostLosses = { name, count };
        }
    });

    // Get MotM wins from cached data
    const motmCounts = {};
    managers.forEach(m => motmCounts[m.player_name] = 0);
    if (dataCache.motm?.winners) {
        dataCache.motm.winners.forEach(w => {
            if (w.winner?.name && motmCounts[w.winner.name] !== undefined) {
                motmCounts[w.winner.name]++;
            }
        });
    }

    let mostMotM = { name: '', count: 0 };
    Object.entries(motmCounts).forEach(([name, count]) => {
        if (count > mostMotM.count) {
            mostMotM = { name, count };
        }
    });

    // Calculate bench points wasted
    let mostBenchWasted = { name: '', total: 0 };
    for (const manager of histories) {
        const benchData = await fetchBenchPoints(manager.entryId, completedGWs, bootstrap);
        if (benchData.total > mostBenchWasted.total) {
            mostBenchWasted = { name: manager.name, total: benchData.total };
        }
    }

    // Calculate best and worst captain picks across all managers
    let bestCaptain = { manager: '', player: '', points: 0, gw: 0 };
    let worstCaptain = { manager: '', player: '', points: Infinity, gw: 0 };

    for (const manager of histories) {
        const captainPicks = await fetchAllCaptainPicks(manager.entryId, completedGWs, bootstrap);
        captainPicks.forEach(pick => {
            if (pick.points > bestCaptain.points) {
                bestCaptain = { manager: manager.name, player: pick.playerName, points: pick.points, gw: pick.gw };
            }
            if (pick.points < worstCaptain.points) {
                worstCaptain = { manager: manager.name, player: pick.playerName, points: pick.points, gw: pick.gw };
            }
        });
    }

    if (worstCaptain.points === Infinity) {
        worstCaptain = { manager: '-', player: '-', points: 0, gw: 0 };
    }

    // Fix lowestGW if still infinity
    if (lowestGW.score === Infinity) {
        lowestGW = { name: '-', score: 0, gw: 0 };
    }

    return {
        highlights: {
            highestGW,
            biggestClimb,
            bestCaptain,
            mostMotM,
            mostConsistent
        },
        lowlights: {
            lowestGW,
            mostLosses,
            biggestHit,
            worstCaptain,
            mostBenchWasted,
            biggestDrop,
            mostTransfers
        }
    };
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
            ...dataCache,  // Preserve week data
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
let livePollingInterval = null;
let isLivePolling = false;

async function getFixturesForCurrentGW(forceRefresh = false) {
    const now = Date.now();
    // Cache fixtures for 1 hour unless forced
    if (!forceRefresh && fixturesCache && lastFixturesFetch && (now - lastFixturesFetch) < 3600000) {
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
    // Match duration approximately 115 minutes (90 + stoppage + halftime + buffer for final whistle)
    const kickoff = new Date(kickoffTime);
    return new Date(kickoff.getTime() + 115 * 60 * 1000);
}

// Group fixtures into kickoff windows (matches starting within 30 mins of each other)
function groupFixturesIntoWindows(fixtures) {
    if (!fixtures || fixtures.length === 0) return [];

    const sortedFixtures = fixtures
        .filter(f => f.kickoff_time)
        .map(f => ({ ...f, kickoffDate: new Date(f.kickoff_time) }))
        .sort((a, b) => a.kickoffDate - b.kickoffDate);

    const windows = [];
    let currentWindow = null;

    sortedFixtures.forEach(fixture => {
        if (!currentWindow) {
            currentWindow = {
                start: fixture.kickoffDate,
                end: getMatchEndTime(fixture.kickoffDate),
                fixtures: [fixture]
            };
        } else {
            // If this kickoff is within 30 mins of the window start, add to current window
            const timeDiff = fixture.kickoffDate - currentWindow.start;
            if (timeDiff <= 30 * 60 * 1000) {
                currentWindow.fixtures.push(fixture);
                // Extend window end time if this match ends later
                const matchEnd = getMatchEndTime(fixture.kickoffDate);
                if (matchEnd > currentWindow.end) {
                    currentWindow.end = matchEnd;
                }
            } else {
                // Start a new window
                windows.push(currentWindow);
                currentWindow = {
                    start: fixture.kickoffDate,
                    end: getMatchEndTime(fixture.kickoffDate),
                    fixtures: [fixture]
                };
            }
        }
    });

    if (currentWindow) {
        windows.push(currentWindow);
    }

    return windows;
}

function startLivePolling(reason) {
    if (isLivePolling) {
        console.log('[Live] Already polling - skipping start');
        return;
    }

    isLivePolling = true;
    console.log(`[Live] Starting live polling (60s interval) - ${reason}`);

    // Immediate refresh when starting
    refreshAllData(`live-start-${reason}`);
    refreshWeekData().catch(e => console.error('[Live] Week refresh failed:', e.message));

    // Poll every 60 seconds
    livePollingInterval = setInterval(async () => {
        await refreshAllData('live-poll');
        await refreshWeekData().catch(e => console.error('[Live] Week refresh failed:', e.message));
    }, 60 * 1000);
}

function stopLivePolling(reason) {
    if (!isLivePolling) return;

    isLivePolling = false;
    if (livePollingInterval) {
        clearInterval(livePollingInterval);
        livePollingInterval = null;
    }

    console.log(`[Live] Stopped live polling - ${reason}`);

    // Do one final refresh to capture final scores
    refreshAllData(`live-end-${reason}`);
    refreshWeekData().catch(e => console.error('[Live] Week refresh failed:', e.message));
}

async function scheduleRefreshes() {
    // Clear existing scheduled jobs
    scheduledJobs.forEach(job => job.stop());
    scheduledJobs = [];

    // Stop any live polling
    stopLivePolling('reschedule');

    console.log('[Scheduler] Calculating refresh schedule...');

    const fixtureData = await getFixturesForCurrentGW(true); // Force refresh fixture data
    if (!fixtureData) {
        console.log('[Scheduler] No fixture data available - will retry in 1 hour');
        const retryJob = setTimeout(scheduleRefreshes, 3600000);
        scheduledJobs.push({ stop: () => clearTimeout(retryJob) });
        return;
    }

    const now = new Date();
    const { currentGWFixtures, currentGW, events } = fixtureData;

    console.log(`[Scheduler] Current GW: ${currentGW}`);

    // Group fixtures into kickoff windows
    const windows = groupFixturesIntoWindows(currentGWFixtures);

    console.log(`[Scheduler] Found ${windows.length} match window(s) for GW ${currentGW}`);

    // Check if we're currently in a live window
    let currentlyLive = false;
    windows.forEach((window, idx) => {
        const pollStart = new Date(window.start.getTime() - 5 * 60 * 1000); // 5 mins before kickoff
        const pollEnd = window.end;

        if (now >= pollStart && now <= pollEnd) {
            currentlyLive = true;
            const matchCount = window.fixtures.length;
            const kickoffTime = window.start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            startLivePolling(`${matchCount} match(es) at ${kickoffTime}`);

            // Schedule stop at window end
            const stopDelay = pollEnd.getTime() - now.getTime();
            if (stopDelay > 0) {
                const stopJob = setTimeout(() => {
                    stopLivePolling('window-end');
                    // Re-schedule after window ends
                    setTimeout(scheduleRefreshes, 60000);
                }, stopDelay);
                scheduledJobs.push({ stop: () => clearTimeout(stopJob) });
                console.log(`[Scheduler] Will stop polling at ${pollEnd.toLocaleTimeString('en-GB')}`);
            }
        }
    });

    // Schedule future windows
    if (!currentlyLive) {
        windows.forEach((window, idx) => {
            const pollStart = new Date(window.start.getTime() - 5 * 60 * 1000);
            const pollEnd = window.end;

            if (pollStart > now) {
                // Schedule start of live polling
                const startDelay = pollStart.getTime() - now.getTime();
                const matchCount = window.fixtures.length;
                const kickoffTime = window.start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

                console.log(`[Scheduler] Window ${idx + 1}: ${matchCount} match(es) at ${kickoffTime}`);
                console.log(`  - Polling starts: ${pollStart.toLocaleString('en-GB')}`);
                console.log(`  - Polling ends: ${pollEnd.toLocaleString('en-GB')}`);

                if (startDelay < 7 * 24 * 60 * 60 * 1000) { // Within 7 days
                    const startJob = setTimeout(() => {
                        startLivePolling(`${matchCount} match(es) at ${kickoffTime}`);

                        // Schedule stop
                        const stopDelay = pollEnd.getTime() - Date.now();
                        if (stopDelay > 0) {
                            const stopJob = setTimeout(() => {
                                stopLivePolling('window-end');
                                setTimeout(scheduleRefreshes, 60000);
                            }, stopDelay);
                            scheduledJobs.push({ stop: () => clearTimeout(stopJob) });
                        }
                    }, startDelay);
                    scheduledJobs.push({ stop: () => clearTimeout(startJob) });
                }
            }
        });
    }

    // Schedule morning-after refresh (8 AM day after last GW match)
    const allKickoffs = currentGWFixtures
        .filter(f => f.kickoff_time)
        .map(f => new Date(f.kickoff_time));

    if (allKickoffs.length > 0) {
        const lastGWKickoff = new Date(Math.max(...allKickoffs));
        const lastMatchEnd = getMatchEndTime(lastGWKickoff);

        const morningAfter = new Date(lastMatchEnd);
        morningAfter.setDate(morningAfter.getDate() + 1);
        morningAfter.setHours(8, 0, 0, 0);

        if (morningAfter > now) {
            const delay = morningAfter.getTime() - now.getTime();
            if (delay < 7 * 24 * 60 * 60 * 1000) {
                console.log(`[Scheduler] Morning-after refresh: ${morningAfter.toLocaleString('en-GB')}`);
                const morningJob = setTimeout(async () => {
                    await morningRefreshWithAlert();
                    setTimeout(scheduleRefreshes, 60000);
                }, delay);
                scheduledJobs.push({ stop: () => clearTimeout(morningJob) });
            }
        }
    }

    // Schedule daily fixture check at 6 AM if no windows scheduled within 24 hours
    const nextWindow = windows.find(w => w.start > now);
    const hoursUntilNextWindow = nextWindow ? (nextWindow.start - now) / (1000 * 60 * 60) : Infinity;

    if (hoursUntilNextWindow > 24 || !nextWindow) {
        // Calculate next 6 AM
        const next6AM = new Date(now);
        next6AM.setHours(6, 0, 0, 0);
        if (next6AM <= now) {
            next6AM.setDate(next6AM.getDate() + 1);
        }

        const delay = next6AM.getTime() - now.getTime();
        console.log(`[Scheduler] Daily fixture check: ${next6AM.toLocaleString('en-GB')}`);

        const dailyJob = setTimeout(async () => {
            console.log('[Daily] Checking for fixture changes...');
            await getFixturesForCurrentGW(true);
            await refreshAllData('daily-check');
            scheduleRefreshes();
        }, delay);
        scheduledJobs.push({ stop: () => clearTimeout(dailyJob) });
    }

    // Summary
    const scheduledCount = scheduledJobs.length;
    console.log(`[Scheduler] ${scheduledCount} job(s) scheduled. ${isLivePolling ? 'LIVE POLLING ACTIVE' : 'Waiting for matches'}`);
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
    // Parse URL for dynamic routes
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // Track visitor for analytics
    trackVisitor(req);

    // API routes - serve from cache, fallback to live fetch
    const apiRoutes = {
        '/api/league': () => dataCache.league || fetchLeagueData(),
        '/api/standings': () => dataCache.standings || fetchStandingsWithTransfers(),
        '/api/losers': () => dataCache.losers || fetchWeeklyLosers(),
        '/api/motm': () => dataCache.motm || fetchMotmData(),
        '/api/chips': () => dataCache.chips || fetchChipsData(),
        '/api/earnings': () => dataCache.earnings || fetchProfitLossData(),
        '/api/week': () => dataCache.week || refreshWeekData(),
        '/api/stats': () => {
            // Convert daily stats Sets to counts for JSON
            const dailyData = {};
            Object.entries(visitorStats.dailyStats).forEach(([date, data]) => {
                const visitors = data.visitors instanceof Set ? data.visitors.size :
                    (Array.isArray(data.visitors) ? data.visitors.length : 0);
                dailyData[date] = { visits: data.visits, visitors };
            });
            return {
                totalVisits: visitorStats.totalVisits,
                uniqueVisitors: visitorStats.uniqueVisitorsSet.size,
                trackingSince: visitorStats.startTime,
                dailyStats: dailyData
            };
        },
    };

    // Check for manager picks route: /api/manager/:entryId/picks
    const managerPicksMatch = pathname.match(/^\/api\/manager\/(\d+)\/picks$/);
    if (managerPicksMatch) {
        try {
            const entryId = parseInt(managerPicksMatch[1]);
            const gw = url.searchParams.get('gw');
            const bootstrap = await fetchBootstrap();
            const currentGW = gw ? parseInt(gw) : bootstrap.events.find(e => e.is_current)?.id || 1;
            const data = await fetchManagerPicksDetailed(entryId, currentGW);
            serveJSON(res, data);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Check for manager profile route: /api/manager/:entryId/profile
    const managerProfileMatch = pathname.match(/^\/api\/manager\/(\d+)\/profile$/);
    if (managerProfileMatch) {
        try {
            const entryId = parseInt(managerProfileMatch[1]);
            const data = await fetchManagerProfile(entryId);
            serveJSON(res, data);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Hall of Fame API route
    if (pathname === '/api/hall-of-fame') {
        try {
            const data = await fetchHallOfFameData();
            serveJSON(res, data);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    if (apiRoutes[pathname]) {
        try {
            const data = await apiRoutes[pathname]();
            serveJSON(res, data);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    } else if (pathname === '/styles.css') {
        serveFile(res, 'styles.css', 'text/css');
    } else if (pathname === '/favicon.svg') {
        serveFile(res, 'favicon.svg', 'image/svg+xml');
    } else if (pathname === '/standings') {
        serveFile(res, 'standings.html');
    } else if (pathname === '/losers') {
        serveFile(res, 'losers.html');
    } else if (pathname === '/motm') {
        serveFile(res, 'motm.html');
    } else if (pathname === '/chips') {
        serveFile(res, 'chips.html');
    } else if (pathname === '/earnings') {
        serveFile(res, 'earnings.html');
    } else if (pathname === '/rules') {
        serveFile(res, 'rules.html');
    } else if (pathname === '/week') {
        serveFile(res, 'week.html');
    } else if (pathname === '/hall-of-fame') {
        serveFile(res, 'hall-of-fame.html');
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

    // Start HTTP server FIRST so Render detects the port quickly
    server.listen(PORT, () => {
        console.log(`[Server] Running at http://localhost:${PORT}`);
        console.log('='.repeat(60));
    });

    // Do initial data fetch in background (after port is open)
    console.log('[Startup] Performing initial data fetch...');
    await refreshAllData('startup');
    await refreshWeekData().catch(e => console.error('[Startup] Week refresh failed:', e.message));

    // Schedule future refreshes based on fixtures
    await scheduleRefreshes();

    console.log('[Startup] Initialization complete');
}

startup();
