/**
 * Utility functions for FPL Dashboard.
 * Near-verbatim TypeScript port of legacy/lib/utils.js — logic must stay
 * byte-identical; only types may be added.
 */

export interface TiedRecord {
  names: string[];
  value: number;
  [key: string]: unknown;
}

export interface FixtureLike {
  kickoff_time?: string | null;
  [key: string]: unknown;
}

export interface FixtureWindow {
  start: Date;
  end: Date;
  fixtures: (FixtureLike & { kickoffDate: Date })[];
}

export interface CaptaincyPlayer {
  isCaptain: boolean;
  isViceCaptain: boolean;
  multiplier: number;
  subOut?: boolean;
  minutes?: number;
  allFixturesStarted?: boolean;
  hasNoGame?: boolean;
  [key: string]: unknown;
}

/** Format tied names for display */
export function formatTiedNames(names: string[] | null | undefined): string {
  if (!names || names.length === 0) return '-';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names[0]} +${names.length - 1} others`;
}

/** Update a record with tie support (higher is better) */
export function updateRecordWithTies(
  current: TiedRecord,
  newName: string,
  newValue: number,
  additionalData: Record<string, unknown> = {},
): TiedRecord {
  if (newValue > current.value) {
    return { names: [newName], value: newValue, ...additionalData };
  } else if (newValue === current.value && !current.names.includes(newName)) {
    return { ...current, names: [...current.names, newName] };
  }
  return current;
}

/** Update a record with tie support (lower is better) */
export function updateRecordWithTiesLow(
  current: TiedRecord,
  newName: string,
  newValue: number,
  additionalData: Record<string, unknown> = {},
): TiedRecord {
  if (newValue < current.value) {
    return { names: [newName], value: newValue, ...additionalData };
  } else if (newValue === current.value && !current.names.includes(newName)) {
    return { ...current, names: [...current.names, newName] };
  }
  return current;
}

/**
 * Calculate match end time from kickoff time.
 * Match duration approximately 115 minutes (90 + stoppage + halftime + buffer).
 */
export function getMatchEndTime(kickoffTime: string | Date): Date {
  const kickoff = new Date(kickoffTime);
  return new Date(kickoff.getTime() + 115 * 60 * 1000);
}

/** Group fixtures into kickoff windows (matches starting within 30 mins of each other) */
export function groupFixturesIntoWindows(fixtures: FixtureLike[] | null | undefined): FixtureWindow[] {
  if (!fixtures || fixtures.length === 0) return [];

  const sortedFixtures = fixtures
    .filter((f) => f.kickoff_time)
    .map((f) => ({ ...f, kickoffDate: new Date(f.kickoff_time as string) }))
    .sort((a, b) => a.kickoffDate.getTime() - b.kickoffDate.getTime());

  const windows: FixtureWindow[] = [];
  let currentWindow: FixtureWindow | null = null;

  sortedFixtures.forEach((fixture) => {
    if (!currentWindow) {
      currentWindow = {
        start: fixture.kickoffDate,
        end: getMatchEndTime(fixture.kickoffDate),
        fixtures: [fixture],
      };
    } else {
      // If this kickoff is within 30 mins of the window start, add to current window
      const timeDiff = fixture.kickoffDate.getTime() - currentWindow.start.getTime();
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
          fixtures: [fixture],
        };
      }
    }
  });

  if (currentWindow) {
    windows.push(currentWindow);
  }

  return windows;
}

/** Generate a simple hash for data change detection */
export function generateDataHash(data: unknown): string {
  const str = JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Determine whether a player effectively didn't play this GW.
 * True when explicitly subbed out, or when they have 0 minutes and can no
 * longer earn any (all their fixtures started, or they have no game in a
 * GW that has already kicked off).
 */
function didNotPlay(player: CaptaincyPlayer | undefined, gwHasStarted: boolean): boolean {
  if (!player) return false;
  if (player.subOut) return true;
  if (player.minutes !== 0) return false;
  if (player.allFixturesStarted) return true;
  if (player.hasNoGame && gwHasStarted) return true;
  return false;
}

/**
 * Resolve effective captaincy after auto-subs.
 * If the captain didn't play (auto-subbed out, or 0 minutes with no remaining
 * fixtures), the vice-captain inherits the captain multiplier (2x, or 3x for
 * Triple Captain). The VC inherits regardless of whether the captain was
 * successfully auto-subbed — FPL still passes the armband even when no valid
 * bench replacement exists. If both captain and vice-captain didn't play,
 * nobody gets the multiplier.
 * Mutates the players array in place.
 */
export function resolveEffectiveCaptaincy(players: CaptaincyPlayer[], gwHasStarted = false): void {
  const captain = players.find((p) => p.isCaptain);
  const viceCaptain = players.find((p) => p.isViceCaptain);

  if (!captain) return;
  if (!didNotPlay(captain, gwHasStarted)) return;
  if (!viceCaptain) return;

  // Use the captain's intended multiplier as the value to pass to the VC.
  // Guard against it already being 0 or 1 — the FPL `picks` endpoint rewrites
  // pick.multiplier to 0 on a non-playing captain for completed GWs, and if a
  // caller forwarded that value the VC would inherit 0 instead of 2 (or 3 for
  // Triple Captain), silently zeroing the VC's doubled contribution.
  const captainMultiplier = captain.multiplier >= 2 ? captain.multiplier : 2;
  captain.multiplier = 1;
  captain.isCaptain = false;

  if (!didNotPlay(viceCaptain, gwHasStarted)) {
    viceCaptain.multiplier = captainMultiplier;
    viceCaptain.isCaptain = true;
    viceCaptain.isViceCaptain = false;
  }
}
