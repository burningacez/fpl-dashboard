import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ currentSeason: { value: '2026-27' } }));

vi.mock('../src/server/redis', () => ({
    redisGet: vi.fn(async () => null),
    redisSet: vi.fn(async () => true),
    redisConfigured: () => true,
}));
vi.mock('../src/server/season-state', () => ({
    getCurrentSeason: () => mocks.currentSeason.value,
    getActiveSeasonConfig: () => ({ leagueId: 619028 }),
    getLeagueId: () => 619028,
}));

import { archivedSeasons } from '../src/server/data-cache';
import { getArchivedWeek } from '../src/server/services/archived-week';
import { bakeOverallTotals } from '../src/lib/overall-totals';

beforeEach(() => {
    mocks.currentSeason.value = '2026-27';
    for (const k of Object.keys(archivedSeasons)) delete archivedSeasons[k];

    const weekHistory: Record<string, any> = {
        1: { viewingGW: 1, managers: [{ entryId: 1, name: 'Barry', gwScore: 50 }, { entryId: 2, name: 'Grant', gwScore: 60 }] },
        2: { viewingGW: 2, managers: [{ entryId: 1, name: 'Barry', gwScore: 70 }, { entryId: 2, name: 'Grant', gwScore: 40 }] },
        3: { viewingGW: 3, managers: [{ entryId: 1, name: 'Barry', gwScore: 30 }, { entryId: 2, name: 'Grant', gwScore: 30 }] },
    };
    // Simulate what load/archive does: materialise the static totals once.
    bakeOverallTotals(weekHistory, {
        finalGW: 3,
        finalStandings: [{ entryId: 1, netScore: 200, rank: 1 }, { entryId: 2, netScore: 180, rank: 2 }],
    });
    archivedSeasons['2025-26'] = { weekHistory, finalGW: 3, standings: { standings: [] } };
});

describe('getArchivedWeek (static lookup)', () => {
    it('returns the pre-baked running Total for a mid-season gameweek', () => {
        const res = getArchivedWeek('2025-26', 2);
        const byId = new Map<number, any>(res.managers.map((m: any) => [m.entryId, m]));
        expect(byId.get(1)).toMatchObject({ overallPoints: 120, overallRank: 1 });
        expect(byId.get(2)).toMatchObject({ overallPoints: 100, overallRank: 2 });
        expect(res.viewingGW).toBe(2);
        expect(res.availableGWs).toEqual([1, 2, 3]);
    });

    it('returns the authoritative final standings for the final gameweek', () => {
        const res = getArchivedWeek('2025-26', 3);
        const byId = new Map<number, any>(res.managers.map((m: any) => [m.entryId, m]));
        expect(byId.get(1)).toMatchObject({ overallPoints: 200, overallRank: 1 });
        expect(byId.get(2)).toMatchObject({ overallPoints: 180, overallRank: 2 });
    });

    it('defaults to the final GW when none is requested', () => {
        const res = getArchivedWeek('2025-26');
        expect(res.viewingGW).toBe(3);
        expect(res.currentGW).toBe(3);
    });

    it('reports missing week history', () => {
        const res = getArchivedWeek('2099-00', 5);
        expect(res.error).toBeTruthy();
    });
});
