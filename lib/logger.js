/**
 * Centralized logging module for FPL Dashboard
 *
 * Captures all application logs with levels, categories, and timestamps.
 * Stores logs in memory with periodic Redis persistence.
 * Automatically purges entries older than the configured retention period.
 */

const LOG_LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
};

const LOG_LEVEL_NAMES = ['error', 'warn', 'info', 'debug'];

// In-memory log buffer
let logs = [];

// Configuration (set via init())
let config = {
    maxMemoryLogs: 5000,
    retentionMs: 3 * 24 * 60 * 60 * 1000, // 3 days
    redisFlushInterval: 60 * 1000,          // flush to Redis every 60s
    minLevel: LOG_LEVELS.info
};

// Redis functions (injected via init to avoid circular deps)
let _redisGet = null;
let _redisSet = null;
let _flushTimer = null;
let _initialized = false;
let _dirty = false; // tracks if logs changed since last Redis flush

// Original console methods (saved before intercept)
const _originalConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    debug: console.debug.bind(console)
};

/**
 * Initialize the logger.
 * @param {object} opts
 * @param {function} opts.redisGet - async (key) => value
 * @param {function} opts.redisSet - async (key, value) => bool
 * @param {number} [opts.maxMemoryLogs] - max log entries kept in memory
 * @param {number} [opts.retentionMs] - how long to keep logs (ms)
 * @param {string} [opts.minLevel] - minimum log level ('error','warn','info','debug')
 */
async function init(opts = {}) {
    if (opts.redisGet) _redisGet = opts.redisGet;
    if (opts.redisSet) _redisSet = opts.redisSet;
    if (opts.maxMemoryLogs) config.maxMemoryLogs = opts.maxMemoryLogs;
    if (opts.retentionMs) config.retentionMs = opts.retentionMs;
    if (opts.minLevel && LOG_LEVELS[opts.minLevel] !== undefined) {
        config.minLevel = LOG_LEVELS[opts.minLevel];
    }

    // Load existing logs from Redis
    if (_redisGet) {
        try {
            const stored = await _redisGet('app-logs');
            if (Array.isArray(stored)) {
                logs = stored;
                purgeOld();
            }
        } catch (e) {
            _originalConsole.error('[Logger] Failed to load logs from Redis:', e.message);
        }
    }

    // Start periodic Redis flush
    if (_redisSet && !_flushTimer) {
        _flushTimer = setInterval(flushToRedis, config.redisFlushInterval);
    }

    _initialized = true;
}

/**
 * Add a log entry.
 */
function addEntry(level, category, message, meta) {
    const entry = {
        t: Date.now(),
        level,
        cat: category || 'General',
        msg: message
    };
    if (meta !== undefined) {
        entry.meta = meta;
    }

    logs.push(entry);
    _dirty = true;

    // Trim if over memory limit
    if (logs.length > config.maxMemoryLogs) {
        logs = logs.slice(logs.length - config.maxMemoryLogs);
    }
}

/**
 * Parse a prefixed console message like "[Redis] GET error: ..." into { category, message }.
 */
function parseConsoleMessage(args) {
    const first = args[0];
    if (typeof first === 'string') {
        const match = first.match(/^\[([^\]]+)\]\s*(.*)/);
        if (match) {
            const category = match[1];
            const rest = match[2];
            // Rejoin remaining args
            const remaining = args.slice(1).map(a =>
                a instanceof Error ? a.message : (typeof a === 'string' ? a : JSON.stringify(a))
            ).join(' ');
            return { category, message: remaining ? `${rest} ${remaining}` : rest };
        }
    }
    // No prefix - general category
    const message = args.map(a =>
        a instanceof Error ? a.message : (typeof a === 'string' ? a : JSON.stringify(a))
    ).join(' ');
    return { category: 'General', message };
}

/**
 * Intercept console.log/error/warn/debug to capture into the logger.
 * Original output still goes to stdout/stderr.
 */
