import 'server-only';
import config from './config';
import { redisGet, redisSet } from './redis';
import { DEFAULT_SEASON, getSeasonConfig, type SeasonConfig } from '../lib/season-config';

/**
 * Runtime "which season is live" pointer.
 *
 * The active season lives in Redis ('active-season') so the admin rollover
 * action can switch the whole site without a redeploy. Resolution order:
 * Redis pointer → CURRENT_SEASON env var → DEFAULT_SEASON. The single
 * persistent server process means one boot-time read is enough; after
 * initSeasonState() the sync accessor is always correct.
 */

const ACTIVE_SEASON_KEY = 'active-season';

interface SeasonState {
  current: string;
  loaded: boolean;
}

declare global {
  var __fplSeasonState: SeasonState | undefined;
}

const state: SeasonState = (globalThis.__fplSeasonState ??= {
  current: config.CURRENT_SEASON,
  loaded: false,
});

export async function initSeasonState(): Promise<void> {
  if (state.loaded) return;
  try {
    const stored = await redisGet<string>(ACTIVE_SEASON_KEY);
    if (stored && /^\d{4}-\d{2}$/.test(stored)) {
      state.current = stored;
      if (!getSeasonConfig(stored)) {
        console.error(
          `[Season] Active season ${stored} has no entry in season-config.ts — ` +
            `rules/prizes fall back to ${DEFAULT_SEASON}'s values until an entry is deployed`,
        );
      }
    }
  } catch (error) {
    console.error('[Season] Error loading active season:', (error as Error).message);
  }
  state.loaded = true;
  console.log(`[Season] Active season: ${state.current}`);
}

export function getCurrentSeason(): string {
  return state.current;
}

/** Persists the pointer first; the in-memory value only moves on success. */
export async function setCurrentSeason(next: string): Promise<boolean> {
  const ok = await redisSet(ACTIVE_SEASON_KEY, next);
  if (ok) {
    state.current = next;
    console.log(`[Season] Active season set to ${next}`);
  }
  return ok;
}

export function getActiveSeasonConfig(): SeasonConfig {
  return getSeasonConfig(state.current) ?? getSeasonConfig(DEFAULT_SEASON)!;
}

// Env LEAGUE_ID is an emergency override only; normally the league id comes
// from the active season's config entry.
const envLeagueId = process.env.LEAGUE_ID ? parseInt(process.env.LEAGUE_ID, 10) : null;

export function getLeagueId(): number {
  return envLeagueId || getActiveSeasonConfig().leagueId;
}
