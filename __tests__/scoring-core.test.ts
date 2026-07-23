import { describe, it, expect } from 'vitest';
import { scoreSquad } from '../src/server/services/scoring-core';

// =============================================================================
// Fixture builders — minimal synthetic FPL payloads
// =============================================================================

type PlayerSpec = {
    id: number;
    pos: number; // element_type: 1 GKP, 2 DEF, 3 MID, 4 FWD
    team: number;
    pts?: number;
    mins?: number;
    bonus?: number; // official bonus already inside pts
};

function buildBootstrap(specs: PlayerSpec[]) {
    return {
        elements: specs.map((s) => ({
            id: s.id,
            element_type: s.pos,
            team: s.team,
            web_name: `P${s.id}`,
        })),
        teams: [],
        events: [],
    };
}

function buildLive(specs: PlayerSpec[]) {
    return {
        elements: specs.map((s) => ({
            id: s.id,
            stats: {
                total_points: s.pts ?? 0,
                minutes: s.mins ?? 90,
                bonus: s.bonus ?? 0,
            },
        })),
    };
}

function buildPicks(
    order: number[],
    opts: { captain?: number; vice?: number; chip?: string | null; hits?: number } = {},
) {
    return {
        active_chip: opts.chip ?? null,
        entry_history: { event_transfers_cost: opts.hits ?? 0 },
        picks: order.map((id, idx) => ({
            element: id,
            position: idx + 1,
            is_captain: id === opts.captain,
            is_vice_captain: id === opts.vice,
            multiplier: id === opts.captain ? 2 : idx < 11 ? 1 : 0,
        })),
    };
}

function finishedFixture(teamH: number, teamA: number) {
    return { team_h: teamH, team_a: teamA, started: true, finished: true, finished_provisional: true, stats: [] };
}

function liveFixture(teamH: number, teamA: number, bps: Array<{ element: number; value: number }> = []) {
    return {
        team_h: teamH,
        team_a: teamA,
        started: true,
        finished: false,
        finished_provisional: false,
        stats: [{ identifier: 'bps', h: bps, a: [] }],
    };
}

// A standard 15-player squad: ids 1-15. Team 1 = players 1-11 (starters),
// team 2 = bench (12 GK, 13-15 outfield). Formation 4-4-2.
const POSITIONS: Record<number, number> = {
    1: 1, // GK
    2: 2, 3: 2, 4: 2, 5: 2, // DEF
    6: 3, 7: 3, 8: 3, 9: 3, // MID
    10: 4, 11: 4, // FWD
    12: 1, // bench GK
    13: 2, 14: 3, 15: 4, // bench outfield
};

function squadSpecs(overrides: Partial<Record<number, Partial<PlayerSpec>>> = {}): PlayerSpec[] {
    return Array.from({ length: 15 }, (_, i) => {
        const id = i + 1;
        return {
            id,
            pos: POSITIONS[id],
            team: id <= 11 ? 1 : 2,
            pts: 2,
            mins: 90,
            ...overrides[id],
        };
    });
}

const ORDER = Array.from({ length: 15 }, (_, i) => i + 1);

function score(specs: PlayerSpec[], picksOpts: Parameters<typeof buildPicks>[1] = {}, fixtures?: any[], scoreOpts?: any) {
    const gwFixtures = fixtures ?? [finishedFixture(1, 3), finishedFixture(2, 4)];
    return scoreSquad(buildPicks(ORDER, picksOpts), buildLive(specs), buildBootstrap(specs), gwFixtures, scoreOpts);
}

// =============================================================================

