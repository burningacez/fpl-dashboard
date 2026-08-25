import { describe, it, expect } from 'vitest';
import { hasUnfrozenWork, canRebuildOnDeploy } from '../src/lib/refresh-freeze';

const now = new Date('2026-07-23T09:00:00Z');
const past = '2026-05-01T10:00:00Z';
const future = '2026-08-15T10:00:00Z';

// Helper: a finished season (all 38 done), the July API-reset shape.
function concludedSeasonEvents() {
    return Array.from({ length: 38 }, (_, i) => ({ id: i + 1, finished: true, is_current: i === 37, deadline_time: past }));
}

describe('hasUnfrozenWork', () => {
    it('freezes a fully-concluded, fully-captured season (nothing to recompute)', () => {
        const events = concludedSeasonEvents();
        const completedGWs = events.map((e) => e.id);
        const processedGWs = completedGWs; // every GW already captured
        expect(hasUnfrozenWork({ events, completedGWs, processedGWs, now })).toBe(false);
    });

    it('freezes when the FPL API has reset to a not-yet-started new season', () => {
        // New-season pre-season: events exist but none finished, none current/live.
        const events = Array.from({ length: 38 }, (_, i) => ({ id: i + 1, finished: false, is_current: false, deadline_time: future }));
        expect(hasUnfrozenWork({ events, completedGWs: [], processedGWs: [], now })).toBe(false);
    });

    it('runs while a gameweek is live (deadline passed, not finished)', () => {
        const events = concludedSeasonEvents();
        events[37] = { id: 38, finished: false, is_current: true, deadline_time: past };
        expect(hasUnfrozenWork({ events, completedGWs: [], processedGWs: [], now })).toBe(true);
    });

    it('runs while a completed gameweek is still settling its bonus', () => {
        const events = concludedSeasonEvents();
        events[37] = { id: 38, finished: false, is_current: true, deadline_time: past }; // provisional
        // GW38 provisionally complete but not officially finished
        expect(hasUnfrozenWork({ events, completedGWs: [38], processedGWs: [38], now })).toBe(true);
    });

    it('runs when a completed gameweek has not been captured yet', () => {
        const events = concludedSeasonEvents();
        expect(hasUnfrozenWork({ events, completedGWs: [1, 2, 3], processedGWs: [1, 2], now })).toBe(true);
    });

    it('freezes once the newly-completed gameweek has been captured', () => {
        const events = concludedSeasonEvents();
        expect(hasUnfrozenWork({ events, completedGWs: [1, 2, 3], processedGWs: [1, 2, 3], now })).toBe(false);
    });
});

describe('canRebuildOnDeploy', () => {
    const totalWeeks = 38;

    it('rebuilds mid-season, including in a frozen window between gameweeks', () => {
        // GW1 done and settled: exactly when the freeze guard would otherwise
        // keep a scoring fix off the page until GW2 kicked off.
        expect(canRebuildOnDeploy({ storedGameweeks: 1, liveCompletedGameweeks: 1, totalWeeks })).toBe(true);
        expect(canRebuildOnDeploy({ storedGameweeks: 20, liveCompletedGameweeks: 20, totalWeeks })).toBe(true);
    });

    it('rebuilds on a first-ever deploy with nothing stored', () => {
        expect(canRebuildOnDeploy({ storedGameweeks: 0, liveCompletedGameweeks: 0, totalWeeks })).toBe(true);
    });

    it('rebuilds when a gameweek has completed since the last stored one', () => {
        expect(canRebuildOnDeploy({ storedGameweeks: 5, liveCompletedGameweeks: 6, totalWeeks })).toBe(true);
    });

    it('refuses to recompute a finished season', () => {
        // Its numbers settled real money — they must never move again.
        expect(canRebuildOnDeploy({ storedGameweeks: 38, liveCompletedGameweeks: 38, totalWeeks })).toBe(false);
    });

    it('refuses when the FPL API has reset for the next season', () => {
        // July: we hold a full season, the API serves a fresh one with nothing
        // played. Rebuilding would overwrite our season with another's data.
        expect(canRebuildOnDeploy({ storedGameweeks: 38, liveCompletedGameweeks: 0, totalWeeks })).toBe(false);
    });

    it('refuses whenever the API reports fewer gameweeks than we hold', () => {
        // Same reset seen later, or before rollover was run: the API is behind
        // our own record, so it isn't serving the season we stored.
        expect(canRebuildOnDeploy({ storedGameweeks: 20, liveCompletedGameweeks: 0, totalWeeks })).toBe(false);
        expect(canRebuildOnDeploy({ storedGameweeks: 20, liveCompletedGameweeks: 3, totalWeeks })).toBe(false);
    });

    it('honours a season config with a different length', () => {
        expect(canRebuildOnDeploy({ storedGameweeks: 30, liveCompletedGameweeks: 30, totalWeeks: 30 })).toBe(false);
        expect(canRebuildOnDeploy({ storedGameweeks: 29, liveCompletedGameweeks: 29, totalWeeks: 30 })).toBe(true);
    });
});
