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
  /**
   * Substitutions, as pairs of squad slot INDICES swapped in order, applied
   * after this week's transfers.
   *
   * Indices rather than element ids because applyTransfers replaces a slot in
   * place: a sub stays meaningful even if the player occupying that slot is
   * later transferred out, which is what you want — "start whoever is in slot
   * 3" survives an edit to the plan above it.
   */
  swaps?: [number, number][];
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
  /** True when this week's transfers are unlimited (pre-GW1-deadline edits). */
  unlimited: boolean;
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
  /**
   * Gameweek whose transfers are free AND don't count against the season's
   * transfer accounting — i.e. squad edits made before the GW1 deadline, which
   * FPL treats as building your initial team rather than transferring.
   * Only used by the pre-season draft (baseGw 0, unlimitedGw 1).
   */
  unlimitedGw?: number;
}

// =============================================================================
// Constants
// =============================================================================

export const MAX_FREE_TRANSFERS = 5;
export const HIT_POINTS = 4;
export const SQUAD_SIZE = 15;
export const MAX_PER_CLUB = 3;
export const STARTING_XI = 11;

/** Starting budget for a brand-new FPL entry: £100.0m, in tenths. */
export const INITIAL_BUDGET = 1000;

export const POSITION_QUOTAS: Record<number, number> = { 1: 2, 2: 5, 3: 5, 4: 3 };
export const POSITION_NAMES: Record<number, string> = { 1: 'GKP', 2: 'DEF', 3: 'MID', 4: 'FWD' };

/** Minimum/maximum of each position allowed in a starting XI. */
export const MIN_STARTING: Record<number, number> = { 1: 1, 2: 3, 3: 2, 4: 1 };
export const MAX_STARTING: Record<number, number> = { 1: 1, 2: 5, 3: 5, 4: 3 };

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
      errors.push(`Unknown player id ${t.out} (out). Transfer skipped`);
      continue;
    }
    if (!inPlayer) {
      errors.push(`Unknown player id ${t.in} (in). Transfer skipped`);
      continue;
    }
    const idx = next.findIndex((s) => s.element === t.out);
    if (idx === -1) {
      errors.push(`${outPlayer.web_name} is not in your squad. Transfer skipped`);
      continue;
    }
    if (next.some((s) => s.element === t.in)) {
      errors.push(`${inPlayer.web_name} is already in your squad. Transfer skipped`);
      continue;
    }
    nextBank += next[idx].sellingPrice - inPlayer.now_cost;
    next[idx] = { element: t.in, purchasePrice: inPlayer.now_cost, sellingPrice: inPlayer.now_cost };
    applied += 1;
  }

  if (nextBank < 0) {
    errors.push(`Bank is negative (${formatPrice(nextBank)}): not enough funds for these transfers`);
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
    errors.push(`Squad has ${squad.length} players. Must be exactly ${SQUAD_SIZE}`);
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
      errors.push(`Squad has ${typeCounts[t] ?? 0} ${POSITION_NAMES[t]}. Must be exactly ${quota}`);
    }
  }

  for (const [team, count] of clubCounts) {
    if (count > MAX_PER_CLUB) {
      errors.push(`${count} players from club ${team}: max ${MAX_PER_CLUB} per club`);
    }
  }

  return errors;
}

// =============================================================================
// Lineup (starting XI / bench order)
// =============================================================================

/**
 * A squad's playing order, FPL's own model: 15 element ids where indices 0-10
 * are the starting XI and 11-14 are the bench in substitution order. Index 11
 * is always the reserve goalkeeper (FPL's `position` 12).
 *
 * Order is preserved by applyTransfers (an incoming player takes the outgoing
 * player's slot), so a folded week's `squad` array carries the lineup with it
 * and no extra plumbing is needed through foldPlan.
 */

export function startersOf<T>(order: T[]): T[] {
  return order.slice(0, STARTING_XI);
}

export function benchOf<T>(order: T[]): T[] {
  return order.slice(STARTING_XI);
}