describe('scoreSquad — basics', () => {
    it('sums starters with captain x2, bench excluded', () => {
        const specs = squadSpecs({ 6: { pts: 10 }, 13: { pts: 7 } });
        const result = score(specs, { captain: 6, vice: 7 });
        // 11 starters x2 pts = 22, captain doubles his 10 → +10, bench excluded
        expect(result.totalPoints).toBe(2 * 10 + 10 + 10);
        expect(result.benchPoints).toBe(2 + 7 + 2 + 2);
        expect(result.autoSubs).toEqual([]);
    });

    it('players carry effectiveContribution that sums exactly to totalPoints', () => {
        const specs = squadSpecs({ 2: { pts: 8 }, 10: { pts: 15 } });
        const result = score(specs, { captain: 10, vice: 6 });
        const sum = result.players.reduce((s, p) => s + p.effectiveContribution, 0);
        expect(sum).toBe(result.totalPoints);
    });

    it('triple captain applies x3', () => {
        const specs = squadSpecs({ 6: { pts: 10 } });
        const result = score(specs, { captain: 6, vice: 7, chip: '3xc' });
        expect(result.totalPoints).toBe(2 * 10 + 10 * 3);
    });

    it('bench boost counts all 15 players at x1 (bench)', () => {
        const specs = squadSpecs({ 13: { pts: 9 } });
        const result = score(specs, { captain: 1, vice: 2, chip: 'bboost' });
        // 11 starters x2 + captain extra 2 + bench (2+9+2+2)
        expect(result.totalPoints).toBe(22 + 2 + 15);
        expect(result.benchPoints).toBe(15);
        expect(result.autoSubs).toEqual([]); // BB disables auto-subs
    });
});

describe('scoreSquad — chip override', () => {
    it('chipOverride: null ignores active_chip', () => {
        const specs = squadSpecs({ 6: { pts: 10 } });
        const withChip = score(specs, { captain: 6, vice: 7, chip: '3xc' });
        const noChip = score(specs, { captain: 6, vice: 7, chip: '3xc' }, undefined, { chipOverride: null });
        expect(withChip.totalPoints - noChip.totalPoints).toBe(10); // x3 vs x2
        expect(noChip.activeChip).toBeNull();
    });

    it('chipOverride can force a chip the picks were not saved under', () => {
        const specs = squadSpecs();
        const forced = score(specs, { captain: 1, vice: 2, chip: null }, undefined, { chipOverride: 'bboost' });
        expect(forced.totalPoints).toBe(22 + 2 + 8); // starters + cap extra + bench
    });
});

describe('scoreSquad — auto-subs', () => {
    it('subs in bench outfielder for a 0-minute starter once all fixtures started', () => {
        const specs = squadSpecs({ 11: { pts: 0, mins: 0 }, 13: { pts: 6 } });
        const result = score(specs, { captain: 1, vice: 2 });
        expect(result.autoSubs).toEqual([{ out: { id: 11, name: 'P11' }, in: { id: 13, name: 'P13' } }]);
        // 10 playing starters x2 + captain extra + subbed-in 6
        expect(result.totalPoints).toBe(20 + 2 + 6);
        const p13 = result.players.find((p) => p.id === 13)!;
        expect(p13.counts).toBe(true);
        expect(p13.effectiveMultiplier).toBe(1);
    });

    it('GK can only be replaced by the bench GK', () => {
        const specs = squadSpecs({ 1: { pts: 0, mins: 0 }, 12: { pts: 3 } });
        const result = score(specs, { captain: 6, vice: 7 });
        expect(result.autoSubs).toEqual([{ out: { id: 1, name: 'P1' }, in: { id: 12, name: 'P12' } }]);
    });

    it('respects formation validity (will not drop below 3 DEF)', () => {
        // 4-4-2 with three DEF at 0 minutes but only one bench DEF available:
        // subs happen in bench order but only while formation stays legal.
        const specs = squadSpecs({
            3: { pts: 0, mins: 0 },
            4: { pts: 0, mins: 0 },
            13: { pts: 4 }, // bench DEF
            14: { pts: 5 }, // bench MID
            15: { pts: 6 }, // bench FWD
        });
        const result = score(specs, { captain: 1, vice: 2 });
        // P3 out → P13 (DEF) in keeps 4 DEF. P4 out → next bench is P14 (MID):
        // 4-1=3 DEF valid, so MID comes on.
        expect(result.autoSubs.length).toBe(2);
        expect(result.autoSubs[0]).toEqual({ out: { id: 3, name: 'P3' }, in: { id: 13, name: 'P13' } });
        expect(result.autoSubs[1]).toEqual({ out: { id: 4, name: 'P4' }, in: { id: 14, name: 'P14' } });
    });

    it('DGW: no auto-sub until ALL of the starter fixtures have started', () => {
        const specs = squadSpecs({ 11: { pts: 0, mins: 0 } });
        // Team 1 has one started and one future fixture
        const fixtures = [
            finishedFixture(1, 3),
            { team_h: 1, team_a: 4, started: false, finished: false, finished_provisional: false, stats: [] },
            finishedFixture(2, 5),
        ];
        const result = score(specs, { captain: 1, vice: 2 }, fixtures);
        expect(result.autoSubs).toEqual([]);
    });

    it('blank GW: 0-minute starter with no fixture is subbed once GW starts', () => {
        const specs = squadSpecs({ 11: { pts: 0, mins: 0, team: 9 } }); // team 9 has no fixture
        specs[10] = { ...specs[10], team: 9 };
        const result = score(specs, { captain: 1, vice: 2 });
        expect(result.autoSubs.length).toBe(1);
        expect(result.autoSubs[0].out.id).toBe(11);
    });
});

