/**
 * Shapes and pure derivations for the planner's data feed (/api/planner/data).
 *
 * Shared by the planner page and the player detail card, so neither owns the
 * other's types. NO 'server-only', NO DOM — imported by client components and
 * the vitest suite.
 */

import type { PlannerPlayer } from './squad-rules';

// =============================================================================
// Feed shapes
// =============================================================================

export interface PlannerTeamRow {
  id: number;
  name: string;
  short_name: string;
  code?: number;
}

export interface PlannerEventRow {
  id: number;
  deadline_time: string;
  finished: boolean;
  is_current: boolean;
  is_next: boolean;
}

export interface PlannerFixtureRow {
  id: number;
  event: number | null;
  team_h: number;
  team_a: number;
  team_h_difficulty: number;
  team_a_difficulty: number;
  kickoff_time: string | null;
}

/** A bootstrap element as the planner feed projects it. */
export type PlannerPlayerRow = PlannerPlayer & {
  first_name: string;
  second_name: string;
  cost_change_event: number;
  cost_change_start: number;
  transfers_in_event: number;
  transfers_out_event: number;
  /** Signed % progress to the next price change (100 = threshold). */
  price_change_percent: number;
  total_points: number;
  form: string;
  points_per_game: string;
  selected_by_percent: string;
  status: string;
  news: string;
  chance_of_playing_next_round: number | null;
  ep_next: string | null;
  minutes: number;
  starts: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  penalties_saved: number;
  penalties_missed: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  bonus: number;
  bps: number;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  ict_index: string;
};

export interface PlannerData {
  currentGw: number;
  nextGw: number;
  events: PlannerEventRow[];
  teams: PlannerTeamRow[];
  players: PlannerPlayerRow[];
  fixtures: PlannerFixtureRow[];
}

/** One upcoming fixture from a given team's point of view. */
export interface TeamFixture {
  gw: number | null;
  short: string;
  home: boolean;
  fdr: number;
}

// =============================================================================
// Fixtures
// =============================================================================

export function fixturesForTeam(data: PlannerData, teamId: number, gw: number): TeamFixture[] {
  return data.fixtures
    .filter((f) => f.event === gw && (f.team_h === teamId || f.team_a === teamId))
    .map((f) => {
      const home = f.team_h === teamId;
      const oppId = home ? f.team_a : f.team_h;
      return {
        gw: f.event,
        short: data.teams.find((t) => t.id === oppId)?.short_name ?? '???',
        home,
        fdr: home ? f.team_h_difficulty : f.team_a_difficulty,
      };
    });
}

/**
 * The next `count` gameweeks for a team from `fromGw` inclusive, one entry per
 * gameweek. A blank gameweek yields an entry with no fixture so the strip keeps
 * its columns aligned; a double yields both.
 */
export function upcomingFixtures(
  data: PlannerData,
  teamId: number,
  fromGw: number,
  count: number,
): { gw: number; fixtures: TeamFixture[] }[] {
  return data.events
    .filter((e) => e.id >= fromGw)
    .slice(0, count)
    .map((e) => ({ gw: e.id, fixtures: fixturesForTeam(data, teamId, e.id) }));
}

// =============================================================================
// Price-change outlook
// =============================================================================

export type PriceDirection = 'rise' | 'fall' | 'none';

export interface PriceOutlook {
  direction: PriceDirection;
  /** Absolute progress toward the threshold, as a percentage (100 = at it). */
  progress: number;
  /** Plain-language likelihood, e.g. 'Very likely'. */
  label: string;
  /** Net transfers this gameweek (in minus out) — what drives the change. */
  netTransfers: number;
  /** True once the threshold is reached and a change is expected tonight. */
  imminent: boolean;
}

/**
 * How likely a player's price is to move, from FPL's own progress-to-threshold
 * field. FPL publishes no "will change tonight" flag, so this is a reading of
 * `price_change_percent`: magnitude is the progress toward a change (100 = at
 * the threshold), and the sign is the direction.
 *
 * Pre-season, and before any transfers happen, that field is 0 for everyone —
 * hence the 'none' direction rather than a fabricated prediction. Net transfers
 * are reported alongside so the number behind the verdict is visible.
 */
export function priceChangeOutlook(player: PlannerPlayerRow): PriceOutlook {
  const pct = player.price_change_percent || 0;
  const netTransfers = (player.transfers_in_event || 0) - (player.transfers_out_event || 0);
  const progress = Math.abs(pct);
  const direction: PriceDirection = pct > 0 ? 'rise' : pct < 0 ? 'fall' : 'none';

  let label: string;
  if (direction === 'none') label = 'No movement yet';
  else if (progress >= 100) label = 'Expected tonight';
  else if (progress >= 75) label = 'Very likely';
  else if (progress >= 50) label = 'Possible';
  else if (progress >= 25) label = 'Building';
  else label = 'Unlikely';

  return { direction, progress, label, netTransfers, imminent: progress >= 100 };
}

// =============================================================================
// Ranking (the "18 of 249" line under each stat on FPL's own card)
// =============================================================================

export interface StatRank {
  rank: number;
  total: number;
}

/**
 * Where a player sits among everyone in the same position on `value`, highest
 * first. Ties share the better rank, so two players on equal points are both
 * "5 of 249" rather than 5 and 6.
 */
export function positionRank(
  players: PlannerPlayerRow[],
  player: PlannerPlayerRow,
  value: (p: PlannerPlayerRow) => number,
): StatRank {
  const peers = players.filter((p) => p.element_type === player.element_type);
  const mine = value(player);
  const better = peers.filter((p) => value(p) > mine).length;
  return { rank: better + 1, total: peers.length };
}

/** FPL's decimal-string stats (form, xGI, ICT…) as numbers. */
export function num(value: string | null | undefined): number {
  return parseFloat(value ?? '') || 0;
}

// =============================================================================
// Availability
// =============================================================================

export interface Availability {
  /** null when the player is fully available. */
  tone: 'negative' | 'warning' | null;
  text: string | null;
}

/**
 * Injury/suspension state, from FPL's status code and chance-of-playing. Codes:
 * a available, d doubtful, i injured, s suspended, u unavailable, n on loan.
 */
export function availability(player: PlannerPlayerRow): Availability {
  const chance = player.chance_of_playing_next_round;
  const news = player.news?.trim() || null;

  if (player.status === 'a' && (chance == null || chance === 100)) {
    return { tone: null, text: null };
  }
  const tone: 'negative' | 'warning' =
    player.status === 'a' || (chance != null && chance >= 50) ? 'warning' : 'negative';
  const chanceText = chance != null ? `${chance}% chance of playing` : null;
  return { tone, text: news ?? chanceText ?? 'Availability doubtful' };
}