/** Count a set of players by element_type. Unknown ids are ignored. */
export function formationCounts(
  elements: number[],
  playersById: Map<number, PlannerPlayer>,
): Record<number, number> {
  const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const el of elements) {
    const p = playersById.get(el);
    if (p) counts[p.element_type] = (counts[p.element_type] ?? 0) + 1;
  }
  return counts;
}

/** '3-4-3' style label for a starting XI (outfield only, GK implied). */
export function formationLabel(starters: number[], playersById: Map<number, PlannerPlayer>): string {
  const c = formationCounts(starters, playersById);
  return `${c[2]}-${c[3]}-${c[4]}`;
}

/**
 * FPL lineup legality for a 15-man order: exactly 11 starters containing
 * exactly 1 GKP, at least 3 DEF / 2 MID / 1 FWD, and the reserve keeper in the
 * first bench slot. Squad-level legality (quotas, clubs) is validateSquad's job.
 */
export function lineupErrors(order: number[], playersById: Map<number, PlannerPlayer>): string[] {
  const errors: string[] = [];
  if (order.length !== SQUAD_SIZE) {
    errors.push(`Lineup has ${order.length} players. Must be exactly ${SQUAD_SIZE}`);
    return errors;
  }

  const starters = startersOf(order);
  const bench = benchOf(order);
  const counts = formationCounts(starters, playersById);

  if (counts[1] !== 1) {
    errors.push(`Starting XI has ${counts[1]} goalkeeper${counts[1] === 1 ? '' : 's'}. Must be exactly 1`);
  }
  for (const type of [2, 3, 4]) {
    if (counts[type] < MIN_STARTING[type]) {
      errors.push(
        `Starting XI has ${counts[type]} ${POSITION_NAMES[type]}. Must be at least ${MIN_STARTING[type]}`,
      );
    }
  }

  const benchGk = playersById.get(bench[0]);
  if (benchGk && benchGk.element_type !== 1) {
    errors.push('The first bench slot must be your reserve goalkeeper');
  }

  return errors;
}

/**
 * Arrange 15 players into a legal default lineup: the pricier keeper starts,
 * position minimums are met, and the remaining XI places go to the most
 * expensive outfielders left. Bench is ordered by price, reserve keeper first.
 * Returns the input unchanged when it isn't a full 15.
 */
export function defaultLineup(squad: number[], playersById: Map<number, PlannerPlayer>): number[] {
  if (squad.length !== SQUAD_SIZE) return [...squad];

  const byPrice = (a: number, b: number) =>
    (playersById.get(b)?.now_cost ?? 0) - (playersById.get(a)?.now_cost ?? 0);
  const ofType = (type: number) =>
    squad.filter((el) => playersById.get(el)?.element_type === type).sort(byPrice);

  const keepers = ofType(1);
  const starters: number[] = [];
  const remaining: number[] = [];

  // Exactly one keeper starts; the other heads the bench.
  if (keepers[0] != null) starters.push(keepers[0]);

  for (const type of [2, 3, 4]) {
    const players = ofType(type);
    starters.push(...players.slice(0, MIN_STARTING[type]));
    remaining.push(...players.slice(MIN_STARTING[type]));
  }

  // Fill the rest of the XI with the best outfielders left, respecting maxima.
  const counts = formationCounts(starters, playersById);
  const spare: number[] = [];
  for (const el of remaining.sort(byPrice)) {
    const type = playersById.get(el)?.element_type;
    if (type != null && starters.length < STARTING_XI && counts[type] < MAX_STARTING[type]) {
      starters.push(el);
      counts[type] += 1;
    } else {
      spare.push(el);
    }
  }

  return [...starters, ...keepers.slice(1), ...spare];
}

/**
 * Apply substitutions to a squad, as pairs of slot indices swapped in order.
 * Out-of-range pairs are ignored rather than throwing — a saved plan can
 * outlive the shape of the squad it was written against.
 */
