/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Demo data for the Head to Head walkthrough.
 *
 * This page needs more of a stand-in than the others. Pre-season
 * `/api/h2h` answers `{ available: false }` because there are no manager
 * profiles yet, and even mid-season the page shows nothing at all until two
 * managers have been picked — so a first visit is a pair of empty selects and
 * one line of prompt text. The demo therefore supplies BOTH halves: the roster
 * the two selects offer and the comparison behind them.
 *
 * The example season has played every gameweek up to DEMO_GW, so every card on
 * the page has something in it: a scoreboard, a record bar with wins on both
 * sides and a draw, two charts whose lines cross, a full gameweek table,
 * captain picks that sometimes agree, and chips in three different states.
 *
 * Nothing on this page fetches on open once a comparison has loaded, so demo
 * mode is a pure render-time override of the /api/h2h payload — the real
 * selection and the real payload are neither read nor written while a run is in
 * progress, and both come straight back when it ends.
 *
 * Dynamically imported, so it stays out of the /h2h bundle for page loads that
 * don't run a tour.
 *
 * Mirrors the shape of /api/h2h and nothing type-checks that (the page reads it
 * as `any`). `npm run test:tour:h2h` walks every step against this data and is
 * what catches it going stale.
 */
import { DEMO_GW, DEMO_ROSTER, DEMO_YOU_SLOT, seatUser, type DemoIdentity, type DemoManager } from '@/lib/demo-league';

export interface DemoH2HData {
  /** The /api/h2h payload the page renders while a run is in progress. */
  h2h: any;
  /** The example league, so the two selects offer a real-looking list. */
  members: DemoManager[];
  /** Entry ids of the compared pair, as the selects' values (strings). */
  m1: string;
  m2: string;
}

/**
 * The two slots of DEMO_ROSTER the run compares.
 *
 * Manager 1 is the slot the real user is seated into, because that is what the
 * live page does: with no ?m1/?m2 in the URL it pre-selects the logged-in
 * manager into the left slot. The walkthrough should describe the page people
 * actually land on.
 */
const M1_SLOT = DEMO_YOU_SLOT;
const M2_SLOT = 0;

const CHIP_TYPES = ['wildcard', 'freehit', 'bboost', '3xc'] as const;

/**
 * Chips each slot played, and when.
 *
 * Chosen so the grid has something in every state it can be in at DEMO_GW: a
 * gameweek number for one played in the first half, ✗ for a first-half chip
 * that expired unplayed, ✓ for a second-half chip still in hand, and a number
 * in the second half too, so "used" isn't only ever a first-half thing.
 */
const CHIP_PLAN: Record<number, { name: string; event: number }[]> = {
  [M1_SLOT]: [
    { name: 'wildcard', event: 7 },
    { name: 'bboost', event: 15 },
  ],
  // The Triple Captain lands on a gameweek the whole league captained the same
  // player, so the captain table shows the same name on both sides with one of
  // them scoring half as much again. That is the only place on the page the TC
  // badge means anything, and it would be wasted on a week they disagreed.
  [M2_SLOT]: [
    { name: 'wildcard', event: 4 },
    { name: '3xc', event: 8 },
    { name: 'freehit', event: 21 },
  ],
};

/**
 * The captain pool. Points are a function of the PLAYER and the gameweek, not
 * of who picked them: two managers on the same captain in the same week have to
 * score the same, or the captain table contradicts itself.
 */
const CAPTAINS = ['Haaland', 'Salah', 'Palmer', 'Saka', 'Isak', 'Watkins'];

/**
 * Raw points the captain scored, before the armband multiplier.
 *
 * The gameweek stride is coprime with 9 so a player's return varies from week to
 * week. Pick one that isn't and it lands in phase with the six-week name cycle,
 * and then every Palmer week in the table is worth exactly the same — a column
 * of returns that repeat with the names is the second tell after the names
 * themselves repeating.
 */
function captainBase(name: string, gw: number): number {
  const i = CAPTAINS.indexOf(name);
  return 4 + ((gw * 4 + i * 5) % 9);
}

/**
 * Who a slot captained in `gw`.
 *
 * Every fourth week the whole league piles onto the same obvious pick, which is
 * what gives the Same Captain count something to count; the rest of the time
 * the two slots differ (their indices are three apart in a pool of six, so they
 * can never collide by accident).
 *
 * The stride is coprime with the pool size on purpose. An even stride only ever
 * reaches half the pool, and the table then reads as three pairs of names
 * repeating down the column — which is exactly what it looked like first time
 * round, and is the tell that gives made-up data away.
 */
function captainName(slot: number, gw: number): string {
  if (gw % 4 === 0) return CAPTAINS[0];
  return CAPTAINS[(gw * 5 + slot * 3) % CAPTAINS.length];
}

