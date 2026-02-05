const http = require('http');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const config = require('./config');

// Import commonly used config values
const {
    LEAGUE_ID,
    CURRENT_SEASON,
    PORT,
    ADMIN_PASSWORD,
    API_TIMEOUT_MS,
    FPL_API_BASE_URL
} = config;

const ALERT_EMAIL = config.email.ALERT_EMAIL;
const EMAIL_USER = config.email.EMAIL_USER;
const EMAIL_PASS = config.email.EMAIL_PASS;
const MOTM_PERIODS = config.fpl.MOTM_PERIODS;
const ALL_CHIPS = config.fpl.ALL_CHIPS;
const LOSER_OVERRIDES = config.fpl.LOSER_OVERRIDES;

// Import lib modules
const { getFormationCounts, isValidFormation } = require('./lib/formation');
const {
    formatTiedNames,
    updateRecordWithTies,
    updateRecordWithTiesLow,
    getMatchEndTime,
    groupFixturesIntoWindows
} = require('./lib/utils');

// =============================================================================
// API STATUS TRACKING - Tracks FPL API availability
// =============================================================================
let apiStatus = {
    available: true,
    lastError: null,
    lastErrorTime: null,
    lastSuccessTime: null,
    errorMessage: null  // e.g., "The game is being updated."
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
    managerProfiles: {},  // Pre-calculated manager profiles by entryId
    hallOfFame: null,     // Pre-calculated hall of fame data
    setAndForget: null,   // Pre-calculated set-and-forget data
    tinkeringCache: {},   // Cached tinkering results by `${entryId}-${gw}`
    picksCache: {},       // Cached raw picks by `${entryId}-${gw}`
    liveDataCache: {},    // Cached live GW data by gw number
    processedPicksCache: {},  // Cached processed/enriched picks by `${entryId}-${gw}`
    lastRefresh: null,
    lastWeekRefresh: null,  // Separate timestamp for live week data
    lastDataHash: null  // For detecting overnight changes
};

// =============================================================================
// LIVE EVENT STATE TRACKING - Tracks previous state to detect changes
// =============================================================================
let liveEventState = {
    bonusPositions: {},    // { fixtureId: { playerId: bonusPoints, ... } }
    cleanSheets: {},       // { fixtureId: { home: bool, away: bool } }
    defcons: {},           // { playerId: true }
    scores: {},            // { fixtureId: { home: x, away: y } }
    changeEvents: [],      // Rolling list of change events for ticker
    lastUpdate: null,
    lastGW: null           // Track last GW to detect transitions
};

// Maximum number of change events to keep
const MAX_CHANGE_EVENTS = config.limits.MAX_CHANGE_EVENTS;

// =============================================================================
// ADMIN REBUILD STATUS TRACKING
// =============================================================================
let rebuildStatus = {
    inProgress: false,
    startTime: null,
    phase: null,        // 'clearing', 'refreshing', 'picks', 'tinkering', 'complete', 'failed'
    progress: null,     // e.g., '15/375 picks'
    error: null,
    result: null        // Final result when complete
};

// =============================================================================
// CHRONOLOGICAL EVENT TRACKING - Tracks events in order they happen
// =============================================================================
let chronologicalEvents = [];  // Persisted to Redis, cleared on GW transition

// Previous player state for detecting new events
// Structure: { fixtureId_playerId: { goals_scored: pts, assists: pts, clean_sheets: pts, ... } }
let previousPlayerState = {};

// Previous bonus positions for detecting changes
// Structure: { fixtureId: { 3: [playerIds], 2: [playerIds], 1: [playerIds] } }
let previousBonusPositions = {};

// Event type priority for ordering same-poll events (lower = higher priority)
const EVENT_PRIORITY = config.events.EVENT_PRIORITY;

// Maximum chronological events to keep (prevents unbounded growth)
const MAX_CHRONO_EVENTS = config.limits.MAX_CHRONO_EVENTS;

// =============================================================================
// VISITOR STATS - Persistent analytics tracking via Upstash Redis
// =============================================================================
const UPSTASH_URL = config.redis.UPSTASH_URL;
const UPSTASH_TOKEN = config.redis.UPSTASH_TOKEN;

let visitorStats = {
    totalVisits: 0,
    uniqueVisitors: [],  // Array for JSON serialization
    uniqueVisitorsSet: new Set(),  // Set for fast lookups
    startTime: new Date().toISOString(),
    dailyStats: {}  // { "2024-01-15": { visits: 10, visitors: 5 } }
};

async function redisGet(key) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        console.log('[Redis] No credentials configured');
        return null;
    }
    try {
        const response = await fetch(`${UPSTASH_URL}/get/${key}`, {
            headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
        });
        const data = await response.json();
        return data.result ? JSON.parse(data.result) : null;
    } catch (error) {
        console.error('[Redis] GET error:', error.message);
        return null;
    }
}

