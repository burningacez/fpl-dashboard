/**
 * Pure FPL squad/transfer rules for the team planner.
 *
 * NO 'server-only', NO DOM, NO IO — this module is imported by the client-side
 * planner UI, the planner API routes, and the vitest suite. All prices are in
 * FPL API units: tenths of £m (e.g. 55 = £5.5m).
 */

// =============================================================================
// Types
// =============================================================================

/** Minimal player shape the rules engine needs (subset of bootstrap element). */
export interface PlannerPlayer {
  id: number;
  web_name: string;
  team: number;
  element_type: number; // 1 GKP, 2 DEF, 3 MID, 4 FWD
  now_cost: number; // tenths of £m
}

/** One owned squad slot. Prices in tenths of £m. */
export interface SquadSlot {
  element: number;
  purchasePrice: number;
  sellingPrice: number;
}

export interface PlannedTransfer {
  out: number;
  in: number;
}

export interface PlannerWeek {
  transfers: PlannedTransfer[];
  captain?: number;
  vice?: number;
  chip?: string | null; // 'wildcard' | 'freehit' | 'bboost' | '3xc' | null
}

/** Persisted draft plan (localStorage on the client). */
export interface PlannerPlan {
  version: 1;
  entryId: number;
  season: string;
  baseGw: number;
  /** squadHash() of the real squad+bank the plan was seeded from — mismatch
   *  against a fresh fetch means the real team changed and a rebase is needed. */
  baseSquadHash: string;
  updatedAt: number;
  /** Manual free-transfer override for the base state (the server-side
   *  derivation is heuristic; the UI lets the user correct it). */
  ftOverride?: number;
  /** Keyed by gameweek id as a string (JSON-friendly). */
  weeks: Record<string, PlannerWeek>;
}

/** Folded state for one planned gameweek. */
export interface GwState {
  gw: number;
  squad: SquadSlot[];
  bank: number;
  /** Free transfers ENTERING this GW (before its transfers are made). */
  freeTransfers: number;
  /** Transfers successfully applied this GW. */
  used: number;
  /** Points hit for this GW (0 on wildcard/free-hit weeks). */
  hits: number;
  errors: string[];
  captain?: number;
  vice?: number;
  chip?: string | null;
}

export interface ApplyTransfersResult {
  squad: SquadSlot[];
  bank: number;
  /** Number of transfers actually applied (skipped ones don't count). */
  applied: number;
  errors: string[];
}

export interface FoldBase {
  squad: SquadSlot[];
  bank: number;
  /** Free transfers available entering baseGw + 1. */
  freeTransfers: number;
  baseGw: number;
}

// =============================================================================
// Constants
// =============================================================================

export const MAX_FREE_TRANSFERS = 5;
export const HIT_POINTS = 4;
export const SQUAD_SIZE = 15;
export const MAX_PER_CLUB = 3;

export const POSITION_QUOTAS: Record<number, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
export const POSITION_NAMES: Record<number, string> = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/** Chips whose transfers are free and don't consume the FT bank. */
const FREE_TRANSFER_CHIPS = new Set(['wildcard', 'freehit']);

export function isFreeTransferChip(chip: string | null | undefined): boolean {
  return chip != null && FREE_TRANSFER_CHIPS.has(chip);
}

// =============================================================================
// Prices
// =============================================================================

export function formatPrice(tenths: number): string {
  return `£${(tenths / 10).toFixed(1)}m`;
}

/**
 * FPL selling price rule:
 *  - price dropped since purchase → you sell at the (lower) current price;
 *  - price rose → you keep half the profit, rounded DOWN (in 0.1m steps).
 * e.g. bought 55, now 58 → 55 + floor(3/2) = 56; bought 55, now 53 → 53.
 */
export function sellingPrice(purchasePrice: number, currentPrice: number): number {
  if (currentPrice < purchasePrice) return currentPrice;
  return purchasePrice + Math.floor((currentPrice - purchasePrice) / 2);
}

// =============================================================================
// Transfers
// =============================================================================

