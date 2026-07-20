import 'server-only';

/**
 * Centralized logging module — near-verbatim port of legacy/lib/logger.js.
 *
 * Captures application logs with levels, categories, and timestamps.
 * Stores logs in memory with periodic Redis persistence (key 'app-logs',
 * same as legacy). Automatically purges entries older than the retention
 * period. State lives on globalThis to survive dev-mode re-instantiation.
 */

export const LOG_LEVELS: Record<string, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export interface LogEntry {
  t: number;
  level: string;
  cat: string;
  msg: string;
  meta?: unknown;
}

export interface LogFilters {
  level?: string;
  category?: string;
  search?: string;
  since?: number;
  limit?: number;
  offset?: number;
}

type RedisGet = (key: string) => Promise<unknown>;
type RedisSet = (key: string, value: unknown) => Promise<boolean>;

interface LoggerState {
  logs: LogEntry[];
  config: {
    maxMemoryLogs: number;
    retentionMs: number;
    redisFlushInterval: number;
    minLevel: number;
  };
  redisGet: RedisGet | null;
  redisSet: RedisSet | null;
  flushTimer: ReturnType<typeof setInterval> | null;
  initialized: boolean;
  dirty: boolean;
  intercepted: boolean;
}

declare global {
  var __fplLoggerState: LoggerState | undefined;
}

const state: LoggerState = (globalThis.__fplLoggerState ??= {
  logs: [],
  config: {
    maxMemoryLogs: 5000,
    retentionMs: 3 * 24 * 60 * 60 * 1000, // 3 days
    redisFlushInterval: 60 * 1000, // flush to Redis every 60s
    minLevel: LOG_LEVELS.info,
  },
  redisGet: null,
  redisSet: null,
  flushTimer: null,
  initialized: false,
  dirty: false,
  intercepted: false,
});

// Original console methods (saved before intercept)
const _originalConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
  debug: console.debug.bind(console),
};

export async function init(
  opts: {
    redisGet?: RedisGet;
    redisSet?: RedisSet;
    maxMemoryLogs?: number;
    retentionMs?: number;
    minLevel?: string;
  } = {},
): Promise<void> {
  if (opts.redisGet) state.redisGet = opts.redisGet;
  if (opts.redisSet) state.redisSet = opts.redisSet;
  if (opts.maxMemoryLogs) state.config.maxMemoryLogs = opts.maxMemoryLogs;
  if (opts.retentionMs) state.config.retentionMs = opts.retentionMs;
  if (opts.minLevel && LOG_LEVELS[opts.minLevel] !== undefined) {
    state.config.minLevel = LOG_LEVELS[opts.minLevel];
  }

  // Load existing logs from Redis
  if (state.redisGet) {
    try {
      const stored = await state.redisGet('app-logs');
      if (Array.isArray(stored)) {
        state.logs = stored as LogEntry[];
        purgeOld();
      }
    } catch (e) {
      _originalConsole.error('[Logger] Failed to load logs from Redis:', (e as Error).message);
    }
  }

  // Start periodic Redis flush
  if (state.redisSet && !state.flushTimer) {
    state.flushTimer = setInterval(flushToRedis, state.config.redisFlushInterval);
  }

  state.initialized = true;
}

/** Add a log entry. */
export function addEntry(level: string, category: string, message: string, meta?: unknown): void {
  const entry: LogEntry = {
    t: Date.now(),
    level,
    cat: category || 'General',
    msg: message,
  };
  if (meta !== undefined) {
    entry.meta = meta;
  }

  state.logs.push(entry);
  state.dirty = true;

  // Trim if over memory limit
  if (state.logs.length > state.config.maxMemoryLogs) {
    state.logs = state.logs.slice(state.logs.length - state.config.maxMemoryLogs);
  }
}

/** Parse a prefixed console message like "[Redis] GET error: ..." into { category, message }. */
function parseConsoleMessage(args: unknown[]): { category: string; message: string } {
  const first = args[0];
  if (typeof first === 'string') {
    const match = first.match(/^\[([^\]]+)\]\s*(.*)/);
    if (match) {
      const category = match[1];
      const rest = match[2];
      // Rejoin remaining args
      const remaining = args
        .slice(1)
        .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      return { category, message: remaining ? `${rest} ${remaining}` : rest };
    }
  }
  // No prefix - general category
  const message = args
    .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  return { category: 'General', message };
}

