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
const { getFormationCounts, isValidFormation, getEffectiveFormationCounts } = require('./lib/formation');
const {
    formatTiedNames,
    updateRecordWithTies,
    updateRecordWithTiesLow,
    getMatchEndTime,
    groupFixturesIntoWindows,
    resolveEffectiveCaptaincy
} = require('./lib/utils');
const logger = require('./lib/logger');

// Intercept console immediately so all subsequent console.log/error/warn are captured
logger.interceptConsole();

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
    weekHistoryCache: {},     // Pre-built /api/week/history responses by GW number
    fixtureStatsCache: {},    // Cached fixture stats by fixtureId (finished fixtures only)
    formResultsCache: {},     // Cached form API results by weeks count: { data, ts }
    coinFlips: { motm: {}, losers: {} },  // Persisted coin flip values for deterministic tiebreakers
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

// Generate a signature string for a chronological event (used for deduplication)
function getEventSignature(event) {
    if (event.type === 'bonus_change') {
        const changeIds = (event.changes || []).map(c => c.elementId).sort().join(',');
        return `bonus_change_${event.fixtureId}_${changeIds}`;
    }
    if (event.type === 'team_clean_sheet' || event.type === 'team_goals_conceded') {
        return `${event.type}_${event.teamId}_${event.fixtureId}`;
    }
    // For player events (goal, assist, saves, etc.), include points to distinguish
    // multiple save-point events for the same player
    return `${event.type}_${event.elementId}_${event.fixtureId}_${event.points}`;
}

// Deduplicate new events against events that already exist in the chronological list.
// Handles repeated events correctly (e.g. multiple save-point events for same player)
// by comparing occurrence counts.
function deduplicateNewEvents(existingEvents, newEvents) {
    const existingCounts = {};
    existingEvents.forEach(e => {
        const sig = getEventSignature(e);
        existingCounts[sig] = (existingCounts[sig] || 0) + 1;
    });

    const deduped = [];
    const newCounts = {};
    newEvents.forEach(e => {
        const sig = getEventSignature(e);
        newCounts[sig] = (newCounts[sig] || 0) + 1;
        const existing = existingCounts[sig] || 0;
        // Only add if this occurrence exceeds what already exists
        if (newCounts[sig] > existing) {
            deduped.push(e);
        }
    });

    return deduped;
}

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
            weekHistoryCache: dataCache.weekHistoryCache,
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
            dataCache.weekHistoryCache = data.weekHistoryCache || {};
            dataCache.lastRefresh = data.lastRefresh || null;
            dataCache.lastWeekRefresh = data.lastWeekRefresh || null;
            dataCache.lastDataHash = data.lastDataHash || null;
            // Sanitize any stale manager/team names persisted before cleanDisplayName was added
            sanitizeCachedNames(dataCache);
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
// COIN FLIP PERSISTENCE - Ensures tiebreaker results never change once flipped
// =============================================================================

async function loadCoinFlips() {
    try {
        const data = await redisGet('coin-flips');
        if (data) {
            dataCache.coinFlips = {
                motm: data.motm || {},
                losers: data.losers || {}
            };
            console.log(`[CoinFlips] Loaded from Redis (MOTM periods: ${Object.keys(dataCache.coinFlips.motm).length}, Loser GWs: ${Object.keys(dataCache.coinFlips.losers).length})`);
        } else {
            console.log('[CoinFlips] No persisted coin flips in Redis');
        }
    } catch (error) {
        console.error('[CoinFlips] Error loading:', error.message);
    }
}

async function saveCoinFlips() {
    try {
        const success = await redisSet('coin-flips', dataCache.coinFlips);
        if (success) {
            console.log(`[CoinFlips] Saved to Redis`);
        }
    } catch (error) {
        console.error('[CoinFlips] Error saving:', error.message);
    }
}

/**
 * Get or create a persistent coin flip value for a manager in a given context.
 * Once a value is generated, it's stored and reused on every subsequent call.
 * @param {'motm'|'losers'} type - The tiebreaker context
 * @param {string|number} key - Period number (MOTM) or gameweek number (losers)
 * @param {string} managerName - The manager's name
 * @returns {number} A fixed random value between 0 and 1
 */
function getOrCreateCoinFlip(type, key, managerName) {
    const keyStr = String(key);
    if (!dataCache.coinFlips[type][keyStr]) {
        dataCache.coinFlips[type][keyStr] = {};
    }
    if (dataCache.coinFlips[type][keyStr][managerName] === undefined) {
        dataCache.coinFlips[type][keyStr][managerName] = Math.random();
    }
    return dataCache.coinFlips[type][keyStr][managerName];
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
                    archivedSeasons[season] = sanitizeCachedNames(data);
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

function cleanDisplayName(name) {
    if (!name) return name;
    return name
        .replace(/[\u2B50\u2605\u2606\u{1F31F}\u{1F320}\u{2728}\u{FE0F}]/gu, '') // Remove star/sparkle emoji
        .replace(/\s+\.(?=\s|$)/g, '') // Remove " ." before space or end (handles mid-string and trailing)
        .trim();
}

// Recursively sanitize all manager/team name fields in cached data (e.g. loaded from Redis)
function sanitizeCachedNames(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
        obj.forEach((item, i) => {
            if (typeof item === 'object' && item !== null) sanitizeCachedNames(item);
        });
        return obj;
    }
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' && ['name', 'team', 'player_name', 'entry_name'].includes(key)) {
            obj[key] = cleanDisplayName(value);
        } else if (key === 'names' && Array.isArray(value)) {
            obj[key] = value.map(n => typeof n === 'string' ? cleanDisplayName(n) : n);
        } else if (typeof value === 'object' && value !== null) {
            sanitizeCachedNames(value);
        }
    }
    return obj;
}

async function fetchLeagueData() {
    const data = await fetchWithTimeout(`${FPL_API_BASE_URL}/leagues-classic/${LEAGUE_ID}/standings/`);
    if (data?.standings?.results) {
        data.standings.results.forEach(m => {
            m.player_name = cleanDisplayName(m.player_name);
            m.entry_name = cleanDisplayName(m.entry_name);
        });
    }
    return data;
}

// Short-lived caches for expensive FPL API responses (avoids redundant calls
// when getFixtureStats is called while polling is already fetching the same data)
let apiBootstrapCache = { data: null, ts: 0 };
let apiFixturesCache = { data: null, ts: 0 };
let apiLiveGWCache = {}; // { gw: { data, ts } } - short-lived cache for live GW data
const API_CACHE_TTL = 30000; // 30 seconds

// Short-term cache + in-flight dedup for fixture stats (live fixtures)
let fixtureStatsTempCache = {}; // { fixtureId: { data, ts } }
let fixtureStatsInFlight = {}; // { fixtureId: Promise }

// Background refresh tracking (prevents duplicate concurrent refreshes)
let apiRefreshInFlight = { bootstrap: null, fixtures: null, liveGW: {} };

async function fetchBootstrap() {
    const now = Date.now();
    const fresh = apiBootstrapCache.data && (now - apiBootstrapCache.ts) < API_CACHE_TTL;
    if (fresh) return apiBootstrapCache.data;

    // Stale but have data → return stale immediately, refresh in background
    if (apiBootstrapCache.data) {
        if (!apiRefreshInFlight.bootstrap) {
            apiRefreshInFlight.bootstrap = fetchWithTimeout(`${FPL_API_BASE_URL}/bootstrap-static/`)
                .then(data => { apiBootstrapCache = { data, ts: Date.now() }; })
                .catch(() => {})
                .finally(() => { apiRefreshInFlight.bootstrap = null; });
        }
        return apiBootstrapCache.data;
    }

    // No cache at all → must wait for fetch
    const data = await fetchWithTimeout(`${FPL_API_BASE_URL}/bootstrap-static/`);
    apiBootstrapCache = { data, ts: Date.now() };
    return data;
}

// Force-fresh bootstrap fetch that bypasses the stale-return-with-background-refresh cache.
// Used for critical checks like bonus confirmation where stale data causes missed transitions.
async function fetchBootstrapFresh() {
    const data = await fetchWithTimeout(`${FPL_API_BASE_URL}/bootstrap-static/`);
    apiBootstrapCache = { data, ts: Date.now() };
    return data;
}

async function fetchManagerHistory(entryId) {
    return fetchWithTimeout(`${FPL_API_BASE_URL}/entry/${entryId}/history/`);
}

async function fetchFixtures() {
    const now = Date.now();
    const fresh = apiFixturesCache.data && (now - apiFixturesCache.ts) < API_CACHE_TTL;
    if (fresh) return apiFixturesCache.data;

    if (apiFixturesCache.data) {
        if (!apiRefreshInFlight.fixtures) {
            apiRefreshInFlight.fixtures = fetchWithTimeout(`${FPL_API_BASE_URL}/fixtures/`)
                .then(data => { apiFixturesCache = { data, ts: Date.now() }; })
                .catch(() => {})
                .finally(() => { apiRefreshInFlight.fixtures = null; });
        }
        return apiFixturesCache.data;
    }

    const data = await fetchWithTimeout(`${FPL_API_BASE_URL}/fixtures/`);
    apiFixturesCache = { data, ts: Date.now() };
    return data;
}

