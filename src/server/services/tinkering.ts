/* eslint-disable @typescript-eslint/no-explicit-any */
import 'server-only';
import { fetchBootstrap, fetchFixtures, getCompletedGameweeks } from '../fpl/client';
import { dataCache, rebuildStatus, fetchManagerPicksCached, fetchLiveGWDataCached } from '../data-cache';
import { scoreSquad, type ScoredSquad } from './scoring-core';

// Bump when the payload shape changes: cached entries from an older shape are
// treated as misses and recalculated (tinkeringCache is in-memory only).
export const TINKERING_PAYLOAD_VERSION = 2;

const CHIP_INFO: Record<string, { label: string; note: string }> = {
    freehit: {
        label: 'Free Hit',
        note: 'Free Hit squad vs keeping last week’s team — your team reverts next week.',
    },
    wildcard: {
        label: 'Wildcard',
        note: 'Wildcard active — unlimited changes, no transfer hits.',
    },
    '3xc': {
        label: 'Triple Captain',
        note: 'Triple Captain applies to both sides of the comparison.',
    },
    bboost: {
        label: 'Bench Boost',
        note: 'Bench Boost applies to both sides — bench points count in both scores.',
    },
};

// =============================================================================
// LEDGER
//
// Decomposes (actual score − kept-team score) into buckets that sum EXACTLY to
// the headline, by construction:
//
//   Every player's effectiveContribution = (points + provisionalBonus) ×
//   effectiveMultiplier splits into a base part (×1 if the player counts) and
//   an armband part (×(multiplier−1)). Summing per-player deltas of those
//   parts over the union of both squads gives actual − kept precisely.
//
//   - base deltas of players in exactly one squad  → Transfers
//   - base deltas of players in both squads        → Bench calls
//     (starts/benchings and auto-sub cascade differences)
//   - armband deltas of every player               → Captaincy
//
// so transfers.total + bench.total + captaincy.total === actual − kept, and
// netImpact = actual − kept − transferCost.
// =============================================================================

type LedgerRow = { id: number; name: string; delta: number };

export interface TinkeringLedger {
    transfers: { total: number; rows: Array<LedgerRow & { direction: 'in' | 'out'; captain: boolean }> };
    captaincy: {
        total: number;
        changed: boolean;
        oldCaptain: { id: number; name: string } | null;
        newCaptain: { id: number; name: string } | null;
        rows: LedgerRow[];
    };
    bench: { total: number; rows: Array<LedgerRow & { tag: 'started' | 'benched' | 'autoSub' }> };
}

function baseAndArmband(p: any): { base: number; armband: number } {
    if (!p || !p.counts) return { base: 0, armband: 0 };
    const pts = p.points + (p.provisionalBonus || 0);
    return { base: pts * 1, armband: pts * (p.effectiveMultiplier - 1) };
}

export function buildTinkeringLedger(actual: ScoredSquad, kept: ScoredSquad): TinkeringLedger {
    const actualById = new Map(actual.players.map((p) => [p.id, p]));
    const keptById = new Map(kept.players.map((p) => [p.id, p]));
    const allIds = new Set<number>([...actualById.keys(), ...keptById.keys()]);

    const transfers: TinkeringLedger['transfers'] = { total: 0, rows: [] };
    const captaincy: TinkeringLedger['captaincy'] = {
        total: 0,
        changed: false,
        oldCaptain: null,
        newCaptain: null,
        rows: [],
    };
    const bench: TinkeringLedger['bench'] = { total: 0, rows: [] };

    for (const id of allIds) {
        const a = actualById.get(id) ?? null;
        const k = keptById.get(id) ?? null;
        const aParts = baseAndArmband(a);
        const kParts = baseAndArmband(k);
        const deltaBase = aParts.base - kParts.base;
        const deltaArmband = aParts.armband - kParts.armband;
        const name = (a?.name ?? k?.name ?? 'Unknown') as string;

        // Armband deltas all land in the captaincy bucket
        captaincy.total += deltaArmband;
        if (deltaArmband !== 0) {
            captaincy.rows.push({ id, name, delta: deltaArmband });
        }

        if (a && k) {
            // Kept player: any base delta comes from bench decisions or the
            // auto-sub cascade differing between the two squads
            bench.total += deltaBase;
            const wasBench = (k.pickPosition as number) >= 11;
            const isBench = (a.pickPosition as number) >= 11;
            if (wasBench !== isBench) {
                bench.rows.push({ id, name, delta: deltaBase, tag: isBench ? 'benched' : 'started' });
            } else if (deltaBase !== 0) {
                bench.rows.push({ id, name, delta: deltaBase, tag: 'autoSub' });
            }
        } else {
            // Player in exactly one squad: a transfer
            transfers.total += deltaBase;
            transfers.rows.push({
                id,
                name,
                delta: deltaBase,
                direction: a ? 'in' : 'out',
                captain: ((a ?? k) as any).effectiveMultiplier >= 2,
            });
        }
    }

    // Captain-change display info from the ORIGINAL armbands (pre-inheritance)
    const oldCapId = kept.originalCaptainId;
    const newCapId = actual.originalCaptainId;
    captaincy.changed = oldCapId !== newCapId;
    if (captaincy.changed) {
        const nameFor = (id: number | null, squad: ScoredSquad) =>
            (squad.players.find((p) => p.id === id)?.name as string) || 'Unknown';
        captaincy.oldCaptain = oldCapId ? { id: oldCapId, name: nameFor(oldCapId, kept) } : null;
        captaincy.newCaptain = newCapId ? { id: newCapId, name: nameFor(newCapId, actual) } : null;
    }

    // Stable, reader-friendly ordering: biggest absolute impact first
    const byImpact = (x: LedgerRow, y: LedgerRow) => Math.abs(y.delta) - Math.abs(x.delta);
    transfers.rows.sort(byImpact);
    captaincy.rows.sort(byImpact);
    bench.rows.sort(byImpact);

    return { transfers, captaincy, bench };
}

