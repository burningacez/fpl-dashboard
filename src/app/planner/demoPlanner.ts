/**
 * Demo data for the planner walkthroughs.
 *
 * Unlike the other three demos, this one does NOT invent a football universe.
 * /api/planner/data is published all pre-season — real teams, real players,
 * real fixtures, real difficulty — so fixtures, FDR, prices and the player
 * cards need no help. The only thing FPL withholds until the GW1 deadline is
 * the manager's own squad. So this builds a squad and a plan out of the live
 * feed and leaves everything else alone.
 *
 * Two consequences worth knowing:
 *
 * 1. It cannot hardcode element ids or names — they change every season, and
 *    a demo naming last year's players would be worse than no demo. The squad
 *    is picked by a price-shaped recipe against whatever the feed holds today,
 *    and the walkthrough reads its subjects' names back out of the result (see
 *    `DemoSubjects`), so a step says "Tap <that player>" and means it.
 * 2. Nothing here is persisted, ever. The planner is the one toured page that
 *    writes — it autosaves plans to localStorage — so demo mode has to be a
 *    sandbox rather than a render-time overlay: see the demoPlan/demoDraft
 *    state in page.tsx, which the real plan and draft never see.
 *
 * Dynamically imported, so it stays out of the /planner bundle for loads that
 * don't run a tour.
 */
import {
  INITIAL_BUDGET,
  POSITION_QUOTAS,
  SQUAD_SIZE,
  benchOf,
  defaultLineup,
  startersOf,
  type PlannerPlan,
  type PlannerPlayer,
  type SquadSlot,
} from '@/lib/squad-rules';
import { maxAffordable } from '@/lib/planner-draft';
import type { PlannerData, PlannerPlayerRow } from '@/lib/planner-data';

/**
 * What each slot is meant to cost, in tenths, most expensive first per
 * position. Sums to 995 of the 1000 budget, which leaves the £0.5m bank the
 * walkthrough talks about and, more importantly, makes the squad look like a
 * squad: two premium attackers, a thin bench, and defenders in the middle.
 *
 * Targets rather than fixed picks because the feed decides what exists. Every
 * pick is also capped by what is left after reserving the cheapest available
 * player for each slot still to fill, exactly as the real builder caps you.
 */
const PRICE_SHAPE: Record<number, number[]> = {
  1: [55, 40],
  2: [60, 55, 45, 45, 40],
  3: [145, 100, 75, 50, 45],
  4: [140, 60, 40],
};

/** The players a step points at by name, so the copy and the squad agree. */
export interface DemoSubjects {
  /** Bench player whose card the builder walkthrough opens. */
  benchPlayer: PlannerPlayerRow;
  /** Starter the planner walkthrough transfers out, and his replacement. */
  transferOut: PlannerPlayerRow;
  transferIn: PlannerPlayerRow;
  /** Position left empty in the 13-man draft, for "tap the empty shirt". */
  emptyPosition: number;
  /**
   * The player the builder walkthrough adds. Must be of `emptyPosition` and
   * inside the cap, because the list that step opens is filtered to that
   * position and, by default, to what you can actually afford — a subject
   * outside either is a step with nothing to tap.
   */
  builderPick: PlannerPlayerRow;
  /** What the builder's list is capped at, which the copy quotes. */
  builderCap: number;
}

export interface DemoPlanner {
  /** Squad in the shape /api/planner/squad returns, presented at `baseGw`. */
  squad: {
    entryId: number;
    gw: number;
    bank: number;
    value: number;
    activeChip: null;
    chipsUsed: { name: string; event: number }[];
    picks: (SquadSlot & { position: number; isCaptain: boolean; isViceCaptain: boolean })[];
    approximatePrices: false;
    freeTransfers: number;
    freeTransfersDerivation: { confident: boolean; transfersByGw: Record<number, number> };
  };
  /** A plan with something already in it, so nothing points at an empty page. */
  plan: PlannerPlan;
  /** The 15 element ids in lineup order, and the 13-man cut the builder starts from. */
  order: number[];
  draftOrder: number[];
  subjects: DemoSubjects;
}

/** Available, non-flagged, and not already taken. */
function candidates(players: PlannerPlayerRow[], type: number, taken: Set<number>, clubs: Map<number, number>) {
  return players.filter(
    (p) =>
      p.element_type === type &&
      !taken.has(p.id) &&
      p.status === 'a' &&
      (clubs.get(p.team) ?? 0) < 3,
  );
}

