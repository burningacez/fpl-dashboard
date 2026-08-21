/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The week table's Total column during a live gameweek.
 *
 * overallPoints = (prior GWs' net total) + (live calculated gwScore). The
 * "prior total" is derived from entry_history, with a fallback to the league
 * standings total for the window where entry_history isn't populated yet.
 *
 * Regression: in GW1 the prior total is legitimately 0, and once FPL banks
 * the first match day the league standings total IS the GW1 score — the
 * fallback fired anyway and every Total showed double the GW score.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/server/redis', () => ({
    redisGet: vi.fn(async () => null),
    redisSet: vi.fn(async () => true),
    redisConfigured: () => false,
}));

vi.mock('../src/server/season-state', () => ({
    getCurrentSeason: () => '2026-27',
    getActiveSeasonConfig: () => ({ id: '2026-27', leagueId: 1, attackingTiebreakers: false }),
    getLeagueId: () => 1,
}));

// Per-test fixtures, mutated in beforeEach / individual tests.
const fpl = vi.hoisted(() => ({
    currentGW: 1,
    leagueTotals: {} as Record<number, number>, // standings.results[].total per entry
    entryHistories: {} as Record<number, any>, // picks.entry_history per entry
    managerHistories: {} as Record<number, any>, // /entry/{id}/history per entry
}));

const managers = [
    { entry: 1, player_name: 'Barry', entry_name: 'Team Barry', rank: 1 },
    { entry: 2, player_name: 'Grant', entry_name: 'Team Grant', rank: 2 },
];

vi.mock('../src/server/fpl/client', () => ({
    fetchLeagueData: async () => ({
        league: { name: 'Test League' },
        standings: {
            results: managers.map((m) => ({ ...m, total: fpl.leagueTotals[m.entry] ?? 0 })),
        },
    }),
    fetchBootstrap: async () => ({
        events: [
            { id: 1, is_current: fpl.currentGW === 1, is_next: false, finished: false, deadline_time: '2026-08-15T17:30:00Z' },
            { id: 2, is_current: fpl.currentGW === 2, is_next: fpl.currentGW === 1, finished: false, deadline_time: '2026-08-22T17:30:00Z' },
        ],
        elements: [],
        teams: [
            { id: 1, name: 'Home FC', short_name: 'HOM' },
            { id: 2, name: 'Away FC', short_name: 'AWY' },
        ],
    }),
    // One live (started, unfinished) fixture in the current GW.
    fetchFixtures: async () => [
        {
            id: 100 + fpl.currentGW,
            event: fpl.currentGW,
            team_h: 1,
            team_a: 2,
            started: true,
            finished: false,
            finished_provisional: false,
            kickoff_time: '2026-08-15T19:00:00Z',
            minutes: 30,
            team_h_score: 0,
            team_a_score: 0,
            stats: [],
        },
    ],
    fetchLiveGWData: async () => ({ elements: [] }),
    fetchManagerPicks: async (entryId: number) => ({
        picks: [],
        active_chip: null,
        automatic_subs: [],
        entry_history: fpl.entryHistories[entryId] ?? null,
    }),
    fetchManagerHistory: async (entryId: number) => fpl.managerHistories[entryId] ?? { current: [], chips: [] },
    fetchManagerData: async () => ({}),
    sanitizeCachedNames: (x: any) => x,
}));

// The live GW score itself is scoring-core territory (covered elsewhere);
// here it's pinned per entry so the prior-total arithmetic is what's tested.
const calculatedByEntry: Record<number, number> = {};
vi.mock('../src/server/services/picks', () => ({
    fetchManagerPicksDetailed: async (entryId: number) => ({
        calculatedPoints: calculatedByEntry[entryId] ?? 0,
        totalProvisionalBonus: 0,
        transfersCost: 0,
        pointsOnBench: 0,
        players: [],
    }),
}));

import { fetchWeekData } from '../src/server/services/week';
import { dataCache } from '../src/server/data-cache';
import { liveState } from '../src/server/live/state';

function gwRow(event: number, points: number, totalPoints: number) {
    return { event, points, total_points: totalPoints, value: 1000, bank: 0, event_transfers: 0, event_transfers_cost: 0 };
}

beforeEach(() => {
    dataCache.processedPicksCache = {};
    dataCache.liveDataCache = {};
    dataCache.losers = null;
    dataCache.motm = null;
    liveState.liveEventState.lastGW = null;
    liveState.previousPlayerState = {};
    liveState.previousBonusPositions = {};
    liveState.chronologicalEvents = [];
});

