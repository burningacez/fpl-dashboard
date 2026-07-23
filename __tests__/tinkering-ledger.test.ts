import { describe, it, expect } from 'vitest';
import { scoreSquad, type ScoredSquad } from '../src/server/services/scoring-core';
import { buildTinkeringLedger } from '../src/server/services/tinkering';

// =============================================================================
// Scenario matrix for the tinkering ledger. Every scenario asserts the core
// invariant EXACTLY:
//
//   transfers.total + captaincy.total + bench.total
//     === actual.totalPoints − kept.totalPoints
//
// which is what guarantees the UI breakdown always sums to the headline.
// =============================================================================

type PoolPlayer = { id: number; pos: number; team: number; pts: number; mins: number; bonus?: number };

// Base pool: ids 1-15 (team 1 starters, team 2 bench) + transfer targets 21-24
const BASE_POOL: PoolPlayer[] = [
    { id: 1, pos: 1, team: 1, pts: 2, mins: 90 },
    { id: 2, pos: 2, team: 1, pts: 2, mins: 90 },
    { id: 3, pos: 2, team: 1, pts: 2, mins: 90 },
    { id: 4, pos: 2, team: 1, pts: 2, mins: 90 },
    { id: 5, pos: 2, team: 1, pts: 2, mins: 90 },
    { id: 6, pos: 3, team: 1, pts: 2, mins: 90 },
    { id: 7, pos: 3, team: 1, pts: 2, mins: 90 },
    { id: 8, pos: 3, team: 1, pts: 2, mins: 90 },
    { id: 9, pos: 3, team: 1, pts: 2, mins: 90 },
    { id: 10, pos: 4, team: 1, pts: 2, mins: 90 },
    { id: 11, pos: 4, team: 1, pts: 2, mins: 90 },
    { id: 12, pos: 1, team: 2, pts: 1, mins: 90 },
    { id: 13, pos: 2, team: 2, pts: 1, mins: 90 },
    { id: 14, pos: 3, team: 2, pts: 1, mins: 90 },
    { id: 15, pos: 4, team: 2, pts: 1, mins: 90 },
    { id: 21, pos: 3, team: 3, pts: 12, mins: 90 },
    { id: 22, pos: 4, team: 4, pts: 7, mins: 90 },
    { id: 23, pos: 2, team: 3, pts: 0, mins: 0 },
    { id: 24, pos: 3, team: 4, pts: 5, mins: 90 },
];

function pool(overrides: Partial<Record<number, Partial<PoolPlayer>>> = {}): PoolPlayer[] {
    return BASE_POOL.map((p) => ({ ...p, ...overrides[p.id] }));
}

function bootstrapFor(players: PoolPlayer[]) {
    return {
        elements: players.map((p) => ({ id: p.id, element_type: p.pos, team: p.team, web_name: `P${p.id}` })),
        teams: [],
        events: [],
    };
}

function liveFor(players: PoolPlayer[]) {
    return {
        elements: players.map((p) => ({
            id: p.id,
            stats: { total_points: p.pts, minutes: p.mins, bonus: p.bonus ?? 0 },
        })),
    };
}

function picksFor(order: number[], opts: { captain: number; vice: number; chip?: string | null } = { captain: 1, vice: 2 }) {
    return {
        active_chip: opts.chip ?? null,
        entry_history: {},
        picks: order.map((id, idx) => ({
            element: id,
            position: idx + 1,
            is_captain: id === opts.captain,
            is_vice_captain: id === opts.vice,
            multiplier: id === opts.captain ? 2 : idx < 11 ? 1 : 0,
        })),
    };
}

// Teams 1-4 all play; all finished by default
const FINISHED_FIXTURES = [
    { team_h: 1, team_a: 2, started: true, finished: true, finished_provisional: true, stats: [] },
    { team_h: 3, team_a: 4, started: true, finished: true, finished_provisional: true, stats: [] },
];

const KEPT_ORDER = Array.from({ length: 15 }, (_, i) => i + 1);

function assertInvariant(actual: ScoredSquad, kept: ScoredSquad) {
    const ledger = buildTinkeringLedger(actual, kept);
    const bucketSum = ledger.transfers.total + ledger.captaincy.total + ledger.bench.total;
    expect(bucketSum).toBe(actual.totalPoints - kept.totalPoints);
    return ledger;
}

function score(order: number[], opts: Parameters<typeof picksFor>[1], playerPool: PoolPlayer[], fixtures = FINISHED_FIXTURES, chipOverride?: string | null) {
    const scoreOpts = chipOverride === undefined ? {} : { chipOverride };
    return scoreSquad(picksFor(order, opts), liveFor(playerPool), bootstrapFor(playerPool), fixtures, scoreOpts);
}

