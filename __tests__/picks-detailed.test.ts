import { describe, it, expect } from 'vitest';
import { fetchManagerPicksDetailed } from '../src/server/services/picks';

// Contract tests for the detailed picks payload after the scoring-core
// migration: callers (week, losers, cup, PitchView) rely on these exact
// field semantics. All FPL fetches are bypassed via bootstrapData/sharedData.

type PlayerSpec = { id: number; pos: number; team: number; pts?: number; mins?: number; bonus?: number };

const POSITIONS: Record<number, number> = {
    1: 1, 2: 2, 3: 2, 4: 2, 5: 2, 6: 3, 7: 3, 8: 3, 9: 3, 10: 4, 11: 4,
    12: 1, 13: 2, 14: 3, 15: 4,
};

function squadSpecs(overrides: Partial<Record<number, Partial<PlayerSpec>>> = {}): PlayerSpec[] {
    return Array.from({ length: 15 }, (_, i) => {
        const id = i + 1;
        return { id, pos: POSITIONS[id], team: id <= 11 ? 1 : 2, pts: 2, mins: 90, ...overrides[id] };
    });
}

function buildData(
    specs: PlayerSpec[],
    opts: { captain?: number; vice?: number; chip?: string | null; hits?: number; fixtures?: any[] } = {},
) {
    const bootstrap = {
        elements: specs.map((s) => ({
            id: s.id,
            element_type: s.pos,
            team: s.team,
            web_name: `P${s.id}`,
            first_name: 'F',
            second_name: `P${s.id}`,
            status: 'a',
            news: '',
        })),
        teams: [
            { id: 1, code: 1, short_name: 'AAA' },
            { id: 2, code: 2, short_name: 'BBB' },
            { id: 3, code: 3, short_name: 'CCC' },
            { id: 4, code: 4, short_name: 'DDD' },
        ],
        element_types: [
            { id: 1, singular_name_short: 'GKP' },
            { id: 2, singular_name_short: 'DEF' },
            { id: 3, singular_name_short: 'MID' },
            { id: 4, singular_name_short: 'FWD' },
        ],
        events: [],
    };
    const liveData = {
        elements: specs.map((s) => ({
            id: s.id,
            stats: { total_points: s.pts ?? 0, minutes: s.mins ?? 90, bonus: s.bonus ?? 0, bps: 0 },
            explain: [],
        })),
    };
    const picks = {
        active_chip: opts.chip ?? null,
        entry_history: { points: 0, event_transfers_cost: opts.hits ?? 0 },
        picks: specs.map((s, idx) => ({
            element: s.id,
            position: idx + 1,
            is_captain: s.id === opts.captain,
            is_vice_captain: s.id === opts.vice,
            multiplier: s.id === opts.captain ? 2 : idx < 11 ? 1 : 0,
        })),
    };
    const fixtures = opts.fixtures ?? [
        { event: 1, team_h: 1, team_a: 3, started: true, finished: true, finished_provisional: true, stats: [] },
        { event: 1, team_h: 2, team_a: 4, started: true, finished: true, finished_provisional: true, stats: [] },
    ];
    return { bootstrap, sharedData: { picks, liveData, fixtures } };
}

describe('fetchManagerPicksDetailed contract', () => {
    it('completed GW: calculatedPoints is gross excl. provisional bonus, hits separate', async () => {
        const specs = squadSpecs({ 6: { pts: 10 } });
        const { bootstrap, sharedData } = buildData(specs, { captain: 6, vice: 7, hits: 4 });
        const result = await fetchManagerPicksDetailed(1, 1, bootstrap, sharedData);

        expect(result.calculatedPoints).toBe(2 * 10 + 10 + 10); // starters + captain extra
        expect(result.totalProvisionalBonus).toBe(0);
        expect(result.pointsOnBench).toBe(8);
        expect(result.transfersCost).toBe(4);
        expect(result.formation).toBe('4-4-2');
        expect(result.autoSubs).toEqual([]);
    });

    it('live GW: provisional bonus is reported separately and captain-multiplied', async () => {
        const specs = squadSpecs({ 6: { pts: 10 } });
        const fixtures = [
            {
                event: 1, team_h: 1, team_a: 3, started: true, finished: false, finished_provisional: false,
                stats: [{ identifier: 'bps', h: [{ element: 6, value: 40 }], a: [] }],
            },
            { event: 1, team_h: 2, team_a: 4, started: true, finished: true, finished_provisional: true, stats: [] },
        ];
        const { bootstrap, sharedData } = buildData(specs, { captain: 6, vice: 7, fixtures });
        const result = await fetchManagerPicksDetailed(1, 1, bootstrap, sharedData);

        expect(result.calculatedPoints).toBe(40); // excl. provisional bonus (10 starters x2 + captain 10x2)
        expect(result.totalProvisionalBonus).toBe(6); // 3 provisional x2 captain
        const p6 = result.players.find((p: any) => p.id === 6);
        expect(p6.provisionalBonus).toBe(3);
    });

    it('applies auto-subs and reports them, VC inherits when captain blanks', async () => {
        const specs = squadSpecs({ 6: { pts: 0, mins: 0 }, 7: { pts: 8 }, 14: { pts: 5 } });
        const { bootstrap, sharedData } = buildData(specs, { captain: 6, vice: 7 });
        const result = await fetchManagerPicksDetailed(1, 1, bootstrap, sharedData);

        // Bench order decides: P13 (first bench outfielder) comes on, not P14
        expect(result.autoSubs).toEqual([{ out: { id: 6, name: 'P6' }, in: { id: 13, name: 'P13' } }]);
        const vc = result.players.find((p: any) => p.id === 7);
        expect(vc.multiplier).toBe(2);
        expect(vc.isCaptain).toBe(true);
        expect(result.originalCaptainId).toBe(6);
        expect(result.originalCaptainName).toBe('P6');
        expect(result.originalViceCaptainId).toBe(7);
        // 9 remaining starters x2 + VC 8x2 + sub-in P13's 2
        expect(result.calculatedPoints).toBe(18 + 16 + 2);
    });

    it('bench boost: bench points inside calculatedPoints, none left on bench-not-counting', async () => {
        const specs = squadSpecs({ 13: { pts: 9 } });
        const { bootstrap, sharedData } = buildData(specs, { captain: 1, vice: 2, chip: 'bboost' });
        const result = await fetchManagerPicksDetailed(1, 1, bootstrap, sharedData);

        expect(result.calculatedPoints).toBe(22 + 2 + (2 + 9 + 2 + 2));
        expect(result.pointsOnBench).toBe(15);
        expect(result.autoSubs).toEqual([]);
        expect(result.activeChip).toBe('bboost');
    });
});
