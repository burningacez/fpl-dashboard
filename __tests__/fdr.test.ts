import { describe, it, expect } from 'vitest';
import {
  teamFdrStats,
  classifyGameweek,
  compareByAttractiveness,
  DGW_BONUS,
  BGW_PENALTY,
  type FdrFixture,
} from '@/lib/fdr';

const fx = (fdr: number, home = true): FdrFixture => ({ short: 'xxx', home, fdr });

describe('teamFdrStats', () => {
  it('averages difficulty across single gameweeks', () => {
    const cells = [[fx(2)], [fx(4)], [fx(3)]];
    const s = teamFdrStats(cells, [true, true, true]);
    expect(s.avg).toBeCloseTo(3);
    expect(s.games).toBe(3);
    expect(s.dgwCount).toBe(0);
    expect(s.bgwCount).toBe(0);
    expect(s.score).toBeCloseTo(3);
  });

  it('counts a double gameweek as two games and rewards it', () => {
    const cells = [[fx(3), fx(3)], [fx(3)]];
    const s = teamFdrStats(cells, [true, true]);
    expect(s.games).toBe(3);
    expect(s.avg).toBeCloseTo(3);
    expect(s.dgwCount).toBe(1);
    // avg 3, minus one double bonus
    expect(s.score).toBeCloseTo(3 - DGW_BONUS);
  });

  it('penalises a blank gameweek only when the round is live', () => {
    const cells = [[fx(3)], []]; // plays, then blanks
    const live = teamFdrStats(cells, [true, true]);
    expect(live.bgwCount).toBe(1);
    expect(live.score).toBeCloseTo(3 + BGW_PENALTY);

    // Same cells, but the second gameweek is unscheduled for everyone.
    const unscheduled = teamFdrStats(cells, [true, false]);
    expect(unscheduled.bgwCount).toBe(0);
    expect(unscheduled.score).toBeCloseTo(3);
  });

  it('a blank + double nets to the same game count but still ranks above a flat run', () => {
    // GW1 blank, GW2 double, GW3 single => 3 games, same as three singles.
    const doubler = teamFdrStats([[], [fx(3), fx(3)], [fx(3)]], [true, true, true]);
    const flat = teamFdrStats([[fx(3)], [fx(3)], [fx(3)]], [true, true, true]);
    expect(doubler.games).toBe(3);
    expect(flat.games).toBe(3);
    // One bonus and one penalty cancel, so scores tie on equal difficulty —
    // the concentration shows up as the dgwCount, not a raw game total.
    expect(doubler.score).toBeCloseTo(flat.score!);
    expect(doubler.dgwCount).toBe(1);
  });

  it('returns nulls for a team with no fixtures in range', () => {
    const s = teamFdrStats([[], []], [true, true]);
    expect(s.avg).toBeNull();
    expect(s.score).toBeNull();
    expect(s.games).toBe(0);
  });
});

describe('compareByAttractiveness', () => {
  it('orders lower scores first and sinks no-game teams to the bottom', () => {
    const teams = [
      { name: 'mid', score: 3 },
      { name: 'best', score: 1.5 },
      { name: 'none', score: null },
      { name: 'good', score: 2 },
    ];
    const order = [...teams].sort(compareByAttractiveness).map((t) => t.name);
    expect(order).toEqual(['best', 'good', 'mid', 'none']);
  });
});

describe('classifyGameweek', () => {
  it('flags a normal round as neither', () => {
    expect(classifyGameweek([1, 1, 1, 1])).toEqual({ dgw: false, bgw: false, active: true });
  });

  it('flags a double when any team plays twice', () => {
    expect(classifyGameweek([1, 2, 1])).toEqual({ dgw: true, bgw: false, active: true });
  });

  it('flags a blank only when some play and some do not', () => {
    expect(classifyGameweek([1, 0, 1])).toEqual({ dgw: false, bgw: true, active: true });
  });

  it('flags both when a round has doubles and blanks together', () => {
    expect(classifyGameweek([2, 0, 1])).toEqual({ dgw: true, bgw: true, active: true });
  });

  it('treats a wholly empty round as unscheduled, not a blank', () => {
    expect(classifyGameweek([0, 0, 0])).toEqual({ dgw: false, bgw: false, active: false });
  });
});