/**
 * Pick the player closest to `target` without breaking the budget.
 *
 * Ties go to the higher scorer and then to the lower id: pre-season every
 * points column is zero, so the id is what actually decides, and that is fine
 * as long as it is deterministic — the same demo squad every run means the
 * walkthrough's copy stays true and a screenshot diff means something.
 */
function pickClosest(pool: PlannerPlayerRow[], target: number, cap: number): PlannerPlayerRow | null {
  const affordable = pool.filter((p) => p.now_cost <= cap);
  const from = affordable.length ? affordable : pool;
  if (!from.length) return null;
  return [...from].sort(
    (a, b) =>
      Math.abs(a.now_cost - target) - Math.abs(b.now_cost - target) ||
      b.total_points - a.total_points ||
      a.id - b.id,
  )[0];
}

/**
 * Build a legal 15 from the live feed: 2/5/5/3, max three per club, inside
 * £100.0m. Returns element ids in FPL lineup order (XI then bench).
 */
function buildSquad(players: PlannerPlayerRow[]): number[] {
  const taken = new Set<number>();
  const clubs = new Map<number, number>();
  const picked: PlannerPlayerRow[] = [];

  // Flatten the shape into a slot list, dearest first, so the expensive picks
  // are made while there is still budget to make them with.
  const slots: { type: number; target: number }[] = [];
  for (const type of [1, 2, 3, 4]) {
    PRICE_SHAPE[type].forEach((target) => slots.push({ type, target }));
  }
  slots.sort((a, b) => b.target - a.target);

  let spend = 0;
  slots.forEach((slot, i) => {
    const remaining = slots.slice(i + 1);
    const pool = candidates(players, slot.type, taken, clubs);
    // Reserve the cheapest available option for every slot still to fill.
    const reserved = remaining.reduce((sum, r) => {
      const cheapest = candidates(players, r.type, taken, clubs).reduce(
        (min, p) => Math.min(min, p.now_cost),
        Infinity,
      );
      return sum + (Number.isFinite(cheapest) ? cheapest : 40);
    }, 0);
    const pick = pickClosest(pool, slot.target, INITIAL_BUDGET - spend - reserved);
    if (!pick) return;
    picked.push(pick);
    taken.add(pick.id);
    clubs.set(pick.team, (clubs.get(pick.team) ?? 0) + 1);
    spend += pick.now_cost;
  });

  return picked.map((p) => p.id);
}

