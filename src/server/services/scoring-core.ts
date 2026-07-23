/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { isValidFormation, getEffectiveFormationCounts } from '../../lib/formation';
import { resolveEffectiveCaptaincy } from '../../lib/utils';

// =============================================================================
// SHARED SCORING CORE
//
// Single source of truth for turning a picks payload + live GW data into an
// effective squad score: provisional bonus, auto-subs, effective captaincy
// (VC inheritance) and chip handling all live here. The legacy entry points
// (calculatePointsWithAutoSubs, calculateHypotheticalScore,
// fetchManagerPicksDetailed) are wrappers/decorators over scoreSquad so every
// surface of the app counts points the same way.
// =============================================================================

export interface ScoredPlayer {
    // Index signature so ScoredPlayer satisfies the loose PositionedPlayer /
    // CaptaincyPlayer shapes used by the shared formation/captaincy helpers.
    [key: string]: unknown;
    id: number;
    name: string;
    positionId: number;
    points: number; // raw live total_points (official bonus included once confirmed)
    minutes: number;
    isCaptain: boolean;
    isViceCaptain: boolean;
    // Effective multiplier after resolveEffectiveCaptaincy: 2/3 for the
    // (effective) captain, 1 for other starters and subbed-in players, 0 for
    // bench players (even under Bench Boost — see effectiveMultiplier).
    multiplier: number;
    isBench: boolean;
    benchOrder: number;
    pickPosition: number;
    hasNoGame: boolean;
    fixtureStarted: boolean;
    fixtureFinished: boolean;
    allFixturesStarted: boolean;
    provisionalBonus: number;
    subOut: boolean;
    subIn: boolean;
    // Whether this player contributes to totalPoints (starter not subbed out,
    // subbed in, or on the bench under Bench Boost).
    counts: boolean;
    // Multiplier actually applied to this player's contribution: equals
    // `multiplier` for starters/sub-ins, 1 for Bench Boost bench players,
    // 0 when the player doesn't count.
    effectiveMultiplier: number;
    // (points + provisionalBonus) * effectiveMultiplier — the player's exact
    // share of totalPoints. Sum over all players === totalPoints.
    effectiveContribution: number;
}

export interface ScoredSquad {
    players: ScoredPlayer[];
    // Gross GW score including provisional bonus (no transfer-hit deduction).
    totalPoints: number;
    // Gross GW score excluding provisional bonus (what picks.calculatedPoints is).
    basePoints: number;
    // Multiplier-weighted provisional bonus. totalPoints = basePoints + provisionalBonusPoints.
    provisionalBonusPoints: number;
    // Points left on the bench (players who didn't count), provisional bonus included.
    benchPoints: number;
    autoSubs: Array<{ out: { id: number; name: string }; in: { id: number; name: string } }>;
    activeChip: string | null;
    originalCaptainId: number | null;
    originalViceCaptainId: number | null;
}

export interface ScoreSquadOptions {
    // undefined = use picks.active_chip; null = force no chip; string = force
    // that chip. Tinkering scores the kept team under THIS week's chip; Set &
    // Forget scores the GW1 team with no chip at all.
    chipOverride?: string | null;
}

const EMPTY_SQUAD: ScoredSquad = {
    players: [],
    totalPoints: 0,
    basePoints: 0,
    provisionalBonusPoints: 0,
    benchPoints: 0,
    autoSubs: [],
    activeChip: null,
    originalCaptainId: null,
    originalViceCaptainId: null,
};

// Provisional bonus from live BPS: top 3 ranks get 3/2/1, ties share the rank
// (same behaviour the legacy app had).
export function calcProvisionalBonusForFixture(fixture: any): Record<number, number> {
    if (!fixture?.stats) return {};
    const bpsStat = fixture.stats.find((s: any) => s.identifier === 'bps');
    if (!bpsStat) return {};

    const allBps = [...(bpsStat.h || []), ...(bpsStat.a || [])]
        .sort((a: any, b: any) => b.value - a.value);

    if (allBps.length === 0) return {};

    const bonusMap: Record<number, number> = {};
    let currentRank = 1;
    let i = 0;

    while (i < allBps.length && currentRank <= 3) {
        const currentBps = allBps[i].value;
        const tiedPlayers: number[] = [];
        while (i < allBps.length && allBps[i].value === currentBps) {
            tiedPlayers.push(allBps[i].element);
            i++;
        }
        const bonusForRank = currentRank === 1 ? 3 : currentRank === 2 ? 2 : currentRank === 3 ? 1 : 0;
        if (bonusForRank > 0) {
            tiedPlayers.forEach((elementId) => (bonusMap[elementId] = bonusForRank));
        }
        currentRank += tiedPlayers.length;
    }
    return bonusMap;
}