/**
 * Apply a list of transfers to a squad, sequentially (later transfers see the
 * effect of earlier ones — required for same-week chains).
 *
 * - The outgoing player sells at his slot's sellingPrice.
 * - The incoming player is bought at now_cost, and — because future price
 *   changes are unknowable in a sandbox — enters the squad with
 *   purchasePrice = sellingPrice = now_cost. That means planned buys never
 *   gain or lose value across planned weeks; only the real squad's stored
 *   selling prices carry price-change information.
 * - Unknown player ids, selling a player you don't own, or buying a player
 *   you already own → the transfer is skipped and an error string recorded.
 * - A negative bank after applying everything is reported as an error but the
 *   state is still returned (the UI shows the overdraft rather than blocking).
 */
export function applyTransfers(
  squad: SquadSlot[],
  transfers: PlannedTransfer[],
  playersById: Map<number, PlannerPlayer>,
  bank: number,
): ApplyTransfersResult {
  const next: SquadSlot[] = squad.map((s) => ({ ...s }));
  let nextBank = bank;
  let applied = 0;
  const errors: string[] = [];

  for (const t of transfers) {
    const outPlayer = playersById.get(t.out);
    const inPlayer = playersById.get(t.in);
    if (!outPlayer) {
      errors.push(`Unknown player id ${t.out} (out) — transfer skipped`);
      continue;
    }
    if (!inPlayer) {
      errors.push(`Unknown player id ${t.in} (in) — transfer skipped`);
      continue;
    }
    const idx = next.findIndex((s) => s.element === t.out);
    if (idx === -1) {
      errors.push(`${outPlayer.web_name} is not in your squad — transfer skipped`);
      continue;
    }
    if (next.some((s) => s.element === t.in)) {
      errors.push(`${inPlayer.web_name} is already in your squad — transfer skipped`);
      continue;
    }
    nextBank += next[idx].sellingPrice - inPlayer.now_cost;
    next[idx] = { element: t.in, purchasePrice: inPlayer.now_cost, sellingPrice: inPlayer.now_cost };
    applied += 1;
  }

  if (nextBank < 0) {
    errors.push(`Bank is negative (${formatPrice(nextBank)}) — not enough funds for these transfers`);
  }

  return { squad: next, bank: nextBank, applied, errors };
}

// =============================================================================
// Squad validation
// =============================================================================

/**
 * FPL squad legality: exactly 15 players; exactly 2 GKP / 5 DEF / 5 MID /
 * 3 FWD; max 3 per club; no duplicates. Unknown ids are reported and excluded
 * from the positional/club counts.
 */
export function validateSquad(squad: SquadSlot[], playersById: Map<number, PlannerPlayer>): string[] {
  const errors: string[] = [];

  if (squad.length !== SQUAD_SIZE) {
    errors.push(`Squad has ${squad.length} players — must be exactly ${SQUAD_SIZE}`);
  }

  const seen = new Set<number>();
  const typeCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const clubCounts = new Map<number, number>();

  for (const slot of squad) {
    if (seen.has(slot.element)) {
      const p = playersById.get(slot.element);
      errors.push(`Duplicate player in squad: ${p ? p.web_name : `id ${slot.element}`}`);
      continue;
    }
    seen.add(slot.element);

    const player = playersById.get(slot.element);
    if (!player) {
      errors.push(`Unknown player id ${slot.element} in squad`);
      continue;
    }
    typeCounts[player.element_type] = (typeCounts[player.element_type] ?? 0) + 1;
    clubCounts.set(player.team, (clubCounts.get(player.team) ?? 0) + 1);
  }

  for (const [type, quota] of Object.entries(POSITION_QUOTAS)) {
    const t = Number(type);
    if (typeCounts[t] !== quota) {
      errors.push(`Squad has ${typeCounts[t] ?? 0} ${POSITION_NAMES[t]} — must be exactly ${quota}`);
    }
  }

  for (const [team, count] of clubCounts) {
    if (count > MAX_PER_CLUB) {
      errors.push(`${count} players from club ${team} — max ${MAX_PER_CLUB} per club`);
    }
  }

  return errors;
}

