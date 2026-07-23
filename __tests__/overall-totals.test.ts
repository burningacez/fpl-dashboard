import { describe, it, expect } from 'vitest';
import { bakeOverallTotals } from '../src/lib/overall-totals';

// A 3-GW mini history: the lead flips between GW1 and GW2.
function mkHistory(): Record<string, any> {
    return {
        1: { viewingGW: 1, managers: [{ entryId: 1, gwScore: 50 }, { entryId: 2, gwScore: 60 }] },
        2: { viewingGW: 2, managers: [{ entryId: 1, gwScore: 70 }, { entryId: 2, gwScore: 40 }] },
        3: { viewingGW: 3, managers: [{ entryId: 1, gwScore: 30 }, { entryId: 2, gwScore: 30 }] },
    };
}

describe('bakeOverallTotals', () => {
    it('writes a running cumulative Total + rank onto every gameweek', () => {
        const wh = mkHistory();
        expect(bakeOverallTotals(wh)).toBe(true);

        // GW1: manager 2 leads (60 vs 50)
        const gw1 = new Map(wh[1].managers.map((m: any) => [m.entryId, m]));
        expect(gw1.get(1)).toMatchObject({ overallPoints: 50, overallRank: 2 });
        expect(gw1.get(2)).toMatchObject({ overallPoints: 60, overallRank: 1 });

        // GW2: manager 1 overtakes (120 vs 100)
        const gw2 = new Map(wh[2].managers.map((m: any) => [m.entryId, m]));
        expect(gw2.get(1)).toMatchObject({ overallPoints: 120, overallRank: 1 });
        expect(gw2.get(2)).toMatchObject({ overallPoints: 100, overallRank: 2 });

        // GW3: 150 vs 130
        const gw3 = new Map(wh[3].managers.map((m: any) => [m.entryId, m]));
        expect(gw3.get(1)!.overallPoints).toBe(150);
        expect(gw3.get(2)!.overallPoints).toBe(130);
    });

    it('overrides the final GW with the authoritative standings snapshot', () => {
        const wh = mkHistory();
        bakeOverallTotals(wh, {
            finalGW: 3,
            finalStandings: [
                { entryId: 1, netScore: 200, rank: 1 },
                { entryId: 2, netScore: 180, rank: 2 },
            ],
        });
        const gw3 = new Map(wh[3].managers.map((m: any) => [m.entryId, m]));
        expect(gw3.get(1)).toMatchObject({ overallPoints: 200, overallRank: 1 });
        expect(gw3.get(2)).toMatchObject({ overallPoints: 180, overallRank: 2 });
        // Earlier GWs still use the running sum
        const gw2 = new Map(wh[2].managers.map((m: any) => [m.entryId, m]));
        expect(gw2.get(1)!.overallPoints).toBe(120);
    });

    it('is a no-op on empty/missing history', () => {
        expect(bakeOverallTotals(null)).toBe(false);
        expect(bakeOverallTotals({})).toBe(false);
    });

    it('is idempotent (re-running yields the same values)', () => {
        const wh = mkHistory();
        bakeOverallTotals(wh);
        bakeOverallTotals(wh);
        const gw2 = new Map(wh[2].managers.map((m: any) => [m.entryId, m]));
        expect(gw2.get(1)!.overallPoints).toBe(120);
    });
});