/**
 * Intercept console.log/error/warn/debug to capture into the logger.
 * Original output still goes to stdout/stderr.
 */
export function interceptConsole(): void {
  if (state.intercepted) return;
  state.intercepted = true;

  console.log = function (...args: unknown[]) {
    _originalConsole.log(...args);
    const { category, message } = parseConsoleMessage(args);
    addEntry('info', category, message);
  };

  console.error = function (...args: unknown[]) {
    _originalConsole.error(...args);
    const { category, message } = parseConsoleMessage(args);
    addEntry('error', category, message);
  };

  console.warn = function (...args: unknown[]) {
    _originalConsole.warn(...args);
    const { category, message } = parseConsoleMessage(args);
    addEntry('warn', category, message);
  };

  console.debug = function (...args: unknown[]) {
    _originalConsole.debug(...args);
    const { category, message } = parseConsoleMessage(args);
    addEntry('debug', category, message);
  };
}

/** Log a request (call from middleware/route handlers). */
export function logRequest(method: string, url: string, statusCode: number, durationMs: number): void {
  const path = url.split('?')[0];
  // Skip static assets to reduce noise
  if (path.match(/\.(css|js|png|ico|json|webmanifest)$/)) return;

  const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
  addEntry(level, 'HTTP', `${method} ${path} ${statusCode} ${durationMs}ms`);
}

/** Remove logs older than retention period. */
export function purgeOld(): number {
  const cutoff = Date.now() - state.config.retentionMs;
  const before = state.logs.length;
  state.logs = state.logs.filter((e) => e.t >= cutoff);
  return before - state.logs.length;
}

/** Flush logs to Redis. */
export async function flushToRedis(): Promise<void> {
  if (!state.redisSet || !state.dirty) return;
  try {
    purgeOld();
    await state.redisSet('app-logs', state.logs);
    state.dirty = false;
  } catch (e) {
    _originalConsole.error('[Logger] Redis flush failed:', (e as Error).message);
  }
}

/** Get logs, with optional filtering. Most recent first. */
export function getLogs(filters: LogFilters = {}): {
  entries: LogEntry[];
  total: number;
  categories: string[];
} {
  purgeOld();

  let result = state.logs;

  // Filter by level
  if (filters.level && LOG_LEVELS[filters.level] !== undefined) {
    const maxLevel = LOG_LEVELS[filters.level];
    result = result.filter((e) => LOG_LEVELS[e.level] <= maxLevel);
  }

  // Filter by category
  if (filters.category) {
    const cat = filters.category.toLowerCase();
    result = result.filter((e) => e.cat.toLowerCase().includes(cat));
  }

  // Filter by search text
  if (filters.search) {
    const term = filters.search.toLowerCase();
    result = result.filter((e) => e.msg.toLowerCase().includes(term));
  }

  // Filter by time
  if (filters.since) {
    result = result.filter((e) => e.t >= filters.since!);
  }

  const total = result.length;

  // Get unique categories from all logs (not just filtered)
  const categories = [...new Set(state.logs.map((e) => e.cat))].sort();

  // Apply offset and limit (most recent first)
  const limit = filters.limit || 500;
  const offset = filters.offset || 0;
  result = result.slice().reverse().slice(offset, offset + limit);

  return { entries: result, total, categories };
}

/** Clear all logs. */
export async function clearLogs(): Promise<void> {
  state.logs = [];
  state.dirty = true;
  await flushToRedis();
}

/** Get log stats summary. */
export function getStats(): {
  total: number;
  counts: Record<string, number>;
  oldest: number | null;
  newest: number | null;
  categories: string[];
} {
  purgeOld();
  const counts: Record<string, number> = { error: 0, warn: 0, info: 0, debug: 0 };
  for (const entry of state.logs) {
    counts[entry.level] = (counts[entry.level] || 0) + 1;
  }
  return {
    total: state.logs.length,
    counts,
    oldest: state.logs.length > 0 ? state.logs[0].t : null,
    newest: state.logs.length > 0 ? state.logs[state.logs.length - 1].t : null,
    categories: [...new Set(state.logs.map((e) => e.cat))].sort(),
  };
}

/** Shutdown: flush remaining logs to Redis and stop timers. */
export async function shutdown(): Promise<void> {
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
  await flushToRedis();
}