// =============================================================================
// SERVICE
// =============================================================================

function buildNavigation(gw: number, maxGW: number) {
    return {
        currentGW: gw,
        minGW: 2,
        maxGW,
        hasPrev: gw > 2,
        hasNext: gw < maxGW,
    };
}

// Latest gameweek for navigation bounds, from stored data — no live FPL fetch,
// so serving a cached tinkering entry never depends on the (possibly reset) API.
function resolveMaxGW(fallback: number): number {
    const wkGW = dataCache.week?.currentGW;
    if (typeof wkGW === 'number' && wkGW > 0) return wkGW;
    const gws = Object.keys(dataCache.weekHistoryCache || {}).map(Number).filter(Number.isFinite);
    return gws.length ? Math.max(...gws) : fallback;
}

export async function calculateTinkeringImpact(entryId: any, gw: any): Promise<any> {
    // GW1 has no previous team to compare
    if (gw <= 1) {
        return {
            available: false,
            reason: 'gw1',
            navigation: { currentGW: gw, minGW: 2, maxGW: gw, hasPrev: false, hasNext: false }
        };
    }

    // Navigation is computed per request (never cached — maxGW moves weekly),
    // but from stored data so a cached hit needs no live FPL fetch.
    const cacheKey = `${entryId}-${gw}`;
    const cached = dataCache.tinkeringCache[cacheKey];
    if (cached && cached.payloadVersion === TINKERING_PAYLOAD_VERSION) {
        return { ...cached, navigation: buildNavigation(gw, resolveMaxGW(gw)) };
    }

    // A concluded past gameweek is read-only: its ledger is served from the
    // stored cache, never recomputed from the live API. If it isn't stored,
    // degrade gracefully rather than re-fetching a settled week.
    const storedCurrentGW = dataCache.week?.currentGW;
    if (typeof storedCurrentGW === 'number' && gw < storedCurrentGW) {
        return {
            available: false,
            reason: 'unavailable',
            navigation: buildNavigation(gw, resolveMaxGW(gw)),
        };
    }

    try {
        const [bootstrap, fixtures] = await Promise.all([
            fetchBootstrap(),
            fetchFixtures()
        ]);

        const currentGWEvent = bootstrap.events.find((e: any) => e.is_current);
        const maxGW = currentGWEvent?.id || gw;
        const gwFixtures = fixtures.filter((f: any) => f.event === gw);

        // Check if this GW is completed (for caching)
        const gwEvent = bootstrap.events.find((e: any) => e.id === gw);
        const isGWCompleted = gwEvent?.finished || false;

        // Fetch current GW picks (use cached version for completed GWs)
        const currentPicks: any = await fetchManagerPicksCached(entryId, gw, bootstrap);
        const currentChip = currentPicks.active_chip;

        // Determine which previous GW to compare against.
        // Free Hit edge case: if the PREVIOUS week was a Free Hit, the team
        // reverted — compare against the week before that instead.
        let compareGW = gw - 1;
        const prevPicks: any = await fetchManagerPicksCached(entryId, compareGW, bootstrap);
        if (prevPicks.active_chip === 'freehit' && compareGW > 1) {
            compareGW = compareGW - 1;
        }
        const previousPicks: any = compareGW !== gw - 1
            ? await fetchManagerPicksCached(entryId, compareGW, bootstrap)
            : prevPicks;

        const liveData: any = await fetchLiveGWDataCached(gw, bootstrap);

        // Score both squads with the SAME engine and the SAME chip. The kept
        // team applies THIS GW's chip — the question is "what would last
        // week's team have scored this week", and the chip the manager played
        // is a property of this week, not the team selection.
        const kept = scoreSquad(previousPicks, liveData, bootstrap, gwFixtures, { chipOverride: currentChip });
        const actual = scoreSquad(currentPicks, liveData, bootstrap, gwFixtures);

        const transferCost = currentPicks.entry_history?.event_transfers_cost || 0;
        const netImpact = actual.totalPoints - kept.totalPoints - transferCost;

        const ledger = buildTinkeringLedger(actual, kept);

        // The ledger reconciles with the headline by construction; if it ever
        // doesn't, something in the scoring core broke — log loudly.
        const bucketSum = ledger.transfers.total + ledger.captaincy.total + ledger.bench.total;
        if (bucketSum !== actual.totalPoints - kept.totalPoints) {
            console.error(
                `[Tinkering] Ledger mismatch for entry ${entryId} GW${gw}: buckets sum to ${bucketSum}, ` +
                `actual-kept is ${actual.totalPoints - kept.totalPoints}`
            );
        }

        const result: any = {
            available: true,
            payloadVersion: TINKERING_PAYLOAD_VERSION,
            // Chip code (or null) — name kept from the v1 payload for the badge
            reason: currentChip && CHIP_INFO[currentChip] ? currentChip : null,
            gw,
            comparedToGW: compareGW,
            isLiveGW: !isGWCompleted,
            keptScore: kept.totalPoints,
            actualScore: actual.totalPoints,
            transferCost,
            // Net GW score — identical to the week page row (gross − hits)
            actualNetScore: actual.totalPoints - transferCost,
            netImpact,
            chip: currentChip && CHIP_INFO[currentChip]
                ? { code: currentChip, ...CHIP_INFO[currentChip] }
                : null,
            buckets: ledger,
        };

        // Cache result for completed GWs (navigation intentionally excluded)
        if (isGWCompleted) {
            dataCache.tinkeringCache[cacheKey] = result;
        }

        return { ...result, navigation: buildNavigation(gw, maxGW) };
    } catch (error: any) {
        console.error(`[Tinkering] Error calculating for entry ${entryId}, GW ${gw}:`, error.message);
        return {
            available: false,
            reason: 'error',
            error: error.message,
            navigation: { currentGW: gw, minGW: 2, maxGW: gw, hasPrev: false, hasNext: false }
        };
    }
}