describe('week table Total during a live gameweek', () => {
    it('GW1: Total equals the GW score even after FPL banks match-day points into the standings', async () => {
        fpl.currentGW = 1;
        // FPL has processed Saturday's matches: the classic-league standings
        // total already contains the GW1 points scored so far.
        fpl.leagueTotals = { 1: 66, 2: 45 };
        fpl.entryHistories = {
            1: { points: 66, total_points: 66, event_transfers: 0, event_transfers_cost: 0 },
            2: { points: 45, total_points: 45, event_transfers: 0, event_transfers_cost: 0 },
        };
        fpl.managerHistories = {
            1: { current: [gwRow(1, 66, 66)], chips: [] },
            2: { current: [gwRow(1, 45, 45)], chips: [] },
        };
        calculatedByEntry[1] = 66;
        calculatedByEntry[2] = 45;

        const week = await fetchWeekData();
        const byId = new Map<number, any>(week.managers.map((m: any) => [m.entryId, m]));

        // The regression showed 132 and 90 here — the GW score counted twice.
        expect(byId.get(1)).toMatchObject({ gwScore: 66, overallPoints: 66 });
        expect(byId.get(2)).toMatchObject({ gwScore: 45, overallPoints: 45 });
    });

    it('GW1: Total tracks the live score before the standings have any points', async () => {
        fpl.currentGW = 1;
        fpl.leagueTotals = { 1: 0, 2: 0 };
        fpl.entryHistories = {
            1: { points: 12, total_points: 12, event_transfers: 0, event_transfers_cost: 0 },
            2: { points: 8, total_points: 8, event_transfers: 0, event_transfers_cost: 0 },
        };
        fpl.managerHistories = {
            1: { current: [gwRow(1, 12, 12)], chips: [] },
            2: { current: [gwRow(1, 8, 8)], chips: [] },
        };
        calculatedByEntry[1] = 12;
        calculatedByEntry[2] = 8;

        const week = await fetchWeekData();
        const byId = new Map<number, any>(week.managers.map((m: any) => [m.entryId, m]));
        expect(byId.get(1)).toMatchObject({ gwScore: 12, overallPoints: 12 });
        expect(byId.get(2)).toMatchObject({ gwScore: 8, overallPoints: 8 });
    });

    it('GW2+: still falls back to the standings total while entry_history is empty', async () => {
        fpl.currentGW = 2;
        // Deadline passed, entry_history not populated yet; the standings
        // total holds the season points through GW1.
        fpl.leagueTotals = { 1: 66, 2: 45 };
        fpl.entryHistories = { 1: null, 2: null };
        fpl.managerHistories = {
            1: { current: [gwRow(1, 66, 66)], chips: [] },
            2: { current: [gwRow(1, 45, 45)], chips: [] },
        };
        calculatedByEntry[1] = 20;
        calculatedByEntry[2] = 10;

        const week = await fetchWeekData();
        const byId = new Map<number, any>(week.managers.map((m: any) => [m.entryId, m]));
        expect(byId.get(1)).toMatchObject({ gwScore: 20, overallPoints: 86 });
        expect(byId.get(2)).toMatchObject({ gwScore: 10, overallPoints: 55 });
    });

    it('GW2+: uses entry_history arithmetic once it exists', async () => {
        fpl.currentGW = 2;
        fpl.leagueTotals = { 1: 66, 2: 45 };
        fpl.entryHistories = {
            1: { points: 20, total_points: 86, event_transfers: 0, event_transfers_cost: 0 },
            2: { points: 10, total_points: 55, event_transfers: 0, event_transfers_cost: 0 },
        };
        fpl.managerHistories = {
            1: { current: [gwRow(1, 66, 66), gwRow(2, 20, 86)], chips: [] },
            2: { current: [gwRow(1, 45, 45), gwRow(2, 10, 55)], chips: [] },
        };
        // Live calculation ahead of the API (e.g. provisional auto-sub): the
        // Total column should reflect the adjusted GW score.
        calculatedByEntry[1] = 25;
        calculatedByEntry[2] = 10;

        const week = await fetchWeekData();
        const byId = new Map<number, any>(week.managers.map((m: any) => [m.entryId, m]));
        expect(byId.get(1)).toMatchObject({ gwScore: 25, overallPoints: 91 });
        expect(byId.get(2)).toMatchObject({ gwScore: 10, overallPoints: 55 });
    });
});
