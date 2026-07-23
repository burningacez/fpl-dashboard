/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextRequest, NextResponse } from 'next/server';
import {
  fetchBootstrap,
  fetchManagerPicks,
  fetchManagerHistory,
  fetchManagerTransfers,
} from '@/server/fpl/client';
import { sellingPrice, freeTransfersAfter, isFreeTransferChip } from '@/lib/squad-rules';
import { PLANNER_ENABLED } from '@/lib/features';

export const dynamic = 'force-dynamic';

/**
 * Base squad state for the planner: the manager's current real squad with
 * selling/purchase prices, bank, team value, chips used, and a heuristic
 * free-transfer count (the FPL API exposes no FT field, so we derive it).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ entryId: string }> }) {
  // Withheld from the live app until released — see src/lib/features.ts.
  if (!PLANNER_ENABLED) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { entryId: entryIdStr } = await params;
  const entryId = parseInt(entryIdStr, 10);
  if (!Number.isInteger(entryId) || entryId <= 0) {
    return NextResponse.json({ error: 'Invalid entry ID' }, { status: 400 });
  }

  try {
    const bootstrap = await fetchBootstrap();
    const currentGw = bootstrap.events.find((e) => e.is_current)?.id ?? 1;
    const priceById = new Map<number, number>(bootstrap.elements.map((e) => [e.id, e.now_cost]));

    let picks: any;
    let history: any;
    let transfers: any[];
    try {
      [picks, history, transfers] = await Promise.all([
        fetchManagerPicks(entryId, currentGw),
        fetchManagerHistory(entryId),
        fetchManagerTransfers(entryId).catch(() => []),
      ]);
    } catch {
      return NextResponse.json(
        { error: `No squad found for entry ${entryId} in GW${currentGw}` },
        { status: 404 },
      );
    }

    const eh = picks.entry_history ?? {};
    // selling_price / purchase_price were added to the public picks endpoint in
    // 2023/24 but may be absent — fall back to current price with a UI badge.
    let approximatePrices = false;
    const outPicks = (picks.picks ?? []).map((p: any) => {
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

    // Free-transfer derivation: simulate from GW1. Chips per GW from history.
    const chipByGw = new Map<number, string>();
    for (const c of history.chips ?? []) chipByGw.set(c.event, c.name);
    const current: any[] = history.current ?? [];
    let ft = 1;
    const transfersByGw: Record<number, number> = {};
    let confident = current.length >= currentGw - 1;
    for (const row of current) {
      if (row.event >= currentGw) continue;
      const used = row.event_transfers ?? 0;
      transfersByGw[row.event] = used;
      const chipActive = isFreeTransferChip(chipByGw.get(row.event));
      // event 1 seeds ft=1 (no accrual before the season starts)
      if (row.event >= 1) ft = freeTransfersAfter(ft, used, chipActive);
      // a paid hit with 0 transfers recorded is a data inconsistency
      if ((row.event_transfers_cost ?? 0) > 0 && used === 0) confident = false;
    }

    return NextResponse.json({
      entryId,
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
