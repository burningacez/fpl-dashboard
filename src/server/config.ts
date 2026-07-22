/**
 * Centralized configuration module for FPL Dashboard.
 * Near-verbatim TypeScript port of legacy/config/index.js — values and
 * validation logic unchanged; only types added.
 *
 * NOTE: importable from both the server runtime and tests, so no
 * 'server-only' guard here; secrets never leave the module consumers.
 */

// =============================================================================
// ENVIRONMENT VARIABLES
// =============================================================================

const server = {
  PORT: parseInt(process.env.PORT ?? '', 10) || 3001,
  NODE_ENV: process.env.NODE_ENV || 'development',
};

const league = {
  // Boot-time fallback only — the runtime season pointer (server/season-state.ts)
  // overrides this from Redis, and the league id comes from the active season's
  // entry in lib/season-config.ts (env LEAGUE_ID is an emergency override).
  CURRENT_SEASON: process.env.CURRENT_SEASON || '2025-26',
};

const email = {
  EMAIL_USER: process.env.EMAIL_USER || null,
  EMAIL_PASS: process.env.EMAIL_PASS || null,
  ALERT_EMAIL: process.env.ALERT_EMAIL || 'barold13@gmail.com',
};

const redis = {
  UPSTASH_URL: process.env.UPSTASH_REDIS_REST_URL || null,
  UPSTASH_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || null,
};

const admin = {
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'changeme',
};

// =============================================================================
// API CONFIGURATION
// =============================================================================

const api = {
  FPL_API_BASE_URL: 'https://fantasy.premierleague.com/api',
  API_TIMEOUT_MS: 10000,
};

// =============================================================================
// FPL GAME CONSTANTS
// =============================================================================

// Season-specific values (MOTM periods, loser overrides, cup GWs, league id,
// prizes) live in lib/season-config.ts, keyed by season. Only season-agnostic
// game constants remain here.
const fpl = {
  // All available chips
  ALL_CHIPS: ['wildcard', 'freehit', 'bboost', '3xc'],

  // Position ID to position name mapping
  POSITIONS: {
    1: 'GKP',
    2: 'DEF',
    3: 'MID',
    4: 'FWD',
  } as Record<number, string>,

  // Development/testing flags
  MOCK_CUP_DATA: false,
};

// =============================================================================
// LIMITS AND THRESHOLDS
// =============================================================================

const limits = {
  MAX_CHANGE_EVENTS: 50,
  MAX_CHRONO_EVENTS: 500,
  MAX_BODY_SIZE: 1024,
};

// =============================================================================
// LOGGING CONFIGURATION
// =============================================================================

const logging = {
  MAX_MEMORY_LOGS: 5000,
  RETENTION_MS: 3 * 24 * 60 * 60 * 1000, // 3 days
  REDIS_FLUSH_INTERVAL: 60 * 1000, // flush to Redis every 60s
  MIN_LEVEL: process.env.LOG_LEVEL || 'info',
};

// =============================================================================
// EVENT PRIORITY (for ordering same-poll events)
// =============================================================================

const events = {
  EVENT_PRIORITY: {
    goal: 1,
    assist: 2,
    pen_save: 3,
    pen_miss: 4,
    own_goal: 5,
    red: 6,
    yellow: 7,
    clean_sheet: 8,
    team_clean_sheet: 8, // Same priority as individual clean_sheet
    goals_conceded: 9,
    team_goals_conceded: 9, // Same priority as individual goals_conceded
    saves: 10,
    bonus_change: 11,
    defcon: 12,
  } as Record<string, number>,
};

// =============================================================================
// VALIDATION
// =============================================================================

function validate(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate CURRENT_SEASON format (YYYY-YY)
  if (!/^\d{4}-\d{2}$/.test(league.CURRENT_SEASON)) {
    errors.push('CURRENT_SEASON must be in format YYYY-YY (e.g., 2025-26)');
  }

  // Validate PORT
  if (!Number.isInteger(server.PORT) || server.PORT < 1 || server.PORT > 65535) {
    errors.push('PORT must be a valid port number (1-65535)');
  }

  // Validate API_TIMEOUT_MS
  if (!Number.isInteger(api.API_TIMEOUT_MS) || api.API_TIMEOUT_MS <= 0) {
    errors.push('API_TIMEOUT_MS must be a positive integer');
  }

  // Warn about default admin password in production
  if (admin.ADMIN_PASSWORD === 'changeme' && server.NODE_ENV === 'production') {
    warnings.push(
      'ADMIN_PASSWORD is using default value in production - please set ADMIN_PASSWORD environment variable',
    );
  }

  // MOTM/cup/league-id validation moved to validateSeasonConfig in
  // lib/season-config.ts — those values are per-season now.

  // Log warnings
  warnings.forEach((w) => console.warn(`[Config Warning] ${w}`));

  // Throw on errors
  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n  - ${errors.join('\n  - ')}`);
  }
}

// Run validation on module load
validate();

// =============================================================================
// EXPORT
// =============================================================================

const config = Object.freeze({
  server,
  league,
  email,
  redis,
  admin,
  api,
  fpl,
  limits,
  events,
  logging,

  // Re-export commonly used values at top level for convenience
  CURRENT_SEASON: league.CURRENT_SEASON,
  PORT: server.PORT,
  ADMIN_PASSWORD: admin.ADMIN_PASSWORD,
  API_TIMEOUT_MS: api.API_TIMEOUT_MS,
  FPL_API_BASE_URL: api.FPL_API_BASE_URL,

  // Validation function (for testing)
  _validate: validate,
});

export default config;
