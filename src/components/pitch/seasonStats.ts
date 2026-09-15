/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Season totals for one player, as served by /api/set-and-forget's
 * `playerSeason` map (see src/server/services/set-and-forget.ts).
 *
 * The API deliberately ships totals and denominators only, so the per-game
 * numbers shown on the pitch are always that page's own arithmetic on the
 * totals beside them and cannot drift from them.
 */
export interface PlayerSeasonTotals {
  id: number;
  totalPoints: number;
  /** Gameweeks with at least a minute played. */
  appearances: number;
  /** Gameweeks the player's club had a fixture. */
  gamesAvailable: number;
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  own_goals: number;
  penalties_saved: number;
  penalties_missed: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  bonus: number;
  bps: number;
  defensive_contribution: number;
}

export type SeasonStatsMap = Record<number, PlayerSeasonTotals>;

/** One row of the season table: the total, and what it averages out at. */
export interface SeasonStatRow {
  key: string;
  label: string;
  icon: string;
  total: number;
  /** Per appearance. Null for stats where an average says nothing (cards). */
  perGame: number | null;
}

const ROWS: { key: keyof PlayerSeasonTotals; label: string; icon: string; averaged: boolean }[] = [
  { key: 'minutes', label: 'Minutes', icon: '⏱️', averaged: true },
  { key: 'goals_scored', label: 'Goals', icon: '⚽', averaged: true },
  { key: 'assists', label: 'Assists', icon: '👟', averaged: true },
  { key: 'clean_sheets', label: 'Clean sheets', icon: '🛡️', averaged: false },
  { key: 'saves', label: 'Saves', icon: '✋', averaged: true },
  { key: 'penalties_saved', label: 'Pens saved', icon: '🧤', averaged: false },
  { key: 'defensive_contribution', label: 'Defensive contributions', icon: '🔒', averaged: true },
  { key: 'bonus', label: 'Bonus', icon: '⭐', averaged: true },
  { key: 'goals_conceded', label: 'Goals conceded', icon: '😞', averaged: true },
  { key: 'yellow_cards', label: 'Yellow cards', icon: '🟨', averaged: false },
  { key: 'red_cards', label: 'Red cards', icon: '🟥', averaged: false },
  { key: 'own_goals', label: 'Own goals', icon: '🔴', averaged: false },
  { key: 'penalties_missed', label: 'Pens missed', icon: '❌', averaged: false },
];

/** Total ÷ appearances, or null when the player never played. */
export function perAppearance(total: number, appearances: number): number | null {
  return appearances > 0 ? total / appearances : null;
}

/**
 * The season table for one player: every stat they actually registered.
 *
 * A zero row is dropped rather than printed, for the same reason the gameweek
 * breakdown only lists stats that scored: fourteen zeroes with a goal buried
 * among them is a worse read than one line saying "1 goal".
 */
export function seasonStatRows(season: PlayerSeasonTotals): SeasonStatRow[] {
  return ROWS.filter((row) => (season[row.key] as number) > 0).map((row) => {
    const total = season[row.key] as number;
    return {
      key: row.key,
      label: row.label,
      icon: row.icon,
      total,
      perGame: row.averaged ? perAppearance(total, season.appearances) : null,
    };
  });
}

/** Formats an average: minutes read better whole, fractions of a goal don't. */
export function formatAverage(value: number, key?: string): string {
  if (key === 'minutes') return value.toFixed(0);
  return value.toFixed(value < 10 ? 2 : 1);
}

/** The chip's under-name icons: what the player did over the season. */
export function seasonEventIcons(season: PlayerSeasonTotals): { icon: string; count: number; label: string }[] {
  const events: { icon: string; count: number; label: string }[] = [];
  if (season.goals_scored > 0) events.push({ icon: '⚽', count: season.goals_scored, label: 'Goals' });
  if (season.assists > 0) events.push({ icon: '👟', count: season.assists, label: 'Assists' });
  if (season.clean_sheets > 0) events.push({ icon: '🛡️', count: season.clean_sheets, label: 'Clean sheets' });
  if (season.bonus > 0) events.push({ icon: '⭐', count: season.bonus, label: 'Bonus points' });
  return events;
}