export async function preCalculateTinkeringData(managers: any): Promise<void> {
    console.log('[Tinkering] Pre-calculating tinkering data for all managers...');
    const startTime = Date.now();

    try {
        const [bootstrap, fixtures] = await Promise.all([fetchBootstrap(), fetchFixtures()]);
        const completedGWs = getCompletedGameweeks(bootstrap, fixtures);
        const tinkeringGWs = completedGWs.filter((gw: any) => gw >= 2); // Skip GW1

        if (tinkeringGWs.length === 0) {
            console.log('[Tinkering] No completed GWs to calculate');
            return;
        }

        let calculated = 0;
        let skipped = 0;
        const totalTinkering = managers.length * tinkeringGWs.length;

        for (const manager of managers) {
            for (const gw of tinkeringGWs) {
                const cacheKey = `${manager.entry}-${gw}`;

                // Skip if already cached with the current payload shape
                if (dataCache.tinkeringCache[cacheKey]?.payloadVersion === TINKERING_PAYLOAD_VERSION) {
                    skipped++;
                    continue;
                }

                try {
                    await calculateTinkeringImpact(manager.entry, gw);
                    // Result is automatically cached by calculateTinkeringImpact for completed GWs
                    calculated++;
                    // Update rebuild status if in progress
                    if (rebuildStatus.inProgress && calculated % 10 === 0) {
                        rebuildStatus.phase = 'tinkering';
                        rebuildStatus.progress = `Calculating tinkering: ${calculated + skipped}/${totalTinkering}`;
                    }
                } catch {
                    // Skip failed calculations
                }
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Tinkering] Pre-calculation complete in ${duration}s - ${calculated} new, ${skipped} cached`);
    } catch (error: any) {
        console.error('[Tinkering] Pre-calculation failed:', error.message);
    }
}