/**
 * A manager's typical week, per slot. Close together on purpose: the two the run
 * compares have to be a real contest, or every card on the page reads the same
 * way and none of them teaches anything.
 */
const BASE = [50, 51, 49, 52, 47, 51];
/** Swing applied on top of the base score, rotated so neither line runs away. */
const SWINGS = [4, -6, 11, 0, -9, 7, -2, 14, -5, 2, 9, -11, 6, -3, 12, -8, 1, 10];
/**
 * Transfers made in a week, read at a different STRIDE per slot rather than a
 * different offset: two slots reading the same cyclic table at the same stride
 * land on the same season total however far apart they start, and the Transfers
 * card then shows Total Made tied at both ends with neither side highlighted.
 *
 * A quiet majority of weeks and never more than two, which keeps Hit Cost in
 * the range a real season produces rather than a number nobody would recognise.
 */
const TRANSFERS = [1, 0, 2, 1, 0, 1, 2, 0, 1, 1, 0, 2, 1, 0, 1, 0];

/**
 * One manager's gameweek in the example season. Deterministic, so the season is
 * identical on every run.
 *
 * The swing rotates with a different phase per slot on purpose: a flat base per
 * manager would hand every single week to the same person, and then the GW
 * Record bar would have no draws and no wins on one side, and the two chart
 * lines would never cross — which is the one thing those cards exist to show.
 * The constants are picked so the pair split the honours: manager 1 takes more
 * gameweeks and the better season, manager 2 holds the single best week and the
 * least-bad worst one, so no column on the page is a clean sweep.
 */
function gameweek(slot: number, gw: number) {
  const chip = CHIP_PLAN[slot]?.find((c) => c.event === gw)?.name ?? null;
  const swing = SWINGS[(gw * 5 + slot * 12) % SWINGS.length];
  const gross = BASE[slot % BASE.length] + swing + ((gw * 3 + slot * 7) % 9);
  const transfers = TRANSFERS[(gw * (slot + 2)) % TRANSFERS.length];
  // Four points per transfer past the free one, and nothing at all on a week a
  // Wildcard or Free Hit covered it — the two numbers the Transfers card puts
  // side by side, so one has to actually follow from the other.
  const transferCost = chip === 'wildcard' || chip === 'freehit' ? 0 : Math.max(0, transfers - 1) * 4;
  const name = captainName(slot, gw);
  return {
    gwScore: gross - transferCost,
    transfers,
    transferCost,
    benchPoints: (gw * 5 + slot * 7) % 14,
    captainName: name,
    captainPoints: captainBase(name, gw) * (chip === '3xc' ? 3 : 2),
    activeChip: chip,
  };
}

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

/**
 * Per-half chip status, derived exactly as buildChipStatus does it in
 * src/server/services/h2h.ts: FPL resets the chips at chipSecondHalfStartGw, so
 * an unplayed first-half chip expires the moment that gameweek arrives and the
 * second-half set unlocks at the same time.
 */
function chipStatus(used: { name: string; event: number }[], currentGW: number, secondHalfStart: number) {
  const status: any = { firstHalf: {}, secondHalf: {} };
  for (const type of CHIP_TYPES) {
    const h1 = used.find((c) => c.name === type && c.event < secondHalfStart);
    status.firstHalf[type] = h1
      ? { status: 'used', gw: h1.event }
      : currentGW >= secondHalfStart
        ? { status: 'expired' }
        : { status: 'available' };
    const h2 = used.find((c) => c.name === type && c.event >= secondHalfStart);
    status.secondHalf[type] = h2
      ? { status: 'used', gw: h2.event }
      : currentGW >= secondHalfStart
        ? { status: 'available' }
        : { status: 'locked' };
  }
  return status;
}

/**
 * League rank after each gameweek, computed across the whole example league
 * rather than the pair.
 *
 * The League Rank card is the one thing on this page that is not a two-way
 * comparison: a rank only means something against everyone else, so ranking the
 * two managers alone would put one of them first all season and make the chart
 * a pair of flat lines.
 */
function rankHistories(roster: DemoManager[], gws: number[]): Record<number, { gw: number; rank: number; points: number }[]> {
  const out: Record<number, { gw: number; rank: number; points: number }[]> = {};
  roster.forEach((_m, slot) => (out[slot] = []));
  const cumulative = roster.map(() => 0);

  for (const gw of gws) {
    const weeks = roster.map((_m, slot) => gameweek(slot, gw));
    weeks.forEach((w, slot) => (cumulative[slot] += w.gwScore));
    const order = roster
      .map((_m, slot) => ({ slot, total: cumulative[slot] }))
      .sort((a, b) => b.total - a.total);
    order.forEach(({ slot }, i) => out[slot].push({ gw, rank: i + 1, points: weeks[slot].gwScore }));
  }
  return out;
}

