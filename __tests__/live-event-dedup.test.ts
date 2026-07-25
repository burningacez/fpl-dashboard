/**
 * Live ticker event dedup — guards the fixes for events that used to be
 * silently swallowed:
 *  - a second identical goal (brace/hat-trick) in a later poll
 *  - repeated save-point events across polls
 *  - a lost clean sheet colliding with the earlier gained event
 *  - successive goals-conceded steps
 *  - a bonus position flipping back to a previous holder
 * The signature scheme is (type, element/team, fixture, points, statTotal)
 * where statTotal is the stat's cumulative points after the event.
 */
import { describe, expect, it } from 'vitest';
import { deduplicateNewEvents, getEventSignature } from '@/server/live/state';

const goal = (overrides: Record<string, unknown> = {}) => ({
  type: 'goal',
  elementId: 233,
  player: 'Haaland',
  fixtureId: 7,
  points: 4,
  statTotal: 4,
  ...overrides,
});

describe('getEventSignature', () => {
  it('distinguishes a second identical goal by running total', () => {
    const first = goal({ statTotal: 4 });
    const second = goal({ statTotal: 8 });
    expect(getEventSignature(first)).not.toBe(getEventSignature(second));
  });

  it('keeps old-shape events (no statTotal) stable', () => {
    const legacy = goal({ statTotal: undefined });
    expect(getEventSignature(legacy)).toBe(getEventSignature(goal({ statTotal: undefined })));
  });

  it('separates a lost clean sheet from the gained one by type', () => {
    const gained = { type: 'team_clean_sheet', teamId: 3, fixtureId: 7, points: 4, statTotal: 4 };
    const lost = { type: 'team_clean_sheet_lost', teamId: 3, fixtureId: 7, points: -4, statTotal: 0 };
    expect(getEventSignature(gained)).not.toBe(getEventSignature(lost));
  });

  it('separates successive goals-conceded steps by running total', () => {
    const twoGoals = { type: 'team_goals_conceded', teamId: 3, fixtureId: 7, points: -1, statTotal: -1 };
    const fourGoals = { type: 'team_goals_conceded', teamId: 3, fixtureId: 7, points: -1, statTotal: -2 };
    expect(getEventSignature(twoGoals)).not.toBe(getEventSignature(fourGoals));
  });

  it('separates a bonus flip-back from the original swing', () => {
    const aOverB = {
      type: 'bonus_change',
      fixtureId: 7,
      changes: [
        { elementId: 1, from: 2, to: 3 },
        { elementId: 2, from: 3, to: 2 },
      ],
    };
    const bOverA = {
      type: 'bonus_change',
      fixtureId: 7,
      changes: [
        { elementId: 1, from: 3, to: 2 },
        { elementId: 2, from: 2, to: 3 },
      ],
    };
    expect(getEventSignature(aOverB)).not.toBe(getEventSignature(bOverA));
  });
});

describe('deduplicateNewEvents', () => {
  it('admits the second goal of a brace detected in a later poll', () => {
    const existing = [goal({ statTotal: 4 })];
    const incoming = [goal({ statTotal: 8 })];
    expect(deduplicateNewEvents(existing, incoming)).toHaveLength(1);
  });

  it('admits both goals of a brace detected in the same poll', () => {
    const incoming = [goal({ statTotal: 4 }), goal({ statTotal: 8 })];
    expect(deduplicateNewEvents([], incoming)).toHaveLength(2);
  });

  it('drops a true duplicate (restart replaying the same delta)', () => {
    const existing = [goal({ statTotal: 4 })];
    const incoming = [goal({ statTotal: 4 })];
    expect(deduplicateNewEvents(existing, incoming)).toHaveLength(0);
  });

  it('admits repeated save points across polls', () => {
    const save = (statTotal: number) => ({
      type: 'saves',
      elementId: 91,
      fixtureId: 7,
      points: 1,
      statTotal,
    });
    const existing = [save(1)];
    const incoming = [save(2)];
    expect(deduplicateNewEvents(existing, incoming)).toHaveLength(1);
  });

  it('admits a lost clean sheet after the gained event', () => {
    const gained = { type: 'team_clean_sheet', teamId: 3, fixtureId: 7, points: 4, statTotal: 4 };
    const lost = { type: 'team_clean_sheet_lost', teamId: 3, fixtureId: 7, points: -4, statTotal: 0 };
    expect(deduplicateNewEvents([gained], [lost])).toHaveLength(1);
  });

  it('still deduplicates within a batch by occurrence count', () => {
    const existing = [goal({ statTotal: 4 })];
    // Restart replay produces the first goal again plus a genuinely new second
    const incoming = [goal({ statTotal: 4 }), goal({ statTotal: 8 })];
    const deduped = deduplicateNewEvents(existing, incoming);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].statTotal).toBe(8);
  });
});