async function redisSet(key, value) {
    if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
    try {
        const response = await fetch(`${UPSTASH_URL}/set/${key}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
            body: JSON.stringify(value)
        });
        return response.ok;
    } catch (error) {
        console.error('[Redis] SET error:', error.message);
        return false;
    }
}

// Chronological events Redis functions
async function getChronologicalEvents(gw) {
    const data = await redisGet(`chronological-events-gw${gw}`);
    return data || [];
}

async function setChronologicalEvents(gw, events) {
    return await redisSet(`chronological-events-gw${gw}`, events);
}

async function clearChronologicalEvents(gw) {
    return await redisSet(`chronological-events-gw${gw}`, []);
}

async function loadChronologicalEvents(gw) {
    try {
        const events = await getChronologicalEvents(gw);
        chronologicalEvents = events;
        console.log(`[ChronoEvents] Loaded ${events.length} events from Redis for GW${gw}`);
        return events;
    } catch (error) {
        console.error('[ChronoEvents] Error loading events:', error.message);
        return [];
    }
}

async function saveChronologicalEvents(gw) {
    try {
        const success = await setChronologicalEvents(gw, chronologicalEvents);
        if (success) {
            console.log(`[ChronoEvents] Saved ${chronologicalEvents.length} events to Redis for GW${gw}`);
        }
        return success;
    } catch (error) {
        console.error('[ChronoEvents] Error saving events:', error.message);
        return false;
    }
}

async function loadPreviousPlayerState(gw) {
    try {
        const state = await redisGet(`previous-player-state-gw${gw}`);
        if (state && Object.keys(state).length > 0) {
            previousPlayerState = state;
            console.log(`[ChronoEvents] Loaded previousPlayerState with ${Object.keys(state).length} entries for GW${gw}`);
        }
        const bonus = await redisGet(`previous-bonus-positions-gw${gw}`);
        if (bonus && Object.keys(bonus).length > 0) {
            previousBonusPositions = bonus;
            console.log(`[ChronoEvents] Loaded previousBonusPositions with ${Object.keys(bonus).length} fixtures for GW${gw}`);
        }
    } catch (error) {
        console.error('[ChronoEvents] Error loading previous state:', error.message);
    }
}

async function savePreviousPlayerState(gw) {
    try {
        await redisSet(`previous-player-state-gw${gw}`, previousPlayerState);
        await redisSet(`previous-bonus-positions-gw${gw}`, previousBonusPositions);
    } catch (error) {
        console.error('[ChronoEvents] Error saving previous state:', error.message);
    }
}

async function clearPreviousPlayerState(gw) {
    try {
        await redisSet(`previous-player-state-gw${gw}`, {});
        await redisSet(`previous-bonus-positions-gw${gw}`, {});
        previousPlayerState = {};
        previousBonusPositions = {};
        console.log(`[ChronoEvents] Cleared previous state for GW${gw}`);
    } catch (error) {
        console.error('[ChronoEvents] Error clearing previous state:', error.message);
    }
}

async function loadVisitorStats() {
    try {
        const data = await redisGet('visitor-stats');
        if (data) {
            visitorStats.totalVisits = data.totalVisits || 0;
            visitorStats.uniqueVisitors = data.uniqueVisitors || [];
            visitorStats.uniqueVisitorsSet = new Set(visitorStats.uniqueVisitors);
            visitorStats.startTime = data.startTime || new Date().toISOString();
            visitorStats.dailyStats = data.dailyStats || {};
            console.log(`[Stats] Loaded from Redis: ${visitorStats.totalVisits} visits, ${visitorStats.uniqueVisitorsSet.size} unique visitors`);
        } else {
            console.log('[Stats] No existing stats in Redis, starting fresh');
        }
    } catch (error) {
        console.error('[Stats] Error loading stats:', error.message);
    }
}

async function saveVisitorStats() {
    try {
        // Convert Sets to Arrays for JSON serialization
        const dailyStatsSerializable = {};
        Object.entries(visitorStats.dailyStats).forEach(([date, data]) => {
            dailyStatsSerializable[date] = {
                visits: data.visits,
                visitors: data.visitors instanceof Set ? Array.from(data.visitors) : data.visitors
            };
        });

        const data = {
            totalVisits: visitorStats.totalVisits,
            uniqueVisitors: Array.from(visitorStats.uniqueVisitorsSet),
            startTime: visitorStats.startTime,
            dailyStats: dailyStatsSerializable
        };
        const success = await redisSet('visitor-stats', data);
        if (success) {
            console.log(`[Stats] Saved to Redis: ${visitorStats.totalVisits} visits`);
        }
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
process.on('SIGTERM', async () => {
    await saveVisitorStats();
    if (liveEventState.lastGW) await savePreviousPlayerState(liveEventState.lastGW);
    process.exit(0);
});
process.on('SIGINT', async () => {
    await saveVisitorStats();
    if (liveEventState.lastGW) await savePreviousPlayerState(liveEventState.lastGW);
    process.exit(0);
});

// =============================================================================
// DATA CACHE PERSISTENCE - Survives server restarts
// =============================================================================
async function saveDataCache() {
    try {
        // Only persist the main data, not the temporary caches
        const persistData = {
            standings: dataCache.standings,
            losers: dataCache.losers,
            motm: dataCache.motm,
            chips: dataCache.chips,
            earnings: dataCache.earnings,
            league: dataCache.league,
            week: dataCache.week,
            managerProfiles: dataCache.managerProfiles,
            hallOfFame: dataCache.hallOfFame,
            setAndForget: dataCache.setAndForget,
            lastRefresh: dataCache.lastRefresh,
            lastWeekRefresh: dataCache.lastWeekRefresh,
            lastDataHash: dataCache.lastDataHash
        };
        const success = await redisSet('data-cache', persistData);
        if (success) {
            console.log(`[DataCache] Saved to Redis at ${new Date().toLocaleString('en-GB')}`);
        }
    } catch (error) {
        console.error('[DataCache] Error saving:', error.message);
    }
}

async function loadDataCache() {
    try {
        const data = await redisGet('data-cache');
        if (data) {
            dataCache.standings = data.standings || null;
            dataCache.losers = data.losers || null;
            dataCache.motm = data.motm || null;
            dataCache.chips = data.chips || null;
            dataCache.earnings = data.earnings || null;
            dataCache.league = data.league || null;
            dataCache.week = data.week || null;
            dataCache.managerProfiles = data.managerProfiles || {};
            dataCache.hallOfFame = data.hallOfFame || null;
            dataCache.setAndForget = data.setAndForget || null;
            dataCache.lastRefresh = data.lastRefresh || null;
            dataCache.lastWeekRefresh = data.lastWeekRefresh || null;
            dataCache.lastDataHash = data.lastDataHash || null;
            console.log(`[DataCache] Loaded from Redis (last refresh: ${data.lastRefresh || 'unknown'})`);
            return true;
        } else {
            console.log('[DataCache] No cached data in Redis');
            return false;
        }
    } catch (error) {
        console.error('[DataCache] Error loading:', error.message);
        return false;
    }
}

// =============================================================================
// SEASON ARCHIVE MANAGEMENT
// =============================================================================
let archivedSeasons = {};  // Cache of archived season data

async function loadArchivedSeasons() {
    try {
        const seasonsList = await redisGet('archived-seasons-list');
        if (seasonsList && Array.isArray(seasonsList)) {
            console.log(`[Seasons] Found ${seasonsList.length} archived season(s): ${seasonsList.join(', ')}`);
            // Load each archived season into memory
            for (const season of seasonsList) {
                const data = await redisGet(`season-${season}`);
                if (data) {
                    archivedSeasons[season] = data;
                    console.log(`[Seasons] Loaded ${season}`);
                }
            }
        } else {
            console.log('[Seasons] No archived seasons found');
        }
    } catch (error) {
        console.error('[Seasons] Error loading archived seasons:', error.message);
    }
}

async function archiveCurrentSeason() {
    try {
        console.log(`[Seasons] Archiving season ${CURRENT_SEASON}...`);

        // Gather all current data
        const archive = {
            season: CURRENT_SEASON,
            archivedAt: new Date().toISOString(),
            leagueName: dataCache.league?.league?.name || 'Unknown',
            standings: dataCache.standings,
            losers: dataCache.losers,
            motm: dataCache.motm,
            chips: dataCache.chips,
            earnings: dataCache.earnings,
            hallOfFame: dataCache.hallOfFame,
            managerProfiles: dataCache.managerProfiles
        };

        // Save to Redis
        const success = await redisSet(`season-${CURRENT_SEASON}`, archive);
        if (!success) {
            throw new Error('Failed to save to Redis');
        }

        // Update seasons list
        let seasonsList = await redisGet('archived-seasons-list') || [];
        if (!seasonsList.includes(CURRENT_SEASON)) {
            seasonsList.push(CURRENT_SEASON);
            seasonsList.sort().reverse();  // Most recent first
            await redisSet('archived-seasons-list', seasonsList);
        }

        // Update local cache
        archivedSeasons[CURRENT_SEASON] = archive;

        console.log(`[Seasons] Successfully archived ${CURRENT_SEASON}`);
        return { success: true, season: CURRENT_SEASON };
    } catch (error) {
        console.error('[Seasons] Archive error:', error.message);
        return { success: false, error: error.message };
    }
}

async function getAvailableSeasons() {
    const seasons = [{ id: CURRENT_SEASON, label: `${CURRENT_SEASON} (Current)`, isCurrent: true }];

    const archivedList = await redisGet('archived-seasons-list') || [];
    for (const season of archivedList) {
        if (season !== CURRENT_SEASON) {
            seasons.push({ id: season, label: season, isCurrent: false });
        }
    }

    return seasons;
}

function getSeasonData(season, dataType) {
    // If current season, return live data
    if (season === CURRENT_SEASON || !season) {
        return null;  // Caller should use dataCache
    }

    // Return archived data
    const archived = archivedSeasons[season];
    if (!archived) return null;

    return archived[dataType] || null;
}

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

async function fetchWithTimeout(url, timeoutMs = API_TIMEOUT_MS) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
        // Try to get error message from response body
        let errorBody = '';
        try {
            errorBody = await response.text();
            // FPL returns JSON string like "The game is being updated."
            if (errorBody.startsWith('"') && errorBody.endsWith('"')) {
                errorBody = JSON.parse(errorBody);
            }
        } catch (e) { /* ignore parse errors */ }

        // Only update API status for actual outages (5xx errors, 503, etc.)
        // 404 errors are expected for future GWs and shouldn't mark API as unavailable
        if (response.status >= 500 || response.status === 503) {
            apiStatus.available = false;
            apiStatus.lastError = `HTTP ${response.status}`;
            apiStatus.lastErrorTime = new Date().toISOString();
            apiStatus.errorMessage = errorBody || response.statusText;
        }

        throw new Error(`HTTP ${response.status}: ${errorBody || response.statusText} for ${url}`);
    }

    // API is working
    apiStatus.available = true;
    apiStatus.lastSuccessTime = new Date().toISOString();
    apiStatus.errorMessage = null;

    return response.json();
}

async function fetchLeagueData() {
    return fetchWithTimeout(`${FPL_API_BASE_URL}/leagues-classic/${LEAGUE_ID}/standings/`);
}

async function fetchBootstrap() {
    return fetchWithTimeout(`${FPL_API_BASE_URL}/bootstrap-static/`);
}

async function fetchManagerHistory(entryId) {
    return fetchWithTimeout(`${FPL_API_BASE_URL}/entry/${entryId}/history/`);
}

async function fetchFixtures() {
    return fetchWithTimeout(`${FPL_API_BASE_URL}/fixtures/`);
}

async function fetchLiveGWData(gw) {
    return fetchWithTimeout(`${FPL_API_BASE_URL}/event/${gw}/live/`);
}

async function fetchManagerPicks(entryId, gw) {
    return fetchWithTimeout(`${FPL_API_BASE_URL}/entry/${entryId}/event/${gw}/picks/`);
}

// Cached version of fetchManagerPicks - uses cache for completed GWs
async function fetchManagerPicksCached(entryId, gw, bootstrap = null) {
    const cacheKey = `${entryId}-${gw}`;

    // Check cache first
    if (dataCache.picksCache[cacheKey]) {
        return dataCache.picksCache[cacheKey];
    }

    // Fetch fresh
    const picks = await fetchManagerPicks(entryId, gw);

    // Cache if GW is completed (get bootstrap if not provided)
    if (!bootstrap) {
        bootstrap = await fetchBootstrap();
    }
    const gwEvent = bootstrap.events.find(e => e.id === gw);
    if (gwEvent?.finished) {
        dataCache.picksCache[cacheKey] = picks;
    }

    return picks;
}

// Cached version of fetchLiveGWData - uses cache for completed GWs
async function fetchLiveGWDataCached(gw, bootstrap = null) {
    // Check cache first
    if (dataCache.liveDataCache[gw]) {
        return dataCache.liveDataCache[gw];
    }

    // Fetch fresh
    const liveData = await fetchLiveGWData(gw);

    // Cache if GW is completed (get bootstrap if not provided)
    if (!bootstrap) {
        bootstrap = await fetchBootstrap();
    }
    const gwEvent = bootstrap.events.find(e => e.id === gw);
    if (gwEvent?.finished) {
        dataCache.liveDataCache[gw] = liveData;
    }

    return liveData;
}

async function fetchManagerData(entryId) {
    const response = await fetch(`${FPL_API_BASE_URL}/entry/${entryId}/`);
    return response.json();
}

// Get player stats for a specific fixture
async function getFixtureStats(fixtureId) {
    const [bootstrap, fixtures] = await Promise.all([
        fetchBootstrap(),
        fetchFixtures()
    ]);

    const fixture = fixtures.find(f => f.id === fixtureId);
    if (!fixture) {
        return { error: 'Fixture not found' };
    }

    if (!fixture.started) {
        return { error: 'Match not started yet' };
    }

    const gw = fixture.event;
    const liveData = await fetchLiveGWDataCached(gw, bootstrap);

    const POSITIONS = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

    // Helper to get player stats from live data
    const getPlayerStats = (element) => {
        const liveEl = liveData.elements.find(e => e.id === element.id);
        if (!liveEl || !liveEl.stats) return null;

        const stats = liveEl.stats;
        // Only include players who played (minutes > 0)
        if (stats.minutes === 0) return null;

        // Calculate provisional bonus from fixture BPS
        let bonus = 0;
        if (fixture.stats) {
            const bpsStat = fixture.stats.find(s => s.identifier === 'bps');
            if (bpsStat) {
                const allBps = [...(bpsStat.h || []), ...(bpsStat.a || [])]
                    .sort((a, b) => b.value - a.value);
                if (allBps.length > 0) {
                    const topBps = allBps.slice(0, 3);
                    const playerBps = topBps.find(b => b.element === element.id);
                    if (playerBps) {
                        const rank = topBps.findIndex(b => b.element === element.id);
                        bonus = rank === 0 ? 3 : rank === 1 ? 2 : 1;
                    }
                }
            }
        }

        // Get player's BPS from fixture stats
        let bps = 0;
        if (fixture.stats) {
            const bpsStat = fixture.stats.find(s => s.identifier === 'bps');
            if (bpsStat) {
                const playerBps = [...(bpsStat.h || []), ...(bpsStat.a || [])].find(b => b.element === element.id);
                if (playerBps) bps = playerBps.value;
            }
        }

        // Get saves from fixture stats
        let saves = 0;
        if (fixture.stats) {
            const savesStat = fixture.stats.find(s => s.identifier === 'saves');
            if (savesStat) {
                const playerSaves = [...(savesStat.h || []), ...(savesStat.a || [])].find(s => s.element === element.id);
                if (playerSaves) saves = playerSaves.value;
            }
        }

        // Get defensive contribution count from fixture stats
        let defcon = 0;
        if (fixture.stats) {
            const defconStat = fixture.stats.find(s => s.identifier === 'defensive_contribution');
            if (defconStat) {
                const playerDefcon = [...(defconStat.h || []), ...(defconStat.a || [])].find(d => d.element === element.id);
                if (playerDefcon) defcon = playerDefcon.value || 0;
            }
        }

        // Build points breakdown from explain data
        const explainData = liveEl?.explain || [];
        const pointsBreakdown = [];

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
            'defensive_contribution': { name: 'Defensive contribution', icon: '🔒' }
        };

        explainData.forEach(fixtureExplain => {
            if (fixtureExplain.stats) {
                fixtureExplain.stats.forEach(stat => {
                    if (stat.points !== 0) {
                        const info = STAT_INFO[stat.identifier] || { name: stat.identifier.replace(/_/g, ' '), icon: '📋' };
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

        // Position-based event hierarchy:
        // - Minutes always first
        // - Bonus always last
        // - Other events ordered by relevance to position
        const positionHierarchy = {
            // GKP: saves and penalties_saved are core, then clean sheet, then attacking
            1: ['minutes', 'penalties_saved', 'saves', 'clean_sheets', 'goals_scored', 'assists', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // DEF: clean sheets most important, then attacking contribution
            2: ['minutes', 'clean_sheets', 'goals_scored', 'assists', 'defensive_contribution', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // MID: goals and assists primary, clean sheet secondary
            3: ['minutes', 'goals_scored', 'assists', 'clean_sheets', 'defensive_contribution', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // FWD: goals and assists are everything (no clean sheet points)
            4: ['minutes', 'goals_scored', 'assists', 'defensive_contribution', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus']
        };

        const hierarchy = positionHierarchy[element.element_type] || positionHierarchy[4];
        pointsBreakdown.sort((a, b) => {
            const aIndex = hierarchy.indexOf(a.identifier);
            const bIndex = hierarchy.indexOf(b.identifier);
            // Unknown stats go before bonus but after known stats
            const aPos = aIndex === -1 ? hierarchy.length - 1 : aIndex;
            const bPos = bIndex === -1 ? hierarchy.length - 1 : bIndex;
            return aPos - bPos;
        });

        // Get team info
        const team = bootstrap.teams.find(t => t.id === element.team);

        return {
            id: element.id,
            name: element.web_name,
            fullName: `${element.first_name} ${element.second_name}`,
            position: POSITIONS[element.element_type] || 'UNK',
            positionId: element.element_type,
            teamName: team?.short_name || 'UNK',
            teamCode: team?.code || 1,
            points: stats.total_points,
            goals: stats.goals_scored || 0,
            assists: stats.assists || 0,
            cleanSheet: stats.clean_sheets > 0,
            saves: saves,
            defcon: defcon,
            yellowCard: stats.yellow_cards > 0,
            redCard: stats.red_cards > 0,
            bonus: bonus,
            bps: bps,
            minutes: stats.minutes,
            started: stats.starts === 1,
            pointsBreakdown
        };
    };

    // Sort by position (GKP=1, DEF=2, MID=3, FWD=4) then by points within position
    const sortByPosition = (a, b) => {
        if (a.positionId !== b.positionId) return a.positionId - b.positionId;
        return b.points - a.points;
    };

    // Separate starters from subs based on whether they started the match
    const separateStartersAndSubs = (players) => {
        const starters = players.filter(p => p.started).sort(sortByPosition);
        const subs = players.filter(p => !p.started).sort(sortByPosition);
        return { starters, subs };
    };

    // Get all players from both teams
    const homeAll = bootstrap.elements
        .filter(e => e.team === fixture.team_h)
        .map(getPlayerStats)
        .filter(p => p !== null);
    const homeSplit = separateStartersAndSubs(homeAll);

    const awayAll = bootstrap.elements
        .filter(e => e.team === fixture.team_a)
        .map(getPlayerStats)
        .filter(p => p !== null);
    const awaySplit = separateStartersAndSubs(awayAll);

    return {
        home: { starters: homeSplit.starters, subs: homeSplit.subs },
        away: { starters: awaySplit.starters, subs: awaySplit.subs },
        fixtureId,
        homeScore: fixture.team_h_score,
        awayScore: fixture.team_a_score,
        finished: fixture.finished
    };
}

// =============================================================================
// AUTO-SUB POINTS CALCULATION HELPER
// =============================================================================
function calculatePointsWithAutoSubs(picks, liveData, bootstrap, gwFixtures) {
    if (!picks?.picks || !liveData?.elements) {
        return { totalPoints: picks?.entry_history?.points || 0, benchPoints: 0 };
    }

    const activeChip = picks.active_chip;

    // Helper to calculate provisional bonus for a fixture
    function calcProvisionalBonus(fixture) {
        if (!fixture?.stats) return {};
        const bpsStat = fixture.stats.find(s => s.identifier === 'bps');
        if (!bpsStat) return {};

        const allBps = [...(bpsStat.h || []), ...(bpsStat.a || [])]
            .sort((a, b) => b.value - a.value);

        if (allBps.length === 0) return {};

        const bonusMap = {};
        let currentRank = 1;
        let i = 0;

        while (i < allBps.length && currentRank <= 3) {
            const currentBps = allBps[i].value;
            const tiedPlayers = [];
            while (i < allBps.length && allBps[i].value === currentBps) {
                tiedPlayers.push(allBps[i].element);
                i++;
            }
            let bonusForRank = currentRank === 1 ? 3 : currentRank === 2 ? 2 : currentRank === 3 ? 1 : 0;
            if (bonusForRank > 0) {
                tiedPlayers.forEach(elementId => bonusMap[elementId] = bonusForRank);
            }
            currentRank += tiedPlayers.length;
        }
        return bonusMap;
    }

    // Pre-calculate provisional bonus for all live fixtures (started but not finished)
    const provisionalBonusMap = {};
    gwFixtures?.forEach(fixture => {
        if (fixture.started && !fixture.finished) {
            Object.assign(provisionalBonusMap, calcProvisionalBonus(fixture));
        }
    });

    // Build player data with live points
    const players = picks.picks.map((pick, idx) => {
        const element = bootstrap.elements.find(e => e.id === pick.element);
        const liveElement = liveData.elements.find(e => e.id === pick.element);
        const points = liveElement?.stats?.total_points || 0;
        const minutes = liveElement?.stats?.minutes || 0;

        // Get fixture status
        // Use finished_provisional - match has ended even if bonus not confirmed
        const fixture = gwFixtures?.find(f => f.team_h === element?.team || f.team_a === element?.team);
        const fixtureStarted = fixture?.started || false;
        const fixtureFinished = fixture?.finished_provisional || fixture?.finished || false;

        // Get official bonus - if this is > 0, bonus is already included in total_points
        const officialBonus = liveElement?.stats?.bonus || 0;

        // Get provisional bonus if match is live AND official bonus not yet added
        // When officialBonus > 0, the bonus is already in total_points, so don't add provisional
        const provisionalBonus = (fixtureStarted && !fixtureFinished && officialBonus === 0)
            ? (provisionalBonusMap[pick.element] || 0)
            : 0;

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
            provisionalBonus,
            subOut: false,
            subIn: false
        };
    });

    const starters = players.filter(p => !p.isBench);
    const bench = players.filter(p => p.isBench).sort((a, b) => a.benchOrder - b.benchOrder);

    // Only apply auto-subs if not using Bench Boost
    if (activeChip !== 'bboost') {
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

    // Calculate total points with auto-subs, captaincy, and provisional bonus
    // Provisional bonus DOES get captain multiplier
    let totalPoints = 0;
    let benchPoints = 0;

    players.forEach(p => {
        // Use actual multiplier from picks (3 for TC, 2 for normal captain, 1 for others)
        const multiplier = p.multiplier;
        // Both base points and provisional bonus get the multiplier
        const effectivePoints = (p.points + p.provisionalBonus) * multiplier;

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += p.points + p.provisionalBonus; // Subs don't get captain bonus
        } else if (p.isBench && !p.subIn) {
            benchPoints += p.points + p.provisionalBonus;
        }
    });

    // For Bench Boost, add bench points to total (they all count)
    if (activeChip === 'bboost') {
        totalPoints += benchPoints;
    }

    return { totalPoints, benchPoints, players };
}

// =============================================================================
// TINKERING IMPACT CALCULATION
// =============================================================================

/**
 * Calculate what score a previous team would have achieved with current GW's points
 * Applies auto-sub logic to the hypothetical team
 */
function calculateHypotheticalScore(previousPicks, liveData, bootstrap, gwFixtures) {
    if (!previousPicks?.picks || !liveData?.elements) {
        return { totalPoints: 0, benchPoints: 0, players: [] };
    }

    // Build player data with current GW's live points applied to previous team
    const players = previousPicks.picks.map((pick, idx) => {
        const element = bootstrap.elements.find(e => e.id === pick.element);
        const liveElement = liveData.elements.find(e => e.id === pick.element);
        const points = liveElement?.stats?.total_points || 0;
        const minutes = liveElement?.stats?.minutes || 0;

        // Get fixture status
        // Use finished_provisional - match has ended even if bonus not confirmed
        const fixture = gwFixtures?.find(f => f.team_h === element?.team || f.team_a === element?.team);
        const fixtureStarted = fixture?.started || false;
        const fixtureFinished = fixture?.finished_provisional || fixture?.finished || false;

        return {
            id: pick.element,
            name: element?.web_name || 'Unknown',
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

    // Apply auto-sub logic (same as actual team would use)
    // Find starters needing subs (0 mins and fixture done/in progress)
    const needsSub = starters.filter(p =>
        (p.fixtureFinished || (p.fixtureStarted && p.minutes === 0)) && p.minutes === 0
    );

    for (const playerOut of needsSub) {
        for (const benchPlayer of bench) {
            if (benchPlayer.subIn) continue;
            if (benchPlayer.minutes === 0 && (benchPlayer.fixtureFinished || benchPlayer.fixtureStarted)) continue;

            const testFormation = getFormationCounts(starters);

            if (playerOut.positionId === 1) testFormation.GKP--;
            else if (playerOut.positionId === 2) testFormation.DEF--;
            else if (playerOut.positionId === 3) testFormation.MID--;
            else if (playerOut.positionId === 4) testFormation.FWD--;

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

    // Calculate total points with auto-subs and captaincy
    let totalPoints = 0;
    let benchPoints = 0;

    players.forEach(p => {
        // Use actual multiplier from picks (3 for TC, 2 for normal captain, 1 for others)
        const effectivePoints = p.points * p.multiplier;

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += p.points; // Subs don't get captain bonus
        } else if (p.isBench && !p.subIn) {
            benchPoints += p.points;
        }
    });

    return { totalPoints, benchPoints, players };
}

/**
 * Calculate the tinkering impact for a manager in a given gameweek
 * Compares actual score vs what last week's team would have scored
 */
async function calculateTinkeringImpact(entryId, gw) {
    // GW1 has no previous team to compare
    if (gw <= 1) {
        return {
            available: false,
            reason: 'gw1',
            navigation: { currentGW: gw, minGW: 2, maxGW: gw, hasPrev: false, hasNext: false }
        };
    }

    // Check cache first for completed GWs
    const cacheKey = `${entryId}-${gw}`;
    if (dataCache.tinkeringCache[cacheKey]) {
        // Update navigation with current maxGW (may have changed)
        const cached = dataCache.tinkeringCache[cacheKey];
        const bootstrap = await fetchBootstrap();
        const currentGWEvent = bootstrap.events.find(e => e.is_current);
        const maxGW = currentGWEvent?.id || gw;
        cached.navigation = {
            ...cached.navigation,
            maxGW,
            hasNext: gw < maxGW
        };
        return cached;
    }

    try {
        const [bootstrap, fixtures] = await Promise.all([
            fetchBootstrap(),
            fetchFixtures()
        ]);

        const currentGWEvent = bootstrap.events.find(e => e.is_current);
        const maxGW = currentGWEvent?.id || gw;
        const gwFixtures = fixtures.filter(f => f.event === gw);

        // Check if this GW is completed (for caching)
        const gwEvent = bootstrap.events.find(e => e.id === gw);
        const isGWCompleted = gwEvent?.finished || false;

        // Fetch current GW picks (use cached version for completed GWs)
        const currentPicks = await fetchManagerPicksCached(entryId, gw, bootstrap);
        const currentChip = currentPicks.active_chip;

        // Determine which previous GW to compare against
        let compareGW = gw - 1;

        // Handle Free Hit edge case: if PREVIOUS week was Free Hit, go back one more week
        const prevPicks = await fetchManagerPicksCached(entryId, compareGW, bootstrap);
        if (prevPicks.active_chip === 'freehit' && compareGW > 1) {
            compareGW = compareGW - 1;
        }

        // Fetch the comparison picks (use cached version for completed GWs)
        const previousPicks = compareGW !== gw - 1
            ? await fetchManagerPicksCached(entryId, compareGW, bootstrap)
            : prevPicks;

        // Fetch live data for current GW (use cached version for completed GWs)
        const liveData = await fetchLiveGWDataCached(gw, bootstrap);

        // Calculate hypothetical score (what old team would have scored)
        const hypothetical = calculateHypotheticalScore(previousPicks, liveData, bootstrap, gwFixtures);

        // Calculate actual score with auto-subs
        const actual = calculatePointsWithAutoSubs(currentPicks, liveData, bootstrap, gwFixtures);

        // Get transfer cost
        const transferCost = currentPicks.entry_history?.event_transfers_cost || 0;

        // Calculate net impact
        const netImpact = actual.totalPoints - hypothetical.totalPoints - transferCost;

        // Identify transfers in/out with TRUE impact (considering bench position & auto-subs)
        const currentPlayerIds = new Set(currentPicks.picks.map(p => p.element));
        const previousPlayerIds = new Set(previousPicks.picks.map(p => p.element));

        const transfersIn = [];
        const transfersOut = [];

        // Helper to calculate a player's actual contribution to a team's score
        const getPlayerContribution = (playerId, playersArray) => {
            const player = playersArray?.find(p => p.id === playerId);
            if (!player) return 0;

            // If player is a starter (not subbed out) or subbed in, they contribute
            if ((!player.isBench && !player.subOut) || player.subIn) {
                // Subs don't get captain bonus; otherwise use multiplier (3 for TC, 2 for captain, 1 for others)
                const multiplier = player.subIn ? 1 : player.multiplier;
                return (player.points + (player.provisionalBonus || 0)) * multiplier;
            }
            return 0; // Bench player who didn't come on
        };

        // Find players transferred in - calculate their actual contribution to current team
        currentPicks.picks.forEach(pick => {
            if (!previousPlayerIds.has(pick.element)) {
                const element = bootstrap.elements.find(e => e.id === pick.element);
                const liveElement = liveData.elements.find(e => e.id === pick.element);
                const rawPoints = liveElement?.stats?.total_points || 0;
                const actualContribution = getPlayerContribution(pick.element, actual.players);

                transfersIn.push({
                    player: { id: pick.element, name: element?.web_name || 'Unknown' },
                    points: rawPoints,
                    impact: actualContribution, // True contribution to actual score
                    captained: pick.is_captain
                });
            }
        });

        // Find players transferred out - calculate what they would have contributed
        previousPicks.picks.forEach(pick => {
            if (!currentPlayerIds.has(pick.element)) {
                const element = bootstrap.elements.find(e => e.id === pick.element);
                const liveElement = liveData.elements.find(e => e.id === pick.element);
                const rawPoints = liveElement?.stats?.total_points || 0;
                const hypotheticalContribution = getPlayerContribution(pick.element, hypothetical.players);

                transfersOut.push({
                    player: { id: pick.element, name: element?.web_name || 'Unknown' },
                    points: rawPoints,
                    impact: hypotheticalContribution, // What they would have contributed
                    wasCaptain: pick.is_captain
                });
            }
        });

        // Identify captain change
        const oldCaptain = previousPicks.picks.find(p => p.is_captain);
        const newCaptain = currentPicks.picks.find(p => p.is_captain);

        const captainChange = {
            changed: oldCaptain?.element !== newCaptain?.element,
            oldCaptain: null,
            newCaptain: null,
            impact: 0
        };

        if (captainChange.changed) {
            const oldCaptainElement = bootstrap.elements.find(e => e.id === oldCaptain?.element);
            const newCaptainElement = bootstrap.elements.find(e => e.id === newCaptain?.element);
            const oldCaptainLive = liveData.elements.find(e => e.id === oldCaptain?.element);
            const newCaptainLive = liveData.elements.find(e => e.id === newCaptain?.element);

            const oldCaptainPts = oldCaptainLive?.stats?.total_points || 0;
            const newCaptainPts = newCaptainLive?.stats?.total_points || 0;

            captainChange.oldCaptain = {
                name: oldCaptainElement?.web_name || 'Unknown',
                points: oldCaptainPts
            };
            captainChange.newCaptain = {
                name: newCaptainElement?.web_name || 'Unknown',
                points: newCaptainPts
            };

            // Calculate captain change impact, avoiding double-counting with transfers AND lineup changes
            // If new captain was transferred in, their captain bonus is already in transfersIn
            // If old captain was transferred out, their captain loss is already in transfersOut
            // If new/old captain changed lineup position (bench <-> starting), their impact is already in lineupChanges
            const newCaptainIsTransfer = !previousPlayerIds.has(newCaptain?.element);
            const oldCaptainIsTransfer = !currentPlayerIds.has(oldCaptain?.element);

            // Check if captains changed lineup position (bench <-> starting)
            let newCaptainChangedPosition = false;
            let oldCaptainChangedPosition = false;

            if (!newCaptainIsTransfer) {
                const newCaptainCurrentIdx = currentPicks.picks.findIndex(p => p.element === newCaptain?.element);
                const newCaptainPreviousPick = previousPicks.picks.find(p => p.element === newCaptain?.element);
                const newCaptainPreviousIdx = newCaptainPreviousPick ? previousPicks.picks.indexOf(newCaptainPreviousPick) : -1;
                if (newCaptainPreviousIdx >= 0) {
                    const wasOnBench = newCaptainPreviousIdx >= 11;
                    const isOnBench = newCaptainCurrentIdx >= 11;
                    newCaptainChangedPosition = wasOnBench !== isOnBench;
                }
            }

            if (!oldCaptainIsTransfer) {
                const oldCaptainPreviousIdx = previousPicks.picks.findIndex(p => p.element === oldCaptain?.element);
                const oldCaptainCurrentPick = currentPicks.picks.find(p => p.element === oldCaptain?.element);
                const oldCaptainCurrentIdx = oldCaptainCurrentPick ? currentPicks.picks.indexOf(oldCaptainCurrentPick) : -1;
                if (oldCaptainCurrentIdx >= 0) {
                    const wasOnBench = oldCaptainPreviousIdx >= 11;
                    const isOnBench = oldCaptainCurrentIdx >= 11;
                    oldCaptainChangedPosition = wasOnBench !== isOnBench;
                }
            }

            let impact = 0;
            // Only add new captain's points if they're a kept player who didn't change position
            if (!newCaptainIsTransfer && !newCaptainChangedPosition) {
                impact += newCaptainPts;
            }
            // Only subtract old captain's points if they're a kept player who didn't change position
            if (!oldCaptainIsTransfer && !oldCaptainChangedPosition) {
                impact -= oldCaptainPts;
            }
            captainChange.impact = impact;
        }

        // Identify lineup changes (bench <-> starting XI) with TRUE impact
        const lineupChanges = {
            movedToStarting: [],  // Were on bench, now starting
            movedToBench: []      // Were starting, now on bench
        };

        // Check players in both teams for position changes
        currentPicks.picks.forEach((currentPick, currentIdx) => {
            const previousPick = previousPicks.picks.find(p => p.element === currentPick.element);
            if (previousPick) {
                const previousIdx = previousPicks.picks.indexOf(previousPick);
                const wasOnBench = previousIdx >= 11;
                const isOnBench = currentIdx >= 11;

                const element = bootstrap.elements.find(e => e.id === currentPick.element);
                const liveElement = liveData.elements.find(e => e.id === currentPick.element);
                const playerName = element?.web_name || 'Unknown';
                const points = liveElement?.stats?.total_points || 0;

                // Calculate true impact: difference in contribution between actual and hypothetical
                const actualContrib = getPlayerContribution(currentPick.element, actual.players);
                const hypotheticalContrib = getPlayerContribution(currentPick.element, hypothetical.players);
                const impact = actualContrib - hypotheticalContrib;

                if (wasOnBench && !isOnBench) {
                    lineupChanges.movedToStarting.push({ name: playerName, points, impact });
                } else if (!wasOnBench && isOnBench) {
                    lineupChanges.movedToBench.push({ name: playerName, points, impact });
                }
            }
        });

        // Determine chip badge
        let reason = null;
        if (currentChip === 'freehit') reason = 'freehit';
        else if (currentChip === 'wildcard') reason = 'wildcard';
        else if (currentChip === '3xc') reason = '3xc';
        else if (currentChip === 'bboost') reason = 'bboost';

        // Calculate chip impact (TC and BB)
        const chipImpact = {
            active: currentChip === '3xc' || currentChip === 'bboost',
            chip: currentChip,
            tripleCaptain: null,
            benchBoost: null
        };

        if (currentChip === '3xc') {
            // Triple Captain: extra 1x beyond normal 2x captain
            const captain = actual.players.find(p => p.isCaptain);
            if (captain) {
                const captainPts = captain.points + (captain.provisionalBonus || 0);
                chipImpact.tripleCaptain = {
                    playerName: bootstrap.elements.find(e => e.id === captain.id)?.web_name || 'Captain',
                    basePoints: captainPts,
                    bonus: captainPts // The extra 1x from TC
                };
            }
        }

        if (currentChip === 'bboost') {
            // Bench Boost: all bench players' points count
            // Get individual bench player contributions
            const benchPlayers = actual.players
                .filter(p => p.isBench)
                .map(p => ({
                    name: bootstrap.elements.find(e => e.id === p.id)?.web_name || 'Unknown',
                    points: p.points + (p.provisionalBonus || 0)
                }));

            chipImpact.benchBoost = {
                players: benchPlayers,
                totalBonus: actual.benchPoints // Total bench contribution
            };

            // When BB is active, filter out bench position changes from lineup changes
            // since bench players score regardless of position
            lineupChanges.movedToStarting = lineupChanges.movedToStarting.filter(p => {
                // Keep only if the player actually changed their contribution due to position
                // With BB, bench players score anyway, so only formation-based auto-sub effects matter
                return false; // BB means position doesn't matter for scoring
            });
            lineupChanges.movedToBench = lineupChanges.movedToBench.filter(p => {
                return false; // BB means position doesn't matter for scoring
            });
        }

        const result = {
            available: true,
            reason,
            actualScore: actual.totalPoints,
            hypotheticalScore: hypothetical.totalPoints,
            transferCost,
            netImpact,
            transfersIn,
            transfersOut,
            captainChange,
            lineupChanges,
            chipImpact,
            navigation: {
                currentGW: gw,
                minGW: 2,
                maxGW,
                hasPrev: gw > 2,
                hasNext: gw < maxGW
            }
        };

        // Cache result for completed GWs
        if (isGWCompleted) {
            dataCache.tinkeringCache[cacheKey] = result;
        }

        return result;
    } catch (error) {
        console.error(`[Tinkering] Error calculating for entry ${entryId}, GW ${gw}:`, error.message);
        return {
            available: false,
            reason: 'error',
            error: error.message,
            navigation: { currentGW: gw, minGW: 2, maxGW: gw, hasPrev: false, hasNext: false }
        };
    }
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

            // Always calculate netScore the same way as weekly scores page
            // Use entry_history.total_points as authoritative source (same as weekly)
            let netScore = m.total; // fallback

            try {
                const picks = await fetchManagerPicks(m.entry, currentGW);
                const apiTotalPoints = picks.entry_history?.total_points || 0;

                if (isLive && liveData) {
                    // Live: recalculate current GW with auto-subs
                    const calculated = calculatePointsWithAutoSubs(picks, liveData, bootstrap, gwFixtures);
                    const apiGWPoints = picks.entry_history?.points || 0;
                    netScore = apiTotalPoints - apiGWPoints + calculated.totalPoints;
                } else {
                    // Not live: use entry_history.total_points directly (same source as weekly)
                    netScore = apiTotalPoints;
                }
            } catch (e) {
                // If picks fetch fails, use league API total as fallback
            }

            const grossScore = netScore + totalTransferCost;

            // Get team value from the most recent gameweek
            const latestGW = history.current[history.current.length - 1];
            const teamValue = latestGW ? (latestGW.value / 10).toFixed(1) : '100.0';

            // Calculate previous week's net score for rank comparison
            const prevGW = currentGW > 1 ? history.current.find(h => h.event === currentGW - 1) : null;
            const prevNetScore = prevGW
                ? history.current
                    .filter(h => h.event < currentGW)
                    .reduce((sum, h) => sum + h.points - h.event_transfers_cost, 0)
                : 0;

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

async function fetchWeeklyLosers() {
    const [leagueData, bootstrap] = await Promise.all([fetchLeagueData(), fetchBootstrap()]);
    const completedGameweeks = bootstrap.events.filter(e => e.finished).map(e => e.id);
    const managers = leagueData.standings.results;

    // Fetch histories for transfer data (still needed for tiebreakers)
    const histories = await Promise.all(
        managers.map(async m => {
            const history = await fetchManagerHistory(m.entry);
            return { entry: m.entry, name: m.player_name, team: m.entry_name, gameweeks: history.current };
        })
    );

    // Calculate points for each manager/GW using the same method as pitch view
    // This ensures consistency - we calculate from live element data, not history API
    const getCalculatedPoints = async (entryId, gw) => {
        // Check cache first
        const cacheKey = `${entryId}-${gw}`;
        const cached = dataCache.processedPicksCache[cacheKey];
        if (cached?.calculatedPoints !== undefined) {
            return cached.calculatedPoints;
        }

        // Cache miss - calculate fresh (same as pitch view)
        try {
            const data = await fetchManagerPicksDetailed(entryId, gw, bootstrap);
            // Cache it for future use
            dataCache.processedPicksCache[cacheKey] = data;
            return data.calculatedPoints;
        } catch (e) {
            // Fallback to history API if calculation fails
            const manager = histories.find(h => h.entry === entryId);
            const gwData = manager?.gameweeks.find(g => g.event === gw);
            return gwData?.points || 0;
        }
    };

    // Build weekly losers data with calculated points
    const weeklyLosers = [];
    for (const gw of completedGameweeks) {
        // Get all managers' scores for this GW
        const gwScores = await Promise.all(
            histories.map(async manager => {
                const gwData = manager.gameweeks.find(g => g.event === gw);
                const points = await getCalculatedPoints(manager.entry, gw);
                return {
                    name: manager.name,
                    team: manager.team,
                    entry: manager.entry,
                    points,
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
            const overrideName = LOSER_OVERRIDES[gw];
            const overrideManager = gwScores.find(m => m.name === overrideName);
            if (overrideManager) {
                weeklyLosers.push({
                    gameweek: gw,
                    name: overrideManager.name,
                    team: overrideManager.team,
                    points: lowestPoints - 1,
                    isOverride: true,
                    context: 'Lost by 1 pt'
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

        weeklyLosers.push({
            gameweek: gw,
            name: loser.name,
            team: loser.team,
            points: loser.points,
            context
        });
    }

    // Build allGameweeks data for modal display
    const allGameweeks = {};
    for (const gw of completedGameweeks) {
        const overrideName = LOSER_OVERRIDES[gw];
        const managersData = await Promise.all(
            histories.map(async manager => {
                const points = await getCalculatedPoints(manager.entry, gw);
                return {
                    entry: manager.entry,
                    name: manager.name,
                    team: manager.team,
                    points
                };
            })
        );
        allGameweeks[gw] = {
            managers: managersData.sort((a, b) => a.points - b.points),
            overrideName: overrideName || null
        };
    }

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
            // Override history points with cached calculated points when available
            // The history API's points can be incorrect (e.g., missing bench boost bonus)
            const gameweeks = history.current.map(gw => {
                const cacheKey = `${m.entry}-${gw.event}`;
                const cached = dataCache.processedPicksCache[cacheKey];
                if (cached?.calculatedPoints !== undefined) {
                    return { ...gw, points: cached.calculatedPoints };
                }
                return gw;
            });
            return { name: m.player_name, team: m.entry_name, entryId: m.entry, gameweeks };
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
    const gwNotFinished = currentGWEvent && !currentGWEvent.finished;

    // Clear change events if gameweek has transitioned
    if (liveEventState.lastGW !== null && liveEventState.lastGW !== currentGW) {
        console.log(`[Week] Gameweek changed from ${liveEventState.lastGW} to ${currentGW}, clearing ticker events`);
        liveEventState.changeEvents = [];
        liveEventState.bonusPositions = {};
        liveEventState.cleanSheets = {};
        liveEventState.defcons = {};
        liveEventState.scores = {};
        // Clear chronological events and previous state for new GW
        chronologicalEvents = [];
        previousPlayerState = {};
        previousBonusPositions = {};
        await clearChronologicalEvents(liveEventState.lastGW);
        await clearPreviousPlayerState(liveEventState.lastGW);
    } else if (liveEventState.lastGW === null) {
        // First run - load existing chronological events and previous state from Redis
        await loadChronologicalEvents(currentGW);
        await loadPreviousPlayerState(currentGW);
    }
    liveEventState.lastGW = currentGW;

    const managers = leagueData.standings.results;
    const currentGWFixtures = fixtures.filter(f => f.event === currentGW);

    // Smarter live detection:
    // Show LIVE only when matches have started or are within 1 hour of first kickoff
    const now = new Date();
    const sortedFixtures = [...currentGWFixtures].sort((a, b) =>
        new Date(a.kickoff_time) - new Date(b.kickoff_time)
    );
    const firstKickoff = sortedFixtures.length > 0 ? new Date(sortedFixtures[0].kickoff_time) : null;
    const hasStartedMatches = currentGWFixtures.some(f => f.started);
    const allMatchesFinished = currentGWFixtures.length > 0 && currentGWFixtures.every(f => f.finished_provisional);
    const withinOneHour = firstKickoff && (now >= new Date(firstKickoff.getTime() - 60 * 60 * 1000));

    // Get live element data if GW not finished and matches starting soon or started
    let liveData = null;
    let liveDataSuccess = false;
    if (gwNotFinished && (withinOneHour || hasStartedMatches)) {
        try {
            liveData = await fetchLiveGWData(currentGW);
            liveDataSuccess = !!liveData;
        } catch (e) {
            console.error('[Week] Failed to fetch live data:', e.message);
        }
    }

    // isLive = matches have started AND we have live data (not just deadline passed)
    const isLive = hasStartedMatches && liveDataSuccess && !allMatchesFinished;

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

                // Calculate GW score - always use calculated points for consistency with pitch view
                let gwScore = picks.entry_history?.points || 0;
                let benchPoints = 0;
                const apiGWPoints = picks.entry_history?.points || 0;
                const apiTotalPoints = picks.entry_history?.total_points || 0;

                // Try to get calculated points (same as pitch view) for consistency
                // Check cache first, then calculate fresh if needed
                const cacheKey = `${m.entry}-${currentGW}`;
                const cached = dataCache.processedPicksCache[cacheKey];

                if (cached?.calculatedPoints !== undefined) {
                    // Use cached calculated points
                    gwScore = cached.calculatedPoints;
                    benchPoints = cached.pointsOnBench || 0;
                } else if (gwNotFinished && liveData) {
                    // GW in progress - calculate with auto-subs
                    const calculated = calculatePointsWithAutoSubs(picks, liveData, bootstrap, currentGWFixtures);
                    gwScore = calculated.totalPoints;
                    benchPoints = calculated.benchPoints;
                } else {
                    // No cache and GW finished - calculate fresh using same method as pitch view
                    try {
                        const detailedData = await fetchManagerPicksDetailed(m.entry, currentGW, bootstrap);
                        gwScore = detailedData.calculatedPoints;
                        benchPoints = detailedData.pointsOnBench || 0;
                        // Cache for future use
                        dataCache.processedPicksCache[cacheKey] = detailedData;
                    } catch (e) {
                        // Fallback to entry_history if calculation fails
                        gwScore = apiGWPoints;
                    }
                }

                // Calculate overall points: API total adjusted for calculated gwScore
                // This ensures live auto-sub/bonus calculations are reflected in overall
                const overallPoints = apiTotalPoints - apiGWPoints + gwScore;

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

                // Extract starting 11 player IDs and captain info for event impact
                const starting11 = picks.picks.slice(0, 11).map(p => p.element);
                const captainId = picks.picks.find(p => p.is_captain)?.element || null;
                const viceCaptainId = picks.picks.find(p => p.is_vice_captain)?.element || null;
                const captainElement = captainId ? bootstrap.elements.find(e => e.id === captainId) : null;
                const captainName = captainElement?.web_name || null;
                const viceCaptainElement = viceCaptainId ? bootstrap.elements.find(e => e.id === viceCaptainId) : null;
                const viceCaptainName = viceCaptainElement?.web_name || null;

                // Build player->team map and defender IDs for team event impact
                const playerTeamMap = {};
                const defenderIds = [];
                picks.picks.slice(0, 11).forEach(p => {
                    const element = bootstrap.elements.find(e => e.id === p.element);
                    if (element) {
                        playerTeamMap[p.element] = element.team;
                        // GK (1) and DEF (2) are affected by clean sheets
                        if (element.element_type === 1 || element.element_type === 2) {
                            defenderIds.push(p.element);
                        }
                    }
                });

                return {
                    rank: m.rank,
                    name: m.player_name,
                    team: m.entry_name,
                    entryId: m.entry,
                    gwScore,
                    overallPoints,
                    playersLeft,
                    teamValue,
                    bank,
                    benchPoints,
                    activeChip,
                    freeTransfers: picks.entry_history?.event_transfers || 0,
                    transferCost: picks.entry_history?.event_transfers_cost || 0,
                    starting11,
                    captainId,
                    captainName,
                    viceCaptainId,
                    viceCaptainName,
                    playerTeamMap,
                    defenderIds
                };
            } catch (e) {
                console.error(`[Week] Failed to fetch data for ${m.player_name}:`, e.message);
                return {
                    rank: m.rank,
                    name: m.player_name,
                    team: m.entry_name,
                    entryId: m.entry,
                    gwScore: 0,
                    overallPoints: 0,
                    playersLeft: 11,
                    teamValue: '100.0',
                    bank: '0.0',
                    benchPoints: 0,
                    activeChip: null,
                    freeTransfers: 0,
                    starting11: [],
                    captainId: null,
                    captainName: null,
                    viceCaptainId: null,
                    viceCaptainName: null,
                    playerTeamMap: {},
                    defenderIds: []
                };
            }
        })
    );

    // Sort by GW score
    weekData.sort((a, b) => b.gwScore - a.gwScore);
    weekData.forEach((m, i) => m.gwRank = i + 1);

    // Extract live events from fixtures for ticker
    const liveEvents = [];

    // Add transfer hit events at the start (for managers with hits this GW)
    weekData.filter(m => m.transferCost > 0).forEach(m => {
        liveEvents.push({
            type: 'transfer_hit',
            elementId: null,
            player: m.name,
            team: '',
            match: '',
            icon: '📉',
            points: -m.transferCost,
            isTransferHit: true
        });
    });

    currentGWFixtures.forEach(fixture => {
        if (!fixture.stats || !fixture.started) return;

        const homeTeam = bootstrap.teams.find(t => t.id === fixture.team_h);
        const awayTeam = bootstrap.teams.find(t => t.id === fixture.team_a);
        const matchLabel = `${homeTeam?.short_name || 'HOM'} ${fixture.team_h_score ?? 0}-${fixture.team_a_score ?? 0} ${awayTeam?.short_name || 'AWY'}`;

        // Helper to get goal points by position
        const getGoalPoints = (posType) => posType <= 2 ? 6 : posType === 3 ? 5 : 4;

        // Extract goals
        const goalsStat = fixture.stats.find(s => s.identifier === 'goals_scored');
        if (goalsStat) {
            [...(goalsStat.h || []), ...(goalsStat.a || [])].forEach(g => {
                const player = bootstrap.elements.find(e => e.id === g.element);
                if (player) {
                    for (let i = 0; i < g.value; i++) {
                        liveEvents.push({
                            type: 'goal',
                            elementId: player.id,
                            player: player.web_name,
                            team: bootstrap.teams.find(t => t.id === player.team)?.short_name || '',
                            match: matchLabel,
                            icon: '⚽',
                            points: getGoalPoints(player.element_type)
                        });
                    }
                }
            });
        }

        // Extract assists
        const assistsStat = fixture.stats.find(s => s.identifier === 'assists');
        if (assistsStat) {
            [...(assistsStat.h || []), ...(assistsStat.a || [])].forEach(a => {
                const player = bootstrap.elements.find(e => e.id === a.element);
                if (player) {
                    for (let i = 0; i < a.value; i++) {
                        liveEvents.push({
                            type: 'assist',
                            elementId: player.id,
                            player: player.web_name,
                            team: bootstrap.teams.find(t => t.id === player.team)?.short_name || '',
                            match: matchLabel,
                            icon: '👟',
                            points: 3
                        });
                    }
                }
            });
        }

        // Extract yellow cards
        const yellowsStat = fixture.stats.find(s => s.identifier === 'yellow_cards');
        if (yellowsStat) {
            [...(yellowsStat.h || []), ...(yellowsStat.a || [])].forEach(y => {
                const player = bootstrap.elements.find(e => e.id === y.element);
                if (player) {
                    liveEvents.push({
                        type: 'yellow',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find(t => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '🟨',
                        points: -1
                    });
                }
            });
        }

        // Extract red cards
        const redsStat = fixture.stats.find(s => s.identifier === 'red_cards');
        if (redsStat) {
            [...(redsStat.h || []), ...(redsStat.a || [])].forEach(r => {
                const player = bootstrap.elements.find(e => e.id === r.element);
                if (player) {
                    liveEvents.push({
                        type: 'red',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find(t => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '🟥',
                        points: -3
                    });
                }
            });
        }

        // Extract own goals
        const ownGoalsStat = fixture.stats.find(s => s.identifier === 'own_goals');
        if (ownGoalsStat) {
            [...(ownGoalsStat.h || []), ...(ownGoalsStat.a || [])].forEach(og => {
                const player = bootstrap.elements.find(e => e.id === og.element);
                if (player) {
                    liveEvents.push({
                        type: 'own_goal',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find(t => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '⚽',
                        points: -2
                    });
                }
            });
        }

        // Extract penalties saved
        const penSavedStat = fixture.stats.find(s => s.identifier === 'penalties_saved');
        if (penSavedStat) {
            [...(penSavedStat.h || []), ...(penSavedStat.a || [])].forEach(ps => {
                const player = bootstrap.elements.find(e => e.id === ps.element);
                if (player) {
                    liveEvents.push({
                        type: 'pen_save',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find(t => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '🧤',
                        points: 5
                    });
                }
            });
        }

        // Extract penalties missed
        const penMissedStat = fixture.stats.find(s => s.identifier === 'penalties_missed');
        if (penMissedStat) {
            [...(penMissedStat.h || []), ...(penMissedStat.a || [])].forEach(pm => {
                const player = bootstrap.elements.find(e => e.id === pm.element);
                if (player) {
                    liveEvents.push({
                        type: 'pen_miss',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find(t => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '❌',
                        points: -2
                    });
                }
            });
        }

        // Extract saves (GK gets 1pt per 3 saves)
        const savesStat = fixture.stats.find(s => s.identifier === 'saves');
        if (savesStat) {
            [...(savesStat.h || []), ...(savesStat.a || [])].forEach(s => {
                const player = bootstrap.elements.find(e => e.id === s.element);
                if (player && s.value >= 3) {
                    const savePoints = Math.floor(s.value / 3);
                    liveEvents.push({
                        type: 'saves',
                        elementId: player.id,
                        player: player.web_name,
                        team: bootstrap.teams.find(t => t.id === player.team)?.short_name || '',
                        match: matchLabel,
                        icon: '🧤',
                        points: savePoints,
                        detail: `${s.value} saves`
                    });
                }
            });
        }

        // Track clean sheets and goals conceded
        // team_h_score = goals scored BY home = goals conceded BY away
        // team_a_score = goals scored BY away = goals conceded BY home
        const homeTeamConceded = fixture.team_a_score || 0;
        const awayTeamConceded = fixture.team_h_score || 0;

        // Clean sheets - only show after 60 minutes (when CS points are actually awarded)
        // FPL awards CS points to players who play 60+ mins without conceding
        const fixtureMinutes = fixture.minutes || 0;

        if (fixture.started && fixtureMinutes >= 60 && homeTeamConceded === 0) {
            // Home team has clean sheet
            liveEvents.push({
                type: 'clean_sheet',
                elementId: null,
                player: homeTeam?.short_name || 'HOME',
                team: homeTeam?.short_name || '',
                match: matchLabel,
                icon: '🛡️',
                points: 4, // GK/DEF get 4 pts each
                teamId: fixture.team_h,
                isTeamEvent: true
            });
        }

        if (fixture.started && fixtureMinutes >= 60 && awayTeamConceded === 0) {
            // Away team has clean sheet
            liveEvents.push({
                type: 'clean_sheet',
                elementId: null,
                player: awayTeam?.short_name || 'AWAY',
                team: awayTeam?.short_name || '',
                match: matchLabel,
                icon: '🛡️',
                points: 4,
                teamId: fixture.team_a,
                isTeamEvent: true
            });
        }

        // Goals conceded - GK/DEF lose 1pt per 2 goals conceded
        if (homeTeamConceded >= 2) {
            const gcPoints = -Math.floor(homeTeamConceded / 2);
            liveEvents.push({
                type: 'goals_conceded',
                elementId: null,
                player: homeTeam?.short_name || 'HOME',
                team: homeTeam?.short_name || '',
                match: matchLabel,
                icon: '😞',
                points: gcPoints,
                teamId: fixture.team_h,
                isTeamEvent: true,
                detail: `${homeTeamConceded} conceded`
            });
        }

        if (awayTeamConceded >= 2) {
            const gcPoints = -Math.floor(awayTeamConceded / 2);
            liveEvents.push({
                type: 'goals_conceded',
                elementId: null,
                player: awayTeam?.short_name || 'AWAY',
                team: awayTeam?.short_name || '',
                match: matchLabel,
                icon: '😞',
                points: gcPoints,
                teamId: fixture.team_a,
                isTeamEvent: true,
                detail: `${awayTeamConceded} conceded`
            });
        }

        // Extract bonus points as single item per match with full BPS details
        const bpsStat = fixture.stats.find(s => s.identifier === 'bps');
        if (bpsStat && fixture.started) {
            const allBps = [...(bpsStat.h || []), ...(bpsStat.a || [])]
                .sort((a, b) => b.value - a.value);

            if (allBps.length >= 1) {
                // Calculate who gets bonus
                const bonusPlayers = [];
                const nearMissPlayers = []; // Players just outside bonus
                let rank = 1;
                let i = 0;

                while (i < allBps.length && rank <= 3) {
                    const currentBps = allBps[i].value;
                    const tied = [];
                    while (i < allBps.length && allBps[i].value === currentBps) {
                        const player = bootstrap.elements.find(e => e.id === allBps[i].element);
                        if (player) {
                            tied.push({
                                elementId: player.id,
                                name: player.web_name,
                                bps: currentBps,
                                bonus: rank === 1 ? 3 : rank === 2 ? 2 : 1
                            });
                        }
                        i++;
                    }
                    bonusPlayers.push(...tied);
                    rank += tied.length;
                }

                // Get next few players who are close to bonus (4th-6th)
                let nearMissCount = 0;
                while (i < allBps.length && nearMissCount < 3) {
                    const player = bootstrap.elements.find(e => e.id === allBps[i].element);
                    if (player) {
                        nearMissPlayers.push({
                            elementId: player.id,
                            name: player.web_name,
                            bps: allBps[i].value,
                            bonus: 0
                        });
                    }
                    i++;
                    nearMissCount++;
                }

                liveEvents.push({
                    type: 'bonus',
                    elementId: null, // Multiple players
                    player: 'Bonus',
                    team: '',
                    match: matchLabel,
                    icon: '⭐',
                    points: null, // Varies per player
                    isBonus: true,
                    bonusPlayers,
                    nearMissPlayers,
                    fixtureId: fixture.id
                });
            }
        }
    });

    // Extract defensive contributions from live player data
    if (liveData && liveData.elements) {
        liveData.elements.forEach(liveElement => {
            if (!liveElement.explain) return;

            liveElement.explain.forEach(fixture => {
                if (!fixture.stats) return;

                const defconStat = fixture.stats.find(s => s.identifier === 'defensive_contribution');
                if (defconStat && defconStat.points > 0) {
                    const player = bootstrap.elements.find(e => e.id === liveElement.id);
                    if (player) {
                        // Find the fixture info for match label
                        const fixtureData = currentGWFixtures.find(f => f.id === fixture.fixture);
                        let matchLabel = '';
                        if (fixtureData) {
                            const homeTeam = bootstrap.teams.find(t => t.id === fixtureData.team_h);
                            const awayTeam = bootstrap.teams.find(t => t.id === fixtureData.team_a);
                            matchLabel = `${homeTeam?.short_name || 'HOM'} ${fixtureData.team_h_score ?? 0}-${fixtureData.team_a_score ?? 0} ${awayTeam?.short_name || 'AWY'}`;
                        }

                        liveEvents.push({
                            type: 'defcon',
                            elementId: player.id,
                            player: player.web_name,
                            team: bootstrap.teams.find(t => t.id === player.team)?.short_name || '',
                            match: matchLabel,
                            icon: '🔒',
                            points: defconStat.points
                        });
                    }
                }
            });
        });
    }

    // Build fixtures summary for display
    const fixturesSummary = currentGWFixtures.map(f => {
        const homeTeam = bootstrap.teams.find(t => t.id === f.team_h);
        const awayTeam = bootstrap.teams.find(t => t.id === f.team_a);
        return {
            id: f.id,
            home: homeTeam?.short_name || 'HOM',
            away: awayTeam?.short_name || 'AWY',
            homeScore: f.team_h_score,
            awayScore: f.team_a_score,
            started: f.started,
            finished: f.finished || f.finished_provisional,  // Show FT as soon as match ends
            kickoff: f.kickoff_time,
            minutes: f.minutes
        };
    }).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));

    // Find next kickoff time
    const upcomingFixtures = currentGWFixtures
        .filter(f => !f.started && f.kickoff_time)
        .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
    const nextKickoff = upcomingFixtures[0]?.kickoff_time || null;

    // ==========================================================================
    // CHANGE DETECTION - Compare current state with previous to detect changes
    // ==========================================================================
    const timestamp = now.toISOString();

    // Build current state
    const currentBonusPositions = {};
    const currentCleanSheets = {};
    const currentDefcons = {};
    const currentScores = {};

    // Extract current bonus positions from liveEvents
    liveEvents.filter(e => e.isBonus).forEach(e => {
        currentBonusPositions[e.fixtureId] = {};
        (e.bonusPlayers || []).forEach(bp => {
            currentBonusPositions[e.fixtureId][bp.elementId] = bp.bonus;
        });
    });

    // Extract current clean sheet status
    currentGWFixtures.forEach(f => {
        if (f.started) {
            const homeTeamConceded = f.team_a_score || 0;
            const awayTeamConceded = f.team_h_score || 0;
            currentCleanSheets[f.id] = {
                home: homeTeamConceded === 0,
                away: awayTeamConceded === 0,
                homeTeamId: f.team_h,
                awayTeamId: f.team_a
            };
            currentScores[f.id] = {
                home: f.team_h_score || 0,
                away: f.team_a_score || 0
            };
        }
    });

    // Extract current defcons from liveEvents
    liveEvents.filter(e => e.type === 'defcon').forEach(e => {
        currentDefcons[e.elementId] = true;
    });

    // Detect changes and create change events
    if (liveEventState.lastUpdate && isLive) {
        // Check for bonus changes
        Object.keys(currentBonusPositions).forEach(fixtureId => {
            const prevBonus = liveEventState.bonusPositions[fixtureId] || {};
            const currBonus = currentBonusPositions[fixtureId];

            const changes = [];
            const allPlayerIds = new Set([...Object.keys(prevBonus), ...Object.keys(currBonus)]);

            allPlayerIds.forEach(pid => {
                const prevPts = prevBonus[pid] || 0;
                const currPts = currBonus[pid] || 0;
                if (prevPts !== currPts) {
                    const player = bootstrap.elements.find(e => e.id === parseInt(pid));
                    if (player) {
                        changes.push({
                            elementId: parseInt(pid),
                            player: player.web_name,
                            from: prevPts,
                            to: currPts,
                            impact: currPts - prevPts
                        });
                    }
                }
            });

            if (changes.length > 0) {
                const fixture = currentGWFixtures.find(f => f.id === parseInt(fixtureId));
                const homeTeam = bootstrap.teams.find(t => t.id === fixture?.team_h);
                const awayTeam = bootstrap.teams.find(t => t.id === fixture?.team_a);
                const matchLabel = `${homeTeam?.short_name || 'HOM'} ${fixture?.team_h_score ?? 0}-${fixture?.team_a_score ?? 0} ${awayTeam?.short_name || 'AWY'}`;

                liveEventState.changeEvents.unshift({
                    type: 'bonus_change',
                    match: matchLabel,
                    fixtureId: parseInt(fixtureId),
                    changes,
                    timestamp,
                    icon: '⭐',
                    minute: fixture?.minutes || null
                });
            }
        });

        // Check for clean sheet changes (lost)
        Object.keys(currentCleanSheets).forEach(fixtureId => {
            const prevCS = liveEventState.cleanSheets[fixtureId];
            const currCS = currentCleanSheets[fixtureId];

            if (prevCS) {
                const fixture = currentGWFixtures.find(f => f.id === parseInt(fixtureId));
                const homeTeam = bootstrap.teams.find(t => t.id === fixture?.team_h);
                const awayTeam = bootstrap.teams.find(t => t.id === fixture?.team_a);
                const matchLabel = `${homeTeam?.short_name || 'HOM'} ${fixture?.team_h_score ?? 0}-${fixture?.team_a_score ?? 0} ${awayTeam?.short_name || 'AWY'}`;

                // Home team lost clean sheet
                if (prevCS.home && !currCS.home) {
                    liveEventState.changeEvents.unshift({
                        type: 'cs_lost',
                        team: homeTeam?.short_name || 'HOME',
                        teamId: currCS.homeTeamId,
                        match: matchLabel,
                        fixtureId: parseInt(fixtureId),
                        timestamp,
                        icon: '💔',
                        points: -4, // GK/DEF lose 4 pts
                        minute: fixture?.minutes || null
                    });
                }

                // Away team lost clean sheet
                if (prevCS.away && !currCS.away) {
                    liveEventState.changeEvents.unshift({
                        type: 'cs_lost',
                        team: awayTeam?.short_name || 'AWAY',
                        teamId: currCS.awayTeamId,
                        match: matchLabel,
                        fixtureId: parseInt(fixtureId),
                        timestamp,
                        icon: '💔',
                        points: -4,
                        minute: fixture?.minutes || null
                    });
                }
            }
        });

        // Check for new defcons
        Object.keys(currentDefcons).forEach(pid => {
            if (!liveEventState.defcons[pid]) {
                const player = bootstrap.elements.find(e => e.id === parseInt(pid));
                if (player) {
                    // Find the match this defcon is from
                    const defconEvent = liveEvents.find(e => e.type === 'defcon' && e.elementId === parseInt(pid));
                    liveEventState.changeEvents.unshift({
                        type: 'defcon_gained',
                        elementId: parseInt(pid),
                        player: player.web_name,
                        team: bootstrap.teams.find(t => t.id === player.team)?.short_name || '',
                        match: defconEvent?.match || '',
                        timestamp,
                        icon: '🔒',
                        points: 1
                    });
                }
            }
        });

        // Trim change events to max
        if (liveEventState.changeEvents.length > MAX_CHANGE_EVENTS) {
            liveEventState.changeEvents = liveEventState.changeEvents.slice(0, MAX_CHANGE_EVENTS);
        }
    }

    // ==========================================================================
    // CHRONOLOGICAL EVENT DETECTION - Detect all events by comparing explain data
    // ==========================================================================
    const newChronoEvents = [];

    if (liveData && liveData.elements && isLive) {
        // Build lookup maps for O(1) access (instead of repeated .find() calls)
        const playerMap = new Map(bootstrap.elements.map(e => [e.id, e]));
        const teamMap = new Map(bootstrap.teams.map(t => [t.id, t]));
        const fixtureMap = new Map(currentGWFixtures.map(f => [f.id, f]));

        // Build current player state from explain data
        const currentPlayerState = {};

        liveData.elements.forEach(liveElement => {
            if (!liveElement.explain) return;

            liveElement.explain.forEach(fixtureExplain => {
                const fixtureId = fixtureExplain.fixture;
                const stateKey = `${fixtureId}_${liveElement.id}`;

                // Initialize state for this player/fixture
                // Note: Keys must match FPL API explain stat identifiers exactly
                currentPlayerState[stateKey] = {
                    goals_scored: 0,
                    assists: 0,
                    clean_sheets: 0,
                    goals_conceded: 0,
                    own_goals: 0,
                    penalties_saved: 0,
                    penalties_missed: 0,
                    yellow_cards: 0,
                    red_cards: 0,
                    saves: 0,
                    bonus: 0,
                    defensive_contribution: 0
                };

                // Extract points from each stat
                (fixtureExplain.stats || []).forEach(stat => {
                    if (currentPlayerState[stateKey].hasOwnProperty(stat.identifier)) {
                        currentPlayerState[stateKey][stat.identifier] = stat.points;
                    }
                });
            });
        });

        // Helper functions using lookup maps (O(1) instead of O(n))
        const getMatchLabel = (fixtureId) => {
            const fixture = fixtureMap.get(fixtureId);
            if (!fixture) return '';
            const homeTeam = teamMap.get(fixture.team_h);
            const awayTeam = teamMap.get(fixture.team_a);
            return `${homeTeam?.short_name || 'HOM'} ${fixture.team_h_score ?? 0}-${fixture.team_a_score ?? 0} ${awayTeam?.short_name || 'AWY'}`;
        };

        const getPlayerInfo = (elementId) => {
            const player = playerMap.get(elementId);
            if (!player) return null;
            const team = teamMap.get(player.team);
            return {
                id: player.id,
                name: player.web_name,
                team: team?.short_name || '',
                teamId: player.team,
                positionId: player.element_type // 1=GK, 2=DEF, 3=MID, 4=FWD
            };
        };

        // Event type mapping: explain identifier -> our event type
        // Keys must match FPL API explain stat identifiers exactly
        const statToEventType = {
            'goals_scored': 'goal',
            'assists': 'assist',
            'clean_sheets': 'clean_sheet',
            'goals_conceded': 'goals_conceded',
            'own_goals': 'own_goal',
            'penalties_saved': 'pen_save',
            'penalties_missed': 'pen_miss',
            'yellow_cards': 'yellow',
            'red_cards': 'red',
            'saves': 'saves',
            'defensive_contribution': 'defcon'
        };

        const statIcons = {
            'goal': '⚽',
            'assist': '👟',
            'clean_sheet': '🛡️',
            'goals_conceded': '😞',
            'own_goal': '🙈',
            'pen_save': '🧤',
            'pen_miss': '❌',
            'yellow': '🟨',
            'red': '🟥',
            'saves': '🧤',
            'defcon': '🔒'
        };

        // Only detect changes if we have previous state
        if (Object.keys(previousPlayerState).length > 0) {
            // Collect team events (clean sheets and goals conceded) by team+fixture
            // Structure: { 'fixtureId_teamId_statKey': { players: [], ... } }
            const teamEventBuckets = {};

            Object.keys(currentPlayerState).forEach(stateKey => {
                const [fixtureIdStr, elementIdStr] = stateKey.split('_');
                const fixtureId = parseInt(fixtureIdStr);
                const elementId = parseInt(elementIdStr);
                const prevState = previousPlayerState[stateKey] || {};
                const currState = currentPlayerState[stateKey];
                const playerInfo = getPlayerInfo(elementId);
                if (!playerInfo) return;

                const matchLabel = getMatchLabel(fixtureId);

                // Check each stat for changes
                Object.keys(currState).forEach(statKey => {
                    if (statKey === 'bonus') return; // Handle bonus separately

                    const prevPts = prevState[statKey] || 0;
                    const currPts = currState[statKey] || 0;
                    const diff = currPts - prevPts;

                    if (diff !== 0) {
                        const eventType = statToEventType[statKey];
                        if (!eventType) return;

                        // Clean sheets and goals conceded: group by team
                        if (statKey === 'clean_sheets' || statKey === 'goals_conceded') {
                            const bucketKey = `${fixtureId}_${playerInfo.teamId}_${statKey}`;
                            if (!teamEventBuckets[bucketKey]) {
                                teamEventBuckets[bucketKey] = {
                                    type: statKey === 'clean_sheets' ? 'team_clean_sheet' : 'team_goals_conceded',
                                    teamId: playerInfo.teamId,
                                    team: playerInfo.team,
                                    match: matchLabel,
                                    fixtureId,
                                    icon: statIcons[eventType],
                                    points: diff, // Points per player (for display)
                                    affectedPlayers: [],
                                    timestamp
                                };
                            }
                            teamEventBuckets[bucketKey].affectedPlayers.push({
                                elementId: playerInfo.id,
                                player: playerInfo.name,
                                points: diff
                            });
                        } else if (statKey === 'saves') {
                            // Saves: create individual +1 events (per point gained)
                            const eventsToAdd = Math.abs(diff);
                            for (let i = 0; i < eventsToAdd; i++) {
                                newChronoEvents.push({
                                    type: eventType,
                                    elementId: playerInfo.id,
                                    player: playerInfo.name,
                                    team: playerInfo.team,
                                    match: matchLabel,
                                    fixtureId,
                                    icon: statIcons[eventType],
                                    points: diff > 0 ? 1 : -1,
                                    timestamp
                                });
                            }
                        } else {
                            // For other events (goals, assists, cards, etc.), create one event per player
                            newChronoEvents.push({
                                type: eventType,
                                elementId: playerInfo.id,
                                player: playerInfo.name,
                                team: playerInfo.team,
                                match: matchLabel,
                                fixtureId,
                                icon: statIcons[eventType],
                                points: diff,
                                timestamp
                            });
                        }
                    }
                });
            });

            // Add team events to chronological events
            Object.values(teamEventBuckets).forEach(teamEvent => {
                // Sort affected players alphabetically
                teamEvent.affectedPlayers.sort((a, b) => a.player.localeCompare(b.player));
                newChronoEvents.push(teamEvent);
            });
        }

        // Handle bonus position changes (only when 3/2/1 positions change hands)
        const currentBonusHolders = {}; // { fixtureId: { 3: [ids], 2: [ids], 1: [ids] } }

        liveEvents.filter(e => e.isBonus).forEach(e => {
            currentBonusHolders[e.fixtureId] = { 3: [], 2: [], 1: [] };
            (e.bonusPlayers || []).forEach(bp => {
                if (bp.bonus >= 1 && bp.bonus <= 3) {
                    currentBonusHolders[e.fixtureId][bp.bonus].push(bp.elementId);
                }
            });
        });

        // Compare bonus holders with previous
        if (Object.keys(previousBonusPositions).length > 0) {
            Object.keys(currentBonusHolders).forEach(fixtureIdStr => {
                const fixtureId = parseInt(fixtureIdStr);
                const prev = previousBonusPositions[fixtureId] || { 3: [], 2: [], 1: [] };
                const curr = currentBonusHolders[fixtureId];
                const matchLabel = getMatchLabel(fixtureId);

                // Check if the actual position holders changed (not just BPS values)
                const positionsChanged = [3, 2, 1].some(pos => {
                    const prevIds = (prev[pos] || []).sort().join(',');
                    const currIds = (curr[pos] || []).sort().join(',');
                    return prevIds !== currIds;
                });

                if (positionsChanged) {
                    // Build change details
                    const changes = [];
                    [3, 2, 1].forEach(pos => {
                        const prevIds = prev[pos] || [];
                        const currIds = curr[pos] || [];

                        // Players who gained this position
                        currIds.filter(id => !prevIds.includes(id)).forEach(id => {
                            const player = getPlayerInfo(id);
                            if (player) {
                                // Find what position they had before
                                let prevPos = 0;
                                [3, 2, 1].forEach(p => {
                                    if ((prev[p] || []).includes(id)) prevPos = p;
                                });
                                changes.push({
                                    elementId: id,
                                    player: player.name,
                                    from: prevPos,
                                    to: pos,
                                    impact: pos - prevPos
                                });
                            }
                        });

                        // Players who lost this position (and didn't gain another)
                        prevIds.filter(id => !currIds.includes(id)).forEach(id => {
                            // Check if they're in another position
                            const newPos = [3, 2, 1].find(p => (curr[p] || []).includes(id)) || 0;
                            if (newPos === 0) {
                                const player = getPlayerInfo(id);
                                if (player) {
                                    changes.push({
                                        elementId: id,
                                        player: player.name,
                                        from: pos,
                                        to: 0,
                                        impact: -pos
                                    });
                                }
                            }
                        });
                    });

                    if (changes.length > 0) {
                        newChronoEvents.push({
                            type: 'bonus_change',
                            match: matchLabel,
                            fixtureId,
                            icon: '⭐',
                            points: null,
                            changes,
                            timestamp
                        });
                    }
                }
            });
        }

        // Sort new events by priority, then alphabetically by player name
        newChronoEvents.sort((a, b) => {
            const priorityA = EVENT_PRIORITY[a.type] || 99;
            const priorityB = EVENT_PRIORITY[b.type] || 99;
            if (priorityA !== priorityB) return priorityA - priorityB;
            return (a.player || '').localeCompare(b.player || '');
        });

        // Append to chronological events and save
        if (newChronoEvents.length > 0) {
            chronologicalEvents.push(...newChronoEvents);
            // Limit array size to prevent unbounded growth
            if (chronologicalEvents.length > MAX_CHRONO_EVENTS) {
                chronologicalEvents = chronologicalEvents.slice(-MAX_CHRONO_EVENTS);
            }
            await saveChronologicalEvents(currentGW);
            console.log(`[ChronoEvents] Added ${newChronoEvents.length} new events (total: ${chronologicalEvents.length})`);
        }

        // Update previous state AFTER successful save (prevents data loss if save fails)
        previousPlayerState = currentPlayerState;
        previousBonusPositions = currentBonusHolders;
        // Note: previousPlayerState persisted on polling stop/shutdown, not every poll (too large)
    }

    // Update state for next comparison
    liveEventState.bonusPositions = currentBonusPositions;
    liveEventState.cleanSheets = currentCleanSheets;
    liveEventState.defcons = currentDefcons;
    liveEventState.scores = currentScores;
    liveEventState.lastUpdate = timestamp;

    const refreshTime = new Date().toISOString();
    return {
        leagueName: leagueData.league.name,
        currentGW,
        isLive,
        managers: weekData,
        lastUpdated: refreshTime,
        liveEvents,
        chronologicalEvents,
        changeEvents: liveEventState.changeEvents,
        fixtures: fixturesSummary,
        nextKickoff
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

async function fetchManagerPicksDetailed(entryId, gw, bootstrapData = null) {
    // Use provided bootstrap or fetch it (fetching in parallel with other data)
    const [bootstrap, picks, liveData, fixtures] = await Promise.all([
        bootstrapData ? Promise.resolve(bootstrapData) : fetchBootstrap(),
        fetchManagerPicksCached(entryId, gw, bootstrapData),
        fetchLiveGWDataCached(gw, bootstrapData),
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
            kickoffTime: fixture.kickoff_time,
            fixture  // Include full fixture for BPS lookup
        };
    }

    // Helper to calculate provisional bonus from BPS for a fixture
    // Returns { elementId: bonusPoints } map for players who would get bonus
    function calculateProvisionalBonus(fixture) {
        if (!fixture?.stats) return {};

        const bpsStat = fixture.stats.find(s => s.identifier === 'bps');
        if (!bpsStat) return {};

        // Combine home and away BPS, sort descending
        const allBps = [...(bpsStat.h || []), ...(bpsStat.a || [])]
            .sort((a, b) => b.value - a.value);

        if (allBps.length === 0) return {};

        const bonusMap = {};
        let bonusRemaining = 3;
        let currentRank = 1;
        let i = 0;

        while (i < allBps.length && bonusRemaining > 0) {
            const currentBps = allBps[i].value;

            // Find all players tied at this BPS value
            const tiedPlayers = [];
            while (i < allBps.length && allBps[i].value === currentBps) {
                tiedPlayers.push(allBps[i].element);
                i++;
            }

            // Determine bonus for this rank
            let bonusForRank;
            if (currentRank === 1) bonusForRank = 3;
            else if (currentRank === 2) bonusForRank = 2;
            else if (currentRank === 3) bonusForRank = 1;
            else break;

            // All tied players get the same bonus
            tiedPlayers.forEach(elementId => {
                bonusMap[elementId] = bonusForRank;
            });

            // Advance rank by number of tied players
            currentRank += tiedPlayers.length;
            bonusRemaining = Math.max(0, 4 - currentRank);
        }

        return bonusMap;
    }

    // Pre-calculate provisional bonus for all live fixtures
    const provisionalBonusMap = {};
    gwFixtures.forEach(fixture => {
        if (fixture.started && !fixture.finished) {
            const bonusForFixture = calculateProvisionalBonus(fixture);
            Object.assign(provisionalBonusMap, bonusForFixture);
        }
    });

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

        // Position-based event hierarchy:
        // - Minutes always first
        // - Bonus always last
        // - Other events ordered by relevance to position
        const positionHierarchy = {
            // GKP: saves and penalties_saved are core, then clean sheet, then attacking
            1: ['minutes', 'penalties_saved', 'saves', 'clean_sheets', 'goals_scored', 'assists', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // DEF: clean sheets most important, then attacking contribution
            2: ['minutes', 'clean_sheets', 'goals_scored', 'assists', 'defensive_contribution', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // MID: goals and assists primary, clean sheet secondary
            3: ['minutes', 'goals_scored', 'assists', 'clean_sheets', 'defensive_contribution', 'goals_conceded', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus'],
            // FWD: goals and assists are everything (no clean sheet points)
            4: ['minutes', 'goals_scored', 'assists', 'defensive_contribution', 'yellow_cards', 'red_cards', 'own_goals', 'penalties_missed', 'bonus']
        };

        const hierarchy = positionHierarchy[posId] || positionHierarchy[4];
        pointsBreakdown.sort((a, b) => {
            const aIndex = hierarchy.indexOf(a.identifier);
            const bIndex = hierarchy.indexOf(b.identifier);
            // Unknown stats go before bonus but after known stats
            const aPos = aIndex === -1 ? hierarchy.length - 1 : aIndex;
            const bPos = bIndex === -1 ? hierarchy.length - 1 : bIndex;
            return aPos - bPos;
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

        // Get BPS and bonus info
        const bps = stats.bps || 0;
        const officialBonus = stats.bonus || 0;
        // Provisional bonus only applies during live matches (started but not finished)
        // AND when official bonus hasn't been added yet (officialBonus === 0)
        // When officialBonus > 0, the bonus is already included in total_points
        const provisionalBonus = (fixtureStarted && !fixtureFinished && officialBonus === 0)
            ? (provisionalBonusMap[pick.element] || 0)
            : 0;

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
            fixtureFinished,
            bps,
            officialBonus,
            provisionalBonus
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
        // Use actual multiplier from picks (3 for TC, 2 for normal captain, 1 for others)
        const effectivePoints = p.points * p.multiplier;

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += p.points; // Subs don't get captain bonus
        } else if (p.isBench && !p.subIn) {
            benchPoints += p.points;
        }
    });

    // For Bench Boost, add bench points to total (they all count)
    if (picks.active_chip === 'bboost') {
        totalPoints += benchPoints;
    }

    // Detect formation from effective starting 11
    const effectiveStarters = adjustedPlayers.filter(p => (!p.isBench && !p.subOut) || p.subIn);
    const formation = {
        GKP: effectiveStarters.filter(p => p.positionId === 1).length,
        DEF: effectiveStarters.filter(p => p.positionId === 2).length,
        MID: effectiveStarters.filter(p => p.positionId === 3).length,
        FWD: effectiveStarters.filter(p => p.positionId === 4).length
    };
    const formationString = `${formation.DEF}-${formation.MID}-${formation.FWD}`;

    // Calculate base points and bonus separately for display (X+Y format)
    // Must match totalPoints calculation: subs don't get captain multiplier
    let basePoints = 0;
    let totalProvisionalBonus = 0;
    effectiveStarters.forEach(p => {
        // Subs (subIn) don't get captain bonus; otherwise use multiplier (3 for TC, 2 for captain, 1 for others)
        const multiplier = p.subIn ? 1 : p.multiplier;
        basePoints += (p.points || 0) * multiplier;
        totalProvisionalBonus += (p.provisionalBonus || 0) * multiplier;
    });

    return {
        entryId,
        gameweek: gw,
        points: picks.entry_history?.points || 0,
        calculatedPoints: totalPoints,
        basePoints,
        totalProvisionalBonus,
        pointsOnBench: benchPoints,
        activeChip: picks.active_chip,
        formation: formationString,
        players: adjustedPlayers,
        autoSubs,
        transfersCost: picks.entry_history?.event_transfers_cost || 0
    };
}

// =============================================================================
// MANAGER PROFILE DATA (Pre-calculated during refresh)
// =============================================================================

// Calculate league rank history by comparing all managers' cumulative points per GW
function calculateLeagueRankHistory(allHistories) {
    if (!allHistories || allHistories.length === 0) return {};

    // Find max GW
    const maxGW = Math.max(...allHistories.flatMap(h => h.gameweeks.map(g => g.event)));

    // Build cumulative points per manager per GW
    const managerCumulative = {};
    allHistories.forEach(manager => {
        managerCumulative[manager.entryId] = {};
        let cumulative = 0;
        manager.gameweeks.forEach(gw => {
            cumulative += gw.points - (gw.event_transfers_cost || 0);
            managerCumulative[manager.entryId][gw.event] = cumulative;
        });
    });

    // Calculate rank for each manager at each GW
    const rankHistory = {};
    allHistories.forEach(m => rankHistory[m.entryId] = []);

    for (let gw = 1; gw <= maxGW; gw++) {
        // Get all managers' cumulative at this GW
        const gwScores = allHistories
            .filter(m => managerCumulative[m.entryId][gw] !== undefined)
            .map(m => ({
                entryId: m.entryId,
                cumulative: managerCumulative[m.entryId][gw]
            }))
            .sort((a, b) => b.cumulative - a.cumulative);

        // Assign ranks
        gwScores.forEach((score, idx) => {
            rankHistory[score.entryId].push({
                gw,
                rank: idx + 1,
                points: allHistories.find(h => h.entryId === score.entryId)?.gameweeks.find(g => g.event === gw)?.points || 0
            });
        });
    }

    return rankHistory;
}

// Pre-calculate all manager profiles using already-fetched data
async function preCalculateManagerProfiles(leagueData, histories, losersData, motmData) {
    const profiles = {};
    const managers = leagueData.standings.results;

    // Calculate league rank history for all managers
    const leagueRankHistory = calculateLeagueRankHistory(histories);

    // Count losses per manager
    const loserCounts = {};
    managers.forEach(m => loserCounts[m.player_name] = 0);
    if (losersData?.losers) {
        losersData.losers.forEach(l => {
            if (loserCounts[l.name] !== undefined) {
                loserCounts[l.name]++;
            }
        });
    }

    // Count MotM wins per manager
    const motmCounts = {};
    managers.forEach(m => motmCounts[m.player_name] = 0);
    if (motmData?.winners) {
        motmData.winners.forEach(w => {
            if (w.winner?.name && motmCounts[w.winner.name] !== undefined) {
                motmCounts[w.winner.name]++;
            }
        });
    }

    histories.forEach(manager => {
        const gwData = manager.gameweeks;
        if (!gwData || gwData.length === 0) return;

        // Calculate season records from history
        let highest = { points: 0, gw: 0 };
        let lowest = { points: Infinity, gw: 0 };
        let totalPoints = 0;
        let totalTransfers = 0;
        let transferHits = 0;

        gwData.forEach(gw => {
            if (gw.points > highest.points) {
                highest = { points: gw.points, gw: gw.event };
            }
            if (gw.points < lowest.points) {
                lowest = { points: gw.points, gw: gw.event };
            }
            totalPoints += gw.points;
            totalTransfers += gw.event_transfers || 0;
            transferHits += gw.event_transfers_cost || 0;
        });

        if (lowest.points === Infinity) lowest = { points: 0, gw: 0 };

        // Get current league standing
        const standing = managers.find(m => m.entry === manager.entryId);
        const currentLeagueRank = standing?.rank || 0;

        // Get best league rank from history
        const rankHist = leagueRankHistory[manager.entryId] || [];
        const bestLeagueRank = rankHist.length > 0 ? Math.min(...rankHist.map(r => r.rank)) : currentLeagueRank;

        profiles[manager.entryId] = {
            entryId: manager.entryId,
            name: manager.name,
            team: manager.team,
            history: rankHist,
            records: {
                highestGW: highest,
                lowestGW: lowest,
                bestRank: bestLeagueRank,
                currentRank: currentLeagueRank,
                avgScore: Math.round(totalPoints / gwData.length * 10) / 10,
                totalTransfers,
                transferHits
            },
            loserCount: loserCounts[manager.name] || 0,
            motmWins: motmCounts[manager.name] || 0
        };
    });

    return profiles;
}

// =============================================================================
// HALL OF FAME DATA (Pre-calculated during refresh)
// =============================================================================
// Note: formatTiedNames, updateRecordWithTies, updateRecordWithTiesLow are imported from lib/utils.js

// Calculate perfect chip usage for BB and TC
async function calculatePerfectChipUsage(histories) {
    const perfectBB = [];
    const perfectTC = [];

    // Get bootstrap for player data
    let bootstrap;
    try {
        bootstrap = await fetchBootstrap();
    } catch (e) {
        console.error('[HoF] Failed to fetch bootstrap for chip calc:', e.message);
        return { perfectBB, perfectTC };
    }

    for (const manager of histories) {
        const bbChip = manager.chips?.find(c => c.name === 'bboost');
        const tcChip = manager.chips?.find(c => c.name === '3xc');

        // Calculate Perfect BB
        if (bbChip) {
            try {
                // Get the manager's bench points for non-BB weeks
                const nonBBWeeks = manager.gameweeks.filter(gw => gw.event !== bbChip.event);
                const maxNonBBBench = Math.max(...nonBBWeeks.map(gw => gw.points_on_bench || 0));

                // Fetch picks for BB week to calculate what bench scored
                const bbPicks = await fetchManagerPicks(manager.entryId, bbChip.event);
                if (bbPicks?.picks) {
                    // Get bench players (positions 12-15)
                    const benchPlayers = bbPicks.picks.slice(11);

                    // Fetch live data for that GW to get their points
                    const liveData = await fetchLiveGWData(bbChip.event);

                    let bbBenchPoints = 0;
                    benchPlayers.forEach(pick => {
                        const liveEl = liveData?.elements?.find(e => e.id === pick.element);
                        bbBenchPoints += liveEl?.stats?.total_points || 0;
                    });

                    // If BB week bench >= max other week's bench, it was a perfect use
                    if (bbBenchPoints >= maxNonBBBench && bbBenchPoints > 0) {
                        perfectBB.push({
                            name: manager.name,
                            gw: bbChip.event,
                            benchPoints: bbBenchPoints,
                            maxOtherBench: maxNonBBBench
                        });
                    }
                }
            } catch (e) {
                console.error(`[HoF] BB calc error for ${manager.name}:`, e.message);
            }
        }

        // Calculate Perfect TC
        if (tcChip) {
            try {
                // Fetch picks for TC week
                const tcPicks = await fetchManagerPicks(manager.entryId, tcChip.event);
                if (tcPicks?.picks) {
                    const captain = tcPicks.picks.find(p => p.is_captain);
                    if (captain) {
                        // Get captain's points
                        const liveData = await fetchLiveGWData(tcChip.event);
                        const captainLive = liveData?.elements?.find(e => e.id === captain.element);
                        const tcCaptainPoints = captainLive?.stats?.total_points || 0;

                        // Compare to captain points from other weeks
                        // We need to fetch picks for other weeks to compare captain performance
                        // This is expensive, so we'll only compare to a sample of weeks
                        const completedGWs = manager.gameweeks.map(gw => gw.event).filter(e => e !== tcChip.event);

                        // Sample 5 random GWs to check captain performance
                        const sampleGWs = completedGWs.sort(() => 0.5 - Math.random()).slice(0, 5);

                        let maxOtherCaptainPts = 0;
                        for (const gw of sampleGWs) {
                            try {
                                const gwPicks = await fetchManagerPicks(manager.entryId, gw);
                                const gwCaptain = gwPicks?.picks?.find(p => p.is_captain);
                                if (gwCaptain) {
                                    const gwLive = await fetchLiveGWData(gw);
                                    const gwCaptainLive = gwLive?.elements?.find(e => e.id === gwCaptain.element);
                                    const pts = gwCaptainLive?.stats?.total_points || 0;
                                    if (pts > maxOtherCaptainPts) maxOtherCaptainPts = pts;
                                }
                            } catch (e) {
                                // Skip failed weeks
                            }
                        }

                        // If TC captain scored >= max sampled captain, likely a good use
                        if (tcCaptainPoints >= maxOtherCaptainPts && tcCaptainPoints >= 10) {
                            perfectTC.push({
                                name: manager.name,
                                gw: tcChip.event,
                                captainPoints: tcCaptainPoints,
                                player: bootstrap.elements?.find(e => e.id === captain.element)?.web_name || 'Unknown'
                            });
                        }
                    }
                }
            } catch (e) {
                console.error(`[HoF] TC calc error for ${manager.name}:`, e.message);
            }
        }
    }

    return { perfectBB, perfectTC };
}

async function preCalculateHallOfFame(histories, losersData, motmData, chipsData, completedGWs = null) {
    // Initialize records with tie support
    let highestGW = { names: [], value: 0, gw: 0 };
    let lowestGW = { names: [], value: Infinity, gw: 0 };
    let biggestClimb = { names: [], value: 0, gw: 0 };
    let biggestDrop = { names: [], value: 0, gw: 0 };
    let mostTransfers = { names: [], value: 0 };
    let biggestHit = { names: [], value: 0, gw: 0 };
    let highestTeamValue = { names: [], value: 0, gw: 0 };
    let lowestTeamValue = { names: [], value: Infinity, gw: 0 };
    let biggestBenchHaul = { names: [], value: 0, gw: 0 };

    // Track scores for consistency calculation
    const managerScoreStats = {};
    const managerTransferTotals = {};

    // Calculate league rank history for climb/drop calculations
    const leagueRankHistory = calculateLeagueRankHistory(histories);

    // First pass: calculate basic records from history
    histories.forEach(manager => {
        let totalTransfers = 0;
        const scores = [];
        const rankHist = leagueRankHistory[manager.entryId] || [];

        manager.gameweeks.forEach((gw, idx) => {
            scores.push(gw.points);

            // Highest/Lowest GW scores
            highestGW = updateRecordWithTies(highestGW, manager.name, gw.points, { gw: gw.event });
            lowestGW = updateRecordWithTiesLow(lowestGW, manager.name, gw.points, { gw: gw.event });

            // Transfers
            totalTransfers += gw.event_transfers || 0;

            // Transfer hits (single GW)
            const hitCost = gw.event_transfers_cost || 0;
            biggestHit = updateRecordWithTies(biggestHit, manager.name, hitCost, { gw: gw.event });

            // Team value tracking (value is in tenths, e.g. 1000 = £100.0m)
            const teamValue = gw.value || 0;
            highestTeamValue = updateRecordWithTies(highestTeamValue, manager.name, teamValue, { gw: gw.event });
            if (teamValue > 0) {
                lowestTeamValue = updateRecordWithTiesLow(lowestTeamValue, manager.name, teamValue, { gw: gw.event });
            }

            // Bench points from history (points_on_bench field if available)
            // Check for BB chip usage - exclude those weeks
            const usedBB = manager.chips?.some(c => c.name === 'bboost' && c.event === gw.event);
            if (!usedBB && gw.points_on_bench !== undefined && gw.points_on_bench > 0) {
                biggestBenchHaul = updateRecordWithTies(biggestBenchHaul, manager.name, gw.points_on_bench, { gw: gw.event });
            }
        });

        managerTransferTotals[manager.name] = totalTransfers;

        // Rank changes from league rank history
        for (let i = 1; i < rankHist.length; i++) {
            const rankChange = rankHist[i-1].rank - rankHist[i].rank;
            if (rankChange > 0) {
                biggestClimb = updateRecordWithTies(biggestClimb, manager.name, rankChange, { gw: rankHist[i].gw });
            }
            if (rankChange < 0) {
                const ranksLost = -rankChange;
                biggestDrop = updateRecordWithTies(biggestDrop, manager.name, ranksLost, { gw: rankHist[i].gw });
            }
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

    // Process total transfers (needs separate pass after collecting all)
    Object.entries(managerTransferTotals).forEach(([name, count]) => {
        mostTransfers = updateRecordWithTies(mostTransfers, name, count, {});
    });

    // Most consistent (lowest std dev) - with tie support
    let mostConsistent = { names: [], value: Infinity };
    Object.entries(managerScoreStats).forEach(([name, stats]) => {
        const rounded = Math.round(stats.stdDev * 10) / 10;
        mostConsistent = updateRecordWithTiesLow(mostConsistent, name, rounded, {});
    });

    // Get losers count with tie support
    const loserCounts = {};
    histories.forEach(m => loserCounts[m.name] = 0);
    if (losersData?.losers) {
        losersData.losers.forEach(l => {
            if (loserCounts[l.name] !== undefined) {
                loserCounts[l.name]++;
            }
        });
    }

    let mostLosses = { names: [], value: 0 };
    Object.entries(loserCounts).forEach(([name, count]) => {
        mostLosses = updateRecordWithTies(mostLosses, name, count, {});
    });

    // Get MotM wins with tie support
    const motmCounts = {};
    histories.forEach(m => motmCounts[m.name] = 0);
    if (motmData?.winners) {
        motmData.winners.forEach(w => {
            if (w.winner?.name && motmCounts[w.winner.name] !== undefined) {
                motmCounts[w.winner.name]++;
            }
        });
    }

    let mostMotM = { names: [], value: 0 };
    Object.entries(motmCounts).forEach(([name, count]) => {
        mostMotM = updateRecordWithTies(mostMotM, name, count, {});
    });

    // Fix defaults for records with no data
    if (lowestGW.value === Infinity) {
        lowestGW = { names: ['-'], value: 0, gw: 0 };
    }
    if (lowestTeamValue.value === Infinity) {
        lowestTeamValue = { names: ['-'], value: 1000, gw: 0 };
    }
    if (mostConsistent.value === Infinity) {
        mostConsistent = { names: ['-'], value: 0 };
    }

    // Calculate perfect chip usage (BB and TC)
    console.log('[HoF] Calculating perfect chip usage...');
    const chipAwards = await calculatePerfectChipUsage(histories);
    console.log(`[HoF] Found ${chipAwards.perfectBB.length} perfect BB, ${chipAwards.perfectTC.length} perfect TC`);

    // Get best/worst tinkering from cache (populated as users browse week modal)
    // This avoids expensive API calls during Hall of Fame calculation
    let bestTinkering = { names: [], value: -Infinity, gw: 0 };
    let worstTinkering = { names: [], value: Infinity, gw: 0 };

    const entryIdToName = {};
    histories.forEach(m => entryIdToName[m.entryId] = m.name);

    Object.entries(dataCache.tinkeringCache || {}).forEach(([key, data]) => {
        if (!data.available || typeof data.netImpact !== 'number') return;

        const [entryId, gw] = key.split('-').map(Number);
        const managerName = entryIdToName[entryId];
        if (!managerName) return;

        // Skip current/unfinished gameweeks
        if (completedGWs && !completedGWs.includes(gw)) return;

        if (data.netImpact > bestTinkering.value) {
            bestTinkering = { names: [managerName], value: data.netImpact, gw };
        } else if (data.netImpact === bestTinkering.value && !bestTinkering.names.includes(managerName)) {
            bestTinkering.names.push(managerName);
        }

        if (data.netImpact < worstTinkering.value) {
            worstTinkering = { names: [managerName], value: data.netImpact, gw };
        } else if (data.netImpact === worstTinkering.value && !worstTinkering.names.includes(managerName)) {
            worstTinkering.names.push(managerName);
        }
    });

    const cacheSize = Object.keys(dataCache.tinkeringCache || {}).length;
    if (cacheSize > 0) {
        console.log(`[HoF] Tinkering records from ${cacheSize} cached entries`);
    }

    // Fix defaults for tinkering if no cached data
    if (bestTinkering.value === -Infinity) {
        bestTinkering = { names: ['-'], value: 0, gw: 0 };
    }
    if (worstTinkering.value === Infinity) {
        worstTinkering = { names: ['-'], value: 0, gw: 0 };
    }

    // Convert to frontend-friendly format
    return {
        highlights: {
            highestGW: {
                name: formatTiedNames(highestGW.names),
                names: highestGW.names,
                score: highestGW.value,
                gw: highestGW.gw
            },
            biggestClimb: {
                name: formatTiedNames(biggestClimb.names),
                names: biggestClimb.names,
                ranksGained: biggestClimb.value,
                gw: biggestClimb.gw
            },
            mostMotM: {
                name: formatTiedNames(mostMotM.names),
                names: mostMotM.names,
                count: mostMotM.value
            },
            mostConsistent: {
                name: formatTiedNames(mostConsistent.names),
                names: mostConsistent.names,
                stdDev: mostConsistent.value
            },
            highestTeamValue: {
                name: formatTiedNames(highestTeamValue.names),
                names: highestTeamValue.names,
                value: (highestTeamValue.value / 10).toFixed(1),
                gw: highestTeamValue.gw
            },
            bestTinkering: {
                name: formatTiedNames(bestTinkering.names),
                names: bestTinkering.names,
                impact: bestTinkering.value,
                gw: bestTinkering.gw
            }
        },
        lowlights: {
            lowestGW: {
                name: formatTiedNames(lowestGW.names),
                names: lowestGW.names,
                score: lowestGW.value,
                gw: lowestGW.gw
            },
            mostLosses: {
                name: formatTiedNames(mostLosses.names),
                names: mostLosses.names,
                count: mostLosses.value
            },
            biggestHit: {
                name: formatTiedNames(biggestHit.names),
                names: biggestHit.names,
                cost: biggestHit.value,
                gw: biggestHit.gw
            },
            biggestDrop: {
                name: formatTiedNames(biggestDrop.names),
                names: biggestDrop.names,
                ranksLost: biggestDrop.value,
                gw: biggestDrop.gw
            },
            mostTransfers: {
                name: formatTiedNames(mostTransfers.names),
                names: mostTransfers.names,
                count: mostTransfers.value
            },
            lowestTeamValue: {
                name: formatTiedNames(lowestTeamValue.names),
                names: lowestTeamValue.names,
                value: (lowestTeamValue.value / 10).toFixed(1),
                gw: lowestTeamValue.gw
            },
            biggestBenchHaul: {
                name: formatTiedNames(biggestBenchHaul.names),
                names: biggestBenchHaul.names,
                points: biggestBenchHaul.value,
                gw: biggestBenchHaul.gw
            },
            worstTinkering: {
                name: formatTiedNames(worstTinkering.names),
                names: worstTinkering.names,
                impact: worstTinkering.value,
                gw: worstTinkering.gw
            }
        },
        chipAwards: {
            perfectBB: chipAwards.perfectBB,
            perfectTC: chipAwards.perfectTC
        }
    };
}

/**
 * Calculate Set and Forget data - what if managers kept their GW1 team all season
 * Uses GW1 picks for each manager and calculates hypothetical scores with auto-subs
 */
async function calculateSetAndForgetData() {
    console.log('[SetAndForget] Starting calculation...');
    const startTime = Date.now();

    try {
        const [bootstrap, leagueData] = await Promise.all([fetchBootstrap(), fetchLeagueData()]);
        const managers = leagueData.standings.results;
        const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);

        if (completedGWs.length === 0) {
            console.log('[SetAndForget] No completed gameweeks yet');
            return { managers: [], completedGWs: 0 };
        }

        // Get GW1 picks for all managers
        const gw1Picks = {};
        for (const m of managers) {
            const cacheKey = `${m.entry}-1`;
            if (dataCache.picksCache[cacheKey]) {
                gw1Picks[m.entry] = dataCache.picksCache[cacheKey];
            } else {
                // Fetch if not cached
                try {
                    const picks = await fetchManagerPicks(m.entry, 1);
                    gw1Picks[m.entry] = picks;
                    dataCache.picksCache[cacheKey] = picks;
                } catch (err) {
                    console.log(`[SetAndForget] Could not fetch GW1 picks for ${m.entry}`);
                }
            }
        }

        // Fetch fixtures for all GWs
        const fixtures = await fetchFixtures();

        // Calculate set-and-forget scores for each manager
        const results = [];

        for (const m of managers) {
            const picks = gw1Picks[m.entry];
            if (!picks?.picks) continue;

            let totalSAFPoints = 0;
            const gwBreakdown = [];

            for (const gw of completedGWs) {
                // Get live data for this GW (from cache)
                const liveData = dataCache.liveDataCache[gw];
                if (!liveData) continue;

                const gwFixtures = fixtures.filter(f => f.event === gw);

                // Calculate what GW1 team would have scored in this GW
                const result = calculateHypotheticalScore(picks, liveData, bootstrap, gwFixtures);
                totalSAFPoints += result.totalPoints;

                gwBreakdown.push({
                    gw,
                    points: result.totalPoints,
                    benchPoints: result.benchPoints
                });
            }

            // Get actual total points
            const actualTotal = m.total;

            results.push({
                entryId: m.entry,
                name: m.player_name,
                team: m.entry_name,
                actualRank: m.rank,
                actualTotal,
                safTotal: totalSAFPoints,
                difference: actualTotal - totalSAFPoints,
                gwBreakdown
            });
        }

        // Sort by SAF total (highest first) and assign SAF ranks
        results.sort((a, b) => b.safTotal - a.safTotal);
        results.forEach((r, i) => r.safRank = i + 1);

        // Re-sort by difference to show who benefited most from tinkering
        const sortedByDiff = [...results].sort((a, b) => b.difference - a.difference);

        console.log(`[SetAndForget] Calculated in ${Date.now() - startTime}ms for ${results.length} managers`);

        return {
            leagueName: leagueData.league.name,
            managers: results,
            completedGWs: completedGWs.length,
            bestTinkerer: sortedByDiff[0],
            worstTinkerer: sortedByDiff[sortedByDiff.length - 1]
        };
    } catch (error) {
        console.error('[SetAndForget] Error:', error.message);
        return { managers: [], completedGWs: 0, error: error.message };
    }
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
// PICKS DATA PRE-CALCULATION (runs during daily refresh)
// =============================================================================
async function preCalculatePicksData(managers) {
    console.log('[Picks] Pre-caching picks and live data for all managers...');
    const startTime = Date.now();

    try {
        const bootstrap = await fetchBootstrap();
        const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);

        if (completedGWs.length === 0) {
            console.log('[Picks] No completed GWs to cache');
            return;
        }

        // First, cache live data for all completed GWs (once per GW)
        let liveDataCached = 0;
        for (const gw of completedGWs) {
            if (!dataCache.liveDataCache[gw]) {
                const liveData = await fetchLiveGWData(gw);
                dataCache.liveDataCache[gw] = liveData;
                liveDataCached++;
                // Update rebuild status if in progress
                if (rebuildStatus.inProgress) {
                    rebuildStatus.phase = 'picks';
                    rebuildStatus.progress = `Fetching live data: GW${gw} (${liveDataCached}/${completedGWs.length})`;
                }
            }
        }
        console.log(`[Picks] Cached live data for ${liveDataCached} GWs (${completedGWs.length - liveDataCached} already cached)`);

        // Then cache raw picks for all managers × all completed GWs
        let picksCached = 0;
        let picksSkipped = 0;
        const totalPicks = managers.length * completedGWs.length;

        for (const manager of managers) {
            for (const gw of completedGWs) {
                const cacheKey = `${manager.entry}-${gw}`;

                if (dataCache.picksCache[cacheKey]) {
                    picksSkipped++;
                    continue;
                }

                try {
                    const picks = await fetchManagerPicks(manager.entry, gw);
                    dataCache.picksCache[cacheKey] = picks;
                    picksCached++;
                    // Update rebuild status if in progress
                    if (rebuildStatus.inProgress && picksCached % 10 === 0) {
                        rebuildStatus.progress = `Fetching picks: ${picksCached + picksSkipped}/${totalPicks}`;
                    }
                } catch (e) {
                    // Skip failed fetches
                }
            }
        }

        console.log(`[Picks] Raw picks cached: ${picksCached} new, ${picksSkipped} already cached`);

        // Finally, pre-calculate processed picks for all managers × all completed GWs
        let processedCached = 0;
        let processedSkipped = 0;

        for (const manager of managers) {
            for (const gw of completedGWs) {
                const cacheKey = `${manager.entry}-${gw}`;

                if (dataCache.processedPicksCache[cacheKey]) {
                    processedSkipped++;
                    continue;
                }

                try {
                    const processedData = await fetchManagerPicksDetailed(manager.entry, gw, bootstrap);
                    dataCache.processedPicksCache[cacheKey] = processedData;
                    processedCached++;
                    // Update rebuild status if in progress
                    if (rebuildStatus.inProgress && processedCached % 10 === 0) {
                        rebuildStatus.progress = `Processing picks: ${processedCached + processedSkipped}/${totalPicks}`;
                    }
                } catch (e) {
                    // Skip failed fetches
                }
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Picks] Pre-cache complete in ${duration}s - ${processedCached} processed picks cached (${processedSkipped} already cached)`);
    } catch (error) {
        console.error('[Picks] Pre-cache failed:', error.message);
    }
}

