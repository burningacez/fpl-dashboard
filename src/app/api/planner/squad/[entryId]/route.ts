/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import {
  fetchBootstrap,
  fetchManagerPicks,
  fetchManagerHistory,
} from '@/server/fpl/client';
import { sellingPrice, deriveFreeTransfers, INITIAL_BUDGET } from '@/lib/squad-rules';
import config from '@/server/config';

export const dynamic = 'force-dynamic';

/**
 * Whether the pre-season squad builder is offered to this entry.
 *
 * Deliberately decided server-side: the allowlist is an env var, so no entry
 * ids ship in the client bundle. Empty allowlist means on in development (so
 * local testing needs no setup) and off in production (so it stays closed
 * until someone opts in).
 */
function builderEnabledFor(entryId: number): boolean {
  const allowed = config.planner.PREVIEW_ENTRY_IDS;
  if (allowed.length === 0) return config.server.NODE_ENV !== 'production';
  return allowed.includes(entryId);
}

/**
 * Base squad state for the planner: the manager's current real squad with
 * selling/purchase prices, bank, team value, chips used, and a heuristic
 * free-transfer count (the FPL API exposes no FT field, so we derive it).
 *
 * Pre-season there is no squad to fetch — FPL only publishes picks once the
 * GW1 deadline passes — so the route reports `preSeason` instead and the
 * client falls back to a locally-built draft (or a fixtures-only view).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ entryId: string }> }) {
  const { entryId: entryIdStr } = await params;
  const entryId = parseInt(entryIdStr, 10);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return NextResponse.json({ error: 'Invalid entry ID' }, { status: 400 });
  }

  try {
    const bootstrap = await fetchBootstrap();
    const currentGw = bootstrap.events.find((e) => e.is_current)?.id ?? 1;
    const priceById = new Map<number, number>(bootstrap.elements.map((e) => [e.id, e.now_cost]));

    // Pre-season proper: no gameweek is current and none has finished. Checked
    // against the calendar rather than inferred from a failed picks fetch, so a
    // transient FPL outage mid-season can never drop a user into the builder.
    const preSeason = !bootstrap.events.some((e) => e.finished || e.is_current);
    if (preSeason) {
      const firstGw = bootstrap.events.find((e) => e.is_next) ?? bootstrap.events[0];
      return NextResponse.json({
        entryId,
        preSeason: true,
        builderEnabled: builderEnabledFor(entryId),
        firstGw: firstGw?.id ?? 1,
        firstDeadline: firstGw?.deadline_time ?? null,
        budget: INITIAL_BUDGET,
      });
    }

    let picks: any;
    let history: any;
    try {
      [picks, history] = await Promise.all([
        fetchManagerPicks(entryId, currentGw),
        fetchManagerHistory(entryId),
      ]);
    } catch {
      return NextResponse.json(
        { error: `No squad found for entry ${entryId} in GW${currentGw}`, preSeason: false },
        { status: 404 },
      );
    }

    const eh = picks.entry_history ?? {};
    // selling_price / purchase_price were added to the public picks endpoint in
    // 2023/24 but may be absent — fall back to current price with a UI badge.
    let approximatePrices = false;
    // Sorted by FPL `position` (1-11 starting XI, 12-15 bench in sub order) so
    // the array index doubles as the lineup — applyTransfers swaps in place, so
    // that ordering survives the planner's fold.
    const sortedPicks = [...(picks.picks ?? [])].sort((a: any, b: any) => a.position - b.position);
    const outPicks = sortedPicks.map((p: any) => {
      const now = priceById.get(p.element) ?? 0;
      const purchase = p.purchase_price ?? (approximatePrices = true, now);
      const selling = p.selling_price ?? sellingPrice(purchase, now);
      return {
        element: p.element,
        position: p.position,
        isCaptain: p.is_captain,
        isViceCaptain: p.is_vice_captain,
        purchasePrice: purchase,
        sellingPrice: selling,
      };
    });

    // Free-transfer derivation: simulate from GW1 (see deriveFreeTransfers).
    // The fold consumes this as "FT available entering currentGw + 1", so the
    // simulation includes the current gameweek's own transfers.
    const chipByGw = new Map<number, string>();
    for (const c of history.chips ?? []) chipByGw.set(c.event, c.name);
    const { freeTransfers: ft, confident, transfersByGw } = deriveFreeTransfers(
      history.current ?? [],
      chipByGw,
      currentGw,
    );

    return NextResponse.json({
      entryId,
      preSeason: false,
      gw: currentGw,
      bank: eh.bank ?? 0,
      value: eh.value ?? 0,
      activeChip: picks.active_chip ?? null,
      chipsUsed: (history.chips ?? []).map((c: any) => ({ name: c.name, event: c.event })),
      picks: outPicks,
      approximatePrices,
      freeTransfers: ft,
      freeTransfersDerivation: { confident, transfersByGw },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
