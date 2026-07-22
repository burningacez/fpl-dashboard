import 'server-only';
import { getSeasonConfig } from '../../lib/season-config';
import { getCurrentSeason, setCurrentSeason } from '../season-state';
import { redisConfigured, redisGet, redisSet } from '../redis';
import {
  archivedSeasons,
  archiveCurrentSeason,
  rebuildStatus,
  resetDataCacheForNewSeason,
  saveCoinFlips,
  saveDataCache,
} from '../data-cache';
import { invalidateAllRawCaches } from '../fpl/client';
import * as traffic from '../traffic';
import { refreshAllData } from './refresh';

export interface RolloverResult {
  success: boolean;
  noop?: boolean;
  archived?: string;
  newSeason?: string;
  message?: string;
  error?: string;
}

declare global {
  var __fplRolloverInFlight: boolean | undefined;
}

/**
 * Season rollover — the one admin action that starts a new season:
 *
 *   1. snapshot the finishing season into the archive (unless skipSnapshot),
 *   2. flip the active-season pointer in Redis,
 *   3. wipe every in-memory cache and persist the cleared, season-stamped
 *      data-cache blob so a restart can't resurrect old-season data,
 *   4. roll traffic stats over and kick off a background refresh against the
 *      new season's league (which may not exist yet — that's fine, the site
 *      shows empty states until it does).
 *
 * Each step aborts on failure and earlier steps are idempotent, so a failed
 * rollover can simply be retried. skipSnapshot exists for the case where the
 * season was snapshotted right after GW38 and the FPL API has since reset,
 * making the live caches untrustworthy.
 */
export async function rolloverSeason(
  nextSeason: string,
  opts: { skipSnapshot?: boolean } = {},
): Promise<RolloverResult> {
  if (!/^\d{4}-\d{2}$/.test(nextSeason)) {
    return { success: false, error: 'Season must be in YYYY-YY format (e.g. 2026-27)' };
  }

  const current = getCurrentSeason();
  if (nextSeason === current) {
    // Retry after a mid-flip crash lands here — the pointer already moved.
    return { success: true, noop: true, newSeason: current, message: `Already on ${current}` };
  }
  if (!getSeasonConfig(nextSeason)) {
    return {
      success: false,
      error: `No config entry for ${nextSeason} — add it to src/lib/season-config.ts and deploy first`,
    };
  }
  if (!redisConfigured()) {
    return { success: false, error: 'Redis is not configured — rollover needs persistence to be safe' };
  }
  if (rebuildStatus.inProgress) {
    return { success: false, error: 'A data rebuild is in progress — wait for it to finish' };
  }
  if (globalThis.__fplRolloverInFlight) {
    return { success: false, error: 'A rollover is already in progress' };
  }

  globalThis.__fplRolloverInFlight = true;
  try {
    console.log(`[Rollover] ${current} → ${nextSeason} starting...`);

    if (opts.skipSnapshot) {
      if (!archivedSeasons[current]) {
        return {
          success: false,
          error: `skipSnapshot needs an existing ${current} archive — run the snapshot first`,
        };
      }
      console.log(`[Rollover] Skipping snapshot (existing ${current} archive kept)`);
    } else {
      const archiveResult = await archiveCurrentSeason();
      if (!archiveResult.success) {
        return { success: false, error: `Snapshot failed, nothing changed: ${archiveResult.error}` };
      }
    }

    // The point of no return. If the write fails the pointer is unchanged and
    // a retry just re-snapshots harmlessly.
    const flipped = await setCurrentSeason(nextSeason);
    if (!flipped) {
      return { success: false, error: 'Could not persist the new season pointer to Redis — nothing changed' };
    }

    resetDataCacheForNewSeason();
    invalidateAllRawCaches();

    // Persist the cleared blob (stamped with the new season) and the reset
    // coin flips. If the process dies before this, loadDataCache discards the
    // old blob anyway thanks to the season stamp.
    await saveDataCache();
    await saveCoinFlips();

    // traffic.init archives the old season's stats and starts fresh when the
    // season it's given differs from the stored one.
    await traffic.init({ season: nextSeason, redisGet, redisSet });

    // Best-effort warm-up against the new league; expected to fail until the
    // owner has created the new FPL league.
    refreshAllData('season-rollover').catch((e: Error) =>
      console.warn('[Rollover] Post-rollover refresh failed (new league may not exist yet):', e.message),
    );

    console.log(`[Rollover] Complete — active season is now ${nextSeason}`);
    return {
      success: true,
      archived: opts.skipSnapshot ? undefined : current,
      newSeason: nextSeason,
      message: `Archived ${current} and switched to ${nextSeason}`,
    };
  } catch (error) {
    return { success: false, error: (error as Error).message };
  } finally {
    globalThis.__fplRolloverInFlight = false;
  }
}