export function scoreSquad(
    picks: any,
    liveData: any,
    bootstrap: any,
    gwFixtures: any,
    opts: ScoreSquadOptions = {},
): ScoredSquad {
    if (!picks?.picks || !liveData?.elements) {
        return { ...EMPTY_SQUAD };
    }

    const activeChip: string | null =
        opts.chipOverride !== undefined ? opts.chipOverride : (picks.active_chip ?? null);
    const isTripleCaptain = activeChip === '3xc';
    const isBenchBoost = activeChip === 'bboost';

    // Provisional bonus applies while a fixture has started but official bonus
    // isn't in total_points yet (live matches and finished_provisional).
    const provisionalBonusMap: Record<number, number> = {};
    gwFixtures?.forEach((fixture: any) => {
        if (fixture.started && !fixture.finished) {
            Object.assign(provisionalBonusMap, calcProvisionalBonusForFixture(fixture));
        }
    });

    const gwHasStarted = gwFixtures?.some((f: any) => f.started) || false;

    const players: ScoredPlayer[] = picks.picks.map((pick: any, idx: number) => {
        const element = bootstrap.elements.find((e: any) => e.id === pick.element);
        const liveElement = liveData.elements.find((e: any) => e.id === pick.element);
        const points = liveElement?.stats?.total_points || 0;
        const minutes = liveElement?.stats?.minutes || 0;

        // Fixture status — handles DGW (multiple fixtures per team)
        const teamFixtures = gwFixtures?.filter((f: any) => f.team_h === element?.team || f.team_a === element?.team) || [];
        const hasNoGame = teamFixtures.length === 0;
        const fixtureStarted = teamFixtures.some((f: any) => f.started);
        const fixtureFinished = teamFixtures.length > 0 && teamFixtures.every((f: any) => f.finished_provisional || f.finished);
        const allFixturesStarted = teamFixtures.length > 0 && teamFixtures.every((f: any) => f.started);

        // If official bonus is in total_points already, provisional must not double it
        const officialBonus = liveElement?.stats?.bonus || 0;
        const provisionalBonus = (fixtureStarted && officialBonus === 0)
            ? (provisionalBonusMap[pick.element] || 0)
            : 0;

        return {
            id: pick.element,
            name: element?.web_name || 'Unknown',
            positionId: element?.element_type,
            points,
            minutes,
            isCaptain: pick.is_captain,
            isViceCaptain: pick.is_vice_captain,
            // Derive from is_captain rather than pick.multiplier: for completed
            // GWs the FPL API rewrites pick.multiplier to post-auto-sub state
            // (a non-playing captain gets 0), which would poison VC inheritance.
            multiplier: pick.is_captain ? (isTripleCaptain ? 3 : 2) : (idx >= 11 ? 0 : 1),
            isBench: idx >= 11,
            benchOrder: idx >= 11 ? idx - 10 : 0,
            pickPosition: idx,
            hasNoGame,
            fixtureStarted,
            fixtureFinished,
            allFixturesStarted,
            provisionalBonus,
            subOut: false,
            subIn: false,
            counts: false,
            effectiveMultiplier: 0,
            effectiveContribution: 0,
        };
    });

    const starters = players.filter((p) => !p.isBench);
    const bench = players.filter((p) => p.isBench).sort((a, b) => a.benchOrder - b.benchOrder);
    const autoSubs: ScoredSquad['autoSubs'] = [];

    // Bench Boost disables auto-subs (all 15 players count)
    if (!isBenchBoost) {
        // Step 1: GK auto-sub (processed separately, matches official FPL behaviour)
        const startingGK = starters.find((p) => p.positionId === 1);
        const benchGK = bench.find((p) => p.positionId === 1);

        if (startingGK && benchGK) {
            // In DGW, only trigger auto-sub when ALL fixtures have started.
            // For blank GW (no game), trigger once any GW fixture has started.
            const gkNeedsSub = startingGK.minutes === 0 &&
                (startingGK.allFixturesStarted || (startingGK.hasNoGame && gwHasStarted));
            const benchGKAvailable = !(benchGK.minutes === 0 &&
                (benchGK.allFixturesStarted || (benchGK.hasNoGame && gwHasStarted)));

            if (gkNeedsSub && benchGKAvailable) {
                startingGK.subOut = true;
                benchGK.subIn = true;
                autoSubs.push({
                    out: { id: startingGK.id, name: startingGK.name },
                    in: { id: benchGK.id, name: benchGK.name },
                });
            }
        }

        // Step 2: Outfield auto-subs (bench priority order, skipping GK bench slot)
        const outfieldNeedsSub = starters.filter((p) =>
            p.positionId !== 1 && !p.subOut &&
            p.minutes === 0 && (p.allFixturesStarted || (p.hasNoGame && gwHasStarted))
        );
        const outfieldBench = bench.filter((p) => p.positionId !== 1);

        for (const playerOut of outfieldNeedsSub) {
            for (const benchPlayer of outfieldBench) {
                if (benchPlayer.subIn) continue; // Already used
                if (benchPlayer.minutes === 0 && (benchPlayer.allFixturesStarted || (benchPlayer.hasNoGame && gwHasStarted))) continue;

                // Use effective formation (includes already-subbed-in bench players)
                const testFormation = getEffectiveFormationCounts(players);

                if (playerOut.positionId === 2) testFormation.DEF--;
                else if (playerOut.positionId === 3) testFormation.MID--;
                else if (playerOut.positionId === 4) testFormation.FWD--;

                if (benchPlayer.positionId === 2) testFormation.DEF++;
                else if (benchPlayer.positionId === 3) testFormation.MID++;
                else if (benchPlayer.positionId === 4) testFormation.FWD++;

                if (isValidFormation(testFormation)) {
                    playerOut.subOut = true;
                    benchPlayer.subIn = true;
                    autoSubs.push({
                        out: { id: playerOut.id, name: playerOut.name },
                        in: { id: benchPlayer.id, name: benchPlayer.name },
                    });
                    break;
                }
            }
        }
    }

    // FPL API returns multiplier=0 for bench players. When a bench player is
    // auto-subbed in they count as a regular starter (multiplier=1).
    players.forEach((p) => {
        if (p.subIn && p.multiplier === 0) p.multiplier = 1;
    });

    const originalCaptainId = players.find((p) => p.isCaptain)?.id ?? null;
    const originalViceCaptainId = players.find((p) => p.isViceCaptain)?.id ?? null;

    // If captain was auto-subbed out (or never played), vice-captain inherits
    resolveEffectiveCaptaincy(players, gwHasStarted);

    let totalPoints = 0;
    let basePoints = 0;
    let provisionalBonusPoints = 0;
    let benchPoints = 0;

    players.forEach((p) => {
        const isBenchNotSubbedIn = p.isBench && !p.subIn;
        p.counts = (!p.isBench && !p.subOut) || p.subIn || (isBenchBoost && isBenchNotSubbedIn);
        p.effectiveMultiplier = p.counts ? (isBenchNotSubbedIn ? 1 : p.multiplier) : 0;
        p.effectiveContribution = (p.points + p.provisionalBonus) * p.effectiveMultiplier;

        totalPoints += p.effectiveContribution;
        basePoints += p.points * p.effectiveMultiplier;
        provisionalBonusPoints += p.provisionalBonus * p.effectiveMultiplier;
        if (isBenchNotSubbedIn) {
            benchPoints += p.points + p.provisionalBonus;
        }
    });

    return {
        players,
        totalPoints,
        basePoints,
        provisionalBonusPoints,
        benchPoints,
        autoSubs,
        activeChip,
        originalCaptainId,
        originalViceCaptainId,
    };
}
