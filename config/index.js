/**
 * Centralized configuration module for FPL Dashboard
 * All configuration values and environment variables are defined here.
 */

// =============================================================================
// ENVIRONMENT VARIABLES
// =============================================================================

const server = {
  PORT: parseInt(process.env.PORT, 10) || 3001,
  NODE_ENV: process.env.NODE_ENV || 'development'
};

const league = {
  LEAGUE_ID: parseInt(process.env.LEAGUE_ID, 10) || 619028,
  CURRENT_SEASON: process.env.CURRENT_SEASON || '2025-26'
};

const email = {
  EMAIL_USER: process.env.EMAIL_USER || null,
  EMAIL_PASS: process.env.EMAIL_PASS || null,
  ALERT_EMAIL: process.env.ALERT_EMAIL || 'barold13@gmail.com'
};

const redis = {
  UPSTASH_URL: process.env.UPSTASH_REDIS_REST_URL || null,
  UPSTASH_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || null
};

const admin = {
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'changeme'
};

// =============================================================================
// API CONFIGURATION
// =============================================================================

const api = {
  FPL_API_BASE_URL: 'https://fantasy.premierleague.com/api',
  API_TIMEOUT_MS: 10000
};

// =============================================================================
// FPL GAME CONSTANTS
// =============================================================================

const fpl = {
  // Manager of the Month periods (9 periods across 38 GWs)
  MOTM_PERIODS: {
    1: [1, 5],
    2: [6, 9],
    3: [10, 13],
    4: [14, 17],
    5: [18, 21],
    6: [22, 25],
    7: [26, 29],
    8: [30, 33],
    9: [34, 38]
  },

  // All available chips
  ALL_CHIPS: ['wildcard', 'freehit', 'bboost', '3xc'],

  // Manual overrides for weekly losers (corrections to API data)
  LOSER_OVERRIDES: {
    2: 'Grant Clark',
    12: 'James Armstrong'
  },

  // Position ID to position name mapping
  POSITIONS: {
    1: 'GKP',
    2: 'DEF',
    3: 'MID',
    4: 'FWD'
  },

  // Cup configuration
  CUP_START_GW: 34,
  SEEDING_GW: 33,

  // Development/testing flags
  MOCK_CUP_DATA: false
};

// =============================================================================
// LIMITS AND THRESHOLDS
// =============================================================================

const limits = {
  MAX_CHANGE_EVENTS: 50,
  MAX_CHRONO_EVENTS: 500,
  MAX_BODY_SIZE: 1024
};

// =============================================================================
// EVENT PRIORITY (for ordering same-poll events)
// =============================================================================

const events = {
  EVENT_PRIORITY: {
    'goal': 1,
    'assist': 2,
    'pen_save': 3,
    'pen_miss': 4,
    'own_goal': 5,
    'red': 6,
    'yellow': 7,
    'clean_sheet': 8,
    'team_clean_sheet': 8,  // Same priority as individual clean_sheet
    'goals_conceded': 9,
    'team_goals_conceded': 9,  // Same priority as individual goals_conceded
    'saves': 10,
    'bonus_change': 11,
    'defcon': 12
  }
};

// =============================================================================
// VALIDATION
// =============================================================================

function validate() {
  const errors = [];
  const warnings = [];

  // Validate LEAGUE_ID
  if (!Number.isInteger(league.LEAGUE_ID) || league.LEAGUE_ID <= 0) {
    errors.push('LEAGUE_ID must be a positive integer');
  }

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
    warnings.push('ADMIN_PASSWORD is using default value in production - please set ADMIN_PASSWORD environment variable');
  }

  // Validate MOTM_PERIODS
  const periods = Object.entries(fpl.MOTM_PERIODS);
  if (periods.length !== 9) {
    errors.push('MOTM_PERIODS must have exactly 9 periods');
  }
  periods.forEach(([num, [start, end]]) => {
    if (start < 1 || end > 38 || start > end) {
      errors.push(`MOTM_PERIODS[${num}] has invalid GW range [${start}, ${end}]`);
    }
  });

  // Validate CUP configuration
  if (fpl.CUP_START_GW < 1 || fpl.CUP_START_GW > 38) {
    errors.push('CUP_START_GW must be between 1 and 38');
  }
  if (fpl.SEEDING_GW < 1 || fpl.SEEDING_GW >= fpl.CUP_START_GW) {
    errors.push('SEEDING_GW must be between 1 and CUP_START_GW - 1');
  }

  // Log warnings
  warnings.forEach(w => console.warn(`[Config Warning] ${w}`));

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

module.exports = Object.freeze({
  server,
  league,
  email,
  redis,
  admin,
  api,
  fpl,
  limits,
  events,

  // Re-export commonly used values at top level for convenience
  LEAGUE_ID: league.LEAGUE_ID,
  CURRENT_SEASON: league.CURRENT_SEASON,
  PORT: server.PORT,
  ADMIN_PASSWORD: admin.ADMIN_PASSWORD,
  API_TIMEOUT_MS: api.API_TIMEOUT_MS,
  FPL_API_BASE_URL: api.FPL_API_BASE_URL,

  // Validation function (for testing)
  _validate: validate
});