// =============================================================================
// Free transfers & hits
// =============================================================================

/**
 * Free transfers available entering the NEXT gameweek, given `ft` entering
 * this one and `used` transfers made. FPL 2024+ rule: bank up to 5.
 * On wildcard/free-hit weeks (`chipActive`) transfers are free, so `used`
 * counts as 0 — the FT bank still accrues by 1.
 */
export function freeTransfersAfter(ft: number, used: number, chipActive = false): number {
  const effectiveUsed = chipActive ? 0 : used;
  return Math.min(MAX_FREE_TRANSFERS, Math.max(ft - effectiveUsed, 0) + 1);
}

/**
 * Points hit for making `used` transfers with `ft` free transfers available.
 * 0 on wildcard/free-hit weeks (`chipActive`).
 */
export function hitCost(ft: number, used: number, chipActive = false): number {
  if (chipActive) return 0;
  return Math.max(0, used - ft) * HIT_POINTS;
}

// =============================================================================
// Plan folding
// =============================================================================

/**
 * Fold a plan into per-gameweek states, week by week from baseGw+1 upward.
 * Each week applies its transfers to the PREVIOUS week's squad/bank, computes
 * hits with chip awareness (wildcard/free-hit → free transfers, FT bank
 * untouched) and validates the resulting squad.
 *
 * Weeks with no plan entry still produce a state (FT accrues, squad carries).
 * `throughGw` (optional) extends the fold beyond the last planned week so the
 * UI can render a fixed horizon (e.g. next 5 GWs).
 *
 * Known simplification: free hit's one-week squad reversion is NOT modelled —
 * a free-hit week's transfers persist into following weeks like any others.
 * The chip only affects transfer cost / FT accounting here.
 */
export function foldPlan(
  base: FoldBase,
  plan: PlannerPlan,
  playersById: Map<number, PlannerPlayer>,
  throughGw?: number,
): GwState[] {
  const plannedGws = Object.keys(plan.weeks)
    .map(Number)
    .filter((gw) => Number.isInteger(gw) && gw > base.baseGw);
  const lastGw = Math.max(base.baseGw, throughGw ?? base.baseGw, ...plannedGws);

  const states: GwState[] = [];
  let squad = base.squad;
  let bank = base.bank;
  let ft = base.freeTransfers;

  for (let gw = base.baseGw + 1; gw <= lastGw; gw++) {
    const week = plan.weeks[String(gw)];
    const transfers = week?.transfers ?? [];
    const chip = week?.chip ?? null;
    const chipActive = isFreeTransferChip(chip);

    const applied = applyTransfers(squad, transfers, playersById, bank);
    const used = applied.applied;
    const hits = hitCost(ft, used, chipActive);
    const errors = [...applied.errors, ...validateSquad(applied.squad, playersById)];

    if (week?.captain !== undefined && !applied.squad.some((s) => s.element === week.captain)) {
      errors.push('Captain is not in this week’s squad');
    }
    if (week?.vice !== undefined && !applied.squad.some((s) => s.element === week.vice)) {
      errors.push('Vice-captain is not in this week’s squad');
    }

    states.push({
      gw,
      squad: applied.squad,
      bank: applied.bank,
      freeTransfers: ft,
      used,
      hits,
      errors,
      captain: week?.captain,
      vice: week?.vice,
      chip,
    });

    ft = freeTransfersAfter(ft, used, chipActive);
    squad = applied.squad;
    bank = applied.bank;
  }

  return states;
}

// =============================================================================
// Squad hashing
// =============================================================================

/**
 * Stable identity string for a squad+bank: sorted element ids joined with '-',
 * then '|bank'. Used to detect that the real team changed under a saved plan.
 * (Deliberately ignores selling prices: a pure price tick shouldn't force a
 * rebase; a transfer or bank change should.)
 */
export function squadHash(squad: SquadSlot[], bank: number): string {
  const ids = squad
    .map((s) => s.element)
    .sort((a, b) => a - b)
    .join('-');
  return `${ids}|${bank}`;
}