// =============================================================================
// TINKERING DATA PRE-CALCULATION (runs during daily refresh)
// =============================================================================
async function preCalculateTinkeringData(managers) {
    console.log('[Tinkering] Pre-calculating tinkering data for all managers...');
    const startTime = Date.now();

    try {
        const bootstrap = await fetchBootstrap();
        const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);
        const tinkeringGWs = completedGWs.filter(gw => gw >= 2); // Skip GW1

        if (tinkeringGWs.length === 0) {
            console.log('[Tinkering] No completed GWs to calculate');
            return;
        }

        let calculated = 0;
        let skipped = 0;
        const totalTinkering = managers.length * tinkeringGWs.length;

        for (const manager of managers) {
            for (const gw of tinkeringGWs) {
                const cacheKey = `${manager.entry}-${gw}`;

                // Skip if already cached
                if (dataCache.tinkeringCache[cacheKey]) {
                    skipped++;
                    continue;
                }

                try {
                    const result = await calculateTinkeringImpact(manager.entry, gw);
                    // Result is automatically cached by calculateTinkeringImpact for completed GWs
                    calculated++;
                    // Update rebuild status if in progress
                    if (rebuildStatus.inProgress && calculated % 10 === 0) {
                        rebuildStatus.phase = 'tinkering';
                        rebuildStatus.progress = `Calculating tinkering: ${calculated + skipped}/${totalTinkering}`;
                    }
                } catch (e) {
                    // Skip failed calculations
                }
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Tinkering] Pre-calculation complete in ${duration}s - ${calculated} new, ${skipped} cached`);
    } catch (error) {
        console.error('[Tinkering] Pre-calculation failed:', error.message);
    }
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

    // Skip heavy profile/hall-of-fame calculations during live polling
    const isLivePoll = reason.includes('live-poll');

    try {
        const [standings, losers, motm, chips, earnings, league] = await Promise.all([
            fetchStandingsWithTransfers(),
            fetchWeeklyLosers(),
            fetchMotmData(),
            fetchChipsData(),
            fetchProfitLossData(),
            fetchLeagueData()
        ]);

        let managerProfiles = dataCache.managerProfiles || {};
        let hallOfFame = dataCache.hallOfFame || null;

        // Only pre-calculate profiles/hall-of-fame on startup, morning refresh, or non-live refreshes
        if (!isLivePoll) {
            console.log('[Refresh] Pre-calculating manager profiles and hall of fame...');
            const managers = league.standings.results;

            // Get completed gameweeks (exclude current/unfinished GW from Hall of Fame)
            const bootstrap = await fetchBootstrap();
            const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);

            // Pre-cache picks and live data FIRST so histories can use cached calculated points
            // Only run during startup/daily/morning refreshes, NOT during live polling
            const shouldPreCache = ['startup', 'morning-after-gameweek', 'daily-check', 'admin-rebuild-historical'].includes(reason);
            if (shouldPreCache) {
                await preCalculatePicksData(managers);
                await preCalculateTinkeringData(managers);
            }

            // Now build histories - will use cached calculated points when available
            // (history API's points can be incorrect, e.g., missing bench boost bonus)
            const histories = await Promise.all(
                managers.map(async m => {
                    const history = await fetchManagerHistory(m.entry);
                    const gameweeks = history.current.map(gw => {
                        const cacheKey = `${m.entry}-${gw.event}`;
                        const cached = dataCache.processedPicksCache[cacheKey];
                        if (cached?.calculatedPoints !== undefined) {
                            return { ...gw, points: cached.calculatedPoints };
                        }
                        return gw;
                    });
                    return {
                        name: m.player_name,
                        team: m.entry_name,
                        entryId: m.entry,
                        gameweeks,
                        chips: history.chips || []  // Include chips for bench boost detection
                    };
                })
            );

            managerProfiles = await preCalculateManagerProfiles(league, histories, losers, motm);

            // Filter histories to only completed GWs for Hall of Fame (exclude current/live GW)
            const completedHistories = histories.map(h => ({
                ...h,
                gameweeks: h.gameweeks.filter(gw => completedGWs.includes(gw.event))
            }));

            // Calculate hall of fame (uses tinkering cache) - only completed GWs
            hallOfFame = await preCalculateHallOfFame(completedHistories, losers, motm, chips, completedGWs);

            // Calculate Set and Forget data (uses picks cache and live data cache)
            dataCache.setAndForget = await calculateSetAndForgetData();
        }

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
            managerProfiles,
            hallOfFame,
            lastRefresh: new Date().toISOString(),
            lastDataHash: newDataHash
        };

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[Refresh] Complete in ${duration}s - Changes detected: ${hadChanges}${isLivePoll ? ' (live poll - skipped profile calc)' : ''}`);

        // Persist data to Redis so it survives server restarts
        await saveDataCache();

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
    await refreshWeekData();  // Also refresh week data to update timestamp

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

// Note: getMatchEndTime and groupFixturesIntoWindows are imported from lib/utils.js

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

async function stopLivePolling(reason) {
    if (!isLivePolling) return;

    isLivePolling = false;
    if (livePollingInterval) {
        clearInterval(livePollingInterval);
        livePollingInterval = null;
    }

    console.log(`[Live] Stopped live polling - ${reason}`);

    // Save previous state for restart recovery before stopping
    if (liveEventState.lastGW) {
        await savePreviousPlayerState(liveEventState.lastGW);
        console.log(`[Live] Saved previous state for GW${liveEventState.lastGW}`);
    }

    // Do one final refresh to capture final scores
    refreshAllData(`live-end-${reason}`);
    refreshWeekData().catch(e => console.error('[Live] Week refresh failed:', e.message));
}

// Check if all matches are finished before stopping polling
// Extends polling up to 30 mins if FPL hasn't set finished_provisional yet
async function checkAndStopPolling(originalEndTime, reason) {
    const maxExtension = 30 * 60 * 1000; // 30 minutes max extension
    const now = Date.now();

    // Safety: don't extend beyond 30 mins past original end
    if (now > originalEndTime.getTime() + maxExtension) {
        console.log('[Live] Max extension reached (30 mins), stopping polling');
        await stopLivePolling(reason);
        setTimeout(scheduleRefreshes, 60000);
        return;
    }

    try {
        // Fetch fresh fixtures to check status
        const [fixtures, bootstrap] = await Promise.all([fetchFixtures(), fetchBootstrap()]);
        const currentGW = bootstrap.events.find(e => e.is_current)?.id || 0;
        const currentGWFixtures = fixtures.filter(f => f.event === currentGW);
        const startedMatches = currentGWFixtures.filter(f => f.started);
        const unfinishedMatches = startedMatches.filter(f => !f.finished_provisional);

        if (unfinishedMatches.length > 0) {
            const extendedMins = Math.round((now - originalEndTime.getTime()) / 60000);
            console.log(`[Live] ${unfinishedMatches.length} match(es) not yet finished (extended ${extendedMins}+ mins), continuing polling`);
            // Check again in 1 minute
            setTimeout(() => checkAndStopPolling(originalEndTime, reason), 60000);
            return;
        }

        // All matches finished, stop polling
        console.log('[Live] All matches finished (finished_provisional=true), stopping polling');
        await stopLivePolling(reason);
        setTimeout(scheduleRefreshes, 60000);
    } catch (error) {
        console.error('[Live] Error checking fixture status:', error.message);
        // On error, try again in 1 minute (up to max extension)
        setTimeout(() => checkAndStopPolling(originalEndTime, reason), 60000);
    }
}

async function scheduleRefreshes() {
    // Clear existing scheduled jobs
    scheduledJobs.forEach(job => job.stop());
    scheduledJobs = [];

    // Stop any live polling
    await stopLivePolling('reschedule');

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

    // Get deadline from current GW event
    const currentGWEvent = events.find(e => e.id === currentGW);
    const deadline = currentGWEvent ? new Date(currentGWEvent.deadline_time) : null;

    // Group fixtures into kickoff windows
    const windows = groupFixturesIntoWindows(currentGWFixtures);

    console.log(`[Scheduler] Found ${windows.length} match window(s) for GW ${currentGW}`);
    if (deadline) {
        console.log(`[Scheduler] GW${currentGW} deadline: ${deadline.toLocaleString('en-GB')}`);
    }

    // Check if we're in pre-match polling window (post-deadline, pre-kickoff)
    // FPL releases data shortly after deadline, not 5 mins before kickoff
    const firstKickoff = windows[0]?.start;
    const lastPollEnd = windows[windows.length - 1]?.end;
    const isPostDeadline = deadline && now >= deadline;
    const isPreFirstKickoff = firstKickoff && now < firstKickoff;
    const isInPreMatchWindow = isPostDeadline && isPreFirstKickoff;

    // Check if we're currently in a live window (during matches)
    let currentlyLive = false;
    windows.forEach((window, idx) => {
        const pollStart = new Date(window.start.getTime() - 5 * 60 * 1000); // 5 mins before kickoff
        const pollEnd = window.end;

        if (now >= pollStart && now <= pollEnd) {
            currentlyLive = true;
            const matchCount = window.fixtures.length;
            const kickoffTime = window.start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
            startLivePolling(`${matchCount} match(es) at ${kickoffTime}`);

            // Schedule stop check at window end (will extend if matches not finished)
            const stopDelay = pollEnd.getTime() - now.getTime();
            if (stopDelay > 0) {
                const stopJob = setTimeout(() => {
                    checkAndStopPolling(pollEnd, 'window-end');
                }, stopDelay);
                scheduledJobs.push({ stop: () => clearTimeout(stopJob) });
                console.log(`[Scheduler] Will check for stop at ${pollEnd.toLocaleTimeString('en-GB')} (extends if matches not finished)`);
            }
        }
    });

    // Handle pre-match polling (post-deadline, pre-kickoff)
    // This allows data to refresh as soon as FPL releases it after deadline
    if (!currentlyLive && isInPreMatchWindow) {
        console.log(`[Scheduler] In pre-match window (post-deadline, pre-kickoff)`);
        startLivePolling('pre-match (post-deadline)');

        // Schedule transition to regular live polling at first kickoff
        const switchDelay = firstKickoff.getTime() - now.getTime();
        if (switchDelay > 0) {
            console.log(`[Scheduler] Will switch to match polling at ${firstKickoff.toLocaleString('en-GB')}`);
            const switchJob = setTimeout(() => {
                // Re-schedule to pick up normal match window logic
                scheduleRefreshes();
            }, switchDelay);
            scheduledJobs.push({ stop: () => clearTimeout(switchJob) });
        }
    }

    // Schedule future windows
    if (!currentlyLive && !isInPreMatchWindow) {
        // Schedule pre-match polling from deadline if it's in the future
        if (deadline && deadline > now && firstKickoff) {
            const deadlineDelay = deadline.getTime() - now.getTime();
            if (deadlineDelay < 7 * 24 * 60 * 60 * 1000) { // Within 7 days
                console.log(`[Scheduler] Pre-match polling scheduled from: ${deadline.toLocaleString('en-GB')}`);
                const deadlineJob = setTimeout(() => {
                    startLivePolling('pre-match (post-deadline)');

                    // Schedule switch to regular polling at first kickoff
                    const switchDelay = firstKickoff.getTime() - Date.now();
                    if (switchDelay > 0) {
                        const switchJob = setTimeout(() => {
                            scheduleRefreshes();
                        }, switchDelay);
                        scheduledJobs.push({ stop: () => clearTimeout(switchJob) });
                    }
                }, deadlineDelay);
                scheduledJobs.push({ stop: () => clearTimeout(deadlineJob) });
            }
        }

        windows.forEach((window, idx) => {
            const pollStart = new Date(window.start.getTime() - 5 * 60 * 1000);
            const pollEnd = window.end;

            // Skip scheduling if this window will be covered by pre-match polling from deadline
            // (deadline is scheduled above and will transition to match polling at first kickoff)
            const coveredByPreMatchPolling = deadline && deadline > now && idx === 0 && deadline < pollStart;

            if (pollStart > now && !coveredByPreMatchPolling) {
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

                        // Schedule stop check (will extend if matches not finished)
                        const stopDelay = pollEnd.getTime() - Date.now();
                        if (stopDelay > 0) {
                            const stopJob = setTimeout(() => {
                                checkAndStopPolling(pollEnd, 'window-end');
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
            await refreshWeekData();  // Also refresh week data to update timestamp
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
        const isBinary = contentType.startsWith('image/');
        const content = fs.readFileSync(path.join(__dirname, filename), isBinary ? null : 'utf8');
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

    // Get season from query parameter
    const requestedSeason = url.searchParams.get('season');
    const isCurrentSeason = !requestedSeason || requestedSeason === CURRENT_SEASON;

    // Season management endpoints
    if (pathname === '/api/seasons') {
        const seasons = await getAvailableSeasons();
        serveJSON(res, { currentSeason: CURRENT_SEASON, seasons });
        return;
    }

    // Admin verification endpoint
    if (pathname === '/api/admin/verify') {
        if (req.method === 'POST') {
            let body = '';
            let bodySize = 0;
            const MAX_BODY_SIZE = 1024; // 1KB limit for password verification

            req.on('data', chunk => {
                bodySize += chunk.length;
                if (bodySize > MAX_BODY_SIZE) {
                    req.destroy();
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Request body too large' }));
                    return;
                }
                body += chunk;
            });
            req.on('error', () => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request error' }));
            });
            req.on('end', () => {
                if (res.writableEnded) return;
                try {
                    const { password } = JSON.parse(body);
                    if (password === ADMIN_PASSWORD) {
                        serveJSON(res, { success: true });
                    } else {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid password' }));
                    }
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid request' }));
                }
            });
        } else {
            serveJSON(res, { error: 'Use POST method' });
        }
        return;
    }

    if (pathname === '/api/archive-season') {
        if (req.method === 'POST') {
            let body = '';
            let bodySize = 0;
            const MAX_BODY_SIZE = 1024; // 1KB limit for archive request

            req.on('data', chunk => {
                bodySize += chunk.length;
                if (bodySize > MAX_BODY_SIZE) {
                    req.destroy();
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Request body too large' }));
                    return;
                }
                body += chunk;
            });
            req.on('error', () => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request error' }));
            });
            req.on('end', async () => {
                if (res.writableEnded) return;
                try {
                    const { password } = JSON.parse(body);
                    if (password !== ADMIN_PASSWORD) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid password' }));
                        return;
                    }
                    const result = await archiveCurrentSeason();
                    serveJSON(res, result);
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid request: ' + e.message }));
                }
            });
        } else {
            serveJSON(res, { error: 'Use POST to archive' });
        }
        return;
    }

    // Admin endpoint to check rebuild status
    if (pathname === '/api/admin/rebuild-status') {
        const elapsed = rebuildStatus.startTime
            ? ((Date.now() - rebuildStatus.startTime) / 1000).toFixed(1) + 's'
            : null;
        serveJSON(res, {
            ...rebuildStatus,
            elapsed,
            cacheStats: {
                picksCache: Object.keys(dataCache.picksCache).length,
                liveDataCache: Object.keys(dataCache.liveDataCache).length,
                processedPicksCache: Object.keys(dataCache.processedPicksCache).length,
                tinkeringCache: Object.keys(dataCache.tinkeringCache).length
            }
        });
        return;
    }

    // Admin endpoint to rebuild all historical gameweek data
    // Clears all caches and re-fetches fresh data from FPL API
    // This runs ASYNC - returns immediately and rebuilds in background
    if (pathname === '/api/admin/rebuild-historical-data') {
        if (req.method === 'POST') {
            let body = '';
            let bodySize = 0;
            const MAX_BODY_SIZE = 1024;

            req.on('data', chunk => {
                bodySize += chunk.length;
                if (bodySize > MAX_BODY_SIZE) {
                    req.destroy();
                    res.writeHead(413, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Request body too large' }));
                    return;
                }
                body += chunk;
            });
            req.on('error', () => {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Request error' }));
            });
            req.on('end', async () => {
                if (res.writableEnded) return;
                try {
                    const { password } = JSON.parse(body);
                    if (password !== ADMIN_PASSWORD) {
                        res.writeHead(401, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Invalid password' }));
                        return;
                    }

                    // Check if rebuild is already in progress
                    if (rebuildStatus.inProgress) {
                        serveJSON(res, {
                            success: false,
                            error: 'Rebuild already in progress',
                            status: rebuildStatus
                        });
                        return;
                    }

                    console.log('[Admin] Starting async rebuild of all historical gameweek data...');

                    // Count items before clearing
                    const picksCount = Object.keys(dataCache.picksCache).length;
                    const liveDataCount = Object.keys(dataCache.liveDataCache).length;
                    const processedCount = Object.keys(dataCache.processedPicksCache).length;
                    const tinkeringCount = Object.keys(dataCache.tinkeringCache).length;

                    // Initialize rebuild status
                    rebuildStatus = {
                        inProgress: true,
                        startTime: Date.now(),
                        phase: 'clearing',
                        progress: 'Clearing caches...',
                        error: null,
                        result: null,
                        cleared: { picksCount, liveDataCount, processedCount, tinkeringCount }
                    };

                    // Clear ALL historical caches
                    dataCache.picksCache = {};
                    dataCache.liveDataCache = {};
                    dataCache.processedPicksCache = {};
                    dataCache.tinkeringCache = {};

                    console.log(`[Admin] Cleared caches: ${picksCount} picks, ${liveDataCount} liveData, ${processedCount} processed, ${tinkeringCount} tinkering`);

                    // Return immediately - rebuild runs in background
                    serveJSON(res, {
                        success: true,
                        message: 'Rebuild started - poll /api/admin/rebuild-status for progress',
                        cleared: { picksCount, liveDataCount, processedCount, tinkeringCount }
                    });

                    // Run rebuild in background (don't await - fire and forget)
                    (async () => {
                        try {
                            rebuildStatus.phase = 'refreshing';
                            rebuildStatus.progress = 'Fetching data from FPL API...';

                            const refreshResult = await refreshAllData('admin-rebuild-historical');

                            // Also refresh week data to use newly calculated points
                            await refreshWeekData();

                            const duration = ((Date.now() - rebuildStatus.startTime) / 1000).toFixed(1);

                            if (!refreshResult.success) {
                                console.error(`[Admin] Rebuild failed after ${duration}s:`, refreshResult.error);
                                rebuildStatus.inProgress = false;
                                rebuildStatus.phase = 'failed';
                                rebuildStatus.error = refreshResult.error || 'Unknown error';
                                return;
                            }

                            console.log(`[Admin] Rebuild complete in ${duration}s`);

                            rebuildStatus.inProgress = false;
                            rebuildStatus.phase = 'complete';
                            rebuildStatus.progress = null;
                            rebuildStatus.result = {
                                duration: duration + 's',
                                rebuilt: {
                                    picksCache: Object.keys(dataCache.picksCache).length,
                                    liveDataCache: Object.keys(dataCache.liveDataCache).length,
                                    processedPicksCache: Object.keys(dataCache.processedPicksCache).length,
                                    tinkeringCache: Object.keys(dataCache.tinkeringCache).length
                                }
                            };
                        } catch (e) {
                            console.error('[Admin] Rebuild failed:', e);
                            rebuildStatus.inProgress = false;
                            rebuildStatus.phase = 'failed';
                            rebuildStatus.error = e.message;
                        }
                    })();
                } catch (e) {
                    console.error('[Admin] Rebuild historical data failed:', e);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Rebuild failed: ' + e.message }));
                }
            });
        } else {
            serveJSON(res, { error: 'Use POST method with admin password' });
        }
        return;
    }

    // API routes - serve from cache (or archived data if viewing past season)
    const apiRoutes = {
        '/api/league': () => {
            if (!isCurrentSeason) {
                const archived = getSeasonData(requestedSeason, 'standings');
                if (archived) return { league: { name: archivedSeasons[requestedSeason]?.leagueName || 'Unknown' }};
            }
            return dataCache.league || fetchLeagueData();
        },
        '/api/standings': () => {
            if (!isCurrentSeason) return getSeasonData(requestedSeason, 'standings');
            return dataCache.standings || fetchStandingsWithTransfers();
        },
        '/api/losers': () => {
            if (!isCurrentSeason) return getSeasonData(requestedSeason, 'losers');
            return dataCache.losers || fetchWeeklyLosers();
        },
        '/api/motm': () => {
            if (!isCurrentSeason) return getSeasonData(requestedSeason, 'motm');
            return dataCache.motm || fetchMotmData();
        },
        '/api/chips': () => {
            if (!isCurrentSeason) return getSeasonData(requestedSeason, 'chips');
            return dataCache.chips || fetchChipsData();
        },
        '/api/earnings': () => {
            if (!isCurrentSeason) return getSeasonData(requestedSeason, 'earnings');
            return dataCache.earnings || fetchProfitLossData();
        },
        '/api/hall-of-fame': () => {
            if (!isCurrentSeason) return getSeasonData(requestedSeason, 'hallOfFame');
            return dataCache.hallOfFame || { error: 'Hall of Fame data is being calculated. Please refresh in a moment.' };
        },
        '/api/set-and-forget': () => {
            if (!isCurrentSeason) return getSeasonData(requestedSeason, 'setAndForget');
            return dataCache.setAndForget || { error: 'Set & Forget data is being calculated. Please refresh in a moment.' };
        },
        '/api/week': () => {
            // Week data only available for current season
            if (!isCurrentSeason) return { error: 'Live week data only available for current season' };
            return dataCache.week || refreshWeekData();
        },
        '/api/cup': async () => {
            // Mini-league cup configuration
            // Cup starts GW34, bracket drawn after GW33 ends (based on GW33 net scores)
            const CUP_START_GW = config.fpl.CUP_START_GW;
            const SEEDING_GW = config.fpl.SEEDING_GW;
            const MOCK_CUP_DATA = config.fpl.MOCK_CUP_DATA;

            const bootstrap = await fetchBootstrap();
            const currentGW = bootstrap.events.find(e => e.is_current)?.id || 1;

            // Mock data for testing UI (remove for production)
            if (MOCK_CUP_DATA) {
                const managers = [
                    { entry: 70252, name: 'Pieter Sayer', team: 'La Seleccion' },
                    { entry: 656869, name: 'Rich Cooper', team: 'Coopers Troopers' },
                    { entry: 3964451, name: 'Doug Stephenson', team: 'DS' },
                    { entry: 2918350, name: 'Dean Thompson', team: 'CBS United' },
                    { entry: 318792, name: 'Ewan Pirrie', team: 'A Cunha Mateta' },
                    { entry: 1013421, name: 'Alex Hogan', team: "TINDALL'S UCL MAGS" },
                    { entry: 2071480, name: 'Arran May', team: 'Isles of Scilly FC' },
                    { entry: 1624536, name: 'Simon Bays', team: 'Aston Villalobos' },
                    { entry: 3931649, name: 'Calum Smith', team: 'BootCutIsBack' },
                    { entry: 753357, name: 'Janek Metelski', team: 'Jan Utd' },
                    { entry: 2383752, name: 'Harrylujah .', team: 'Derry Rhumba!!!' },
                    { entry: 1282728, name: 'James Armstrong', team: 'Obi-Wan Cunha-bi' },
                    { entry: 323126, name: 'Tom Powell', team: 'Good Ebening' },
                    { entry: 5719661, name: 'Cammy Murrie', team: 'Beef Cherki' },
                    { entry: 4616973, name: 'Kyal Mapara', team: 'Gyok It Like Its Hot' },
                    { entry: 808774, name: 'craig macdonald', team: 'Half The World (A)' },
                    { entry: 119985, name: 'Kenny Jones', team: 'BrokenStonesXI' },
                    { entry: 1380538, name: 'Harry Strouts', team: 'Melbourne Blues' },
                    { entry: 7673766, name: 'Jasper Gray', team: 'Casemiro Royale' },
                    { entry: 810727, name: 'Mike Garty', team: 'FC Gartetaserey' },
                    { entry: 1405359, name: 'Barry Evans', team: 'Bueno Naughty' },
                    { entry: 4982573, name: 'Nadin Khoda', team: 'FC Nadz' },
                    { entry: 2783391, name: 'Marcus Black', team: 'shiit briik' },
                    { entry: 4448148, name: 'Fraser Doig', team: 'Hahahaland' },
                    { entry: 4616587, name: 'Grant Clark', team: 'FrimPingPong' },
                    { entry: 1412038, name: 'Simon Bell', team: 'BFC' },
                    { entry: 3215944, name: 'VÍCTOR MACÍAS LARI', team: 'Unreal Madrid' },
                    { entry: 1282268, name: 'Logan Garty', team: 'hay joonz terrors' },
                    { entry: 7636212, name: 'Charlie Hall', team: 'Haaland & Barrett' }
                ];

                // Simulate completed cup - 29 managers, 3 byes needed
                // Round of 32: 13 matches + 3 byes = 16 winners
                const round1 = {
                    name: 'Round of 32',
                    event: 34,
                    isLive: false,
                    isComplete: true,
                    matches: [
                        // 3 byes for top 3 seeds
                        { entry1: managers[0], entry2: null, score1: null, score2: null, winner: 1, isBye: true },
                        { entry1: managers[1], entry2: null, score1: null, score2: null, winner: 1, isBye: true },
                        { entry1: managers[2], entry2: null, score1: null, score2: null, winner: 1, isBye: true },
                        // 13 actual matches
                        { entry1: managers[3], entry2: managers[28], score1: 67, score2: 54, winner: 1 },
                        { entry1: managers[4], entry2: managers[27], score1: 72, score2: 71, winner: 1 },
                        { entry1: managers[5], entry2: managers[26], score1: 58, score2: 63, winner: 2 },
                        { entry1: managers[6], entry2: managers[25], score1: 81, score2: 45, winner: 1 },
                        { entry1: managers[7], entry2: managers[24], score1: 55, score2: 55, winner: 2, tiebreak: 'goals scored' },
                        { entry1: managers[8], entry2: managers[23], score1: 49, score2: 52, winner: 2 },
                        { entry1: managers[9], entry2: managers[22], score1: 77, score2: 66, winner: 1 },
                        { entry1: managers[10], entry2: managers[21], score1: 61, score2: 59, winner: 1 },
                        { entry1: managers[11], entry2: managers[20], score1: 44, score2: 88, winner: 2 },
                        { entry1: managers[12], entry2: managers[19], score1: 73, score2: 70, winner: 1 },
                        { entry1: managers[13], entry2: managers[18], score1: 56, score2: 62, winner: 2 },
                        { entry1: managers[14], entry2: managers[17], score1: 69, score2: 41, winner: 1 },
                        { entry1: managers[15], entry2: managers[16], score1: 50, score2: 53, winner: 2 }
                    ]
                };

                // Round of 16 winners from round 1
                const r16Players = [
                    managers[0], managers[1], managers[2], managers[3], // byes + Dean
                    managers[4], managers[26], managers[6], managers[24], // Ewan, Victor, Arran, Grant
                    managers[23], managers[9], managers[10], managers[20], // Fraser, Janek, Harrylujah, Barry
                    managers[12], managers[18], managers[14], managers[16] // Tom, Jasper, Kyal, Kenny
                ];

                const round2 = {
                    name: 'Round of 16',
                    event: 35,
                    isLive: false,
                    isComplete: true,
                    matches: [
                        { entry1: r16Players[0], entry2: r16Players[15], score1: 82, score2: 65, winner: 1 },
                        { entry1: r16Players[1], entry2: r16Players[14], score1: 71, score2: 74, winner: 2 },
                        { entry1: r16Players[2], entry2: r16Players[13], score1: 59, score2: 48, winner: 1 },
                        { entry1: r16Players[3], entry2: r16Players[12], score1: 66, score2: 66, winner: 1, tiebreak: 'goals scored' },
                        { entry1: r16Players[4], entry2: r16Players[11], score1: 77, score2: 81, winner: 2 },
                        { entry1: r16Players[5], entry2: r16Players[10], score1: 53, score2: 49, winner: 1 },
                        { entry1: r16Players[6], entry2: r16Players[9], score1: 68, score2: 72, winner: 2 },
                        { entry1: r16Players[7], entry2: r16Players[8], score1: 61, score2: 55, winner: 1 }
                    ]
                };

                // Quarter-final players
                const qfPlayers = [
                    managers[0], managers[14], managers[2], managers[3],
                    managers[20], managers[26], managers[9], managers[24]
                ];

                const round3 = {
                    name: 'Quarter-Finals',
                    event: 36,
                    isLive: false,
                    isComplete: true,
                    matches: [
                        { entry1: qfPlayers[0], entry2: qfPlayers[7], score1: 91, score2: 78, winner: 1 },
                        { entry1: qfPlayers[1], entry2: qfPlayers[6], score1: 64, score2: 69, winner: 2 },
                        { entry1: qfPlayers[2], entry2: qfPlayers[5], score1: 57, score2: 52, winner: 1 },
                        { entry1: qfPlayers[3], entry2: qfPlayers[4], score1: 73, score2: 85, winner: 2 }
                    ]
                };

                // Semi-final players
                const sfPlayers = [managers[0], managers[9], managers[2], managers[20]];

                const round4 = {
                    name: 'Semi-Finals',
                    event: 37,
                    isLive: false,
                    isComplete: true,
                    matches: [
                        { entry1: sfPlayers[0], entry2: sfPlayers[1], score1: 84, score2: 79, winner: 1 },
                        { entry1: sfPlayers[2], entry2: sfPlayers[3], score1: 62, score2: 71, winner: 2 }
                    ]
                };

                // Final
                const round5 = {
                    name: 'Final',
                    event: 38,
                    isLive: true, // Simulating live final
                    isComplete: false,
                    matches: [
                        { entry1: managers[0], entry2: managers[20], score1: 45, score2: 52, winner: null, liveScore1: 45, liveScore2: 52, bonusScore1: 3, bonusScore2: 0 }
                    ]
                };

                return {
                    cupStarted: true,
                    cupName: 'Si and chums Cup',
                    cupStartGW: CUP_START_GW,
                    qualificationGW: 33,
                    currentGW: 38, // Simulating GW38
                    totalManagers: 29,
                    hasByes: true,
                    byeCount: 3,
                    rounds: [round1, round2, round3, round4, round5]
                };
            }

            // Production code - real cup data
            if (currentGW < CUP_START_GW) {
                return {
                    cupStarted: false,
                    cupStartGW: CUP_START_GW,
                    message: `Cup will start in Gameweek ${CUP_START_GW}`
                };
            }

            return {
                cupStarted: true,
                cupStartGW: CUP_START_GW,
                currentGW: currentGW,
                rounds: []
            };
        },
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
        '/api/status': () => {
            return {
                apiAvailable: apiStatus.available,
                errorMessage: apiStatus.errorMessage,
                lastError: apiStatus.lastError,
                lastErrorTime: apiStatus.lastErrorTime,
                lastSuccessTime: apiStatus.lastSuccessTime,
                cacheAvailable: {
                    standings: !!dataCache.standings,
                    losers: !!dataCache.losers,
                    motm: !!dataCache.motm,
                    week: !!dataCache.week,
                    hallOfFame: !!dataCache.hallOfFame
                },
                lastRefresh: dataCache.lastRefresh,
                lastWeekRefresh: dataCache.lastWeekRefresh
            };
        },
        '/api/health': () => {
            // Lightweight health check endpoint for keep-alive pings and monitoring
            // Returns minimal data to keep response fast
            return {
                status: 'ok',
                timestamp: new Date().toISOString(),
                uptime: process.uptime()
            };
        },
    };

    // Check for manager picks route: /api/manager/:entryId/picks
    const managerPicksMatch = pathname.match(/^\/api\/manager\/(\d+)\/picks$/);
    if (managerPicksMatch) {
        try {
            const entryId = parseInt(managerPicksMatch[1]);
            if (isNaN(entryId)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid entry ID' }));
                return;
            }
            const gwParam = url.searchParams.get('gw');

            // If GW is provided, check cache FIRST (no network calls needed)
            if (gwParam) {
                const gwNum = parseInt(gwParam);
                if (isNaN(gwNum) || gwNum < 1 || gwNum > 38) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid gameweek parameter' }));
                    return;
                }
                const cacheKey = `${entryId}-${gwNum}`;
                if (dataCache.processedPicksCache[cacheKey]) {
                    serveJSON(res, dataCache.processedPicksCache[cacheKey]);
                    return;
                }
            }

            // Cache miss or no GW param - need to fetch
            const bootstrap = await fetchBootstrap();
            const currentGW = gwParam ? parseInt(gwParam) : bootstrap.events.find(e => e.is_current)?.id || 1;
            const cacheKey = `${entryId}-${currentGW}`;

            // Check cache again (for case where no GW param was provided)
            if (dataCache.processedPicksCache[cacheKey]) {
                serveJSON(res, dataCache.processedPicksCache[cacheKey]);
                return;
            }

            // Fetch and process (pass bootstrap to avoid duplicate fetch)
            const data = await fetchManagerPicksDetailed(entryId, currentGW, bootstrap);

            // Cache result for completed GWs
            const gwEvent = bootstrap.events.find(e => e.id === currentGW);
            if (gwEvent?.finished) {
                dataCache.processedPicksCache[cacheKey] = data;
            }

            serveJSON(res, data);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Check for manager profile route: /api/manager/:entryId/profile
    // Manager profile route - serve from pre-calculated cache
    const managerProfileMatch = pathname.match(/^\/api\/manager\/(\d+)\/profile$/);
    if (managerProfileMatch) {
        const entryId = parseInt(managerProfileMatch[1]);
        const profile = dataCache.managerProfiles?.[entryId];
        if (profile) {
            serveJSON(res, profile);
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Profile not found. Data may still be loading.' }));
        }
        return;
    }

    // Check for manager tinkering route: /api/manager/:entryId/tinkering
    const managerTinkeringMatch = pathname.match(/^\/api\/manager\/(\d+)\/tinkering$/);
    if (managerTinkeringMatch) {
        try {
            const entryId = parseInt(managerTinkeringMatch[1]);
            if (isNaN(entryId)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid entry ID' }));
                return;
            }
            const gwParam = url.searchParams.get('gw');

            // If GW is provided, check cache FIRST (no network calls needed)
            if (gwParam) {
                const gwNum = parseInt(gwParam);
                if (isNaN(gwNum) || gwNum < 1 || gwNum > 38) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid gameweek parameter' }));
                    return;
                }
                const cacheKey = `${entryId}-${gwNum}`;
                if (dataCache.tinkeringCache[cacheKey]) {
                    // Return cached data with updated navigation
                    const cached = { ...dataCache.tinkeringCache[cacheKey] };
                    serveJSON(res, cached);
                    return;
                }
            }

            // Cache miss - need to calculate
            const bootstrap = await fetchBootstrap();
            const currentGW = gwParam ? parseInt(gwParam) : bootstrap.events.find(e => e.is_current)?.id || 1;
            const data = await calculateTinkeringImpact(entryId, currentGW);
            serveJSON(res, data);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Fixture stats route: /api/fixture/:fixtureId/stats
    const fixtureStatsMatch = pathname.match(/^\/api\/fixture\/(\d+)\/stats$/);
    if (fixtureStatsMatch) {
        try {
            const fixtureId = parseInt(fixtureStatsMatch[1]);
            const data = await getFixtureStats(fixtureId);
            serveJSON(res, data);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Hall of Fame route - serve from pre-calculated cache
    if (pathname === '/api/hall-of-fame') {
        if (dataCache.hallOfFame) {
            serveJSON(res, dataCache.hallOfFame);
        } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Hall of Fame data still loading. Please refresh in a moment.' }));
        }
        return;
    }

    if (apiRoutes[pathname]) {
        try {
            const data = await apiRoutes[pathname]();
            // Add API status to response if API is down but we have cached data
            if (!apiStatus.available && data && !data.error) {
                data._apiStatus = {
                    cached: true,
                    message: apiStatus.errorMessage || 'FPL API temporarily unavailable',
                    lastRefresh: dataCache.lastRefresh
                };
            }
            serveJSON(res, data);
        } catch (error) {
            // Try to serve cached data as fallback
            const cacheMap = {
                '/api/standings': dataCache.standings,
                '/api/losers': dataCache.losers,
                '/api/motm': dataCache.motm,
                '/api/chips': dataCache.chips,
                '/api/earnings': dataCache.earnings,
                '/api/week': dataCache.week,
                '/api/league': dataCache.league,
                '/api/hall-of-fame': dataCache.hallOfFame,
                '/api/set-and-forget': dataCache.setAndForget
            };

            const cachedData = cacheMap[pathname];
            if (cachedData) {
                console.log(`[API] Serving cached data for ${pathname} due to error: ${error.message}`);
                const response = { ...cachedData };
                response._apiStatus = {
                    cached: true,
                    message: apiStatus.errorMessage || 'FPL API temporarily unavailable',
                    lastRefresh: dataCache.lastRefresh
                };
                serveJSON(res, response);
            } else {
                // Try to get next kickoff time for helpful error message
                let nextKickoffInfo = null;
                try {
                    // Use a simple fetch to get fixtures if possible
                    const fixturesRes = await fetch(`${FPL_API_BASE_URL}/fixtures/`, {
                        signal: AbortSignal.timeout(3000)
                    });
                    if (fixturesRes.ok) {
                        const fixtures = await fixturesRes.json();
                        const now = new Date();
                        const upcoming = fixtures
                            .filter(f => !f.finished && f.kickoff_time)
                            .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
                        if (upcoming.length > 0) {
                            const nextKickoff = new Date(upcoming[0].kickoff_time);
                            const availableTime = new Date(nextKickoff.getTime() - 15 * 60 * 1000); // 15 mins before
                            nextKickoffInfo = {
                                kickoff: upcoming[0].kickoff_time,
                                availableFrom: availableTime.toISOString()
                            };
                        }
                    }
                } catch (e) { /* ignore - just won't have kickoff info */ }

                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    error: 'Data temporarily unavailable',
                    message: apiStatus.errorMessage || error.message,
                    cached: false,
                    nextKickoff: nextKickoffInfo
                }));
            }
        }
    } else if (pathname === '/styles.css') {
        serveFile(res, 'styles.css', 'text/css');
    } else if (pathname === '/season-selector.js') {
        serveFile(res, 'season-selector.js', 'application/javascript');
    } else if (pathname === '/favicon.png') {
        serveFile(res, 'favicon.png', 'image/png');
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
    } else if (pathname === '/set-and-forget') {
        serveFile(res, 'set-and-forget.html');
    } else if (pathname === '/admin') {
        serveFile(res, 'admin.html');
    } else if (pathname === '/cup') {
        serveFile(res, 'cup.html');
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

    // Load visitor stats, archived seasons, and cached data from Redis
    await loadVisitorStats();
    await loadArchivedSeasons();
    await loadDataCache();

    // Start HTTP server FIRST so Render detects the port quickly
    server.listen(PORT, () => {
        console.log(`[Server] Running at http://localhost:${PORT}`);
        console.log('='.repeat(60));
    });

    // Schedule refreshes based on fixtures
    await scheduleRefreshes();

    // Initial data refresh to populate caches (only if not already loaded from Redis)
    if (!dataCache.hallOfFame || !dataCache.setAndForget) {
        console.log('[Startup] Running initial data refresh...');
        await refreshAllData('startup');
    }

    console.log('[Startup] Initialization complete');
}

startup();

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

function gracefulShutdown(signal) {
    console.log(`\n[Shutdown] Received ${signal}, shutting down gracefully...`);

    server.close(() => {
        console.log('[Shutdown] HTTP server closed');
        console.log('[Shutdown] Goodbye!');
        process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown fails
    setTimeout(() => {
        console.error('[Shutdown] Forced exit after timeout');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