export function buildDemoPlanner(
  data: PlannerData,
  entryId: number,
  season: string,
  /** True before the GW1 deadline: the base is a draft at gw 0, GW1 is free. */
  preSeason: boolean,
): DemoPlanner | null {
  const byId = new Map<number, PlannerPlayerRow>(data.players.map((p) => [p.id, p]));
  const ids = buildSquad(data.players);
  if (ids.length !== SQUAD_SIZE) return null;

  const typed = byId as unknown as Map<number, PlannerPlayer>;
  const order = defaultLineup(ids, typed);
  const spend = order.reduce((sum, id) => sum + (byId.get(id)?.now_cost ?? 0), 0);
  const bank = INITIAL_BUDGET - spend;

  // Pre-season the draft is presented at gw 0 so the fold's first week is GW1
  // itself; in-season it sits on the last completed gameweek, as a real squad
  // does. Free transfers follow: none banked before GW1, one otherwise.
  const baseGw = preSeason ? 0 : Math.max(1, (data.currentGw ?? 1) - 1);
  const freeTransfers = preSeason ? 0 : 1;

  const starters = startersOf(order);
  const bench = benchOf(order);
  // Captain and vice: the two dearest starters, which is what anyone would do.
  const byCost = [...starters].sort((a, b) => (byId.get(b)?.now_cost ?? 0) - (byId.get(a)?.now_cost ?? 0));
  const captain = byCost[0];
  const vice = byCost[1];

  const picks = order.map((element, i) => {
    const price = byId.get(element)?.now_cost ?? 0;
    return {
      element,
      purchasePrice: price,
      sellingPrice: price,
      position: i + 1,
      isCaptain: element === captain,
      isViceCaptain: element === vice,
    };
  });

  // ---- the subjects the script names ---------------------------------------
  // Transfer out: the cheapest starting midfielder — a plausible thing to move
  // on, and cheap enough that the bank plus his sale buys someone real.
  const transferOutId =
    [...starters]
      .filter((id) => byId.get(id)?.element_type === 3)
      .sort((a, b) => (byId.get(a)?.now_cost ?? 0) - (byId.get(b)?.now_cost ?? 0))[0] ?? starters[0];
  const transferOut = byId.get(transferOutId)!;
  const budgetForIn = bank + transferOut.now_cost;
  const owned = new Set(order);
  const sameClubCounts = new Map<number, number>();
  order.forEach((id) => {
    if (id === transferOutId) return;
    const t = byId.get(id)?.team;
    if (t != null) sameClubCounts.set(t, (sameClubCounts.get(t) ?? 0) + 1);
  });
  const replacements = data.players
    .filter(
      (p) =>
        p.element_type === transferOut.element_type &&
        !owned.has(p.id) &&
        p.status === 'a' &&
        (sameClubCounts.get(p.team) ?? 0) < 3,
    )
    .sort((a, b) => b.now_cost - a.now_cost || a.id - b.id);
  // Dearest affordable: the transfer should visibly spend the bank, because the
  // step after it is about what that cost.
  const transferIn = replacements.find((p) => p.now_cost <= budgetForIn) ?? replacements[0];
  if (!transferIn) return null;

  // ---- the 13-man draft the builder walkthrough starts from ---------------
  // Drop the cheapest forward and the cheapest midfielder, so there are two
  // gaps in different rows and the affordability cap has something to reserve.
  const dropFwd = [...order]
    .filter((id) => byId.get(id)?.element_type === 4)
    .sort((a, b) => (byId.get(a)?.now_cost ?? 0) - (byId.get(b)?.now_cost ?? 0))[0];
  const dropMid = [...order]
    .filter((id) => byId.get(id)?.element_type === 3)
    .sort((a, b) => (byId.get(a)?.now_cost ?? 0) - (byId.get(b)?.now_cost ?? 0))[0];
  const draftOrder = order.filter((id) => id !== dropFwd && id !== dropMid);
  // The forward the walkthrough puts back. He was in a legal 15 a moment ago,
  // so he is guaranteed to be inside the cap the list will apply — which the
  // step quotes, because it is less than the budget still unspent.
  const builderPick = byId.get(dropFwd)!;
  const builderCap = maxAffordable(draftOrder, builderPick.element_type, typed, INITIAL_BUDGET, data.players);

  // ---- a plan with something in it ----------------------------------------
  // One transfer already made in the second planned week, so the gameweek bar
  // has a marker and the footer has a row from step one; a Bench Boost two
  // weeks later, so the chip bar has a blocked chip to explain. The second
  // transfer — the one that costs 4 points — is made by the user, mid-tour.
  const firstGw = baseGw + 1;
  const seededOut = bench[bench.length - 1] ?? starters[0];
  const seededOutRow = byId.get(seededOut)!;
  const seededIn = data.players.find(
    (p) =>
      p.element_type === seededOutRow.element_type &&
      !owned.has(p.id) &&
      p.id !== transferIn.id &&
      p.status === 'a' &&
      p.now_cost <= seededOutRow.now_cost + bank,
  );

  const weeks: PlannerPlan['weeks'] = {};
  if (seededIn) weeks[String(firstGw + 1)] = { transfers: [{ out: seededOut, in: seededIn.id }] };
  weeks[String(firstGw + 3)] = { transfers: [], chip: 'bboost' };

  return {
    squad: {
      entryId,
      gw: baseGw,
      bank,
      value: spend,
      activeChip: null,
      // In-season, one chip already spent in the first half, so the chip bar
      // can show "Played GW7" alongside the planned-elsewhere case.
      chipsUsed: preSeason ? [] : [{ name: 'wildcard', event: Math.min(7, baseGw) }],
      picks,
      approximatePrices: false,
      freeTransfers,
      freeTransfersDerivation: { confident: true, transfersByGw: {} },
    },
    plan: {
      version: 1,
      entryId,
      season,
      baseGw,
      // Seeded in page.tsx once the demo squad exists, so it can never trip the
      // rebase banner against its own base.
      baseSquadHash: '',
      updatedAt: 0,
      weeks,
    },
    order,
    draftOrder,
    subjects: {
      benchPlayer: byId.get(bench[bench.length - 1])!,
      transferOut,
      transferIn,
      emptyPosition: builderPick.element_type,
      builderPick,
      builderCap,
    },
  };
}

/** Quotas, re-exported so the tour can talk about "two more to pick". */
export const DEMO_DRAFT_GAPS = SQUAD_SIZE - (SQUAD_SIZE - 2);
export { POSITION_QUOTAS };
