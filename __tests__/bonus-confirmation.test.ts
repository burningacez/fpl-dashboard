import { describe, it, expect } from 'vitest';
import { hasRemainingFixtures } from '../src/lib/utils';
import { bonusCheckInterval } from '../src/server/live/scheduler';

// A gameweek spread over Friday to Monday ends a match window five or six
// times. The bonus watch that follows a window is a refresh loop running for
// up to 12 hours, so it must start only after the LAST window — `finished`
// cannot flip while fixtures are still to be played.
describe('hasRemainingFixtures', () => {
    const now = new Date('2026-09-19T18:00:00Z');

    it('reports football to come when a later fixture in the GW is unplayed', () => {
        const fixtures = [
            { event: 6, finished_provisional: true, kickoff_time: '2026-09-19T14:00:00Z' },
            { event: 6, finished_provisional: false, kickoff_time: '2026-09-21T19:00:00Z' }, // Monday night
        ];
        expect(hasRemainingFixtures(fixtures, 6, now)).toBe(true);
    });

    it('reports none once every fixture in the GW has been played', () => {
        const fixtures = [
            { event: 6, finished_provisional: true, kickoff_time: '2026-09-18T19:00:00Z' },
            { event: 6, finished_provisional: true, kickoff_time: '2026-09-19T14:00:00Z' },
        ];
        expect(hasRemainingFixtures(fixtures, 6, now)).toBe(false);
    });

    it('ignores another gameweek s fixtures', () => {
        const fixtures = [
            { event: 6, finished_provisional: true, kickoff_time: '2026-09-19T14:00:00Z' },
            { event: 7, finished_provisional: false, kickoff_time: '2026-09-26T14:00:00Z' },
        ];
        expect(hasRemainingFixtures(fixtures, 6, now)).toBe(false);
    });

    // The reason this is clock-based rather than flag-based: a postponed
    // fixture never flips finished_provisional, and treating it as pending
    // would defer confirmation forever, freezing the gameweek's final numbers.
    it('does not treat a postponed fixture as football still to come', () => {
        const fixtures = [
            { event: 6, finished_provisional: true, kickoff_time: '2026-09-19T14:00:00Z' },
            { event: 6, finished_provisional: false, kickoff_time: '2026-09-19T11:30:00Z' }, // never played
        ];
        expect(hasRemainingFixtures(fixtures, 6, now)).toBe(false);
    });

    it('treats a fixture kicking off right now as still to come', () => {
        const fixtures = [
            { event: 6, finished_provisional: false, kickoff_time: '2026-09-19T17:30:00Z' },
        ];
        expect(hasRemainingFixtures(fixtures, 6, now)).toBe(true);
    });

    it('ignores a fixture with no kickoff time', () => {
        expect(hasRemainingFixtures([{ event: 6, finished_provisional: false, kickoff_time: null }], 6, now)).toBe(false);
    });
});

describe('bonusCheckInterval', () => {
    const MIN = 60 * 1000;

    it('widens as the wait goes on', () => {
        expect(bonusCheckInterval(0)).toBe(5 * MIN);
        expect(bonusCheckInterval(30 * MIN)).toBe(5 * MIN);
        expect(bonusCheckInterval(90 * MIN)).toBe(15 * MIN);
        expect(bonusCheckInterval(4 * 60 * MIN)).toBe(30 * MIN);
    });

    // The overnight wait is the common case, and the one that used to cost the
    // most: a 12-hour watch at the old flat cadence ran ~160 full refreshes.
    it('keeps an overnight wait to a few dozen checks', () => {
        let elapsed = 0;
        let checks = 0;
        while (elapsed < 12 * 60 * MIN) {
            elapsed += bonusCheckInterval(elapsed);
            checks++;
        }
        expect(checks).toBeLessThan(40);
    });
});