describe('tinkering ledger — invariant across scenarios', () => {
    it('identical squads: all buckets zero', () => {
        const p = pool();
        const kept = score(KEPT_ORDER, { captain: 6, vice: 7 }, p);
        const actual = score(KEPT_ORDER, { captain: 6, vice: 7 }, p);
        const ledger = assertInvariant(actual, kept);
        expect(ledger.transfers.total).toBe(0);
        expect(ledger.captaincy.total).toBe(0);
        expect(ledger.bench.total).toBe(0);
        expect(ledger.captaincy.changed).toBe(false);
    });

    it('straight transfer: out P11 (2 pts), in P21 (12 pts)', () => {
        const p = pool();
        const actualOrder = KEPT_ORDER.map((id) => (id === 11 ? 21 : id));
        const kept = score(KEPT_ORDER, { captain: 6, vice: 7 }, p);
        const actual = score(actualOrder, { captain: 6, vice: 7 }, p);
        const ledger = assertInvariant(actual, kept);
        expect(ledger.transfers.total).toBe(12 - 2);
        expect(ledger.transfers.rows).toEqual([
            { id: 21, name: 'P21', delta: 12, direction: 'in', captain: false },
            { id: 11, name: 'P11', delta: -2, direction: 'out', captain: false },
        ]);
        expect(ledger.captaincy.total).toBe(0);
        expect(ledger.bench.total).toBe(0);
    });

    it('captain moved between two kept players', () => {
        const p = pool({ 6: { pts: 10 }, 7: { pts: 4 } });
        const kept = score(KEPT_ORDER, { captain: 7, vice: 6 }, p);
        const actual = score(KEPT_ORDER, { captain: 6, vice: 7 }, p);
        const ledger = assertInvariant(actual, kept);
        // Armband extra moved from P7 (4) to P6 (10): +10 − 4
        expect(ledger.captaincy.total).toBe(6);
        expect(ledger.captaincy.changed).toBe(true);
        expect(ledger.captaincy.oldCaptain).toEqual({ id: 7, name: 'P7' });
        expect(ledger.captaincy.newCaptain).toEqual({ id: 6, name: 'P6' });
        expect(ledger.transfers.total).toBe(0);
        expect(ledger.bench.total).toBe(0);
    });

    it('triple captain + captain change (the old residual-leak case)', () => {
        const p = pool({ 6: { pts: 10 }, 7: { pts: 4 } });
        // Both sides scored under 3xc (kept side gets the chip override)
        const kept = score(KEPT_ORDER, { captain: 7, vice: 6, chip: null }, p, FINISHED_FIXTURES, '3xc');
        const actual = score(KEPT_ORDER, { captain: 6, vice: 7, chip: '3xc' }, p);
        const ledger = assertInvariant(actual, kept);
        // Armband extra is x2 under TC: +2×10 − 2×4
        expect(ledger.captaincy.total).toBe(12);
    });

    it('captain transferred in / old captain transferred out', () => {
        const p = pool({ 21: { pts: 12 } });
        // Kept captain P11 leaves; new player P21 comes in and takes the armband
        const actualOrder = KEPT_ORDER.map((id) => (id === 11 ? 21 : id));
        const kept = score(KEPT_ORDER, { captain: 11, vice: 7 }, p);
        const actual = score(actualOrder, { captain: 21, vice: 7 }, p);
        const ledger = assertInvariant(actual, kept);
        // Base swing lands in transfers; armband swing (12 − 2) in captaincy
        expect(ledger.transfers.total).toBe(12 - 2);
        expect(ledger.captaincy.total).toBe(12 - 2);
        expect(ledger.transfers.rows.find((r) => r.id === 21)?.captain).toBe(true);
    });

    it('lineup change: benched a scorer, started a bench player', () => {
        const p = pool({ 11: { pts: 8 }, 15: { pts: 1 } });
        // Swap P11 (starter) with P15 (bench FWD)
        const actualOrder = KEPT_ORDER.map((id) => (id === 11 ? 15 : id === 15 ? 11 : id));
        const kept = score(KEPT_ORDER, { captain: 6, vice: 7 }, p);
        const actual = score(actualOrder, { captain: 6, vice: 7 }, p);
        const ledger = assertInvariant(actual, kept);
        expect(ledger.bench.total).toBe(1 - 8);
        expect(ledger.bench.rows).toEqual(
            expect.arrayContaining([
                { id: 15, name: 'P15', delta: 1, tag: 'started' },
                { id: 11, name: 'P11', delta: -8, tag: 'benched' },
            ]),
        );
    });

    it('captain benched: VC inherits on the actual side only', () => {
        const p = pool({ 6: { pts: 10 }, 7: { pts: 4 }, 14: { pts: 1 } });
        // Manager benches captain P6 (swaps with bench MID P14) but leaves the armband on P6.
        // P6 on the bench doesn't play the armband — VC P7 inherits on the actual side.
        const actualOrder = KEPT_ORDER.map((id) => (id === 6 ? 14 : id === 14 ? 6 : id));
        const kept = score(KEPT_ORDER, { captain: 6, vice: 7 }, p);
        const actual = score(actualOrder, { captain: 6, vice: 7 }, p);
        assertInvariant(actual, kept);
    });

    it('auto-sub cascade differs for an untouched kept player', () => {
        // P23-style blank: make starter P11 blank (0 mins) in both squads, but
        // the actual side transferred away the first bench outfielder P13 so
        // the cascade brings on P14 instead — P14's delta lands in bench bucket
        const p = pool({ 11: { pts: 0, mins: 0 }, 13: { pts: 3 }, 14: { pts: 5 }, 24: { pts: 0, mins: 0 } });
        const actualOrder = KEPT_ORDER.map((id) => (id === 13 ? 24 : id)); // P13 -> P24 (also blanks)
        const kept = score(KEPT_ORDER, { captain: 6, vice: 7 }, p);
        const actual = score(actualOrder, { captain: 6, vice: 7 }, p);
        const ledger = assertInvariant(actual, kept);
        // Kept: P13 subs in (+3). Actual: P24 blanks, P14 subs in (+5).
        // P14's +5 vs 0 shows as an autoSub row.
        expect(ledger.bench.rows).toEqual(
            expect.arrayContaining([{ id: 14, name: 'P14', delta: 5, tag: 'autoSub' }]),
        );
    });

    it('bench boost: bench deltas count on both sides', () => {
        const p = pool({ 13: { pts: 6 }, 15: { pts: 4 } });
        // Transfer bench player P15 -> P22 under Bench Boost
        const actualOrder = KEPT_ORDER.map((id) => (id === 15 ? 22 : id));
        const kept = score(KEPT_ORDER, { captain: 6, vice: 7, chip: null }, p, FINISHED_FIXTURES, 'bboost');
        const actual = score(actualOrder, { captain: 6, vice: 7, chip: 'bboost' }, p);
        const ledger = assertInvariant(actual, kept);
        // Bench transfer matters under BB: out P15 (4), in P22 (7)
        expect(ledger.transfers.total).toBe(7 - 4);
    });

    it('live GW: provisional bonus flows through both sides symmetrically', () => {
        const p = pool({ 6: { pts: 10 }, 21: { pts: 12 } });
        const liveFixtures = [
            {
                team_h: 1, team_a: 2, started: true, finished: false, finished_provisional: false,
                stats: [{ identifier: 'bps', h: [{ element: 6, value: 40 }], a: [] }],
            },
            {
                team_h: 3, team_a: 4, started: true, finished: false, finished_provisional: false,
                stats: [{ identifier: 'bps', h: [{ element: 21, value: 38 }], a: [] }],
            },
        ];
        // Transfer in P21 (gets +3 provisional) and keep captain P6 (+3 provisional)
        const actualOrder = KEPT_ORDER.map((id) => (id === 11 ? 21 : id));
        const kept = score(KEPT_ORDER, { captain: 6, vice: 7 }, p, liveFixtures);
        const actual = score(actualOrder, { captain: 6, vice: 7 }, p, liveFixtures);
        const ledger = assertInvariant(actual, kept);
        // P21 contributes 12+3 provisional; P11 would have contributed 2
        expect(ledger.transfers.total).toBe(15 - 2);
        // Captain P6 identical on both sides — no captaincy noise
        expect(ledger.captaincy.total).toBe(0);
    });

    it('blank GW for one team: no-game starters handled identically on both sides', () => {
        // Team 4 has no fixture; P22 (team 4) is in the actual squad
        const p = pool({ 22: { pts: 0, mins: 0 } });
        const fixtures = [
            { team_h: 1, team_a: 2, started: true, finished: true, finished_provisional: true, stats: [] },
            { team_h: 3, team_a: 5, started: true, finished: true, finished_provisional: true, stats: [] },
        ];
        const actualOrder = KEPT_ORDER.map((id) => (id === 11 ? 22 : id));
        const kept = score(KEPT_ORDER, { captain: 6, vice: 7 }, p, fixtures);
        const actual = score(actualOrder, { captain: 6, vice: 7 }, p, fixtures);
        const ledger = assertInvariant(actual, kept);
        // P22 blanks (no game, auto-subbed) — transfer shows the true swing vs P11's 2 pts
        expect(ledger.transfers.rows.find((r) => r.id === 22)?.delta).toBe(0);
    });
});
