import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    league: null as any,
    bootstrap: { events: [] as any[] } as any,
    fixtures: [] as any[],
    completedGWs: [] as number[],
    history: new Map<number, any>(),
    historyThrows: new Set<number>(),
}));

vi.mock('../src/server/redis', () => ({
    redisGet: vi.fn(async () => null),
    redisSet: vi.fn(async () => true),
    redisConfigured: () => true,
}));
vi.mock('../src/server/season-state', () => ({
    getCurrentSeason: () => '2025-26',
    getActiveSeasonConfig: () => ({ leagueId: 619028 }),
    getLeagueId: () => 619028,
}));
vi.mock('../src/server/fpl/client', () => ({
    fetchLeagueData: vi.fn(async () => mocks.league),
    fetchBootstrap: vi.fn(async () => mocks.bootstrap),
    fetchFixtures: vi.fn(async () => mocks.fixtures),
    getCompletedGameweeks: vi.fn(() => mocks.completedGWs),
    fetchManagerHistory: vi.fn(async (entry: number) => {
        if (mocks.historyThrows.has(entry)) throw new Error(`HTTP 404 for entry ${entry}`);
        return mocks.history.get(entry);
    }),
}));

import { fetchFormData } from '../src/server/services/form';
import { dataCache } from '../src/server/data-cache';

function mkHistory(entries: Array<{ event: number; total_points: number; event_transfers?: number; event_transfers_cost?: number }>) {
    return {
        current: entries.map((e) => ({
            event: e.event,
            total_points: e.total_points,
            event_transfers: e.event_transfers ?? 0,
            event_transfers_cost: e.event_transfers_cost ?? 0,
        })),
    };
}

beforeEach(() => {
    mocks.league = { league: { name: 'Si and chums' }, standings: { results: [
        { entry: 1, player_name: 'Barry', entry_name: 'Team B' },
        { entry: 2, player_name: 'Grant', entry_name: 'Team G' },
    ] } };
    mocks.bootstrap = { events: [] };
    mocks.fixtures = [];
    mocks.completedGWs = [1, 2, 3];
    mocks.historyThrows.clear();
    mocks.history = new Map<number, any>([
        [1, mkHistory([{ event: 1, total_points: 50 }, { event: 2, total_points: 110 }, { event: 3, total_points: 150 }])],
        [2, mkHistory([{ event: 1, total_points: 60 }, { event: 2, total_points: 100 }, { event: 3, total_points: 130 }])],
    ]);
    dataCache.formResultsCache = {};
    dataCache.weekHistoryCache = {};
    dataCache.league = mocks.league;
});

describe('fetchFormData — static path (materialised week history)', () => {
    beforeEach(() => {
        // Completed GWs are read-only, so form serves from stored per-GW rows.
        dataCache.weekHistoryCache = {
            2: { managers: [
                { entryId: 1, name: 'Barry', team: 'Team B', gwScore: 60, transferCost: 0, transfers: 1 },
                { entryId: 2, name: 'Grant', team: 'Team G', gwScore: 40, transferCost: 4, transfers: 2 },
            ] },
            3: { managers: [
                { entryId: 1, name: 'Barry', team: 'Team B', gwScore: 40, transferCost: 0, transfers: 0 },
                { entryId: 2, name: 'Grant', team: 'Team G', gwScore: 30, transferCost: 0, transfers: 1 },
            ] },
        };
    });

    it('sums net/gross/transfers over the window without touching the FPL API', async () => {
        const client: any = await import('../src/server/fpl/client');
        const res = await fetchFormData(2, null); // GWs 2..3
        const byId = new Map(res.form.map((f: any) => [f.entryId, f]));
        // Barry: net 60+40=100, cost 0, transfers 1
        expect(byId.get(1)).toMatchObject({ netScore: 100, grossScore: 100, transferCost: 0, transfers: 1, rank: 1 });
        // Grant: net 40+30=70, cost 4 → gross 74, transfers 3
        expect(byId.get(2)).toMatchObject({ netScore: 70, grossScore: 74, transferCost: 4, transfers: 3, rank: 2 });
        expect(client.fetchManagerHistory).not.toHaveBeenCalled();
    });

    it('honours the asof window bound', async () => {
        const res = await fetchFormData(5, 2); // only GW2 eligible
        expect(res.gwRange).toEqual([2]);
        const byId = new Map(res.form.map((f: any) => [f.entryId, f]));
        expect(byId.get(1)!.netScore).toBe(60);
    });
});

describe('fetchFormData — live fallback (nothing materialised yet)', () => {
    it('computes net form over the window from total_points deltas', async () => {
        const res = await fetchFormData(2, null);
        const byId = new Map(res.form.map((f: any) => [f.entryId, f]));
        expect(byId.get(1)!.netScore).toBe(100); // 150 - 50
        expect(byId.get(2)!.netScore).toBe(70); // 130 - 60
        expect(byId.get(1)!.rank).toBe(1);
    });

    it('does not throw when a single manager history fetch fails', async () => {
        mocks.historyThrows.add(2);
        const res = await fetchFormData(2, null);
        const byId = new Map(res.form.map((f: any) => [f.entryId, f]));
        expect(byId.get(1)!.netScore).toBe(100);
        expect(byId.get(2)!.netScore).toBe(0);
        expect(res.form.length).toBe(2);
    });

    it('tolerates a league payload missing its league object', async () => {
        mocks.league = { standings: { results: [] } };
        mocks.completedGWs = [];
        const res = await fetchFormData(5, null);
        expect(res.leagueName).toBe('');
        expect(res.form).toEqual([]);
    });
});
