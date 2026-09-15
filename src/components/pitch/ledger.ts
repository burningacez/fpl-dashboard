/**
 * The contribution ledger for a frozen Set & Forget squad.
 *
 * Shape and meaning are defined server-side (see the LEDGER block in
 * src/server/services/set-and-forget.ts). The short version, because it is what
 * every component in here renders: a squad's season total is NOT the sum of its
 * players' season points — points scored on the bench are never collected — so
 * each player's season splits into what they BANKED (started + armband +
 * off the bench) and, outside that sum, what was wasted on the bench.
 */

export interface PlayerLedger {
  id: number;
  /** started + captain + offBench. These sum to the manager's S&F total. */
  banked: number;
  /** One unit of points per gameweek in the starting XI. */
  started: number;
  /** The EXTRA the armband was worth, over and above that one unit. */
  captain: number;
  /** One unit for a gameweek they came on: auto-sub or Bench Boost. */
  offBench: number;
  subbedOn: number;
  benchBoost: number;
  /** Scored, never banked. Deliberately not part of `banked`. */
  wasted: number;
  weeksStarted: number;
  weeksSubbedOn: number;
  weeksBenched: number;
  weeksCaptained: number;
}

export interface LedgerTotals {
  banked: number;
  started: number;
  captain: number;
  offBench: number;
  subbedOn: number;
  benchBoost: number;
  wasted: number;
}

export type LedgerMap = Record<number, PlayerLedger>;

/** Ledger rows keyed by element id, for the pitch's per-player lookups. */
export function byPlayerId(ledger: PlayerLedger[] | undefined): LedgerMap {
  if (!ledger) return {};
  return Object.fromEntries(ledger.map((row) => [row.id, row]));
}

/**
 * The three segments of the contribution bar, zero-width ones dropped.
 *
 * Ordered started → armband → off the bench, which is both the order they
 * happen in a gameweek and the order the legend reads.
 */
export function bankedSegments(row: {
  started: number;
  captain: number;
  offBench: number;
}): { key: 'started' | 'captain' | 'offBench'; value: number; className: string }[] {
  return (
    [
      { key: 'started' as const, value: row.started, className: 'bg-banked-started' },
      { key: 'captain' as const, value: row.captain, className: 'bg-banked-captain' },
      { key: 'offBench' as const, value: row.offBench, className: 'bg-banked-bench' },
    ]
      // A zero segment would still paint its 2px gap and read as a hairline of
      // a category the player never had.
      .filter((segment) => segment.value > 0)
  );
}

/** Labels, kept in one place so the bar, the legend and the table agree. */
export const BANKED_LABELS = {
  started: 'Started',
  captain: 'Armband',
  offBench: 'Off the bench',
  wasted: 'Lost on bench',
} as const;
