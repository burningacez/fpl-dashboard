/**
 * Pre-season draft squad — the team you build in the app before FPL publishes
 * real squads at the GW1 deadline.
 *
 * Purely local: the draft lives in localStorage next to the planner's saved
 * plans, is never sent to the server, and is deleted the moment a real squad
 * loads. It is a sandbox for exercising the planner pre-season, NOT an entry
 * into FPL — the real team is entered on fantasy.premierleague.com.
 *
 * NO 'server-only' and no React — imported by the planner UI and the vitest
 * suite. Storage access is guarded so importing this on the server is safe.
 */

import { POSITION_QUOTAS, SQUAD_SIZE, type PlannerPlayer, type SquadSlot } from './squad-rules';

export interface DraftSquad {
  version: 1;
  entryId: number;
  season: string;
  /**
   * Element ids in FPL lineup order: 0-10 are the starting XI, 11-14 the bench
   * (11 = reserve keeper). Shorter than 15 while the squad is being built, in
   * which case the lineup split is not yet meaningful.
   */
  order: number[];
  updatedAt: number;
}

export function draftStorageKey(entryId: number, season: string): string {
  return `fpl-planner-draft-${entryId}-${season}`;
}

export function emptyDraft(entryId: number, season: string): DraftSquad {
  return { version: 1, entryId, season, order: [], updatedAt: Date.now() };
}

export function isComplete(draft: DraftSquad): boolean {
  return draft.order.length === SQUAD_SIZE;
}

/** Total cost of the drafted players at current prices, in tenths of £m. */
export function draftSpend(order: number[], playersById: Map<number, PlannerPlayer>): number {
  return order.reduce((sum, el) => sum + (playersById.get(el)?.now_cost ?? 0), 0);
}

/**
 * Draft squad as planner slots. A pre-season buy has no price history, so
 * purchase and selling price are both the current price — which is exactly
 * what FPL does for a newly bought player.
 */
export function draftToSlots(order: number[], playersById: Map<number, PlannerPlayer>): SquadSlot[] {
  return order.map((el) => {
    const cost = playersById.get(el)?.now_cost ?? 0;
    return { element: el, purchasePrice: cost, sellingPrice: cost };
  });
}

/**
 * The most you can spend on the next pick of `type` and still be able to fill
 * every remaining slot — FPL's own constraint, which stops you blowing the
 * budget on a front six and stranding yourself with unfillable slots.
 *
 * Reserves the cheapest available player for each slot left after this pick.
 * Deliberately ignores the 3-per-club rule: a cap that's occasionally a shade
 * generous is far better than one that wrongly hides affordable players.
 */
export function maxAffordable(
  order: number[],
  type: number,
  playersById: Map<number, PlannerPlayer>,
  budget: number,
  allPlayers: PlannerPlayer[],
): number {
  const owned = new Set(order);
  const cheapest: Record<number, number> = {};
  for (const p of allPlayers) {
    if (owned.has(p.id)) continue;
    const current = cheapest[p.element_type];
    if (current == null || p.now_cost < current) cheapest[p.element_type] = p.now_cost;
  }

  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const el of order) {
    const t = playersById.get(el)?.element_type;
    if (t != null) counts[t] = (counts[t] ?? 0) + 1;
  }

  let reserve = 0;
  for (const t of [1, 2, 3, 4]) {
    const filled = (counts[t] ?? 0) + (t === type ? 1 : 0);
    const slotsLeft = Math.max(0, POSITION_QUOTAS[t] - filled);
    reserve += slotsLeft * (cheapest[t] ?? 0);
  }

  return budget - draftSpend(order, playersById) - reserve;
}

/** Reads the draft for this entry+season. Returns null when absent or foreign. */
export function loadDraft(entryId: number, season: string): DraftSquad | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(draftStorageKey(entryId, season));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Same guard as saved plans: a stale or foreign blob under our key must not
    // silently become the draft.
    if (parsed?.version !== 1 || parsed.entryId !== entryId || parsed.season !== season) return null;
    if (!Array.isArray(parsed.order) || !parsed.order.every((n: unknown) => Number.isInteger(n))) {
      return null;
    }
    return { ...parsed, order: parsed.order.slice(0, SQUAD_SIZE) } as DraftSquad;
  } catch {
    return null;
  }
}

export function saveDraft(draft: DraftSquad): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      draftStorageKey(draft.entryId, draft.season),
      JSON.stringify({ ...draft, updatedAt: Date.now() }),
    );
  } catch {
    /* quota or private mode — the draft just won't persist */
  }
}

export function clearDraft(entryId: number, season: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(draftStorageKey(entryId, season));
  } catch {
    /* ignore */
  }
}
