/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { redisGet, redisSet } from '../redis';
import config from '../config';

/**
 * Live event state tracking — port of legacy/server.js:85-169 and :246-321.
 *
 * The legacy code reassigns bare module variables (chronologicalEvents,
 * previousPlayerState, previousBonusPositions); here they live as properties
 * of the exported `liveState` holder so transliterated code writes
 * `liveState.chronologicalEvents = []` instead. Redis keys are unchanged.
 */

export interface LiveEventState {
  bonusPositions: Record<string, any>; // { fixtureId: { playerId: bonusPoints, ... } }
  cleanSheets: Record<string, any>; // { fixtureId: { home: bool, away: bool } }
  defcons: Record<string, any>; // { playerId: true }
  scores: Record<string, any>; // { fixtureId: { home: x, away: y } }
  changeEvents: any[]; // Rolling list of change events for ticker
  lastUpdate: string | null;
  lastGW: number | null; // Track last GW to detect transitions
}

export interface LiveStateHolder {
  liveEventState: LiveEventState;
  chronologicalEvents: any[]; // Persisted to Redis, cleared on GW transition
  // Structure: { fixtureId_playerId: { goals_scored: {p: pts, v: count}, ... } }
  // (entries persisted before the {p,v} shape are plain point numbers)
  previousPlayerState: Record<string, any>;
  // Structure: { fixtureId: { 3: [playerIds], 2: [playerIds], 1: [playerIds] } }
  previousBonusPositions: Record<string, any>;
}

declare global {
  var __fplLiveState: LiveStateHolder | undefined;
}

export const liveState: LiveStateHolder = (globalThis.__fplLiveState ??= {
  liveEventState: {
    bonusPositions: {},
    cleanSheets: {},
    defcons: {},
    scores: {},
    changeEvents: [],
    lastUpdate: null,
    lastGW: null,
  },
  chronologicalEvents: [],
  previousPlayerState: {},
  previousBonusPositions: {},
});

// Maximum number of change events to keep
export const MAX_CHANGE_EVENTS = config.limits.MAX_CHANGE_EVENTS;

// Event type priority for ordering same-poll events (lower = higher priority)
export const EVENT_PRIORITY = config.events.EVENT_PRIORITY;

// Maximum chronological events to keep (prevents unbounded growth)
export const MAX_CHRONO_EVENTS = config.limits.MAX_CHRONO_EVENTS;

/** Generate a signature string for a chronological event (used for deduplication) */
export function getEventSignature(event: any): string {
  if (event.type === 'bonus_change') {
    // Include from>to per player so a position that flips A→B and later back
    // B→A produces two distinct signatures (the flip-back used to be dropped).
    const changeIds = (event.changes || [])
      .map((c: any) => `${c.elementId}:${c.from ?? ''}>${c.to ?? ''}`)
      .sort()
      .join(',');
    return `bonus_change_${event.fixtureId}_${changeIds}`;
  }
  if (
    event.type === 'team_clean_sheet' ||
    event.type === 'team_clean_sheet_lost' ||
    event.type === 'team_goals_conceded'
  ) {
    // statTotal = the stat's cumulative points after this change, so each
    // step of goals-conceded (-1 at 2 goals, -2 at 4 …) stays distinct.
    return `${event.type}_${event.teamId}_${event.fixtureId}_${event.points ?? ''}_${event.statTotal ?? ''}`;
  }
  // Player events (goal, assist, saves, …): points alone is NOT unique — a
  // brace produces two identical (type, element, fixture, points) events in
  // consecutive polls. statTotal (cumulative points for the stat after this
  // event) disambiguates repeats; events persisted before it existed fall
  // back to the old shape.
  return `${event.type}_${event.elementId}_${event.fixtureId}_${event.points}_${event.statTotal ?? ''}`;
}

/**
 * Deduplicate new events against events that already exist in the chronological list.
 * Handles repeated events correctly (e.g. multiple save-point events for same player)
 * by comparing occurrence counts.
 */
export function deduplicateNewEvents(existingEvents: any[], newEvents: any[]): any[] {
  const existingCounts: Record<string, number> = {};
  existingEvents.forEach((e) => {
    const sig = getEventSignature(e);
    existingCounts[sig] = (existingCounts[sig] || 0) + 1;
  });

  const deduped: any[] = [];
  const newCounts: Record<string, number> = {};
  newEvents.forEach((e) => {
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
// CHRONOLOGICAL EVENTS + PREVIOUS STATE REDIS PERSISTENCE
// =============================================================================

export async function getChronologicalEvents(gw: number): Promise<any[]> {
  const data = await redisGet<any[]>(`chronological-events-gw${gw}`);
  return data || [];
}

export async function setChronologicalEvents(gw: number, events: any[]): Promise<boolean> {
  return await redisSet(`chronological-events-gw${gw}`, events);
}

export async function clearChronologicalEvents(gw: number): Promise<boolean> {
  return await redisSet(`chronological-events-gw${gw}`, []);
}

export async function loadChronologicalEvents(gw: number): Promise<any[]> {
  try {
    const events = await getChronologicalEvents(gw);
    liveState.chronologicalEvents = events;
    console.log(`[ChronoEvents] Loaded ${events.length} events from Redis for GW${gw}`);
    return events;
  } catch (error) {
    console.error('[ChronoEvents] Error loading events:', (error as Error).message);
    return [];
  }
}

export async function saveChronologicalEvents(gw: number): Promise<boolean> {
  try {
    const success = await setChronologicalEvents(gw, liveState.chronologicalEvents);
    if (success) {
      console.log(`[ChronoEvents] Saved ${liveState.chronologicalEvents.length} events to Redis for GW${gw}`);
    }
    return success;
  } catch (error) {
    console.error('[ChronoEvents] Error saving events:', (error as Error).message);
    return false;
  }
}

export async function loadPreviousPlayerState(gw: number): Promise<void> {
  try {
    const state = await redisGet<Record<string, any>>(`previous-player-state-gw${gw}`);
    if (state && Object.keys(state).length > 0) {
      liveState.previousPlayerState = state;
      console.log(`[ChronoEvents] Loaded previousPlayerState with ${Object.keys(state).length} entries for GW${gw}`);
    }
    const bonus = await redisGet<Record<string, any>>(`previous-bonus-positions-gw${gw}`);
    if (bonus && Object.keys(bonus).length > 0) {
      liveState.previousBonusPositions = bonus;
      console.log(
        `[ChronoEvents] Loaded previousBonusPositions with ${Object.keys(bonus).length} fixtures for GW${gw}`,
      );
    }
  } catch (error) {
    console.error('[ChronoEvents] Error loading previous state:', (error as Error).message);
  }
}

export async function savePreviousPlayerState(gw: number): Promise<void> {
  try {
    await redisSet(`previous-player-state-gw${gw}`, liveState.previousPlayerState);
    await redisSet(`previous-bonus-positions-gw${gw}`, liveState.previousBonusPositions);
  } catch (error) {
    console.error('[ChronoEvents] Error saving previous state:', (error as Error).message);
  }
}

export async function clearPreviousPlayerState(gw: number): Promise<void> {
  try {
    await redisSet(`previous-player-state-gw${gw}`, {});
    await redisSet(`previous-bonus-positions-gw${gw}`, {});
    liveState.previousPlayerState = {};
    liveState.previousBonusPositions = {};
    console.log(`[ChronoEvents] Cleared previous state for GW${gw}`);
  } catch (error) {
    console.error('[ChronoEvents] Error clearing previous state:', (error as Error).message);
  }
}