async function fetchLiveGWData(gw) {
    const now = Date.now();
    const cached = apiLiveGWCache[gw];
    const fresh = cached && (now - cached.ts) < API_CACHE_TTL;
    if (fresh) return cached.data;

    if (cached) {
        if (!apiRefreshInFlight.liveGW[gw]) {
            apiRefreshInFlight.liveGW[gw] = fetchWithTimeout(`${FPL_API_BASE_URL}/event/${gw}/live/`)
                .then(data => { apiLiveGWCache[gw] = { data, ts: Date.now() }; })
                .catch(() => {})
                .finally(() => { delete apiRefreshInFlight.liveGW[gw]; });
        }
        return cached.data;
    }

    const data = await fetchWithTimeout(`${FPL_API_BASE_URL}/event/${gw}/live/`);
    apiLiveGWCache[gw] = { data, ts: Date.now() };
    return data;
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

// Get completed gameweeks, including provisionally-completed ones.
// The FPL API only sets finished=true after official bonus confirmation (30 min to hours
// after matches end). But all other data (picks, live points, fixtures) is available as
// soon as finished_provisional is set. Without this, views like losers and H2H show a gap
// where the week view has already advanced but losers/H2H don't include the just-ended GW.
function getCompletedGameweeks(bootstrap, fixtures) {
    const completedGWs = bootstrap.events.filter(e => e.finished).map(e => e.id);

    // Also include the current GW if ALL its fixtures are finished provisionally
    const currentGW = bootstrap.events.find(e => e.is_current);
    if (currentGW && !currentGW.finished) {
        const gwFixtures = fixtures.filter(f => f.event === currentGW.id);
        if (gwFixtures.length > 0 && gwFixtures.every(f => f.finished_provisional)) {
            completedGWs.push(currentGW.id);
        }
    }

    return completedGWs;
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

    // Pre-calculate provisional bonus for the fixture (handles ties correctly)
    const provisionalBonusMap = {};
    if (fixture.stats) {
        const bpsStat = fixture.stats.find(s => s.identifier === 'bps');
        if (bpsStat) {
            const allBps = [...(bpsStat.h || []), ...(bpsStat.a || [])]
                .sort((a, b) => b.value - a.value);
            let currentRank = 1;
            let i = 0;
            while (i < allBps.length && currentRank <= 3) {
                const currentBps = allBps[i].value;
                const tiedPlayers = [];
                while (i < allBps.length && allBps[i].value === currentBps) {
                    tiedPlayers.push(allBps[i].element);
                    i++;
                }
                const bonusForRank = currentRank === 1 ? 3 : currentRank === 2 ? 2 : currentRank === 3 ? 1 : 0;
                if (bonusForRank > 0) {
                    tiedPlayers.forEach(elementId => { provisionalBonusMap[elementId] = bonusForRank; });
                }
                currentRank += tiedPlayers.length;
            }
        }
    }

    // Helper to get player stats from live data
    const getPlayerStats = (element) => {
        const liveEl = liveData.elements.find(e => e.id === element.id);
        if (!liveEl || !liveEl.stats) return null;

        const stats = liveEl.stats;
        // Only include players who played (minutes > 0)
        if (stats.minutes === 0) return null;

        // Get bonus: confirmed (already in total_points) or provisional (not yet)
        const officialBonus = stats.bonus || 0;
        const bonus = provisionalBonusMap[element.id] || 0;

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
            // Provisional bonus: show when match has started and bonus not yet confirmed in total_points
            provisionalBonus: (fixture.started && officialBonus === 0) ? bonus : 0,
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
        return (b.points + b.provisionalBonus) - (a.points + a.provisionalBonus);
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
        finished: fixture.finished,
        finishedProvisional: fixture.finished_provisional
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

        // Get fixture status - handle DGW (multiple fixtures per team)
        const teamFixtures = gwFixtures?.filter(f => f.team_h === element?.team || f.team_a === element?.team) || [];
        const fixtureStarted = teamFixtures.some(f => f.started);
        const fixtureFinished = teamFixtures.length > 0 && teamFixtures.every(f => f.finished_provisional || f.finished);
        const allFixturesStarted = teamFixtures.length > 0 && teamFixtures.every(f => f.started);

        // Get official bonus - if this is > 0, bonus is already included in total_points
        const officialBonus = liveElement?.stats?.bonus || 0;

        // Show provisional bonus when match has started AND official bonus not yet added
        // Covers both live matches and finished_provisional (FT but bonus not confirmed)
        const provisionalBonus = (fixtureStarted && officialBonus === 0)
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
            allFixturesStarted,
            provisionalBonus,
            subOut: false,
            subIn: false
        };
    });

    const starters = players.filter(p => !p.isBench);
    const bench = players.filter(p => p.isBench).sort((a, b) => a.benchOrder - b.benchOrder);

    // Only apply auto-subs if not using Bench Boost
    if (activeChip !== 'bboost') {
        // Step 1: GK auto-sub (processed separately, matches official FPL behaviour)
        const startingGK = starters.find(p => p.positionId === 1);
        const benchGK = bench.find(p => p.positionId === 1);

        if (startingGK && benchGK) {
            // In DGW, only trigger auto-sub when ALL fixtures have started
            const gkNeedsSub = startingGK.minutes === 0 &&
                startingGK.allFixturesStarted;
            const benchGKAvailable = !(benchGK.minutes === 0 &&
                benchGK.allFixturesStarted);

            if (gkNeedsSub && benchGKAvailable) {
                startingGK.subOut = true;
                benchGK.subIn = true;
            }
        }

        // Step 2: Outfield auto-subs (bench priority order, skipping GK bench slot)
        // In DGW, only trigger when ALL fixtures have started (player won't play in any remaining game)
        const outfieldNeedsSub = starters.filter(p =>
            p.positionId !== 1 && !p.subOut &&
            p.minutes === 0 && p.allFixturesStarted
        );
        const outfieldBench = bench.filter(p => p.positionId !== 1);

        for (const playerOut of outfieldNeedsSub) {
            for (const benchPlayer of outfieldBench) {
                if (benchPlayer.subIn) continue; // Already used
                if (benchPlayer.minutes === 0 && benchPlayer.allFixturesStarted) continue;

                // Use effective formation (includes already-subbed-in bench players)
                const testFormation = getEffectiveFormationCounts(players);

                // Adjust for proposed sub
                if (playerOut.positionId === 2) testFormation.DEF--;
                else if (playerOut.positionId === 3) testFormation.MID--;
                else if (playerOut.positionId === 4) testFormation.FWD--;

                if (benchPlayer.positionId === 2) testFormation.DEF++;
                else if (benchPlayer.positionId === 3) testFormation.MID++;
                else if (benchPlayer.positionId === 4) testFormation.FWD++;

                if (isValidFormation(testFormation)) {
                    playerOut.subOut = true;
                    benchPlayer.subIn = true;
                    break;
                }
            }
        }
    }

    // FPL API returns multiplier=0 for bench players. When a bench player is
    // auto-subbed in they should count as a regular starter (multiplier=1).
    players.forEach(p => {
        if (p.subIn && p.multiplier === 0) p.multiplier = 1;
    });

    // If captain was auto-subbed out, vice-captain inherits the multiplier
    resolveEffectiveCaptaincy(players);

    // Calculate total points with auto-subs, captaincy, and provisional bonus
    // Provisional bonus DOES get captain multiplier
    let totalPoints = 0;
    let benchPoints = 0;

    players.forEach(p => {
        const multiplier = p.multiplier;
        // Both base points and provisional bonus get the multiplier
        const effectivePoints = (p.points + p.provisionalBonus) * multiplier;

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += (p.points + p.provisionalBonus) * p.multiplier;
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

        // Get fixture status - handle DGW (multiple fixtures per team)
        const teamFixtures = gwFixtures?.filter(f => f.team_h === element?.team || f.team_a === element?.team) || [];
        const fixtureStarted = teamFixtures.some(f => f.started);
        const fixtureFinished = teamFixtures.length > 0 && teamFixtures.every(f => f.finished_provisional || f.finished);
        const allFixturesStarted = teamFixtures.length > 0 && teamFixtures.every(f => f.started);

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
            allFixturesStarted,
            subOut: false,
            subIn: false
        };
    });

    const starters = players.filter(p => !p.isBench);
    const bench = players.filter(p => p.isBench).sort((a, b) => a.benchOrder - b.benchOrder);

    // Step 1: GK auto-sub (processed separately, matches official FPL behaviour)
    const startingGK = starters.find(p => p.positionId === 1);
    const benchGK = bench.find(p => p.positionId === 1);

    if (startingGK && benchGK) {
        // In DGW, only trigger auto-sub when ALL fixtures have started
        const gkNeedsSub = startingGK.minutes === 0 &&
            startingGK.allFixturesStarted;
        const benchGKAvailable = !(benchGK.minutes === 0 &&
            benchGK.allFixturesStarted);

        if (gkNeedsSub && benchGKAvailable) {
            startingGK.subOut = true;
            benchGK.subIn = true;
        }
    }

    // Step 2: Outfield auto-subs (bench priority order, skipping GK bench slot)
    // In DGW, only trigger when ALL fixtures have started (player won't play in any remaining game)
    const outfieldNeedsSub = starters.filter(p =>
        p.positionId !== 1 && !p.subOut &&
        p.minutes === 0 && p.allFixturesStarted
    );
    const outfieldBench = bench.filter(p => p.positionId !== 1);

    for (const playerOut of outfieldNeedsSub) {
        for (const benchPlayer of outfieldBench) {
            if (benchPlayer.subIn) continue;
            if (benchPlayer.minutes === 0 && benchPlayer.allFixturesStarted) continue;

            // Use effective formation (includes already-subbed-in bench players)
            const testFormation = getEffectiveFormationCounts(players);

            // Adjust for proposed sub
            if (playerOut.positionId === 2) testFormation.DEF--;
            else if (playerOut.positionId === 3) testFormation.MID--;
            else if (playerOut.positionId === 4) testFormation.FWD--;

            if (benchPlayer.positionId === 2) testFormation.DEF++;
            else if (benchPlayer.positionId === 3) testFormation.MID++;
            else if (benchPlayer.positionId === 4) testFormation.FWD++;

            if (isValidFormation(testFormation)) {
                playerOut.subOut = true;
                benchPlayer.subIn = true;
                break;
            }
        }
    }

    // FPL API returns multiplier=0 for bench players. When a bench player is
    // auto-subbed in they should count as a regular starter (multiplier=1).
    players.forEach(p => {
        if (p.subIn && p.multiplier === 0) p.multiplier = 1;
    });

    // If captain was auto-subbed out, vice-captain inherits the multiplier
    resolveEffectiveCaptaincy(players);

    // Calculate total points with auto-subs and captaincy
    let totalPoints = 0;
    let benchPoints = 0;

    players.forEach(p => {
        const effectivePoints = p.points * p.multiplier;

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += p.points * p.multiplier;
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
            // After resolveEffectiveCaptaincy, multiplier is already correct for all players
            if ((!player.isBench && !player.subOut) || player.subIn) {
                return (player.points + (player.provisionalBonus || 0)) * player.multiplier;
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

        // Track captain-related flags for use in auto-sub effects computation
        let newCaptainIsTransfer = false;
        let oldCaptainIsTransfer = false;
        let newCaptainChangedPosition = false;
        let oldCaptainChangedPosition = false;

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
            newCaptainIsTransfer = !previousPlayerIds.has(newCaptain?.element);
            oldCaptainIsTransfer = !currentPlayerIds.has(oldCaptain?.element);

            // Check if captains changed lineup position (bench <-> starting)
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
                    lineupChanges.movedToStarting.push({ id: currentPick.element, name: playerName, points, impact });
                } else if (!wasOnBench && isOnBench) {
                    lineupChanges.movedToBench.push({ id: currentPick.element, name: playerName, points, impact });
                }
            }
        });

        // Calculate auto-sub cascade effects for kept players
        // When transfers and lineup changes alter the squad, auto-substitution patterns
        // can differ between the actual and hypothetical teams, affecting kept players
        // who didn't explicitly change position
        const autoSubEffects = [];
        const lineupChangedIds = new Set([
            ...(lineupChanges.movedToStarting || []).map(p => p.id),
            ...(lineupChanges.movedToBench || []).map(p => p.id)
        ]);

        currentPicks.picks.forEach((currentPick) => {
            const playerId = currentPick.element;

            // Skip transferred-in players (already in transfersIn section)
            if (!previousPlayerIds.has(playerId)) return;

            const previousPick = previousPicks.picks.find(p => p.element === playerId);
            if (!previousPick) return;

            // Skip players already in lineup changes section
            if (lineupChangedIds.has(playerId)) return;

            // Calculate this player's actual contribution difference
            const actualContrib = getPlayerContribution(playerId, actual.players);
            const hypotheticalContrib = getPlayerContribution(playerId, hypothetical.players);
            let diff = actualContrib - hypotheticalContrib;

            // Subtract what the captain change section already accounts for
            if (captainChange.changed) {
                if (playerId === newCaptain?.element && !newCaptainIsTransfer && !newCaptainChangedPosition) {
                    const newCaptainPts = liveData.elements.find(e => e.id === playerId)?.stats?.total_points || 0;
                    diff -= newCaptainPts; // Captain section already added +newCaptainPts
                }
                if (playerId === oldCaptain?.element && !oldCaptainIsTransfer && !oldCaptainChangedPosition) {
                    const oldCaptainPts = liveData.elements.find(e => e.id === playerId)?.stats?.total_points || 0;
                    diff += oldCaptainPts; // Captain section already subtracted -oldCaptainPts
                }
            }

            if (diff !== 0) {
                const element = bootstrap.elements.find(e => e.id === playerId);
                autoSubEffects.push({
                    name: element?.web_name || 'Unknown',
                    impact: diff
                });
            }
        });

        // Also check transferred-out players from hypothetical that might have
        // auto-sub effects not captured in transfersOut (shouldn't happen, but for safety)

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
            autoSubEffects,
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
    const [leagueData, bootstrap, fixtures] = await Promise.all([fetchLeagueData(), fetchBootstrap(), fetchFixtures()]);
    const completedGameweeks = getCompletedGameweeks(bootstrap, fixtures);
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
            // Tie - use transfers as tiebreaker (more transfers = loser), then coin flip
            tiedManagers.sort((a, b) => {
                if (a.transfers !== b.transfers) return b.transfers - a.transfers;
                // Persistent coin flip: higher value = loser (sorted to front)
                return getOrCreateCoinFlip('losers', gw, b.name) - getOrCreateCoinFlip('losers', gw, a.name);
            });
            loser = tiedManagers[0];

            if (tiedManagers[0].transfers > tiedManagers[1].transfers) {
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
            context
        });
    }

    // Build allGameweeks data for modal display
    const allGameweeks = {};
    for (const gw of completedGameweeks) {
        const overrideName = LOSER_OVERRIDES[gw];
        const managersData = await Promise.all(
            histories.map(async manager => {
                const gwData = manager.gameweeks.find(g => g.event === gw);
                const points = await getCalculatedPoints(manager.entry, gw);
                return {
                    entry: manager.entry,
                    name: manager.name,
                    team: manager.team,
                    points,
                    transfers: gwData?.event_transfers || 0
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
        const gwScores = periodData.map(g => g.points - g.event_transfers_cost).sort((a, b) => b - a);
        const highestGW = gwScores[0] || 0;
        const sortedAsc = [...gwScores].sort((a, b) => a - b);
        const lowestTwo = sortedAsc.slice(0, 2);

        return { name: manager.name, team: manager.team, netScore, grossScore, transfers, transferCost, highestGW, lowestTwo, coinFlip: getOrCreateCoinFlip('motm', periodNum, manager.name) };
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
    const [leagueData, bootstrap, fixtures] = await Promise.all([fetchLeagueData(), fetchBootstrap(), fetchFixtures()]);
    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
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

        // Fix: a live (unfinished) GW is included in gwsForCalc for ranking calculations,
        // but it should not cause the period to be marked as complete
        if (periods[p].isLive && result.periodComplete) {
            const trueCompleted = completedGWs.filter(gw => gw >= result.startGW && gw <= result.endGW);
            result.periodComplete = trueCompleted.length === (result.endGW - result.startGW + 1);
        }

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
    let currentGW = currentGWEvent?.id || 1;
    let gwNotFinished = currentGWEvent && !currentGWEvent.finished;

    // Detect if the current GW is fully done and we should advance to the next GW.
    // The FPL API keeps is_current on a finished GW until the next GW's deadline passes,
    // but once the deadline passes, picks become available and we should show the new GW.
    const now = new Date();
    const apiCurrentGW = currentGW;
    let currentGWFixturesCheck = fixtures.filter(f => f.event === currentGW);
    const isCurrentGWDone = currentGWEvent?.finished ||
        (currentGWFixturesCheck.length > 0 && currentGWFixturesCheck.every(f => f.finished_provisional));

    if (isCurrentGWDone) {
        const nextEvent = bootstrap.events.find(e => e.is_next) ||
                          bootstrap.events.find(e => e.id === currentGW + 1);
        if (nextEvent && new Date(nextEvent.deadline_time) <= now) {
            console.log(`[Week] GW${currentGW} is done and GW${nextEvent.id} deadline passed - advancing to GW${nextEvent.id}`);
            currentGW = nextEvent.id;
            gwNotFinished = !nextEvent.finished;
        }
    }

    // Always clear cached live data for current GW to ensure fresh player points
    // (bonus points, corrections, etc. may have been added since last cache)
    delete dataCache.liveDataCache[currentGW];

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

                // Calculate GW score - ALWAYS use fetchManagerPicksDetailed (same as pitch view)
                // This guarantees the weekly table score matches what's shown in the pitch view modal
                // IMPORTANT: Never trust processedPicksCache for the current GW - it may contain
                // stale data from before bonus was confirmed, or from previous code versions.
                // Always calculate fresh from live API data.
                let gwScore = picks.entry_history?.points || 0;
                let benchPoints = 0;
                const apiGWPoints = picks.entry_history?.points || 0;
                const apiTotalPoints = picks.entry_history?.total_points || 0;

                // Track effective captain and auto-sub info after resolution
                let effectiveCaptainId = null;
                let effectiveVCId = null;
                let detailedData = null;

                try {
                    const sharedData = { picks };
                    if (liveData) sharedData.liveData = liveData;
                    sharedData.fixtures = fixtures;

                    detailedData = await fetchManagerPicksDetailed(m.entry, currentGW, bootstrap, sharedData);
                    // Match pitch view: calculatedPoints + provisional bonus (bonus is 0 for finished GWs)
                    gwScore = detailedData.calculatedPoints + (detailedData.totalProvisionalBonus || 0);
                    benchPoints = detailedData.pointsOnBench || 0;
                    // Update cache so pitch view modal shows consistent data
                    dataCache.processedPicksCache[`${m.entry}-${currentGW}`] = detailedData;

                    // Get effective captain/VC after auto-sub captaincy resolution
                    const effCaptain = detailedData.players?.find(p => p.isCaptain);
                    const effVC = detailedData.players?.find(p => p.isViceCaptain);
                    effectiveCaptainId = effCaptain?.id || null;
                    effectiveVCId = effVC?.id || null;
                } catch (e) {
                    // Fallback to entry_history if calculation fails
                    gwScore = apiGWPoints;
                }

                // Calculate overall points: API total adjusted for calculated gwScore
                // This ensures live auto-sub/bonus calculations are reflected in overall
                const overallPoints = apiTotalPoints - apiGWPoints + gwScore;

                // Calculate players who haven't played yet
                // In DGWs a team can have multiple fixtures, so count remaining
                // (unstarted) fixtures per team rather than a simple started flag
                const teamRemainingFixtures = {};
                const teamActiveFixtures = {};
                currentGWFixtures.forEach(f => {
                    const increment = f.started ? 0 : 1;
                    teamRemainingFixtures[f.team_h] = (teamRemainingFixtures[f.team_h] || 0) + increment;
                    teamRemainingFixtures[f.team_a] = (teamRemainingFixtures[f.team_a] || 0) + increment;
                    // Count in-progress fixtures (started but not finished)
                    const active = (f.started && !f.finished_provisional && !f.finished) ? 1 : 0;
                    teamActiveFixtures[f.team_h] = (teamActiveFixtures[f.team_h] || 0) + active;
                    teamActiveFixtures[f.team_a] = (teamActiveFixtures[f.team_a] || 0) + active;
                });

                // Count players left
                // Each unstarted fixture counts as 1 per player (DGW = up to 2)
                // Captain multiplier: 2x (or 3x if Triple Captain chip is active)
                // Bench Boost means bench players (idx 11-14) also count
                // Use effective captain (may be VC if captain was auto-subbed out)
                // Account for auto-subs: exclude subbed-out starters, include subbed-in bench players
                const isBenchBoost = activeChip === 'bboost';
                const isTripleCaptain = activeChip === '3xc';
                let playersLeft = 0;
                let activePlayers = 0;

                // Build set of auto-subbed player IDs from detailedData
                const autoSubbedOutIds = new Set();
                const autoSubbedInIds = new Set();
                if (detailedData?.players) {
                    detailedData.players.forEach(p => {
                        if (p.subOut) autoSubbedOutIds.add(p.id);
                        if (p.subIn) autoSubbedInIds.add(p.id);
                    });
                }

                picks.picks.forEach((pick, idx) => {
                    const element = bootstrap.elements.find(e => e.id === pick.element);
                    if (element) {
                        const remaining = teamRemainingFixtures[element.team] || 0;
                        const activeCount = teamActiveFixtures[element.team] || 0;
                        // Effective squad: original starters minus subbed out, plus subbed in
                        const isOriginalStarter = idx < 11;
                        const wasSubbedOut = autoSubbedOutIds.has(pick.element);
                        const wasSubbedIn = autoSubbedInIds.has(pick.element);
                        const inSquad = isBenchBoost
                            || (isOriginalStarter && !wasSubbedOut)
                            || wasSubbedIn;
                        if (inSquad && remaining > 0) {
                            const isCaptain = effectiveCaptainId
                                ? (pick.element === effectiveCaptainId)
                                : pick.is_captain;
                            const multiplier = isCaptain ? (isTripleCaptain ? 3 : 2) : 1;
                            playersLeft += remaining * multiplier;
                        }
                        if (inSquad && activeCount > 0) {
                            activePlayers += activeCount;
                        }
                    }
                });

                // Free transfers (from previous GW)
                const freeTransfers = managerInfo.last_deadline_total_transfers !== undefined
                    ? Math.min(managerInfo.last_deadline_bank !== undefined ? 2 : 1, 2)
                    : 1;

                // Extract starting 11 player IDs and captain info for event impact
                // Use effective captain (VC inherits if captain auto-subbed out)
                const starting11 = picks.picks.slice(0, 11).map(p => p.element);
                const benchPlayerIds = picks.picks.slice(11).map(p => p.element);
                const captainId = effectiveCaptainId || picks.picks.find(p => p.is_captain)?.element || null;
                const viceCaptainId = effectiveVCId || picks.picks.find(p => p.is_vice_captain)?.element || null;
                const captainElement = captainId ? bootstrap.elements.find(e => e.id === captainId) : null;
                const captainName = captainElement?.web_name || null;
                const viceCaptainElement = viceCaptainId ? bootstrap.elements.find(e => e.id === viceCaptainId) : null;
                const viceCaptainName = viceCaptainElement?.web_name || null;

                // Build player->team map and defender IDs for team event impact
                // Include bench players when bench boost is active
                const playerTeamMap = {};
                const defenderIds = [];
                const squadSlice = activeChip === 'bboost' ? picks.picks : picks.picks.slice(0, 11);
                squadSlice.forEach(p => {
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
                    activePlayers,
                    teamValue,
                    bank,
                    benchPoints,
                    activeChip,
                    transfersMade: picks.entry_history?.event_transfers || 0,
                    transferCost: picks.entry_history?.event_transfers_cost || 0,
                    starting11,
                    benchPlayerIds,
                    captainId,
                    captainName,
                    viceCaptainId,
                    viceCaptainName,
                    playerTeamMap,
                    defenderIds,
                    autoSubsIn: (picks.automatic_subs || []).map(s => s.element_in),
                    autoSubsOut: (picks.automatic_subs || []).map(s => s.element_out)
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
                    playersLeft: 12,
                    activePlayers: 0,
                    teamValue: '100.0',
                    bank: '0.0',
                    benchPoints: 0,
                    activeChip: null,
                    transfersMade: 0,
                    starting11: [],
                    benchPlayerIds: [],
                    captainId: null,
                    captainName: null,
                    viceCaptainId: null,
                    viceCaptainName: null,
                    playerTeamMap: {},
                    defenderIds: [],
                    autoSubsIn: [],
                    autoSubsOut: []
                };
            }
        })
    );

    // Sort by GW score
    weekData.sort((a, b) => b.gwScore - a.gwScore);
    weekData.forEach((m, i) => m.gwRank = i + 1);

    // Build squad player map for highlight feature (all players across all squads)
    const squadPlayers = {};
    weekData.forEach(m => {
        [...(m.starting11 || []), ...(m.benchPlayerIds || [])].forEach(elementId => {
            if (!squadPlayers[elementId]) {
                const element = bootstrap.elements.find(e => e.id === elementId);
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

    // Build teams list for highlight feature
    const plTeams = bootstrap.teams.map(t => ({
        id: t.id,
        name: t.name,
        shortName: t.short_name
    })).sort((a, b) => a.name.localeCompare(b.name));

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

        // Deduplicate new events against existing chronological events.
        // This prevents duplicates when previousPlayerState loaded from Redis
        // is stale (e.g. after a server restart between polls).
        const dedupedEvents = deduplicateNewEvents(chronologicalEvents, newChronoEvents);

        // Append to chronological events and save
        if (dedupedEvents.length > 0) {
            chronologicalEvents.push(...dedupedEvents);
            // Limit array size to prevent unbounded growth
            if (chronologicalEvents.length > MAX_CHRONO_EVENTS) {
                chronologicalEvents = chronologicalEvents.slice(-MAX_CHRONO_EVENTS);
            }
            await saveChronologicalEvents(currentGW);
            console.log(`[ChronoEvents] Added ${dedupedEvents.length} new events (total: ${chronologicalEvents.length})${dedupedEvents.length < newChronoEvents.length ? ` [${newChronoEvents.length - dedupedEvents.length} duplicates filtered]` : ''}`);
        } else if (newChronoEvents.length > 0) {
            console.log(`[ChronoEvents] All ${newChronoEvents.length} detected events were duplicates, skipped`);
        }

        // Update previous state AFTER successful save (prevents data loss if save fails)
        previousPlayerState = currentPlayerState;
        previousBonusPositions = currentBonusHolders;
        // Save previous state to Redis alongside chrono events to prevent
        // stale state after restarts from causing duplicate event detection
        await savePreviousPlayerState(currentGW);
    }

    // Update state for next comparison
    liveEventState.bonusPositions = currentBonusPositions;
    liveEventState.cleanSheets = currentCleanSheets;
    liveEventState.defcons = currentDefcons;
    liveEventState.scores = currentScores;
    liveEventState.lastUpdate = timestamp;

    // Build next GW info when the displayed GW is fully done (all matches finished)
    // and there's an upcoming GW. This allows the client to show an "incoming" banner.
    let nextGWInfo = null;
    if (allMatchesFinished) {
        const nextEvent = bootstrap.events.find(e => e.is_next) ||
                          bootstrap.events.find(e => e.id === currentGW + 1);
        if (nextEvent) {
            const nextGWFixturesList = fixtures.filter(f => f.event === nextEvent.id);
            const nextGWSorted = nextGWFixturesList
                .filter(f => f.kickoff_time)
                .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
            const nextFirstKickoff = nextGWSorted[0]?.kickoff_time || null;

            if (nextFirstKickoff) {
                nextGWInfo = {
                    gameweek: nextEvent.id,
                    deadline: nextEvent.deadline_time,
                    firstKickoff: nextFirstKickoff
                };
            }
        }
    }

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
        nextKickoff,
        nextGWInfo,
        squadPlayers,
        plTeams
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

async function fetchManagerPicksDetailed(entryId, gw, bootstrapData = null, sharedData = null) {
    // Use provided bootstrap or fetch it (fetching in parallel with other data)
    // sharedData allows callers to pass pre-fetched picks/liveData/fixtures to avoid redundant API calls
    const [bootstrap, picks, liveData, fixtures] = await Promise.all([
        bootstrapData ? Promise.resolve(bootstrapData) : fetchBootstrap(),
        sharedData?.picks ? Promise.resolve(sharedData.picks) : fetchManagerPicksCached(entryId, gw, bootstrapData),
        sharedData?.liveData ? Promise.resolve(sharedData.liveData) : fetchLiveGWDataCached(gw, bootstrapData),
        sharedData?.fixtures ? Promise.resolve(sharedData.fixtures) : fetchFixtures()
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

    // Helper to get ALL fixture info for a team (supports DGW with multiple fixtures)
    function getAllFixtureInfo(playerTeamId) {
        const teamFixtures = gwFixtures.filter(f => f.team_h === playerTeamId || f.team_a === playerTeamId);
        if (teamFixtures.length === 0) return [];

        return teamFixtures.map(fixture => {
            const isHome = fixture.team_h === playerTeamId;
            const oppTeamId = isHome ? fixture.team_a : fixture.team_h;
            const oppTeam = bootstrap.teams.find(t => t.id === oppTeamId);

            return {
                oppTeamId,
                oppName: oppTeam?.short_name || 'UNK',
                isHome,
                fixtureStarted: fixture.started,
                fixtureFinished: fixture.finished_provisional || fixture.finished || false,
                kickoffTime: fixture.kickoff_time,
                fixture  // Include full fixture for BPS lookup
            };
        });
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

    // Pre-calculate provisional bonus for all started fixtures where official bonus isn't confirmed yet
    // This includes live matches AND finished_provisional matches (FT but bonus not in total_points)
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

        // Get fixture/opponent info (supports DGW with multiple fixtures)
        const allFixtures = getAllFixtureInfo(element?.team);
        const hasDoubleGameweek = allFixtures.length > 1;
        const anyFixtureStarted = allFixtures.some(f => f.fixtureStarted);
        const allFixturesFinished = allFixtures.length > 0 && allFixtures.every(f => f.fixtureFinished);
        const allFixturesStarted = allFixtures.length > 0 && allFixtures.every(f => f.fixtureStarted);
        const anyFixtureInProgress = allFixtures.some(f => f.fixtureStarted && !f.fixtureFinished);
        const minutes = liveElement?.stats?.minutes || 0;

        // For backward compat and display: pick the most relevant opponent
        // Priority: next unstarted fixture > in-progress fixture > first fixture
        const nextUpFixture = allFixtures.find(f => !f.fixtureStarted)
            || allFixtures.find(f => !f.fixtureFinished)
            || allFixtures[0];

        // Use aggregate flags: fixtureStarted = any started, fixtureFinished = ALL finished
        const fixtureStarted = anyFixtureStarted;
        const fixtureFinished = allFixturesFinished;

        // Determine play status across ALL fixtures
        let playStatus = 'not_started';
        if (anyFixtureStarted && minutes > 0) {
            if (anyFixtureInProgress) {
                playStatus = 'playing';       // match currently in progress
            } else if (allFixturesFinished) {
                playStatus = 'played';        // all done
            } else {
                playStatus = 'played';        // between DGW fixtures (won't be faded - see allFixturesFinished)
            }
        } else if (anyFixtureStarted && minutes === 0) {
            playStatus = allFixturesFinished ? 'benched' : 'not_played_yet';
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
        // Show provisional bonus when match has started AND official bonus hasn't been added yet
        // This covers both live matches and finished_provisional matches (FT but bonus not confirmed)
        // When officialBonus > 0, the bonus is already included in total_points
        const provisionalBonus = (fixtureStarted && officialBonus === 0)
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
            opponent: nextUpFixture?.oppName || null,
            isHome: nextUpFixture?.isHome,
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
            // DGW-specific fields
            hasDoubleGameweek,
            allFixturesFinished,
            allFixturesStarted,
            fixtureDetails: allFixtures.map(f => ({
                oppName: f.oppName,
                isHome: f.isHome,
                started: f.fixtureStarted,
                finished: f.fixtureFinished
            })),
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
        // Step 1: GK auto-sub (processed separately, matches official FPL behaviour)
        const startingGK = starters.find(p => p.positionId === 1);
        const benchGK = bench.find(p => p.positionId === 1);

        if (startingGK && benchGK) {
            // In DGW, only trigger auto-sub when ALL fixtures have started
            const gkNeedsSub = startingGK.minutes === 0 &&
                startingGK.allFixturesStarted;
            const benchGKAvailable = !(benchGK.minutes === 0 &&
                benchGK.allFixturesStarted);

            if (gkNeedsSub && benchGKAvailable) {
                autoSubs.push({
                    out: { id: startingGK.id, name: startingGK.name },
                    in: { id: benchGK.id, name: benchGK.name }
                });

                const pOut = adjustedPlayers.find(p => p.id === startingGK.id);
                const pIn = adjustedPlayers.find(p => p.id === benchGK.id);
                if (pOut) pOut.subOut = true;
                if (pIn) pIn.subIn = true;

                startingGK.subOut = true;
                benchGK.subIn = true;
            }
        }

        // Step 2: Outfield auto-subs (bench priority order, skipping GK bench slot)
        // In DGW, only trigger when ALL fixtures have started (player won't play in any remaining game)
        const outfieldNeedsSub = starters.filter(p =>
            p.positionId !== 1 && !p.subOut &&
            p.minutes === 0 && p.allFixturesStarted
        );
        const outfieldBench = bench.filter(p => p.positionId !== 1);

        for (const playerOut of outfieldNeedsSub) {
            for (const benchPlayer of outfieldBench) {
                if (benchPlayer.subIn) continue; // Already used
                if (benchPlayer.minutes === 0 && benchPlayer.allFixturesStarted) continue;

                // Use effective formation (includes already-subbed-in bench players)
                const testFormation = getEffectiveFormationCounts(players);

                // Adjust for proposed sub
                if (playerOut.positionId === 2) testFormation.DEF--;
                else if (playerOut.positionId === 3) testFormation.MID--;
                else if (playerOut.positionId === 4) testFormation.FWD--;

                if (benchPlayer.positionId === 2) testFormation.DEF++;
                else if (benchPlayer.positionId === 3) testFormation.MID++;
                else if (benchPlayer.positionId === 4) testFormation.FWD++;

                if (isValidFormation(testFormation)) {
                    autoSubs.push({
                        out: { id: playerOut.id, name: playerOut.name },
                        in: { id: benchPlayer.id, name: benchPlayer.name }
                    });

                    const pOut = adjustedPlayers.find(p => p.id === playerOut.id);
                    const pIn = adjustedPlayers.find(p => p.id === benchPlayer.id);
                    if (pOut) pOut.subOut = true;
                    if (pIn) pIn.subIn = true;

                    benchPlayer.subIn = true;
                    break;
                }
            }
        }
    }

    // FPL API returns multiplier=0 for bench players. When a bench player is
    // auto-subbed in they should count as a regular starter (multiplier=1).
    adjustedPlayers.forEach(p => {
        if (p.subIn && p.multiplier === 0) p.multiplier = 1;
    });

    // If captain was auto-subbed out, vice-captain inherits the multiplier
    resolveEffectiveCaptaincy(adjustedPlayers);

    // Calculate actual points with auto-subs and captaincy
    let totalPoints = 0;
    let benchPoints = 0;
    let benchProvisionalBonus = 0;

    adjustedPlayers.forEach(p => {
        // Use actual multiplier from picks (3 for TC, 2 for normal captain, 1 for others)
        // After resolveEffectiveCaptaincy, the VC who inherited captaincy has the correct multiplier
        const effectivePoints = p.points * p.multiplier;

        if (!p.isBench && !p.subOut) {
            totalPoints += effectivePoints;
        } else if (p.subIn) {
            totalPoints += p.points * p.multiplier;
        } else if (p.isBench && !p.subIn) {
            benchPoints += p.points;
            benchProvisionalBonus += (p.provisionalBonus || 0);
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
    // After resolveEffectiveCaptaincy, multiplier is already correct for all players
    let basePoints = 0;
    let totalProvisionalBonus = 0;
    effectiveStarters.forEach(p => {
        basePoints += (p.points || 0) * p.multiplier;
        totalProvisionalBonus += (p.provisionalBonus || 0) * p.multiplier;
    });

    // When Bench Boost is active, bench provisional bonus also counts towards total
    if (picks.active_chip === 'bboost') {
        totalProvisionalBonus += benchProvisionalBonus;
    }

    return {
        entryId,
        gameweek: gw,
        points: picks.entry_history?.points || 0,
        calculatedPoints: totalPoints,
        basePoints,
        totalProvisionalBonus,
        pointsOnBench: benchPoints + benchProvisionalBonus,
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

// =============================================================================
// HEAD-TO-HEAD COMPARISON
// =============================================================================
async function fetchH2HComparison(entryId1, entryId2) {
    const [bootstrap, fixtures, history1, history2] = await Promise.all([
        fetchBootstrap(),
        fetchFixtures(),
        fetchManagerHistory(entryId1),
        fetchManagerHistory(entryId2)
    ]);

    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
    const currentGW = bootstrap.events.find(e => e.is_current)?.id || 0;

    // Get manager profiles for names, rank history
    const profile1 = dataCache.managerProfiles[entryId1];
    const profile2 = dataCache.managerProfiles[entryId2];

    if (!profile1 || !profile2) {
        return { error: 'One or both manager profiles not found. Data may still be loading.' };
    }

    // GW-by-GW comparison
    const gwComparison = [];
    let m1Wins = 0, m2Wins = 0, draws = 0;
    let m1Cumulative = 0, m2Cumulative = 0;

    for (const gw of completedGWs) {
        const gw1 = history1.current.find(h => h.event === gw);
        const gw2 = history2.current.find(h => h.event === gw);

        if (!gw1 || !gw2) continue;

        const pts1 = gw1.points;
        const pts2 = gw2.points;
        m1Cumulative += pts1;
        m2Cumulative += pts2;

        if (pts1 > pts2) m1Wins++;
        else if (pts2 > pts1) m2Wins++;
        else draws++;

        gwComparison.push({
            gw,
            m1Points: pts1,
            m2Points: pts2,
            m1Cumulative,
            m2Cumulative
        });
    }

    // Captain comparison - fetch picks for each completed GW (uses cache)
    const captainData = [];
    let m1CaptainTotal = 0, m2CaptainTotal = 0;
    let sameCaptainCount = 0;

    for (const gw of completedGWs) {
        try {
            const [picks1, picks2, liveData] = await Promise.all([
                fetchManagerPicksCached(entryId1, gw, bootstrap),
                fetchManagerPicksCached(entryId2, gw, bootstrap),
                fetchLiveGWDataCached(gw, bootstrap)
            ]);

            const captain1 = picks1.picks?.find(p => p.is_captain);
            const captain2 = picks2.picks?.find(p => p.is_captain);

            if (captain1 && captain2 && liveData) {
                const c1Base = liveData.elements?.find(e => e.id === captain1.element)?.stats?.total_points || 0;
                const c2Base = liveData.elements?.find(e => e.id === captain2.element)?.stats?.total_points || 0;

                const c1Multiplied = c1Base * (captain1.multiplier || 2);
                const c2Multiplied = c2Base * (captain2.multiplier || 2);

                m1CaptainTotal += c1Multiplied;
                m2CaptainTotal += c2Multiplied;

                if (captain1.element === captain2.element) sameCaptainCount++;

                const c1Name = bootstrap.elements?.find(e => e.id === captain1.element)?.web_name || 'Unknown';
                const c2Name = bootstrap.elements?.find(e => e.id === captain2.element)?.web_name || 'Unknown';

                captainData.push({
                    gw,
                    m1: { name: c1Name, points: c1Multiplied, chip: picks1.active_chip || null },
                    m2: { name: c2Name, points: c2Multiplied, chip: picks2.active_chip || null },
                    same: captain1.element === captain2.element
                });
            }
        } catch (e) {
            // Skip GWs where picks couldn't be fetched
        }
    }

    // Transfer comparison
    const m1Transfers = history1.current.reduce((sum, gw) => sum + gw.event_transfers, 0);
    const m2Transfers = history2.current.reduce((sum, gw) => sum + gw.event_transfers, 0);
    const m1TransferCost = history1.current.reduce((sum, gw) => sum + gw.event_transfers_cost, 0);
    const m2TransferCost = history2.current.reduce((sum, gw) => sum + gw.event_transfers_cost, 0);

    // Chip comparison - compute per-half status matching chips page format
    function buildChipStatus(usedChips) {
        const CHIP_TYPES = ['wildcard', 'freehit', 'bboost', '3xc'];
        const chipStatus = { firstHalf: {}, secondHalf: {} };
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
        return chipStatus;
    }
    const m1Chips = buildChipStatus(history1.chips || []);
    const m2Chips = buildChipStatus(history2.chips || []);

    // Form (last 5 GW average)
    const last5GWs = completedGWs.slice(-5);
    const m1Form = last5GWs.map(gw => history1.current.find(h => h.event === gw)?.points || 0);
    const m2Form = last5GWs.map(gw => history2.current.find(h => h.event === gw)?.points || 0);
    const m1FormAvg = m1Form.length > 0 ? Math.round(m1Form.reduce((s, p) => s + p, 0) / m1Form.length * 10) / 10 : 0;
    const m2FormAvg = m2Form.length > 0 ? Math.round(m2Form.reduce((s, p) => s + p, 0) / m2Form.length * 10) / 10 : 0;

    // Totals and bench points
    const m1Total = history1.current[history1.current.length - 1]?.total_points || 0;
    const m2Total = history2.current[history2.current.length - 1]?.total_points || 0;
    const m1BenchTotal = history1.current.reduce((sum, gw) => sum + (gw.points_on_bench || 0), 0);
    const m2BenchTotal = history2.current.reduce((sum, gw) => sum + (gw.points_on_bench || 0), 0);

    // Best/worst GW
    const m1Best = history1.current.reduce((best, gw) => gw.points > best.points ? { points: gw.points, gw: gw.event } : best, { points: 0, gw: 0 });
    const m2Best = history2.current.reduce((best, gw) => gw.points > best.points ? { points: gw.points, gw: gw.event } : best, { points: 0, gw: 0 });
    const m1Worst = history1.current.reduce((worst, gw) => gw.points < worst.points ? { points: gw.points, gw: gw.event } : worst, { points: Infinity, gw: 0 });
    const m2Worst = history2.current.reduce((worst, gw) => gw.points < worst.points ? { points: gw.points, gw: gw.event } : worst, { points: Infinity, gw: 0 });
    if (m1Worst.points === Infinity) m1Worst.points = 0;
    if (m2Worst.points === Infinity) m2Worst.points = 0;

    return {
        manager1: { entryId: entryId1, name: profile1.name, team: profile1.team },
        manager2: { entryId: entryId2, name: profile2.name, team: profile2.team },
        currentGW,
        headToHead: { m1Wins, m2Wins, draws },
        gwComparison,
        captains: {
            data: captainData,
            m1Total: m1CaptainTotal,
            m2Total: m2CaptainTotal,
            sameCaptainCount,
            totalGWs: captainData.length
        },
        transfers: {
            m1: { total: m1Transfers, cost: m1TransferCost },
            m2: { total: m2Transfers, cost: m2TransferCost }
        },
        chips: { m1: m1Chips, m2: m2Chips },
        form: {
            m1: { avg: m1FormAvg, scores: m1Form, gws: last5GWs },
            m2: { avg: m2FormAvg, scores: m2Form, gws: last5GWs }
        },
        totals: { m1: m1Total, m2: m2Total },
        benchPoints: { m1: m1BenchTotal, m2: m2BenchTotal },
        bestGW: { m1: m1Best, m2: m2Best },
        worstGW: { m1: m1Worst, m2: m2Worst },
        rankHistory: {
            m1: profile1.history || [],
            m2: profile2.history || []
        }
    };
}

// =============================================================================
// SEASON ANALYTICS (computed on demand from cached data)
// =============================================================================
async function calculateSeasonAnalytics() {
    if (!dataCache.standings?.standings) {
        return { error: 'Data still loading. Please refresh in a moment.' };
    }

    const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
    const currentGW = bootstrap.events.find(e => e.is_current)?.id || 0;

    if (completedGWs.length === 0) {
        return { error: 'No completed gameweeks yet.' };
    }

    const managerList = dataCache.standings.standings;

    // Fetch all manager histories in parallel
    const histories = await Promise.all(
        managerList.map(m => fetchManagerHistory(m.entryId))
    );

    // Step 1: Calculate league average per GW
    const leagueAvgByGW = {};
    for (const gw of completedGWs) {
        let total = 0, count = 0;
        histories.forEach(h => {
            const gwData = h.current.find(g => g.event === gw);
            if (gwData) { total += gwData.points; count++; }
        });
        leagueAvgByGW[gw] = count > 0 ? total / count : 0;
    }

    // Step 2: Build analytics per manager
    const analyticsManagers = [];

    for (let i = 0; i < managerList.length; i++) {
        const manager = managerList[i];
        const history = histories[i];
        const entryId = manager.entryId;

        if (!history?.current || history.current.length === 0) continue;

        const totalPoints = manager.totalPoints ||
            history.current[history.current.length - 1]?.total_points || 0;

        // --- Tinkering Impact (Transfer ROI) ---
        let totalTinkeringImpact = 0;
        let bestTinkering = null;
        let worstTinkering = null;
        let tinkeringGWCount = 0;

        for (const gw of completedGWs) {
            if (gw < 2) continue;
            const cacheKey = `${entryId}-${gw}`;
            const tinkering = dataCache.tinkeringCache[cacheKey];
            if (tinkering?.available && typeof tinkering.netImpact === 'number') {
                totalTinkeringImpact += tinkering.netImpact;
                tinkeringGWCount++;
                if (!bestTinkering || tinkering.netImpact > bestTinkering.impact) {
                    bestTinkering = { gw, impact: tinkering.netImpact };
                }
                if (!worstTinkering || tinkering.netImpact < worstTinkering.impact) {
                    worstTinkering = { gw, impact: tinkering.netImpact };
                }
            }
        }

        // --- Captain Points ---
        let totalCaptainPoints = 0;
        let captainBlanks = 0;
        let captainGWs = 0;

        for (const gw of completedGWs) {
            const cacheKey = `${entryId}-${gw}`;
            const picks = dataCache.picksCache[cacheKey];
            const liveData = dataCache.liveDataCache[gw];

            if (picks?.picks && liveData?.elements) {
                const captain = picks.picks.find(p => p.is_captain);
                if (captain) {
                    const basePoints = liveData.elements.find(
                        e => e.id === captain.element
                    )?.stats?.total_points || 0;
                    const multiplied = basePoints * (captain.multiplier || 2);
                    totalCaptainPoints += multiplied;
                    captainGWs++;
                    if (basePoints <= 2) captainBlanks++;
                }
            }
        }

        // --- Bench Points Wasted ---
        let totalBenchPoints = 0;
        history.current.forEach(gw => {
            const usedBB = history.chips?.some(
                c => c.name === 'bboost' && c.event === gw.event
            );
            if (!usedBB) {
                totalBenchPoints += gw.points_on_bench || 0;
            }
        });

        // --- Consistency (Standard Deviation) ---
        const scores = history.current.map(g => g.points);
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        const variance = scores.reduce(
            (sum, val) => sum + Math.pow(val - avgScore, 2), 0
        ) / scores.length;
        const stdDev = Math.sqrt(variance);

        // --- Form Streaks (vs league average) ---
        let longestAboveAvg = 0, currentAboveAvg = 0;
        let longestBelowAvg = 0, currentBelowAvg = 0;
        let aboveAvgCount = 0;
        let currentStreak = { type: 'none', length: 0 };

        for (const gw of completedGWs) {
            const gwData = history.current.find(g => g.event === gw);
            if (!gwData) continue;

            if (gwData.points >= leagueAvgByGW[gw]) {
                aboveAvgCount++;
                currentAboveAvg++;
                currentBelowAvg = 0;
                if (currentAboveAvg > longestAboveAvg) longestAboveAvg = currentAboveAvg;
                currentStreak = { type: 'above', length: currentAboveAvg };
            } else {
                currentBelowAvg++;
                currentAboveAvg = 0;
                if (currentBelowAvg > longestBelowAvg) longestBelowAvg = currentBelowAvg;
                currentStreak = { type: 'below', length: currentBelowAvg };
            }
        }

        // --- Transfer Stats ---
        const totalTransfers = history.current.reduce(
            (sum, gw) => sum + (gw.event_transfers || 0), 0
        );
        const totalHitCost = history.current.reduce(
            (sum, gw) => sum + (gw.event_transfers_cost || 0), 0
        );

        analyticsManagers.push({
            entryId,
            name: manager.name,
            team: manager.team,
            rank: manager.rank,
            totalPoints,
            avgScore: Math.round(avgScore * 10) / 10,
            tinkering: {
                netImpact: totalTinkeringImpact,
                bestGW: bestTinkering,
                worstGW: worstTinkering,
                gwCount: tinkeringGWCount
            },
            captain: {
                totalPoints: totalCaptainPoints,
                blanks: captainBlanks,
                gwCount: captainGWs,
                avgPoints: captainGWs > 0
                    ? Math.round(totalCaptainPoints / captainGWs * 10) / 10
                    : 0
            },
            benchPoints: {
                total: totalBenchPoints,
                perGW: completedGWs.length > 0
                    ? Math.round(totalBenchPoints / completedGWs.length * 10) / 10
                    : 0
            },
            consistency: {
                stdDev: Math.round(stdDev * 10) / 10
            },
            streaks: {
                longestAboveAvg,
                longestBelowAvg,
                currentStreak,
                aboveAvgCount,
                totalGWs: completedGWs.length
            },
            transfers: {
                total: totalTransfers,
                hitCost: totalHitCost
            }
        });
    }

    // Sort by league rank
    analyticsManagers.sort((a, b) => a.rank - b.rank);

    return {
        currentGW,
        completedGWs: completedGWs.length,
        managers: analyticsManagers
    };
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
        const [bootstrap, leagueData, fixtures] = await Promise.all([fetchBootstrap(), fetchLeagueData(), fetchFixtures()]);
        const managers = leagueData.standings.results;
        const completedGWs = getCompletedGameweeks(bootstrap, fixtures);

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
    const [leagueData, bootstrap, fixtures] = await Promise.all([fetchLeagueData(), fetchBootstrap(), fetchFixtures()]);
    const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
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
        const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
        const completedGWs = getCompletedGameweeks(bootstrap, fixtures);

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
// WEEK HISTORY CACHE BUILDER (runs after picks pre-calculation)
// =============================================================================
// Builds fully-assembled /api/week/history responses for all completed GWs.
// This means the endpoint returns a simple cache lookup — no per-request
// iteration, no bootstrap calls, no API fallbacks.
function buildWeekHistoryCache(managers, bootstrap, completedGWs, leagueName) {
    console.log('[WeekHistory] Building pre-calculated history cache...');
    const startTime = Date.now();
    let built = 0;

    // Build plTeams once (same for every GW within a season)
    const plTeams = bootstrap.teams.map(t => ({
        id: t.id, name: t.name, shortName: t.short_name
    })).sort((a, b) => a.name.localeCompare(b.name));

    // Index elements by id for fast lookup
    const elementsById = {};
    bootstrap.elements.forEach(e => { elementsById[e.id] = e; });

    for (const gw of completedGWs) {
        const weekManagers = [];
        let allCached = true;

        for (const m of managers) {
            const cacheKey = `${m.entry}-${gw}`;
            const cached = dataCache.processedPicksCache[cacheKey];

            if (!cached) {
                allCached = false;
                break;
            }

            const gwScore = (cached.calculatedPoints || 0) + (cached.totalProvisionalBonus || 0);
            const captain = cached.players?.find(p => p.isCaptain);
            const viceCaptain = cached.players?.find(p => p.isViceCaptain);
            const starting11 = (cached.players || []).filter(p => !p.isBench).map(p => p.id);
            const benchPlayerIds = (cached.players || []).filter(p => p.isBench).map(p => p.id);

            weekManagers.push({
                name: m.player_name,
                team: m.entry_name,
                entryId: m.entry,
                gwScore,
                benchPoints: cached.pointsOnBench || 0,
                activeChip: cached.activeChip || null,
                captainName: captain?.name || null,
                viceCaptainName: viceCaptain?.name || null,
                starting11,
                benchPlayerIds,
                transferCost: cached.transfersCost || 0,
                autoSubsIn: (cached.autoSubs || []).map(s => s.in?.id).filter(Boolean),
                autoSubsOut: (cached.autoSubs || []).map(s => s.out?.id).filter(Boolean)
            });
        }

        // Only cache GWs where every manager had processed data
        if (!allCached) continue;

        // Sort by score and assign ranks
        weekManagers.sort((a, b) => b.gwScore - a.gwScore);
        weekManagers.forEach((m, i) => m.gwRank = i + 1);

        // Build squad players map for highlight feature
        const squadPlayers = {};
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
            plTeams
        };
        built++;
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[WeekHistory] Built ${built}/${completedGWs.length} GW history caches in ${duration}s`);
}

// =============================================================================
// TINKERING DATA PRE-CALCULATION (runs during daily refresh)
// =============================================================================
async function preCalculateTinkeringData(managers) {
    console.log('[Tinkering] Pre-calculating tinkering data for all managers...');
    const startTime = Date.now();

    try {
        const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
        const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
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
        // Fetch fresh bootstrap data BEFORE any calculations.
        // fetchBootstrap() uses stale-while-revalidate (returns old data, refreshes in background).
        // If we don't force a fresh fetch here, parallel functions below may use stale data
        // and miss gameweek completions (e.g., GW marked as finished won't be detected).
        if (!isLivePoll) {
            await fetchBootstrapFresh();
        }
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

            // Get completed gameweeks (include provisionally completed GWs)
            const [bootstrap, fixturesForGW] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
            const completedGWs = getCompletedGameweeks(bootstrap, fixturesForGW);

            // Pre-cache picks and live data FIRST so histories can use cached calculated points
            // Only run during startup/daily/morning refreshes, NOT during live polling
            const shouldPreCache = ['startup', 'morning-after-gameweek', 'daily-check', 'admin-rebuild-historical', 'gameweek-confirmed'].includes(reason);
            if (shouldPreCache) {
                await preCalculatePicksData(managers);
                await preCalculateTinkeringData(managers);
                // Build fully-assembled week history responses from processedPicksCache
                buildWeekHistoryCache(managers, bootstrap, completedGWs, league.league.name);
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
        await saveCoinFlips();

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
        const currentGWFixtures = fixtures.filter(f => f.event === currentGW);
        const currentGWEvent = bootstrap.events.find(e => e.id === currentGW);

        // Detect if current GW is fully done (finished or all matches provisionally done)
        const currentGWDone = currentGWEvent?.finished ||
            (currentGWFixtures.length > 0 && currentGWFixtures.every(f => f.finished_provisional));

        // When current GW is done, look ahead to the next GW for scheduling and display
        let nextGW = null;
        let nextGWFixtures = [];
        let nextGWEvent = null;
        if (currentGWDone) {
            nextGWEvent = bootstrap.events.find(e => e.is_next) ||
                          bootstrap.events.find(e => e.id === currentGW + 1);
            if (nextGWEvent) {
                nextGW = nextGWEvent.id;
                nextGWFixtures = fixtures.filter(f => f.event === nextGW);
            }
        }

        fixturesCache = {
            all: fixtures,
            currentGW,
            currentGWFixtures,
            currentGWDone,
            nextGW,
            nextGWFixtures,
            nextGWEvent,
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

    // Cancel any pending bonus confirmation checks (new matches starting)
    if (bonusConfirmationTimeout) {
        clearTimeout(bonusConfirmationTimeout);
        bonusConfirmationTimeout = null;
        bonusConfirmationGW = null;
    }

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

    // Start checking for official bonus confirmation (GW finished)
    // FPL confirms bonus shortly after all matches end - poll until confirmed
    // Pass the specific GW ID so we track it even after is_current moves to next GW
    const gwToConfirm = liveEventState.lastGW;
    if (gwToConfirm) {
        scheduleBonusConfirmationCheck(gwToConfirm);
    }
}

// Poll for official GW completion (bonus confirmation) after all matches finish
// Checks every 2-5 mins for up to 12 hours until the specific GW's finished flag becomes true
// When confirmed, triggers full data refresh (profiles, hall of fame, earnings, etc.)
// IMPORTANT: We track the specific GW ID rather than relying on is_current, because
// when FPL confirms a GW as finished, is_current moves to the NEXT GW simultaneously.
let bonusConfirmationTimeout = null;
let bonusConfirmationGW = null;
function scheduleBonusConfirmationCheck(gwId) {
    if (bonusConfirmationTimeout) {
        clearTimeout(bonusConfirmationTimeout);
        bonusConfirmationTimeout = null;
    }

    bonusConfirmationGW = gwId;
    const startTime = Date.now();
    const maxDuration = 12 * 60 * 60 * 1000; // 12 hours max
    let checkCount = 0;

    async function checkBonusConfirmed() {
        try {
            const elapsed = Date.now() - startTime;
            if (elapsed > maxDuration) {
                console.log(`[Bonus] Max wait time reached (12 hours) for GW${gwId}, running fallback full refresh`);
                // Run a full refresh anyway - the GW is very likely finished by now
                const refreshResult = await refreshAllData('gameweek-confirmed');
                if (!refreshResult.success) {
                    console.error(`[Bonus] GW${gwId} fallback refresh failed: ${refreshResult.error}`);
                }
                await refreshWeekData();
                bonusConfirmationTimeout = null;
                bonusConfirmationGW = null;
                setTimeout(scheduleRefreshes, 60000);
                return;
            }

            checkCount++;
            // Bypass bootstrap cache to get fresh data for this critical check
            const bootstrap = await fetchBootstrapFresh();
            const gwEvent = bootstrap?.events?.find(e => e.id === gwId);

            if (gwEvent?.finished) {
                console.log(`[Bonus] GW${gwId} officially finished - bonus confirmed, running full data refresh`);
                const refreshResult = await refreshAllData('gameweek-confirmed');
                if (!refreshResult.success) {
                    console.error(`[Bonus] GW${gwId} refresh failed: ${refreshResult.error} - will retry`);
                    bonusConfirmationTimeout = setTimeout(checkBonusConfirmed, 2 * 60 * 1000);
                    return;
                }
                await refreshWeekData();
                bonusConfirmationTimeout = null;
                bonusConfirmationGW = null;
                // Re-schedule to pick up next gameweek timing
                setTimeout(scheduleRefreshes, 60000);
                return;
            }

            // Back off polling interval: 2 mins for first hour, then 5 mins after
            const pollInterval = elapsed < 60 * 60 * 1000
                ? 2 * 60 * 1000    // Every 2 minutes for first hour
                : 5 * 60 * 1000;   // Every 5 minutes after that
            const minsElapsed = Math.round(elapsed / 60000);
            const nextMins = Math.round(pollInterval / 60000);
            console.log(`[Bonus] GW${gwId} not yet confirmed (${minsElapsed} mins elapsed, check #${checkCount}), checking again in ${nextMins} minutes`);
            bonusConfirmationTimeout = setTimeout(checkBonusConfirmed, pollInterval);
        } catch (error) {
            console.error(`[Bonus] Error checking GW${gwId} status:`, error.message);
            bonusConfirmationTimeout = setTimeout(checkBonusConfirmed, 2 * 60 * 1000);
        }
    }

    console.log(`[Bonus] Starting bonus confirmation checks for GW${gwId} (every 2-5 mins, up to 12 hours)`);
    bonusConfirmationTimeout = setTimeout(checkBonusConfirmed, 2 * 60 * 1000);
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
    const { currentGWFixtures, currentGW, events, currentGWDone, nextGW, nextGWFixtures, nextGWEvent } = fixtureData;

    console.log(`[Scheduler] Current GW: ${currentGW}${currentGWDone ? ' (finished)' : ''}`);

    // When the current GW is fully done, use the next GW for scheduling.
    // The FPL API keeps is_current on the finished GW until the next GW's deadline
    // passes, creating a dead zone where nothing gets scheduled.
    const effectiveGW = currentGWDone && nextGW ? nextGW : currentGW;
    const effectiveFixtures = currentGWDone && nextGWFixtures.length > 0 ? nextGWFixtures : currentGWFixtures;
    const effectiveEvent = currentGWDone && nextGWEvent ? nextGWEvent : events.find(e => e.id === currentGW);

    if (currentGWDone && nextGW) {
        console.log(`[Scheduler] Current GW${currentGW} is done, scheduling for next GW${nextGW}`);
    }

    // Get deadline from effective GW event
    const deadline = effectiveEvent ? new Date(effectiveEvent.deadline_time) : null;

    // Group fixtures into kickoff windows
    const windows = groupFixturesIntoWindows(effectiveFixtures);

    console.log(`[Scheduler] Found ${windows.length} match window(s) for GW ${effectiveGW}`);
    if (deadline) {
        console.log(`[Scheduler] GW${effectiveGW} deadline: ${deadline.toLocaleString('en-GB')}`);
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

    // When scheduling for a future GW (current GW done), also schedule a refresh
    // at the deadline so we immediately pick up picks data and transition the display.
    // This refresh runs in addition to the pre-match polling scheduled above - it
    // specifically triggers a week data refresh so the UI shows the new GW teams.
    if (currentGWDone && nextGW && deadline && deadline > now) {
        const deadlineRefreshDelay = deadline.getTime() - now.getTime();
        if (deadlineRefreshDelay < 7 * 24 * 60 * 60 * 1000) {
            console.log(`[Scheduler] GW${nextGW} deadline refresh scheduled: ${deadline.toLocaleString('en-GB')}`);
            const deadlineRefreshJob = setTimeout(async () => {
                console.log(`[Scheduler] GW${nextGW} deadline reached - refreshing week data for new GW`);
                await getFixturesForCurrentGW(true);
                await refreshWeekData();
            }, deadlineRefreshDelay);
            scheduledJobs.push({ stop: () => clearTimeout(deadlineRefreshJob) });
        }
    }

    // Schedule morning-after refresh (8 AM day after last GW match)
    const allKickoffs = effectiveFixtures
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

    // Recovery: detect completed GWs (including provisionally complete) that haven't
    // been processed yet. This handles server restarts, missed bonus confirmations,
    // and the gap between finished_provisional and official finished confirmation.
    if (!bonusConfirmationTimeout && !currentlyLive && !isInPreMatchWindow) {
        try {
            const [bootstrap, recoveryFixtures] = await Promise.all([fetchBootstrapFresh(), fetchFixtures()]);
            const completedGWs = getCompletedGameweeks(bootstrap, recoveryFixtures);
            const cachedLosers = dataCache.losers?.losers || [];
            const processedGWs = new Set(cachedLosers.map(l => l.gameweek));
            const unprocessedGWs = completedGWs.filter(gw => !processedGWs.has(gw));

            if (unprocessedGWs.length > 0) {
                console.log(`[Scheduler] Recovery: found ${unprocessedGWs.length} completed but unprocessed GW(s): [${unprocessedGWs.join(', ')}]. Running full refresh.`);
                const refreshResult = await refreshAllData('gameweek-confirmed');
                if (!refreshResult.success) {
                    console.error(`[Scheduler] Recovery refresh failed: ${refreshResult.error}`);
                }
                await refreshWeekData();
            }

            // Also schedule bonus confirmation for any provisionally-complete GW
            // that isn't officially finished yet (scores may change when bonus is confirmed)
            const finishedGWs = new Set(bootstrap.events.filter(e => e.finished).map(e => e.id));
            const provisionalGW = completedGWs.find(gw => !finishedGWs.has(gw));
            if (provisionalGW) {
                console.log(`[Scheduler] GW${provisionalGW} provisionally complete but not yet confirmed - starting bonus confirmation polling`);
                scheduleBonusConfirmationCheck(provisionalGW);
            }
        } catch (e) {
            console.error('[Scheduler] Recovery check failed:', e.message);
        }
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
        const filePath = path.join(__dirname, filename);
        const isBinary = contentType.startsWith('image/');
        let content;
        if (isBinary) {
            content = fs.readFileSync(filePath);
        } else {
            content = fs.readFileSync(filePath, 'utf8');
        }
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

    // Track request timing for logs
    const reqStart = Date.now();
    res.on('finish', () => {
        logger.logRequest(req, res, Date.now() - reqStart);
    });

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
                weekHistoryCache: Object.keys(dataCache.weekHistoryCache).length,
                tinkeringCache: Object.keys(dataCache.tinkeringCache).length
            }
        });
        return;
    }

    // Admin endpoint to get logs (requires password in query or header)
    if (pathname === '/api/admin/logs') {
        const authPassword = url.searchParams.get('password') || req.headers['x-admin-password'];
        if (authPassword !== ADMIN_PASSWORD) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        if (req.method === 'GET') {
            const filters = {
                level: url.searchParams.get('level') || undefined,
                category: url.searchParams.get('category') || undefined,
                search: url.searchParams.get('search') || undefined,
                since: url.searchParams.get('since') ? parseInt(url.searchParams.get('since'), 10) : undefined,
                limit: url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit'), 10) : 500,
                offset: url.searchParams.get('offset') ? parseInt(url.searchParams.get('offset'), 10) : 0
            };
            serveJSON(res, logger.getLogs(filters));
            return;
        }

        if (req.method === 'DELETE') {
            await logger.clearLogs();
            serveJSON(res, { success: true, message: 'Logs cleared' });
            return;
        }

        serveJSON(res, { error: 'Use GET or DELETE' });
        return;
    }

    // Admin endpoint to get log stats summary
    if (pathname === '/api/admin/logs/stats') {
        const authPassword = url.searchParams.get('password') || req.headers['x-admin-password'];
        if (authPassword !== ADMIN_PASSWORD) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }
        serveJSON(res, logger.getStats());
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
                    dataCache.formResultsCache = {};

                    // Note: API-level caches (apiBootstrapCache, apiFixturesCache, apiLiveGWCache)
                    // are NOT cleared here. They are short-lived (30s TTL) performance caches.
                    // refreshAllData() already calls fetchBootstrapFresh() for fresh bootstrap data.
                    // Clearing apiLiveGWCache would force re-fetching live data for ALL completed
                    // GWs from the FPL API (hundreds of calls), when that data never changes.

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
                    { entry: 2383752, name: 'Harrylujah', team: 'Derry Rhumba!!!' },
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

    // Historical week data route: /api/week/history?gw=N
    // Returns pre-built response from weekHistoryCache — instant, no API calls.
    if (pathname === '/api/week/history') {
        try {
            const gwParam = url.searchParams.get('gw');
            if (!gwParam) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'gw parameter is required' }));
                return;
            }
            const gw = parseInt(gwParam);
            if (isNaN(gw) || gw < 1 || gw > 38) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid gameweek' }));
                return;
            }

            // Serve from pre-built cache (populated at startup/daily refresh)
            const cached = dataCache.weekHistoryCache[gw];
            if (cached) {
                const currentGW = dataCache.week?.currentGW || gw;
                serveJSON(res, { ...cached, currentGW });
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: `Gameweek ${gw} data not available yet. Data is still being calculated.` }));
            }
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Head-to-head comparison route: /api/h2h?m1=ENTRY_ID&m2=ENTRY_ID
    if (pathname === '/api/h2h') {
        try {
            const m1 = parseInt(url.searchParams.get('m1'));
            const m2 = parseInt(url.searchParams.get('m2'));
            if (isNaN(m1) || isNaN(m2) || m1 === m2) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Two different manager entry IDs (m1 and m2) are required' }));
                return;
            }
            const data = await fetchH2HComparison(m1, m2);
            serveJSON(res, data);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Season analytics route: /api/analytics
    if (pathname === '/api/analytics') {
        if (!isCurrentSeason) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Analytics only available for the current season.' }));
            return;
        }
        try {
            const data = await calculateSeasonAnalytics();
            serveJSON(res, data);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

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

            // Serve from permanent cache (finished fixtures)
            if (dataCache.fixtureStatsCache[fixtureId]) {
                serveJSON(res, dataCache.fixtureStatsCache[fixtureId]);
                return;
            }

            // Stale-while-revalidate: serve cached data immediately, refresh in background
            const tempCached = fixtureStatsTempCache[fixtureId];
            if (tempCached) {
                serveJSON(res, tempCached.data);
                // If past TTL, trigger background refresh (deduped)
                if ((Date.now() - tempCached.ts) >= API_CACHE_TTL && !fixtureStatsInFlight[fixtureId]) {
                    fixtureStatsInFlight[fixtureId] = getFixtureStats(fixtureId)
                        .then(data => {
                            if (data.finished) {
                                dataCache.fixtureStatsCache[fixtureId] = data;
                                delete fixtureStatsTempCache[fixtureId];
                            } else if (!data.error) {
                                fixtureStatsTempCache[fixtureId] = { data, ts: Date.now() };
                            }
                        })
                        .catch(() => {})
                        .finally(() => { delete fixtureStatsInFlight[fixtureId]; });
                }
                return;
            }

            // No cache at all (first request) → must wait for data
            if (!fixtureStatsInFlight[fixtureId]) {
                fixtureStatsInFlight[fixtureId] = getFixtureStats(fixtureId).finally(() => {
                    delete fixtureStatsInFlight[fixtureId];
                });
            }
            const data = await fixtureStatsInFlight[fixtureId];

            // Cache finished fixtures permanently, live fixtures for 30s
            if (data.finished) {
                dataCache.fixtureStatsCache[fixtureId] = data;
            } else if (!data.error) {
                fixtureStatsTempCache[fixtureId] = { data, ts: Date.now() };
            }

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

    // Form table - league rankings over last N completed gameweeks
    if (pathname === '/api/form') {
        try {
            const weeks = Math.max(1, Math.min(38, parseInt(url.searchParams.get('weeks')) || 5));

            // Check server-side cache (60s TTL)
            const cached = dataCache.formResultsCache[weeks];
            if (cached && (Date.now() - cached.ts) < 60000) {
                serveJSON(res, cached.data);
                return;
            }

            const [leagueData, bootstrap, fixtures] = await Promise.all([
                fetchLeagueData(),
                fetchBootstrap(),
                fetchFixtures()
            ]);

            const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
            if (completedGWs.length === 0) {
                const result = { leagueName: leagueData.league.name, form: [], weeks, totalCompleted: 0, gwRange: [] };
                dataCache.formResultsCache[weeks] = { data: result, ts: Date.now() };
                serveJSON(res, result);
                return;
            }

            // Take the last N completed gameweeks
            const targetGWs = completedGWs.slice(-weeks);
            const managers = leagueData.standings.results;

            const formData = await Promise.all(
                managers.map(async m => {
                    const history = await fetchManagerHistory(m.entry);
                    const gwData = history.current.filter(gw => targetGWs.includes(gw.event));

                    const grossScore = gwData.reduce((sum, gw) => sum + gw.points, 0);
                    const transfers = gwData.reduce((sum, gw) => sum + gw.event_transfers, 0);
                    const transferCost = gwData.reduce((sum, gw) => sum + gw.event_transfers_cost, 0);
                    const netScore = grossScore - transferCost;

                    return {
                        entryId: m.entry,
                        name: m.player_name,
                        team: m.entry_name,
                        grossScore,
                        transfers,
                        transferCost,
                        netScore
                    };
                })
            );

            // Rank by net score descending
            formData.sort((a, b) => b.netScore - a.netScore);
            formData.forEach((m, i) => m.rank = i + 1);

            const result = {
                leagueName: leagueData.league.name,
                form: formData,
                weeks,
                totalCompleted: completedGWs.length,
                gwRange: targetGWs
            };

            // Store in server-side cache
            dataCache.formResultsCache[weeks] = { data: result, ts: Date.now() };

            serveJSON(res, result);
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to load form data: ' + error.message }));
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
    } else if (pathname === '/favicon-32.png') {
        serveFile(res, 'favicon-32.png', 'image/png');
    } else if (pathname === '/favicon-192.png') {
        serveFile(res, 'favicon-192.png', 'image/png');
    } else if (pathname === '/paypal-logo.png') {
        serveFile(res, 'paypal-logo.png', 'image/png');
    } else if (pathname === '/premier-league-logo.png') {
        serveFile(res, 'premier-league-logo.png', 'image/png');
    } else if (pathname === '/livefpl-logo.png') {
        serveFile(res, 'livefpl-logo.png', 'image/png');
    } else if (pathname === '/fpllive-logo.png') {
        serveFile(res, 'fpllive-logo.png', 'image/png');
    } else if (pathname === '/manifest.json') {
        serveFile(res, 'manifest.json', 'application/json');
    } else if (pathname === '/standings') {
        // Redirect to /week?view=season for backwards compatibility
        res.writeHead(302, { 'Location': '/week?view=season' });
        res.end();
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
    } else if (pathname === '/h2h') {
        serveFile(res, 'h2h.html');
    } else if (pathname === '/analytics') {
        serveFile(res, 'analytics.html');
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

    // Initialize logger with Redis persistence
    await logger.init({
        redisGet: redisGet,
        redisSet: redisSet,
        maxMemoryLogs: config.logging.MAX_MEMORY_LOGS,
        retentionMs: config.logging.RETENTION_MS,
        minLevel: config.logging.MIN_LEVEL
    });
    console.log('[Logger] Initialized with 3-day retention');

    // Initialize email transporter
    initEmailTransporter();

    // Load visitor stats, archived seasons, and cached data from Redis
    await loadVisitorStats();
    await loadArchivedSeasons();
    await loadDataCache();
    await loadCoinFlips();

    // Start HTTP server FIRST so Render detects the port quickly
    server.listen(PORT, () => {
        console.log(`[Server] Running at http://localhost:${PORT}`);
        console.log('='.repeat(60));
    });

    // Schedule refreshes based on fixtures
    await scheduleRefreshes();

    // Initial data refresh to populate caches.
    // Always run if weekHistoryCache is empty (it's built from processedPicksCache
    // which is not persisted to Redis, so it must be rebuilt on first deploy).
    // Also run if hallOfFame/setAndForget are missing (first-ever startup).
    const needsFullRefresh = !dataCache.hallOfFame || !dataCache.setAndForget
        || Object.keys(dataCache.weekHistoryCache).length === 0;
    if (needsFullRefresh) {
        console.log('[Startup] Running initial data refresh...');
        await refreshAllData('startup');
    }

    // Always refresh week data on startup - the Redis-persisted week data may be stale
    // (e.g. bonus points added after last save, code fixes changing score calculations)
    console.log('[Startup] Refreshing week data...');
    await refreshWeekData().catch(e => console.error('[Startup] Week refresh failed:', e.message));

    console.log('[Startup] Initialization complete');
}

startup();

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

function gracefulShutdown(signal) {
    console.log(`\n[Shutdown] Received ${signal}, shutting down gracefully...`);

    server.close(async () => {
        console.log('[Shutdown] HTTP server closed');
        await logger.shutdown();
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