export function applySwaps<T>(squad: T[], swaps: [number, number][] | undefined): T[] {
  if (!swaps?.length) return squad;
  const next = [...squad];
  for (const [i, j] of swaps) {
    if (!Number.isInteger(i) || !Number.isInteger(j)) continue;
    if (i < 0 || j < 0 || i >= next.length || j >= next.length) continue;
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

/**
 * Swap two slots in a lineup. Returns null when the result would be illegal
 * (breaks the formation, starts two keepers, or moves the reserve keeper out
 * of the first bench slot), so callers can disable the interaction.
 */
export function swapLineupSlots(
  order: number[],
  i: number,
  j: number,
  playersById: Map<number, PlannerPlayer>,
): number[] | null {
  if (i === j || i < 0 || j < 0 || i >= order.length || j >= order.length) return null;
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return lineupErrors(next, playersById).length === 0 ? next : null;
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

/** One row of an FPL manager's per-gameweek history, as far as FTs care. */
export interface FreeTransferHistoryRow {
  event: number;
  event_transfers?: number;
  event_transfers_cost?: number;
}

export interface FreeTransferDerivation {
  /** Free transfers available entering `currentGw + 1`. */
  freeTransfers: number;
  /** False when the history looks inconsistent and the user should check it. */
  confident: boolean;
  transfersByGw: Record<number, number>;
}

/**
 * Derive free transfers by simulating from GW1 — the FPL API exposes no FT
 * field, so it has to be reconstructed from the transfer history.
 *
 * GW1 deliberately does NOT accrue. Squad selection before the first deadline
 * isn't a transfer, and FPL's first free transfer is the one you take into GW2:
 * a manager who made no GW1 transfers enters GW2 with 1, not 2.
 */
export function deriveFreeTransfers(
  rows: FreeTransferHistoryRow[],
  chipByGw: Map<number, string>,
  currentGw: number,
): FreeTransferDerivation {
  let ft = 1;
  let confident = rows.length >= currentGw - 1;
  const transfersByGw: Record<number, number> = {};

  for (const row of rows) {
    if (row.event > currentGw) continue;
    const used = row.event_transfers ?? 0;
    transfersByGw[row.event] = used;
    // The seed of 1 already represents "entering GW2", so GW1 must not accrue
    // on top of it.
    if (row.event > 1) {
      ft = freeTransfersAfter(ft, used, isFreeTransferChip(chipByGw.get(row.event)));
    }
    // A paid hit with 0 transfers recorded is a data inconsistency.
    if ((row.event_transfers_cost ?? 0) > 0 && used === 0) confident = false;
  }

  return { freeTransfers: ft, confident, transfersByGw };
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
 * `base.unlimitedGw` marks a week whose transfers are free and don't consume
 * the FT bank — used for GW1 in the pre-season draft, where editing your squad
 * before the deadline isn't a transfer at all.
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
    // Pre-GW1-deadline edits are free for the same reason wildcard weeks are:
    // they cost no points and leave the free-transfer bank untouched.
    const unlimited = base.unlimitedGw === gw;
    const chipActive = isFreeTransferChip(chip);
    const free = chipActive || unlimited;

    const applied = applyTransfers(squad, transfers, playersById, bank);
    const used = applied.applied;
    const hits = hitCost(ft, used, free);
    // Subs come after transfers, so a slot swapped this week reflects whoever
    // the transfers put there. The resulting order carries into later weeks,
    // matching FPL: a lineup change holds until you change it again.
    const ordered = applySwaps(applied.squad, week?.swaps);
    const errors = [...applied.errors, ...validateSquad(ordered, playersById)];

    if (week?.captain !== undefined && !ordered.some((s) => s.element === week.captain)) {
      errors.push('Captain is not in this week’s squad');
    }
    if (week?.vice !== undefined && !ordered.some((s) => s.element === week.vice)) {
      errors.push('Vice-captain is not in this week’s squad');
    }

    states.push({
      gw,
      squad: ordered,
      bank: applied.bank,
      freeTransfers: ft,
      used,
      hits,
      unlimited,
      errors,
      captain: week?.captain,
      vice: week?.vice,
      chip,
    });

    ft = freeTransfersAfter(ft, used, free);
    squad = ordered;
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
