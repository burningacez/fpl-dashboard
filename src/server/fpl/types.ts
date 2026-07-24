/**
 * Types for the official FPL API payloads — pragmatic subsets covering the
 * fields this app reads. Index signatures keep room for fields the
 * transliterated legacy logic touches without full typing.
 */

export interface FplEvent {
  id: number;
  name: string;
  deadline_time: string;
  finished: boolean;
  data_checked: boolean;
  is_previous: boolean;
  is_current: boolean;
  is_next: boolean;
  average_entry_score: number | null;
  highest_score: number | null;
  [key: string]: unknown;
}

export interface FplTeam {
  id: number;
  name: string;
  short_name: string;
  [key: string]: unknown;
}

export interface FplElement {
  id: number;
  web_name: string;
  first_name: string;
  second_name: string;
  team: number;
  element_type: number; // 1 GKP, 2 DEF, 3 MID, 4 FWD
  now_cost: number; // tenths of £m
  total_points: number;
  event_points: number;
  form: string;
  points_per_game: string;
  selected_by_percent: string;
  status: string; // a, d, i, s, u, n
  news: string;
  chance_of_playing_next_round: number | null;
  ep_next: string | null;
  photo?: string;
  [key: string]: unknown;
}

export interface Bootstrap {
  events: FplEvent[];
  teams: FplTeam[];
  elements: FplElement[];
  total_players?: number;
  [key: string]: unknown;
}

export interface FixtureStatEntry {
  value: number;
  element: number;
}

export interface FixtureStat {
  identifier: string;
  a: FixtureStatEntry[];
  h: FixtureStatEntry[];
}

export interface Fixture {
  id: number;
  event: number | null;
  team_h: number;
  team_a: number;
  team_h_score: number | null;
  team_a_score: number | null;
  team_h_difficulty: number;
  team_a_difficulty: number;
  kickoff_time: string | null;
  started: boolean;
  finished: boolean;
  finished_provisional: boolean;
  minutes: number;
  stats?: FixtureStat[];
  [key: string]: unknown;
}

export interface LeagueStandingResult {
  id: number;
  entry: number; // entryId
  entry_name: string; // team name
  player_name: string; // manager name
  rank: number;
  last_rank: number;
  total: number;
  event_total: number;
  [key: string]: unknown;
}

// Pre-season, before GW1 is scored, joined managers appear here rather than in
// `standings.results` (the API migrates them into standings once points exist).
export interface NewEntryResult {
  entry: number; // entryId
  entry_name: string; // team name
  player_first_name: string;
  player_last_name: string;
  joined_time: string;
  [key: string]: unknown;
}

export interface LeagueStandings {
  league: { id: number; name: string; [key: string]: unknown };
  standings: { results: LeagueStandingResult[]; [key: string]: unknown };
  new_entries?: { results: NewEntryResult[]; [key: string]: unknown };
  [key: string]: unknown;
}

export interface ManagerPick {
  element: number;
  position: number; // 1-11 starters, 12-15 bench
  multiplier: number; // 0 benched, 1, 2 captain, 3 triple captain
  is_captain: boolean;
  is_vice_captain: boolean;
  selling_price?: number;
  purchase_price?: number;
  [key: string]: unknown;
}

export interface ManagerPicksResponse {
  active_chip: string | null;
  automatic_subs: { element_in: number; element_out: number; [key: string]: unknown }[];
  entry_history: {
    event: number;
    points: number;
    total_points: number;
    bank: number;
    value: number;
    event_transfers: number;
    event_transfers_cost: number;
    points_on_bench: number;
    [key: string]: unknown;
  };
  picks: ManagerPick[];
  [key: string]: unknown;
}

export interface ManagerHistory {
  current: {
    event: number;
    points: number;
    total_points: number;
    rank: number | null;
    bank: number;
    value: number;
    event_transfers: number;
    event_transfers_cost: number;
    points_on_bench: number;
    [key: string]: unknown;
  }[];
  past: { season_name: string; total_points: number; rank: number; [key: string]: unknown }[];
  chips: { name: string; time: string; event: number; [key: string]: unknown }[];
  [key: string]: unknown;
}

export interface LiveElement {
  id: number;
  stats: {
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
    total_points: number;
    [key: string]: unknown;
  };
  explain: unknown[];
  [key: string]: unknown;
}

export interface LiveGWData {
  elements: LiveElement[];
  [key: string]: unknown;
}

export interface CupStatus {
  qualification_event: number | null;
  qualification_numbers: number | null;
  qualification_rank: number | null;
  qualification_state: string | null;
  has_byes: boolean | null;
  league_id: number | null; // the H2H sub-league id once drawn
  name: string | null;
  [key: string]: unknown;
}

export interface H2HMatch {
  id: number;
  event: number;
  entry_1_entry: number | null;
  entry_1_name: string;
  entry_1_player_name: string;
  entry_1_points: number;
  entry_2_entry: number | null;
  entry_2_name: string;
  entry_2_player_name: string;
  entry_2_points: number;
  is_knockout: boolean;
  winner: number | null;
  [key: string]: unknown;
}

export interface ManagerEntry {
  id: number;
  name: string; // team name
  player_first_name: string;
  player_last_name: string;
  summary_overall_points: number;
  summary_overall_rank: number;
  [key: string]: unknown;
}

export interface ManagerTransfer {
  element_in: number;
  element_in_cost: number;
  element_out: number;
  element_out_cost: number;
  entry: number;
  event: number;
  time: string;
  [key: string]: unknown;
}

export interface ApiStatus {
  available: boolean;
  lastError: string | null;
  lastErrorTime: string | null;
  lastSuccessTime: string | null;
  errorMessage: string | null;
}