/**
 * `secondHalfStart` is the selected season's own chip reset gameweek, so the
 * chip grid shows the states this season's rules actually produce rather than a
 * hardcoded set that could drift from the page's own explanation.
 */
export function buildDemoH2H(me: DemoIdentity | null, secondHalfStart: number): DemoH2HData {
  const roster = seatUser(DEMO_ROSTER, me);
  const gws = Array.from({ length: DEMO_GW }, (_, i) => i + 1);
  const ranks = rankHistories(roster, gws);

  const weeks1 = gws.map((gw) => gameweek(M1_SLOT, gw));
  const weeks2 = gws.map((gw) => gameweek(M2_SLOT, gw));

  const gwComparison: any[] = [];
  const captainData: any[] = [];
  let m1Wins = 0;
  let m2Wins = 0;
  let draws = 0;
  let m1Cumulative = 0;
  let m2Cumulative = 0;
  let sameCaptainCount = 0;

  gws.forEach((gw, i) => {
    const w1 = weeks1[i];
    const w2 = weeks2[i];
    m1Cumulative += w1.gwScore;
    m2Cumulative += w2.gwScore;
    if (w1.gwScore > w2.gwScore) m1Wins++;
    else if (w2.gwScore > w1.gwScore) m2Wins++;
    else draws++;
    gwComparison.push({ gw, m1Points: w1.gwScore, m2Points: w2.gwScore, m1Cumulative, m2Cumulative });

    const same = w1.captainName === w2.captainName;
    if (same) sameCaptainCount++;
    captainData.push({
      gw,
      m1: { name: w1.captainName, points: w1.captainPoints, chip: w1.activeChip },
      m2: { name: w2.captainName, points: w2.captainPoints, chip: w2.activeChip },
      same,
    });
  });

  /** Best and worst single gameweek, off the same net scores the table shows. */
  const bestWorst = (weeks: ReturnType<typeof gameweek>[]) => {
    let best = { points: -Infinity, gw: 0 };
    let worst = { points: Infinity, gw: 0 };
    weeks.forEach((w, i) => {
      if (w.gwScore > best.points) best = { points: w.gwScore, gw: gws[i] };
      if (w.gwScore < worst.points) worst = { points: w.gwScore, gw: gws[i] };
    });
    return { best, worst };
  };
  const { best: m1Best, worst: m1Worst } = bestWorst(weeks1);
  const { best: m2Best, worst: m2Worst } = bestWorst(weeks2);

  const last5 = gws.slice(-5);
  const formOf = (weeks: ReturnType<typeof gameweek>[]) => {
    const scores = weeks.slice(-5).map((w) => w.gwScore);
    return { avg: Math.round((sum(scores) / scores.length) * 10) / 10, scores, gws: last5 };
  };

  const managerOf = (slot: number) => ({
    entryId: roster[slot].entryId,
    name: roster[slot].name,
    team: roster[slot].team,
  });

  return {
    h2h: {
      manager1: managerOf(M1_SLOT),
      manager2: managerOf(M2_SLOT),
      currentGW: DEMO_GW,
      headToHead: { m1Wins, m2Wins, draws },
      gwComparison,
      captains: {
        data: captainData,
        m1Total: sum(weeks1.map((w) => w.captainPoints)),
        m2Total: sum(weeks2.map((w) => w.captainPoints)),
        sameCaptainCount,
        totalGWs: captainData.length,
      },
      transfers: {
        m1: { total: sum(weeks1.map((w) => w.transfers)), cost: sum(weeks1.map((w) => w.transferCost)) },
        m2: { total: sum(weeks2.map((w) => w.transfers)), cost: sum(weeks2.map((w) => w.transferCost)) },
      },
      chips: {
        m1: chipStatus(CHIP_PLAN[M1_SLOT], DEMO_GW, secondHalfStart),
        m2: chipStatus(CHIP_PLAN[M2_SLOT], DEMO_GW, secondHalfStart),
      },
      form: { m1: formOf(weeks1), m2: formOf(weeks2) },
      totals: { m1: m1Cumulative, m2: m2Cumulative },
      benchPoints: {
        m1: sum(weeks1.map((w) => w.benchPoints)),
        m2: sum(weeks2.map((w) => w.benchPoints)),
      },
      bestGW: { m1: m1Best, m2: m2Best },
      worstGW: { m1: m1Worst, m2: m2Worst },
      rankHistory: { m1: ranks[M1_SLOT], m2: ranks[M2_SLOT] },
    },
    // Sorted by name, as the real selects are.
    members: [...roster].sort((a, b) => a.name.localeCompare(b.name)),
    m1: String(roster[M1_SLOT].entryId),
    m2: String(roster[M2_SLOT].entryId),
  };
}
