import { describe, it, expect } from 'vitest';
import {
  seasonEventIcons,
  seasonStatRows,
  statAppliesTo,
  type PlayerSeasonTotals,
} from '../src/components/pitch/seasonStats';

/**
 * The season panel lists where a player's points came from, so a stat that
 * cannot earn that player points has no business in it. FPL records clean
 * sheets and goals conceded for every position, but only a keeper, defender or
 * midfielder is ever credited (or docked) for them — printing "Clean sheets 9"
 * under a striker invites the reader to credit him for something the game
 * never paid him for.
 */

const SEASON: PlayerSeasonTotals = {
  id: 1,
  totalPoints: 180,
  appearances: 30,
  gamesAvailable: 38,
  minutes: 2600,
  goals_scored: 14,
  assists: 6,
  clean_sheets: 9,
  goals_conceded: 22,
  own_goals: 0,
  penalties_saved: 0,
  penalties_missed: 1,
  yellow_cards: 3,
  red_cards: 0,
  saves: 0,
  bonus: 12,
  bps: 540,
  defensive_contribution: 4,
};

const GKP = 1;
const DEF = 2;
const MID = 3;
const FWD = 4;

const keysFor = (positionId?: number) => seasonStatRows(SEASON, positionId).map((r) => r.key);

describe('season stat rows — only what the position is paid for', () => {
  it('drops clean sheets and goals conceded for a forward', () => {
    const keys = keysFor(FWD);
    expect(keys).not.toContain('clean_sheets');
    expect(keys).not.toContain('goals_conceded');
    // And says nothing about what he IS paid for.
    expect(keys).toContain('goals_scored');
    expect(keys).toContain('assists');
    expect(keys).toContain('bonus');
  });

  it('keeps them for keepers, defenders and midfielders', () => {
    for (const position of [GKP, DEF, MID]) {
      const keys = keysFor(position);
      expect(keys, `position ${position} clean sheets`).toContain('clean_sheets');
      expect(keys, `position ${position} goals conceded`).toContain('goals_conceded');
    }
  });

  it('keeps keeper-only stats off outfield players', () => {
    const keeperSeason = { ...SEASON, saves: 88, penalties_saved: 2 };
    expect(seasonStatRows(keeperSeason, GKP).map((r) => r.key)).toEqual(
      expect.arrayContaining(['saves', 'penalties_saved']),
    );
    for (const position of [DEF, MID, FWD]) {
      const keys = seasonStatRows(keeperSeason, position).map((r) => r.key);
      expect(keys, `position ${position} saves`).not.toContain('saves');
      expect(keys, `position ${position} pens saved`).not.toContain('penalties_saved');
    }
  });

  it('shows everything when the position is unknown', () => {
    // A stray payload should not silently lose a real stat: the rule is about
    // relevance, not about trimming rows we are unsure of.
    const keys = keysFor(undefined);
    expect(keys).toContain('clean_sheets');
    expect(keys).toContain('goals_conceded');
    expect(statAppliesTo('clean_sheets', undefined)).toBe(true);
  });

  it('still drops a stat the player never registered', () => {
    const blank = { ...SEASON, assists: 0 };
    expect(seasonStatRows(blank, MID).map((r) => r.key)).not.toContain('assists');
  });
});

describe('season event icons — same rule on the pitch chip', () => {
  it('gives a forward no clean-sheet shield', () => {
    const labels = seasonEventIcons(SEASON, FWD).map((e) => e.label);
    expect(labels).not.toContain('Clean sheets');
    expect(labels).toContain('Goals');
  });

  it('gives a defender one', () => {
    expect(seasonEventIcons(SEASON, DEF).map((e) => e.label)).toContain('Clean sheets');
  });
});