describe('scoreSquad — vice-captain inheritance', () => {
    it('VC inherits x2 when captain has 0 minutes', () => {
        const specs = squadSpecs({ 6: { pts: 0, mins: 0 }, 7: { pts: 8 } });
        const result = score(specs, { captain: 6, vice: 7 });
        const vc = result.players.find((p) => p.id === 7)!;
        expect(vc.effectiveMultiplier).toBe(2);
        expect(result.originalCaptainId).toBe(6);
        expect(result.originalViceCaptainId).toBe(7);
    });

    it('VC inherits x3 under triple captain', () => {
        const specs = squadSpecs({ 6: { pts: 0, mins: 0 }, 7: { pts: 8 } });
        const result = score(specs, { captain: 6, vice: 7, chip: '3xc' });
        const vc = result.players.find((p) => p.id === 7)!;
        expect(vc.effectiveMultiplier).toBe(3);
    });

    it('nobody doubles when both captain and VC blank', () => {
        const specs = squadSpecs({ 6: { pts: 0, mins: 0 }, 7: { pts: 0, mins: 0 }, 14: { pts: 1 }, 15: { pts: 1 } });
        const result = score(specs, { captain: 6, vice: 7 });
        expect(result.players.every((p) => p.effectiveMultiplier < 2)).toBe(true);
    });
});

describe('scoreSquad — provisional bonus', () => {
    it('adds provisional bonus during live fixtures, captain-multiplied', () => {
        const specs = squadSpecs({ 6: { pts: 10 }, 2: { pts: 6 } });
        const fixtures = [
            liveFixture(1, 3, [
                { element: 6, value: 40 },
                { element: 2, value: 35 },
            ]),
            finishedFixture(2, 4),
        ];
        const result = score(specs, { captain: 6, vice: 7 }, fixtures);
        // Captain P6 leads BPS → +3 provisional, x2. P2 second → +2.
        expect(result.provisionalBonusPoints).toBe(3 * 2 + 2);
        expect(result.totalPoints).toBe(result.basePoints + result.provisionalBonusPoints);
    });

    it('suppresses provisional bonus once official bonus is in total_points', () => {
        const specs = squadSpecs({ 6: { pts: 13, bonus: 3 } });
        const fixtures = [liveFixture(1, 3, [{ element: 6, value: 40 }]), finishedFixture(2, 4)];
        const result = score(specs, { captain: 1, vice: 2 }, fixtures);
        const p6 = result.players.find((p) => p.id === 6)!;
        expect(p6.provisionalBonus).toBe(0);
    });

    it('bench provisional bonus counts under bench boost', () => {
        const specs = squadSpecs({ 13: { pts: 5, team: 1 } });
        const fixtures = [liveFixture(1, 3, [{ element: 13, value: 40 }]), finishedFixture(2, 4)];
        const result = score(specs, { captain: 1, vice: 2, chip: 'bboost' }, fixtures);
        const p13 = result.players.find((p) => p.id === 13)!;
        expect(p13.provisionalBonus).toBe(3);
        expect(p13.effectiveContribution).toBe(8);
    });

    it('is zero everywhere for fully completed gameweeks', () => {
        const specs = squadSpecs({ 6: { pts: 13, bonus: 3 } });
        const result = score(specs, { captain: 6, vice: 7 });
        expect(result.provisionalBonusPoints).toBe(0);
        expect(result.totalPoints).toBe(result.basePoints);
    });
});

describe('scoreSquad — degenerate inputs', () => {
    it('returns an empty squad when picks or live data are missing', () => {
        expect(scoreSquad(null, null, null, []).totalPoints).toBe(0);
        expect(scoreSquad({ picks: null }, { elements: [] }, { elements: [] }, []).players).toEqual([]);
    });
});