function interceptConsole() {
    console.log = function (...args) {
        _originalConsole.log(...args);
        const { category, message } = parseConsoleMessage(args);
        addEntry('info', category, message);
    };

    console.error = function (...args) {
        _originalConsole.error(...args);
        const { category, message } = parseConsoleMessage(args);
        addEntry('error', category, message);
    };

    console.warn = function (...args) {
        _originalConsole.warn(...args);
        const { category, message } = parseConsoleMessage(args);
        addEntry('warn', category, message);
    };

    console.debug = function (...args) {
        _originalConsole.debug(...args);
        const { category, message } = parseConsoleMessage(args);
        addEntry('debug', category, message);
    };
}

/**
 * Log a request/response (call from request handler).
 */
function logRequest(req, res, durationMs) {
    const url = req.url.split('?')[0];
    // Skip static assets to reduce noise
    if (url.match(/\.(css|js|png|ico|json|webmanifest)$/)) return;

    const status = res.statusCode;
    const method = req.method;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    addEntry(level, 'HTTP', `${method} ${url} ${status} ${durationMs}ms`);
}

/**
 * Remove logs older than retention period.
 */
function purgeOld() {
    const cutoff = Date.now() - config.retentionMs;
    const before = logs.length;
    logs = logs.filter(e => e.t >= cutoff);
    return before - logs.length;
}

/**
 * Flush logs to Redis.
 */
async function flushToRedis() {
    if (!_redisSet || !_dirty) return;
    try {
        purgeOld();
        await _redisSet('app-logs', logs);
        _dirty = false;
    } catch (e) {
        _originalConsole.error('[Logger] Redis flush failed:', e.message);
    }
}

/**
 * Get logs, with optional filtering.
 * @param {object} [filters]
 * @param {string} [filters.level] - minimum level to include
 * @param {string} [filters.category] - filter by category (case-insensitive partial match)
 * @param {string} [filters.search] - search in message text
 * @param {number} [filters.since] - only entries after this timestamp
 * @param {number} [filters.limit] - max entries to return (default 500)
 * @param {number} [filters.offset] - skip first N matching entries
 * @returns {{ entries: Array, total: number, categories: string[] }}
 */
function getLogs(filters = {}) {
    purgeOld();

    let result = logs;

    // Filter by level
    if (filters.level && LOG_LEVELS[filters.level] !== undefined) {
        const maxLevel = LOG_LEVELS[filters.level];
        result = result.filter(e => LOG_LEVELS[e.level] <= maxLevel);
    }

    // Filter by category
    if (filters.category) {
        const cat = filters.category.toLowerCase();
        result = result.filter(e => e.cat.toLowerCase().includes(cat));
    }

    // Filter by search text
    if (filters.search) {
        const term = filters.search.toLowerCase();
        result = result.filter(e => e.msg.toLowerCase().includes(term));
    }

    // Filter by time
    if (filters.since) {
        result = result.filter(e => e.t >= filters.since);
    }

    const total = result.length;

    // Get unique categories from all logs (not just filtered)
    const categories = [...new Set(logs.map(e => e.cat))].sort();

    // Apply offset and limit (most recent first)
    const limit = filters.limit || 500;
    const offset = filters.offset || 0;
    result = result.slice().reverse().slice(offset, offset + limit);

    return { entries: result, total, categories };
}

/**
 * Clear all logs.
 */
async function clearLogs() {
    logs = [];
    _dirty = true;
    await flushToRedis();
}

/**
 * Get log stats summary.
 */
function getStats() {
    purgeOld();
    const counts = { error: 0, warn: 0, info: 0, debug: 0 };
    for (const entry of logs) {
        counts[entry.level] = (counts[entry.level] || 0) + 1;
    }
    return {
        total: logs.length,
        counts,
        oldest: logs.length > 0 ? logs[0].t : null,
        newest: logs.length > 0 ? logs[logs.length - 1].t : null,
        categories: [...new Set(logs.map(e => e.cat))].sort()
    };
}

/**
 * Shutdown: flush remaining logs to Redis and stop timers.
 */
async function shutdown() {
    if (_flushTimer) {
        clearInterval(_flushTimer);
        _flushTimer = null;
    }
    await flushToRedis();
}

module.exports = {
    init,
    interceptConsole,
    addEntry,
    logRequest,
    getLogs,
    clearLogs,
    getStats,
    purgeOld,
    flushToRedis,
    shutdown,
    LOG_LEVELS
};
