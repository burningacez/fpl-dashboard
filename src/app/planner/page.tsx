'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMyTeam, useSeason } from '@/components/providers';
import { ArchivedUnavailable } from '@/components/layout/ArchivedUnavailable';
import { Card, PageHeader, StatTile, Modal, Tabs, Badge, LoadingBlock, ErrorBlock } from '@/components/ui';
import { ShirtImage } from '@/components/pitch/PitchView';
import {
  foldPlan,
  squadHash,
  formatPrice,
  defaultLineup,
  lineupErrors,
  formationLabel,
  startersOf,
  benchOf,
  swapLineupSlots,
  validateSquad,
  MAX_FREE_TRANSFERS,
  POSITION_NAMES,
  POSITION_QUOTAS,
  SQUAD_SIZE,
  STARTING_XI,
  type PlannerPlan,
  type PlannerPlayer,
  type PlannerWeek,
  type SquadSlot,
  type GwState,
} from '@/lib/squad-rules';
import {
  clearDraft,
  draftSpend,
  draftToSlots,
  emptyDraft,
  isComplete,
  loadDraft,
  maxAffordable,
  saveDraft,
  type DraftSquad,
} from '@/lib/planner-draft';
import { getSeasonConfig } from '@/lib/season-config';
import { teamFdrStats, classifyGameweek, compareByAttractiveness } from '@/lib/fdr';

const HORIZON = 5; // plan this many GWs ahead

// Plannable chips. FPL issues one of each per half-season; the Assistant
// Manager chip is deliberately absent (its squad mechanics aren't modelled).
const CHIP_OPTIONS = [
  { id: 'wildcard', label: 'Wildcard', short: 'WC' },
  { id: 'freehit', label: 'Free Hit', short: 'FH' },
  { id: 'bboost', label: 'Bench Boost', short: 'BB' },
  { id: '3xc', label: 'Triple Captain', short: 'TC' },
] as const;

const CHIP_SHORT: Record<string, string> = Object.fromEntries(CHIP_OPTIONS.map((c) => [c.id, c.short]));

type PlannerView = 'pitch' | 'fixtures' | 'prices';
const VIEW_LABELS: Record<PlannerView, string> = { pitch: 'Pitch', fixtures: 'Fixtures', prices: 'Prices' };

// ---- types for the API payloads -----------------------------------------
interface PlannerData {
  currentGw: number;
  nextGw: number;
  events: { id: number; deadline_time: string; finished: boolean; is_current: boolean; is_next: boolean }[];
  teams: { id: number; name: string; short_name: string; code?: number }[];
  players: (PlannerPlayer & {
    cost_change_event: number;
    cost_change_start: number;
    transfers_in_event: number;
    transfers_out_event: number;
    price_change_percent: number; // signed % progress to next change (100 = threshold)
    total_points: number;
    form: string;
    points_per_game: string;
    selected_by_percent: string;
    status: string;
    news: string;
  })[];
  fixtures: {
    id: number;
    event: number | null;
    team_h: number;
    team_a: number;
    team_h_difficulty: number;
    team_a_difficulty: number;
    kickoff_time: string | null;
  }[];
}
interface SquadData {
  entryId: number;
  /** 0 for a pre-season draft: the squad as it stands before GW1 is played. */
  gw: number;
  bank: number;
  value: number;
  activeChip: string | null;
  chipsUsed: { name: string; event: number }[];
  picks: (SquadSlot & { position: number; isCaptain: boolean; isViceCaptain: boolean })[];
  approximatePrices: boolean;
  freeTransfers: number;
  freeTransfersDerivation: { confident: boolean; transfersByGw: Record<number, number> };
}

/** Pre-season reply from /api/planner/squad: there is no squad to fetch yet. */
interface PreSeasonInfo {
  preSeason: true;
  entryId: number;
  builderEnabled: boolean;
  firstGw: number;
  firstDeadline: string | null;
  budget: number;
}

type SquadResponse = ({ preSeason: false } & SquadData) | PreSeasonInfo;

/** Why the "your plan no longer matches its base" banner is showing. */
type RebaseReason = 'squad-changed' | 'draft-changed' | 'season-started';

const REBASE_COPY: Record<RebaseReason, { message: string; action: string }> = {
  'squad-changed': {
    message: 'Your real team changed since this plan was saved.',
    action: 'Rebase to current squad',
  },
  'draft-changed': {
    message: 'Your draft squad changed since this plan was saved.',
    action: 'Rebase to draft squad',
  },
  'season-started': {
    message:
      'The season has started. Your real GW1 squad has replaced the pre-season draft, so this plan is still based on the draft.',
    action: 'Rebase to real squad',
  },
};

// Planner plans (and their localStorage keys) are scoped to the active season.
// Earlier builds hardcoded '2026-27' here, so restore migrates that key.
const LEGACY_PLAN_SEASON = '2026-27';

// ---- fixture-difficulty helpers ------------------------------------------
function fixturesForTeam(data: PlannerData, teamId: number, gw: number) {
  return data.fixtures
    .filter((f) => f.event === gw && (f.team_h === teamId || f.team_a === teamId))
    .map((f) => {
      const home = f.team_h === teamId;
      const oppId = home ? f.team_a : f.team_h;
      const opp = data.teams.find((t) => t.id === oppId);
      return {
        short: opp?.short_name ?? '???',
        home,
        fdr: home ? f.team_h_difficulty : f.team_a_difficulty,
      };
    });
}

function FdrPill({ short, home, fdr }: { short: string; home: boolean; fdr: number }) {
  return (
    <span className={`fdr-${fdr} inline-block rounded px-1 py-0.5 text-[0.65rem] font-bold`}>
      {short}
      {home ? ' (H)' : ' (A)'}
    </span>
  );
}

export default function PlannerPage() {
  const { me } = useMyTeam();
  const { season, currentSeason } = useSeason();

  if (season !== null) return <ArchivedUnavailable title="Team Planner" />;

  if (!me) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <PageHeader title="Team Planner" />
        <Card>
          <p className="text-body">
            Plan your transfers, prices and fixtures weeks ahead. First, tap the{' '}
            <span className="font-bold text-me">👤 Who are you?</span> button in the top bar and pick your team.
          </p>
        </Card>
      </main>
    );
  }

  // Wait for /api/seasons so the plan's storage key is season-correct from the start.
  if (!currentSeason) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <PageHeader title="Team Planner" />
        <LoadingBlock label="Loading…" />
      </main>
    );
  }

  return <PlannerInner entryId={me.entryId} teamName={me.team} season={currentSeason} />;
}

function PlannerInner({ entryId, teamName, season }: { entryId: number; teamName: string; season: string }) {
  const [data, setData] = useState<PlannerData | null>(null);
  const [squadRes, setSquadRes] = useState<SquadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Squad failures are non-fatal: we fall back to a fixtures-only view rather
  // than erroring. Note this is a genuine failure — the expected pre-season
  // "no squad yet" case is a successful reply with preSeason: true.
  const [squadError, setSquadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftSquad | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [plan, setPlan] = useState<PlannerPlan | null>(null);
  const [activeGw, setActiveGw] = useState<number | null>(null);
  const [rebaseReason, setRebaseReason] = useState<RebaseReason | null>(null);
  const [view, setView] = useState<PlannerView>('pitch');
  const [browser, setBrowser] = useState<{ gw: number; outElement: number | null } | null>(null);
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storageKey = `fpl-planner-${entryId}-${season}`;

  // ---- load data + squad (independently) ----
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setSquadError(null);
    // The fixture feed is essential — a failure here is fatal to the page.
    fetch('/api/planner/data')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) throw new Error(d.error);
        setData(d);
      })
      .catch((e) => !cancelled && setError(e.message));
    // The squad is optional: before the GW1 deadline FPL publishes no picks, and
    // mid-season the endpoint can fail transiently.
    fetch(`/api/planner/squad/${entryId}`)
      .then((r) => r.json())
      .then((s) => {
        if (cancelled) return;
        if (s.error) {
          setSquadError(s.error);
          return;
        }
        setSquadRes(s);
      })
      .catch((e) => !cancelled && setSquadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [entryId]);

  const preSeason = squadRes?.preSeason === true;
  // The builder is allowlisted server-side; everyone else gets the pre-season
  // fixtures/prices view they got before.
  const draftMode = squadRes?.preSeason === true && squadRes.builderEnabled;

  // ---- pre-season draft: load once, and bin it the moment a real squad lands ----
  useEffect(() => {
    if (!squadRes) return;
    if (squadRes.preSeason === false) {
      // The season has begun: the real squad is the only truth from here.
      clearDraft(entryId, season);
      setDraft(null);
      return;
    }
    if (!squadRes.builderEnabled) return;
    const existing = loadDraft(entryId, season);
    setDraft(existing ?? emptyDraft(entryId, season));
    // Straight into the builder when there's nothing usable saved yet.
    if (!existing || !isComplete(existing)) setBuilderOpen(true);
  }, [squadRes, entryId, season]);

  const playersById = useMemo(() => {
    const m = new Map<number, PlannerData['players'][number]>();
    data?.players.forEach((p) => m.set(p.id, p));
    return m;
  }, [data]);

  /**
   * The planner's base squad, from FPL in-season or from the local draft
   * pre-season. A completed draft is presented at gw 0 — "the squad as it
   * stands before GW1" — so the fold's first week is GW1 itself, which is what
   * you're actually picking. Free transfers start at 0 because GW1 is an
   * unlimited week; accrual then yields the correct 1 FT entering GW2.
   */
  const squad: SquadData | null = useMemo(() => {
    if (!squadRes) return null;
    if (squadRes.preSeason === false) return squadRes;
    if (!squadRes.builderEnabled || !data || !draft || !isComplete(draft)) return null;
    const slots = draftToSlots(draft.order, playersById as Map<number, PlannerPlayer>);
    const spend = draftSpend(draft.order, playersById as Map<number, PlannerPlayer>);
    return {
      entryId,
      gw: 0,
      bank: squadRes.budget - spend,
      value: spend,
      activeChip: null,
      chipsUsed: [],
      picks: slots.map((s, i) => ({ ...s, position: i + 1, isCaptain: false, isViceCaptain: false })),
      approximatePrices: false,
      freeTransfers: 0,
      freeTransfersDerivation: { confident: true, transfersByGw: {} },
    };
  }, [squadRes, data, draft, playersById, entryId]);

  // ---- seed / restore the plan once squad+data are in ----
  useEffect(() => {
    if (!data || !squad) return;
    const baseSquad: SquadSlot[] = squad.picks.map((p) => ({
      element: p.element,
      purchasePrice: p.purchasePrice,
      sellingPrice: p.sellingPrice,
    }));
    const freshHash = squadHash(baseSquad, squad.bank);

    let restored: PlannerPlan | null = null;
    try {
      // One-time migration of plans saved under the old hardcoded season key.
      if (season !== LEGACY_PLAN_SEASON && !localStorage.getItem(storageKey)) {
        const legacyKey = `fpl-planner-${entryId}-${LEGACY_PLAN_SEASON}`;
        const legacy = localStorage.getItem(legacyKey);
        if (legacy) {
          const parsed = JSON.parse(legacy);
          parsed.season = season;
          localStorage.setItem(storageKey, JSON.stringify(parsed));
          localStorage.removeItem(legacyKey);
        }
      }
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Only trust a plan that matches this entry/season/shape — a stale or
        // foreign blob under our key must not silently become the plan.
        if (parsed?.version === 1 && parsed.entryId === entryId && parsed.season === season) {
          restored = parsed;
        }
      }
    } catch {
      /* ignore */
    }

    if (restored && restored.baseSquadHash === freshHash && restored.baseGw === squad.gw) {
      setPlan(restored);
      setRebaseReason(null);
    } else if (restored) {
      // A plan exists but its base moved — keep it and flag a rebase. Which
      // base moved decides the wording: a plan built pre-season against the
      // draft (baseGw 0) meeting a real squad is season start, not a transfer.
      setPlan(restored);
      setRebaseReason(
        restored.baseGw === 0 && squad.gw > 0
          ? 'season-started'
          : squad.gw === 0
            ? 'draft-changed'
            : 'squad-changed',
      );
    } else {
      setPlan(freshPlan(entryId, season, squad.gw, freshHash));
      setRebaseReason(null);
    }
    setActiveGw((g) => g ?? squad.gw + 1);
  }, [data, squad, entryId, season, storageKey]);

  // ---- autosave (debounced) ----
  useEffect(() => {
    if (!plan) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      localStorage.setItem(storageKey, JSON.stringify({ ...plan, updatedAt: Date.now() }));
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [plan, storageKey]);

  const baseSquad: SquadSlot[] = useMemo(
    () =>
      squad
        ? squad.picks.map((p) => ({ element: p.element, purchasePrice: p.purchasePrice, sellingPrice: p.sellingPrice }))
        : [],
    [squad],
  );

  const effectiveFt = plan?.ftOverride ?? squad?.freeTransfers ?? 1;
  const chipSecondHalfStartGw = getSeasonConfig(season)?.chipSecondHalfStartGw ?? 20;

  const states: GwState[] = useMemo(() => {
    if (!plan || !squad || !data) return [];
    return foldPlan(
      {
        squad: baseSquad,
        bank: squad.bank,
        freeTransfers: effectiveFt,
        baseGw: squad.gw,
        // Pre-season the base is the draft at gw 0, so GW1's changes are squad
        // edits before the deadline: free, and not counted as transfers.
        unlimitedGw: squad.gw === 0 ? 1 : undefined,
      },
      plan,
      playersById as Map<number, PlannerPlayer>,
      squad.gw + HORIZON,
    );
  }, [plan, squad, data, baseSquad, effectiveFt, playersById]);

  const activeState = states.find((s) => s.gw === activeGw) ?? null;

  // ---- mutations ----
  const mutateWeek = useCallback(
    (gw: number, fn: (w: PlannerPlan['weeks'][string]) => PlannerPlan['weeks'][string]) => {
      setPlan((prev) => {
        if (!prev) return prev;
        const week = prev.weeks[String(gw)] ?? { transfers: [] };
        return { ...prev, weeks: { ...prev.weeks, [String(gw)]: fn(week) } };
      });
    },
    [],
  );

  const doTransfer = useCallback(
    (gw: number, outEl: number, inEl: number) => {
      mutateWeek(gw, (w) => ({ ...w, transfers: [...w.transfers, { out: outEl, in: inEl }] }));
      setBrowser(null);
    },
    [mutateWeek],
  );

  const setCaptain = useCallback((gw: number, el: number, role: 'captain' | 'vice') => {
    mutateWeek(gw, (w) => {
      // Captain and vice must be different players: assigning one role clears
      // the same player from the other.
      const other = role === 'captain' ? 'vice' : 'captain';
      const next = { ...w, [role]: el };
      if (next[other] === el) next[other] = undefined;
      return next;
    });
  }, [mutateWeek]);

  const setChip = useCallback((gw: number, chip: string | null) => {
    mutateWeek(gw, (w) => ({ ...w, chip }));
  }, [mutateWeek]);

  const undoTransfer = useCallback(
    (gw: number, index: number) =>
      mutateWeek(gw, (w) => ({ ...w, transfers: w.transfers.filter((_, i) => i !== index) })),
    [mutateWeek],
  );

  const resetGw = useCallback(
    (gw: number) => mutateWeek(gw, () => ({ transfers: [] })),
    [mutateWeek],
  );

  const rebase = useCallback(() => {
    if (!squad) return;
    setPlan(freshPlan(entryId, season, squad.gw, squadHash(baseSquad, squad.bank)));
    setActiveGw(squad.gw + 1);
    setRebaseReason(null);
  }, [squad, entryId, season, baseSquad]);

  const saveDraftOrder = useCallback(
    (order: number[]) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const next = { ...prev, order, updatedAt: Date.now() };
        saveDraft(next);
        return next;
      });
    },
    [],
  );

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <PageHeader title="Team Planner" />
        <ErrorBlock message={error} />
      </main>
    );
  }
  // Fixtures need only the feed; wait solely on that so a slow/missing squad
  // never blocks them.
  if (!data) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10">
        <PageHeader title="Team Planner" />
        <LoadingBlock label="Loading fixtures…" />
      </main>
    );
  }
  // Pre-season squad builder: pick a GW1 team locally so the planner can be
  // used (and exercised) before FPL publishes anything.
  if (draftMode && builderOpen && draft && squadRes?.preSeason) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-8 pb-16">
        <PageHeader title="Squad Builder" subtitle={teamName} />
        <SandboxNotice firstGw={squadRes.firstGw} firstDeadline={squadRes.firstDeadline} />
        <SquadBuilder
          data={data}
          playersById={playersById}
          order={draft.order}
          budget={squadRes.budget}
          onChange={saveDraftOrder}
          onDone={() => setBuilderOpen(false)}
        />
      </main>
    );
  }

  // Squad couldn't be loaded — a genuine failure (FPL outage, unknown entry).
  // The pitch/transfer view needs a squad; fixtures & prices still work.
  // Pre-season without the builder is the same shape, with different wording.
  if (squadError || (preSeason && !draftMode)) {
    const firstGw = data.events.find((e) => !e.finished) ?? data.events[0];
    const preView: PlannerView = view === 'prices' ? 'prices' : 'fixtures';
    return (
      <main className="mx-auto max-w-4xl px-4 py-8 pb-16">
        <PageHeader title="Team Planner" subtitle={teamName} />
        <Card className="mb-4 border-warning">
          <p className="text-sm text-body">
            {squadError ? (
              <>
                Your squad couldn’t be loaded, so transfer planning is unavailable right now. Here are
                the upcoming fixtures, difficulty ratings and price changes in the meantime.
              </>
            ) : (
              <>
                Transfer planning unlocks once your squad is published. FPL releases it when{' '}
                <span className="font-bold text-me">GW{firstGw?.id}</span> locks
                {firstGw?.deadline_time ? ` (${formatDeadline(firstGw.deadline_time)})` : ''}. Until then,
                here are the upcoming fixtures, difficulty ratings and price changes.
              </>
            )}
          </p>
        </Card>
        <div className="mb-4">
          <ViewToggle view={preView} setView={setView} views={['fixtures', 'prices']} />
        </div>
        {preView === 'fixtures' ? (
          <FixturesView data={data} baseGw={(data.currentGw ?? 1) - 1} />
        ) : (
          <PricesView data={data} />
        )}
      </main>
    );
  }
  if (!squad || !plan || !activeState || activeGw == null) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10">
        <PageHeader title="Team Planner" />
        <LoadingBlock label="Loading your squad…" />
      </main>
    );
  }

  const upcomingGws = data.events.filter((e) => e.id > squad.gw).slice(0, HORIZON);
  const outgoingPrice = browser?.outElement != null
    ? activeState.squad.find((s) => s.element === browser.outElement)?.sellingPrice ?? 0
    : 0;
  const maxBrowsePrice = browser?.outElement != null ? activeState.bank + outgoingPrice : Infinity;
  const browsePosition =
    browser?.outElement != null ? playersById.get(browser.outElement)?.element_type : undefined;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 pb-16">
      <PageHeader title="Team Planner" subtitle={teamName} />

      {draftMode && squadRes?.preSeason && (
        <>
          <SandboxNotice firstGw={squadRes.firstGw} firstDeadline={squadRes.firstDeadline} />
          <div className="mb-4">
            <button
              onClick={() => setBuilderOpen(true)}
              className="rounded-md border border-edge px-3 py-1.5 text-sm font-semibold hover:border-accent"
            >
              Edit draft squad
            </button>
          </div>
        </>
      )}

      {squad.approximatePrices && (
        <div className="mb-3">
          <Badge tone="negative">Approximate prices: FPL didn’t return exact buy/sell values</Badge>
        </div>
      )}

      {rebaseReason && (
        <Card className="mb-4 border-warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-warning">{REBASE_COPY[rebaseReason].message}</span>
            <button onClick={rebase} className="rounded-md bg-accent px-3 py-1.5 font-bold text-accent-fg">
              {REBASE_COPY[rebaseReason].action}
            </button>
          </div>
        </Card>
      )}

      {/* view toggle: Pitch / Fixtures / Prices */}
      <div className="mb-4 flex gap-2">
        <ViewToggle view={view} setView={setView} views={['pitch', 'fixtures', 'prices']} />
        {view === 'pitch' && (
          <button
            onClick={() => setBrowser({ gw: activeGw, outElement: null })}
            className="ml-auto rounded-md border border-edge px-3 py-1.5 text-sm font-semibold hover:border-accent"
          >
            Browse players
          </button>
        )}
      </div>

      {view === 'pitch' ? (
        <>
          {/* stat tiles */}
          <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Bank" value={formatPrice(activeState.bank)} tone={activeState.bank < 0 ? 'negative' : 'accent'} />
            <StatTile
              label="Squad value"
              value={formatPrice(activeState.squad.reduce((sum, s) => sum + s.sellingPrice, 0) + activeState.bank)}
            />
            <div className="rounded-xl border border-edge bg-surface px-4 py-3">
              <div className="text-xs font-bold uppercase tracking-wide text-muted">Free transfers</div>
              <div className="mt-0.5 flex items-center gap-2">
                {activeState.unlimited ? (
                  // Before the GW1 deadline you're still building a squad, not
                  // transferring — changes are free and nothing is banked.
                  <span className="text-xl font-extrabold text-accent" title="Squad changes are free until the GW1 deadline">
                    Unlimited
                  </span>
                ) : (
                  <>
                    <span className="text-xl font-extrabold text-accent">{activeState.freeTransfers}</span>
                    <FtOverride setPlan={setPlan} derived={squad.freeTransfers} confident={squad.freeTransfersDerivation.confident} />
                  </>
                )}
              </div>
            </div>
            <StatTile label="Points hit" value={activeState.hits ? `-${activeState.hits}` : '0'} tone={activeState.hits ? 'negative' : 'accent'} />
          </div>

          {/* GW tabs */}
          <div className="mb-4">
            <Tabs
              active={String(activeGw)}
              onChange={(id) => setActiveGw(Number(id))}
              tabs={upcomingGws.map((e) => {
                const st = states.find((s) => s.gw === e.id);
                const wk = plan.weeks[String(e.id)];
                const count = wk?.transfers.length ?? 0;
                const hasErrors = (st?.errors.length ?? 0) > 0;
                return {
                  id: String(e.id),
                  label: (
                    <span className="flex items-center gap-1.5">
                      GW{e.id}
                      {wk?.chip && (
                        <span className="rounded bg-black/20 px-1 text-[0.65rem] font-bold">
                          {CHIP_SHORT[wk.chip] ?? wk.chip}
                        </span>
                      )}
                      {count > 0 && <span className="rounded-full bg-black/20 px-1.5 text-xs">{count}</span>}
                      {hasErrors && <span className="h-1.5 w-1.5 rounded-full bg-negative" />}
                    </span>
                  ),
                };
              })}
            />
            <p className="mt-1 text-xs text-muted">
              Deadline: {formatDeadline(upcomingGws.find((e) => e.id === activeGw)?.deadline_time)}
            </p>
          </div>

          {/* chip selector for the active GW */}
          <ChipBar
            gw={activeGw}
            plan={plan}
            chipsUsed={squad.chipsUsed}
            secondHalfStartGw={chipSecondHalfStartGw}
            onSet={(chip) => setChip(activeGw, chip)}
          />

          {/* validation errors */}
          {activeState.errors.length > 0 && (
            <div className="mb-4 rounded-lg border border-negative/40 bg-negative-soft p-3 text-sm text-negative">
              {activeState.errors.map((e, i) => (
                <div key={i}>• {e}</div>
              ))}
            </div>
          )}

          <PitchView
            state={activeState}
            data={data}
            playersById={playersById}
            onTransferOut={(el) => setBrowser({ gw: activeGw, outElement: el })}
            onCaptain={(el, role) => setCaptain(activeGw, el, role)}
          />

          {/* footer: transfer list */}
          <TransferFooter
            state={activeState}
            week={plan.weeks[String(activeGw)]}
            playersById={playersById}
            onUndo={(i) => undoTransfer(activeGw, i)}
            onReset={() => resetGw(activeGw)}
            saved={saved}
          />
        </>
      ) : view === 'fixtures' ? (
        <FixturesView data={data} baseGw={squad.gw} />
      ) : (
        <PricesView data={data} />
      )}

      {browser && (
        <PlayerBrowser
          data={data}
          owned={activeState.squad.map((s) => s.element)}
          position={browsePosition}
          outElement={browser.outElement}
          maxPrice={maxBrowsePrice}
          onPick={(inEl) =>
            browser.outElement != null
              ? doTransfer(browser.gw, browser.outElement, inEl)
              : setBrowser(null)
          }
          onClose={() => setBrowser(null)}
          browseOnly={browser.outElement == null}
          preSeason={preSeason}
        />
      )}
    </main>
  );
}

// =============================================================================
// subcomponents
// =============================================================================

function freshPlan(entryId: number, season: string, baseGw: number, baseSquadHash: string): PlannerPlan {
  return { version: 1, entryId, season, baseGw, baseSquadHash, updatedAt: Date.now(), weeks: {} };
}

function formatDeadline(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function FtOverride({
  setPlan,
  derived,
  confident,
}: {
  setPlan: (fn: (p: PlannerPlan | null) => PlannerPlan | null) => void;
  /** Server-derived FT count — the base the first +/- tap adjusts from. */
  derived: number;
  confident: boolean;
}) {
  const set = (delta: number) =>
    setPlan((p) =>
      p
        ? {
            ...p,
            ftOverride: Math.max(0, Math.min(MAX_FREE_TRANSFERS, (p.ftOverride ?? derived) + delta)),
          }
        : p,
    );
  return (
    <span className="flex items-center gap-1" title={confident ? 'Adjust starting free transfers' : 'Derived value may be off. Adjust it'}>
      <button onClick={() => set(-1)} className="rounded border border-edge px-1.5 text-sm leading-none">−</button>
      <button onClick={() => set(1)} className="rounded border border-edge px-1.5 text-sm leading-none">+</button>
      {!confident && <span className="text-[0.6rem] text-warning">check</span>}
    </span>
  );
}

/**
 * Chip selector for one planned gameweek. FPL 2025+ chip rules: one of each
 * chip per half-season (halves split at chipSecondHalfStartGw), one chip per
 * gameweek. A chip already played (chipsUsed) or planned in another GW of the
 * same half is disabled with the reason shown.
 */
function ChipBar({
  gw,
  plan,
  chipsUsed,
  secondHalfStartGw,
  onSet,
}: {
  gw: number;
  plan: PlannerPlan;
  chipsUsed: { name: string; event: number }[];
  secondHalfStartGw: number;
  onSet: (chip: string | null) => void;
}) {
  const half = (g: number) => (g < secondHalfStartGw ? 1 : 2);
  const selected = plan.weeks[String(gw)]?.chip ?? null;

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold uppercase tracking-wide text-muted">Chip</span>
      {CHIP_OPTIONS.map((c) => {
        const usedRow = chipsUsed.find((u) => u.name === c.id && half(u.event) === half(gw));
        const plannedGw = Object.entries(plan.weeks).find(
          ([g, w]) => w.chip === c.id && Number(g) !== gw && half(Number(g)) === half(gw),
        );
        const isSelected = selected === c.id;
        const blocked = !isSelected && (usedRow != null || plannedGw != null);
        const reason = usedRow
          ? `Played GW${usedRow.event}`
          : plannedGw
            ? `Planned GW${plannedGw[0]}`
            : undefined;
        return (
          <button
            key={c.id}
            type="button"
            disabled={blocked}
            onClick={() => onSet(isSelected ? null : c.id)}
            title={reason ?? (isSelected ? `Remove ${c.label}` : `Play ${c.label} in GW${gw}`)}
            className={`rounded-md border px-2.5 py-1 text-xs font-bold ${
              isSelected
                ? 'border-accent bg-accent text-accent-fg'
                : blocked
                  ? 'cursor-not-allowed border-edge text-faint line-through'
                  : 'border-edge text-muted hover:border-accent hover:text-body'
            }`}
          >
            {c.label}
            {blocked && reason && <span className="ml-1 font-semibold no-underline">({reason})</span>}
          </button>
        );
      })}
    </div>
  );
}

function ViewToggle({
  view,
  setView,
  views,
}: {
  view: PlannerView;
  setView: (v: PlannerView) => void;
  views: readonly PlannerView[];
}) {
  return (
    <div className="flex rounded-lg border border-edge bg-surface p-1">
      {views.map((v) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={`rounded-md px-3 py-1 text-sm font-bold ${view === v ? 'bg-accent text-accent-fg' : 'text-muted'}`}
        >
          {VIEW_LABELS[v]}
        </button>
      ))}
    </div>
  );
}

// Predicted price-change indicator for a squad player on the pitch. Hidden when
// the field is 0 (no movement / pre-season). Sign assumed to encode direction.
function PitchPriceIndicator({ pct }: { pct: number }) {
  if (!pct) return null;
  const up = pct > 0;
  const crossing = Math.abs(pct) >= 100;
  return (
    <span
      className={`mt-0.5 rounded px-1 text-[0.55rem] font-bold leading-tight ${up ? 'bg-positive-soft text-positive' : 'bg-negative-soft text-negative'} ${crossing ? 'ring-1 ring-current' : ''}`}
      title={crossing ? 'Over threshold: expected to change at 00:00 UK' : 'Progress to next price change'}
    >
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

/**
 * One shirt on the pitch (or on the bench). Shared by the planner pitch and the
 * squad builder so a player looks identical in both.
 *
 * Fills its parent (w-full) rather than sizing itself: callers wrap it in a
 * SLOT_CLASS container. Sizing here instead would collapse the chip wherever a
 * wrapper is needed — for the bench number badge, or the builder's selection
 * ring — because the percentage would resolve against the wrapper, not the row.
 */
// A fixed share of the row rather than w-1/5, and shrink-0: five slots plus
// their gaps would otherwise overflow and flex would shrink them, making a
// crowded row's slots narrower than a sparse one's. Every slot on every row is
// the same size, filled or empty.
const SLOT_CLASS = 'w-[19%] min-w-0 max-w-24 shrink-0';

function PlayerChip({
  element,
  data,
  playersById,
  gw,
  isCaptain,
  isVice,
  onClick,
  compact,
}: {
  element: number;
  data: PlannerData;
  playersById: Map<number, any>;
  gw: number;
  isCaptain?: boolean;
  isVice?: boolean;
  onClick?: () => void;
  compact?: boolean;
}) {
  const p = playersById.get(element);
  if (!p) return null;
  const fixtures = fixturesForTeam(data, p.team, gw);
  const teamCode = data.teams.find((t) => t.id === p.team)?.code;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 cursor-pointer flex-col items-center rounded-md text-center"
    >
      <div className="relative">
        <ShirtImage
          teamCode={teamCode}
          positionId={p.element_type}
          className={`object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.4)] ${compact ? 'h-9 w-9 sm:h-10 sm:w-10' : 'h-12 w-12 sm:h-14 sm:w-14'}`}
        />
        {isCaptain && (
          <span className="absolute -right-1 bottom-0 flex h-4 w-4 items-center justify-center rounded-full border border-white bg-black text-[0.55rem] font-bold text-white">
            C
          </span>
        )}
        {isVice && (
          <span className="absolute -right-1 bottom-0 flex h-4 w-4 items-center justify-center rounded-full border border-white bg-neutral-500 text-[0.55rem] font-bold text-white">
            V
          </span>
        )}
      </div>
      <span className="w-full truncate rounded px-0.5 text-[0.68rem] font-bold text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.8)]">
        {p.web_name}
      </span>
      <span className="text-[0.6rem] font-semibold text-white/90 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
        {formatPrice(p.now_cost)}
      </span>
      {!compact && <PitchPriceIndicator pct={p.price_change_percent} />}
      {!compact && (
        <div className="mt-0.5 flex flex-wrap justify-center gap-0.5">
          {fixtures.length ? (
            fixtures.map((f, i) => <FdrPill key={i} {...f} />)
          ) : (
            <span className="text-[0.6rem] font-semibold text-white/70 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
              blank
            </span>
          )}
        </div>
      )}
    </button>
  );
}

/**
 * A position still to fill. Deliberately mirrors PlayerChip's structure line
 * for line — dashed square where the shirt goes, then the name, price and
 * fixture lines reserved but invisible — so an empty slot is exactly the same
 * size and shape as a filled one and rows stay aligned as the squad fills up.
 */
function EmptySlot({ type, onClick }: { type: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Add a ${POSITION_NAMES[type]}`}
      className="flex w-full min-w-0 cursor-pointer flex-col items-center rounded-md text-center"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-md border-2 border-dashed border-white/45 bg-black/10 sm:h-14 sm:w-14">
        <span className="text-lg font-bold leading-none text-white/70">+</span>
      </div>
      <span className="w-full truncate rounded px-0.5 text-[0.68rem] font-bold text-white/85 [text-shadow:0_1px_3px_rgba(0,0,0,0.8)]">
        {POSITION_NAMES[type]}
      </span>
      <span aria-hidden className="invisible text-[0.6rem] font-semibold">
        £0.0m
      </span>
      <div aria-hidden className="mt-0.5 flex justify-center gap-0.5">
        <span className="invisible rounded px-1 py-0.5 text-[0.65rem] font-bold">XXX (H)</span>
      </div>
    </button>
  );
}

/** The green backdrop with markings — shared by the pitch and the builder. */
function PitchSurface({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative py-3"
      style={{
        background:
          'repeating-linear-gradient(180deg, var(--pitch-from) 0, var(--pitch-from) 10%, var(--pitch-to) 10%, var(--pitch-to) 20%)',
      }}
    >
      <div className="pointer-events-none absolute inset-x-4 inset-y-2 border-2 border-white/25">
        <div className="absolute inset-x-0 top-1/2 h-0.5 bg-white/25" />
        <div className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/25" />
        <div className="absolute left-1/2 top-0 h-9 w-32 -translate-x-1/2 border-2 border-t-0 border-white/25" />
        <div className="absolute bottom-0 left-1/2 h-9 w-32 -translate-x-1/2 border-2 border-b-0 border-white/25" />
      </div>
      {children}
    </div>
  );
}

function PitchView({
  state,
  data,
  playersById,
  onTransferOut,
  onCaptain,
}: {
  state: GwState;
  data: PlannerData;
  playersById: Map<number, any>;
  onTransferOut: (el: number) => void;
  onCaptain: (el: number, role: 'captain' | 'vice') => void;
}) {
  const [sheet, setSheet] = useState<number | null>(null);

  // The squad array is held in FPL lineup order (0-10 start, 11-14 bench), so
  // the split is positional. applyTransfers swaps in place, which keeps that
  // ordering intact across planned weeks.
  const order = state.squad.map((s) => s.element);
  const starters = startersOf(order);
  const bench = benchOf(order);
  const lineupProblems = lineupErrors(order, playersById as Map<number, PlannerPlayer>);
  const byType = (t: number) => starters.filter((el) => playersById.get(el)?.element_type === t);

  return (
    <div className="overflow-hidden rounded-xl border border-edge">
      <div className="flex items-center justify-between gap-2 border-b border-edge bg-surface px-3 py-1.5 text-xs">
        <span className="font-bold uppercase tracking-wide text-muted">
          Formation <span className="text-body">{formationLabel(starters, playersById as Map<number, PlannerPlayer>)}</span>
        </span>
        <span className="text-muted">Starting XI above, bench below</span>
      </div>
      <PitchSurface>
        {[1, 2, 3, 4].map((type) => {
          const row = byType(type);
          if (row.length === 0) return null;
          return (
            <div key={type} className="relative flex justify-center gap-0.5 py-2">
              {row.map((el) => (
                <div key={el} className={SLOT_CLASS}>
                  <PlayerChip
                    element={el}
                    data={data}
                    playersById={playersById}
                    gw={state.gw}
                    isCaptain={state.captain === el}
                    isVice={state.vice === el}
                    onClick={() => setSheet(el)}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </PitchSurface>

      {bench.length > 0 && (
        <div className="border-t border-edge bg-raised/60 px-2 py-2">
          <div className="mb-1 px-1 text-[0.65rem] font-bold uppercase tracking-wide text-muted">
            Bench <span className="font-semibold normal-case text-faint">(in substitution order)</span>
          </div>
          <div className="flex justify-center gap-0.5">
            {bench.map((el, i) => (
              <div key={el} className={`relative ${SLOT_CLASS}`}>
                <span className="absolute -top-0.5 left-1 z-10 text-[0.55rem] font-bold text-muted">
                  {i === 0 ? 'GK' : i}
                </span>
                <PlayerChip
                  element={el}
                  data={data}
                  playersById={playersById}
                  gw={state.gw}
                  isCaptain={state.captain === el}
                  isVice={state.vice === el}
                  onClick={() => setSheet(el)}
                  compact
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {lineupProblems.length > 0 && (
        <div className="border-t border-edge bg-warning/10 px-3 py-2 text-xs text-warning">
          {lineupProblems.map((e, i) => (
            <div key={i}>• {e}</div>
          ))}
          <div className="mt-1 text-muted">
            A transfer changed the shape of your XI. Fix the lineup on FPL, or in the squad builder
            pre-season.
          </div>
        </div>
      )}

      {sheet != null && (
        <Modal title={playersById.get(sheet)?.web_name ?? 'Player'} onClose={() => setSheet(null)}>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => {
                onTransferOut(sheet);
                setSheet(null);
              }}
              className="rounded-md bg-negative-soft px-3 py-2 text-left font-semibold text-negative"
            >
              Transfer out
            </button>
            <button
              onClick={() => {
                onCaptain(sheet, 'captain');
                setSheet(null);
              }}
              className="rounded-md bg-raised px-3 py-2 text-left font-semibold"
            >
              Make captain
            </button>
            <button
              onClick={() => {
                onCaptain(sheet, 'vice');
                setSheet(null);
              }}
              className="rounded-md bg-raised px-3 py-2 text-left font-semibold"
            >
              Make vice-captain
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// =============================================================================
// Pre-season squad builder
// =============================================================================

/**
 * Unmissable, permanent reminder that the draft is a sandbox. Someone who
 * builds a nice-looking squad here could easily believe they've entered a team
 * for the season — they haven't, and the only place that happens is FPL.
 */
function SandboxNotice({ firstGw, firstDeadline }: { firstGw: number; firstDeadline: string | null }) {
  return (
    <Card className="mb-4 border-warning">
      <p className="text-sm text-body">
        <span className="font-bold text-warning">Practice squad.</span> This is a sandbox for trying out
        the planner before the season starts. It does <span className="font-bold">not</span> enter a team
        into FPL — do that at{' '}
        <a
          href="https://fantasy.premierleague.com/my-team"
          target="_blank"
          rel="noreferrer"
          className="font-semibold text-accent underline"
        >
          fantasy.premierleague.com
        </a>
        . Your real squad replaces this draft once GW{firstGw} locks
        {firstDeadline ? ` (${formatDeadline(firstDeadline)})` : ''}.
      </p>
    </Card>
  );
}

/**
 * Pick a 15-man squad from £100.0m, then set the starting XI and bench order.
 *
 * Reuses the rules engine rather than reimplementing the rules: validateSquad
 * covers size/quotas/clubs, lineupErrors covers the formation, and maxAffordable
 * stops you spending so much on one pick that the squad can't be completed.
 */
function SquadBuilder({
  data,
  playersById,
  order,
  budget,
  onChange,
  onDone,
}: {
  data: PlannerData;
  playersById: Map<number, any>;
  order: number[];
  budget: number;
  onChange: (order: number[]) => void;
  onDone: () => void;
}) {
  // Which position the "add player" browser is filtering to, null when closed.
  const [adding, setAdding] = useState<number | null>(null);
  const [selected, setSelected] = useState<number | null>(null);

  const typed = playersById as Map<number, PlannerPlayer>;
  const spend = draftSpend(order, typed);
  const remaining = budget - spend;
  const full = order.length === SQUAD_SIZE;

  const squadProblems = useMemo(
    () => (full ? validateSquad(draftToSlots(order, typed), typed) : []),
    [full, order, typed],
  );
  const lineupProblems = useMemo(() => (full ? lineupErrors(order, typed) : []), [full, order, typed]);
  const ready = full && remaining >= 0 && squadProblems.length === 0 && lineupProblems.length === 0;

  const addPlayer = useCallback(
    (el: number) => {
      const next = [...order, el];
      // Once the fifteenth arrives, arrange a legal XI so the user starts from
      // something valid rather than an arbitrary split they have to repair.
      onChange(next.length === SQUAD_SIZE ? defaultLineup(next, typed) : next);
      setAdding(null);
    },
    [order, onChange, typed],
  );

  const removePlayer = useCallback(
    (el: number) => {
      onChange(order.filter((e) => e !== el));
      setSelected(null);
    },
    [order, onChange],
  );

  // Tap one player then another to swap their slots — the same gesture works
  // for starter/bench swaps and for reordering the bench.
  const tapSlot = useCallback(
    (el: number) => {
      if (!full) return;
      if (selected == null) {
        setSelected(el);
        return;
      }
      if (selected === el) {
        setSelected(null);
        return;
      }
      const i = order.indexOf(selected);
      const j = order.indexOf(el);
      const swapped = swapLineupSlots(order, i, j, typed);
      if (swapped) onChange(swapped);
      setSelected(null);
    },
    [full, selected, order, onChange, typed],
  );

  const maxForNext = adding != null ? maxAffordable(order, adding, typed, budget, data.players) : Infinity;

  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-3">
        <StatTile label="Budget left" value={formatPrice(remaining)} tone={remaining < 0 ? 'negative' : 'accent'} />
        <StatTile label="Players" value={`${order.length}/${SQUAD_SIZE}`} />
      </div>

      <p className="mb-3 text-sm text-muted">
        {full
          ? 'Tap two players to swap their places. The top eleven start; the four below are your bench, in substitution order.'
          : 'Tap an empty shirt to pick that position. Max 3 players from any one club.'}
      </p>

      <BuilderPitch
        data={data}
        playersById={playersById}
        order={order}
        full={full}
        selected={selected}
        onTapSlot={tapSlot}
        onTapEmpty={setAdding}
        onSelectIncomplete={setSelected}
      />

      {selected != null && !full && (
        <Card className="mt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold">{playersById.get(selected)?.web_name}</span>
            <button
              onClick={() => removePlayer(selected)}
              className="rounded-md bg-negative-soft px-3 py-1.5 text-sm font-semibold text-negative"
            >
              Remove
            </button>
          </div>
        </Card>
      )}

      {selected != null && full && (
        <p className="mt-3 text-center text-sm text-accent">
          Tap another player to swap places with {playersById.get(selected)?.web_name}, or{' '}
          <button onClick={() => removePlayer(selected)} className="font-semibold underline">
            remove them
          </button>
          .
        </p>
      )}

      {(squadProblems.length > 0 || lineupProblems.length > 0 || remaining < 0) && (
        <div className="mt-4 rounded-lg border border-negative/40 bg-negative-soft p-3 text-sm text-negative">
          {remaining < 0 && <div>• Over budget by {formatPrice(-remaining)}</div>}
          {[...squadProblems, ...lineupProblems].map((e, i) => (
            <div key={i}>• {e}</div>
          ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={onDone}
          disabled={!ready}
          className={`rounded-md px-4 py-2 font-bold ${
            ready ? 'bg-accent text-accent-fg' : 'cursor-not-allowed border border-edge text-faint'
          }`}
        >
          {ready ? 'Plan with this squad' : `Pick ${SQUAD_SIZE - order.length || 0} more`}
        </button>
        {order.length > 0 && (
          <button onClick={() => onChange([])} className="text-sm text-muted hover:text-negative">
            Clear squad
          </button>
        )}
        {full && (
          <button
            onClick={() => onChange(defaultLineup(order, typed))}
            className="text-sm text-muted hover:text-accent"
          >
            Auto-pick lineup
          </button>
        )}
      </div>

      {adding != null && (
        <PlayerBrowser
          data={data}
          owned={order}
          position={adding}
          outElement={null}
          maxPrice={maxForNext}
          onPick={addPlayer}
          onClose={() => setAdding(null)}
          browseOnly={false}
          title={`Add ${POSITION_NAMES[adding]}`}
          preSeason
        />
      )}
    </>
  );
}

/**
 * Builder pitch: the drafted XI in formation with the bench below, plus dashed
 * placeholders for slots still to fill. Before the squad is complete there's no
 * meaningful starter/bench split, so everyone is shown in position rows.
 */
function BuilderPitch({
  data,
  playersById,
  order,
  full,
  selected,
  onTapSlot,
  onTapEmpty,
  onSelectIncomplete,
}: {
  data: PlannerData;
  playersById: Map<number, any>;
  order: number[];
  full: boolean;
  selected: number | null;
  onTapSlot: (el: number) => void;
  /** Tapping a vacant slot opens the player list filtered to that position. */
  onTapEmpty: (type: number) => void;
  onSelectIncomplete: (el: number | null) => void;
}) {
  const starters = full ? startersOf(order) : order;
  const bench = full ? benchOf(order) : [];
  const byType = (t: number) => starters.filter((el) => playersById.get(el)?.element_type === t);

  const ring = (el: number) =>
    selected === el ? 'rounded-lg ring-2 ring-accent ring-offset-1 ring-offset-black/20' : '';

  return (
    <div className="overflow-hidden rounded-xl border border-edge">
      <PitchSurface>
        {[1, 2, 3, 4].map((type) => {
          const row = byType(type);
          const missing = full ? 0 : POSITION_QUOTAS[type] - row.length;
          if (row.length === 0 && missing === 0) return null;
          return (
            <div key={type} className="relative flex justify-center gap-0.5 py-2">
              {row.map((el) => (
                <div key={el} className={`${SLOT_CLASS} ${ring(el)}`}>
                  <PlayerChip
                    element={el}
                    data={data}
                    playersById={playersById}
                    gw={1}
                    onClick={() => (full ? onTapSlot(el) : onSelectIncomplete(selected === el ? null : el))}
                  />
                </div>
              ))}
              {Array.from({ length: Math.max(0, missing) }).map((_, i) => (
                <div key={`empty-${i}`} className={SLOT_CLASS}>
                  <EmptySlot type={type} onClick={() => onTapEmpty(type)} />
                </div>
              ))}
            </div>
          );
        })}
      </PitchSurface>

      {bench.length > 0 && (
        <div className="border-t border-edge bg-raised/60 px-2 py-2">
          <div className="mb-1 px-1 text-[0.65rem] font-bold uppercase tracking-wide text-muted">
            Bench <span className="font-semibold normal-case text-faint">(in substitution order)</span>
          </div>
          <div className="flex justify-center gap-0.5">
            {bench.map((el, i) => (
              <div key={el} className={`relative ${SLOT_CLASS} ${ring(el)}`}>
                <span className="absolute -top-0.5 left-1 z-10 text-[0.55rem] font-bold text-muted">
                  {i === 0 ? 'GK' : i}
                </span>
                <PlayerChip
                  element={el}
                  data={data}
                  playersById={playersById}
                  gw={1}
                  onClick={() => onTapSlot(el)}
                  compact
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Fixtures — the difficulty matrix (FDR) for all remaining gameweeks.
// Team-centric, so it doesn't depend on the planned squad.
// =============================================================================

const FDR_RANGE_OPTIONS = [
  { key: 'all', label: 'All season' },
  { key: '3', label: 'Next 3' },
  { key: '5', label: 'Next 5' },
] as const;

function FixturesView({ data, baseGw }: { data: PlannerData; baseGw: number }) {
  const [range, setRange] = useState<'all' | '3' | '5'>('all');
  const allGws = useMemo(() => data.events.filter((e) => e.id > baseGw), [data.events, baseGw]);
  const gws = useMemo(
    () => (range === 'all' ? allGws : allGws.slice(0, Number(range))),
    [allGws, range],
  );

  if (allGws.length === 0) {
    return (
      <Card>
        <p className="text-sm text-muted">No upcoming gameweeks to show.</p>
      </Card>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.7rem] text-muted">
          Fixture difficulty. Scroll across. Upper case = home, lower case = away.
        </p>
        <label className="flex items-center gap-1.5 text-sm text-muted">
          Show
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as 'all' | '3' | '5')}
            className="rounded-md border border-edge bg-raised px-2 py-1 text-sm text-body"
          >
            {FDR_RANGE_OPTIONS.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FdrMatrix data={data} gws={gws} />
      <FdrLegend />
    </div>
  );
}

function FdrMatrix({ data, gws }: { data: PlannerData; gws: PlannerData['events'] }) {
  const { rows, gwKinds } = useMemo(() => {
    // One pass builds every team's per-gameweek fixtures; column classification
    // and per-team stats are both derived from it.
    const built = data.teams.map((team) => ({
      team,
      cells: gws.map((e) => fixturesForTeam(data, team.id, e.id)),
    }));
    const gwKinds = gws.map((_, i) => classifyGameweek(built.map((b) => b.cells[i].length)));
    const gwActive = gwKinds.map((k) => k.active);
    const rows = built
      .map((b) => ({ ...b, stats: teamFdrStats(b.cells, gwActive) }))
      .sort((a, b) => compareByAttractiveness(a.stats, b.stats));
    return { rows, gwKinds };
  }, [data, gws]);

  return (
    <div className="overflow-x-auto rounded-xl border border-edge">
      <table className="w-full border-collapse text-[0.65rem]">
        <thead>
          <tr className="bg-surface">
            <th className="sticky left-0 z-10 bg-surface px-2 py-1 text-left font-bold">Team</th>
            {gws.map((e, i) => (
              <th key={e.id} className="px-1 py-1 text-center font-semibold text-muted">
                <span className="flex flex-col items-center gap-0.5 leading-none">
                  <span>{e.id}</span>
                  {gwKinds[i].dgw && <span className="fdr-gwtag fdr-gwtag--dgw">DGW</span>}
                  {gwKinds[i].bgw && <span className="fdr-gwtag fdr-gwtag--bgw">BGW</span>}
                </span>
              </th>
            ))}
            <th
              className="px-2 py-1 text-center font-bold"
              title="Attractiveness: average difficulty, improved for double gameweeks and worsened for blanks. Lower is better."
            >
              Attr.
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ team, cells, stats }) => (
            <tr key={team.id} className="border-t border-edge">
              <td className="sticky left-0 z-10 whitespace-nowrap bg-raised px-2 py-0.5 font-bold">
                {team.short_name}
              </td>
              {cells.map((fx, i) => (
                <td key={i} className="px-0.5 py-0.5 text-center">
                  {fx.length ? (
                    <div
                      className={`flex flex-col items-center gap-0.5 ${fx.length >= 2 ? 'fdr-cell-dgw px-0.5 py-0.5' : ''}`}
                    >
                      {fx.map((f, j) => (
                        <span
                          key={j}
                          className={`fdr-${f.fdr} block rounded px-1 py-0.5 font-bold leading-none`}
                        >
                          {f.home ? f.short.toUpperCase() : f.short.toLowerCase()}
                        </span>
                      ))}
                    </div>
                  ) : gwKinds[i].bgw ? (
                    <span className="fdr-bgw-chip">BGW</span>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              ))}
              <td className="px-2 py-0.5 text-center font-bold">
                {stats.score != null ? (
                  <span className="flex flex-col items-center leading-tight">
                    <span>{stats.score.toFixed(1)}</span>
                    <span className="text-[0.55rem] font-semibold text-muted">
                      {stats.games} game{stats.games === 1 ? '' : 's'}
                    </span>
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Compact key for the matrix: the FDR colour scale plus the double/blank
// markers, so the new cell types are legible without a paragraph of prose.
function FdrLegend() {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[0.65rem] text-muted">
      <span className="flex items-center gap-1.5">
        <span className="font-semibold">FDR</span>
        <span className="flex overflow-hidden rounded">
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} className={`fdr-${n} grid h-4 w-6 place-items-center font-bold leading-none`}>
              {n}
            </span>
          ))}
        </span>
        <span>easy → hard</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="fdr-cell-dgw inline-block h-4 w-4" />
        <span>Double gameweek</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span className="fdr-bgw-chip">BGW</span>
        <span>Blank gameweek</span>
      </span>
    </div>
  );
}

// =============================================================================
// Prices — two modes:
//  • Predicted: players nearest the price-change threshold, from the new
//    2026/27 `price_change_percent` field (100 = threshold, sign = direction).
//    OFFERED ONLY once real (non-zero) values exist — the field's semantics
//    are unverified until FPL publishes live values, so no sample/placeholder
//    content ships to users.
//  • Recent: realized changes already applied (cost_change_event/start).
// Squad-independent.
// =============================================================================

type PriceScope = 'cost_change_event' | 'cost_change_start';
type PlayerRow = PlannerData['players'][number];
const PREDICT_COUNT_OPTIONS = [20, 50] as const;

function PricesView({ data }: { data: PlannerData }) {
  // The Predicted tab only exists when the feed carries real values.
  const hasPredictions = useMemo(
    () => data.players.some((p) => p.price_change_percent !== 0),
    [data.players],
  );
  const [mode, setMode] = useState<'predicted' | 'recent'>(hasPredictions ? 'predicted' : 'recent');

  const teamsById = useMemo(() => {
    const m = new Map<number, PlannerData['teams'][number]>();
    data.teams.forEach((t) => m.set(t.id, t));
    return m;
  }, [data.teams]);

  const effectiveMode = hasPredictions ? mode : 'recent';

  return (
    <div>
      {hasPredictions && (
        <div className="mb-3 flex rounded-lg border border-edge bg-surface p-1">
          {(['predicted', 'recent'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 text-sm font-bold ${effectiveMode === m ? 'bg-accent text-accent-fg' : 'text-muted'}`}
            >
              {m === 'predicted' ? 'Predicted' : 'Recent'}
            </button>
          ))}
        </div>
      )}
      {effectiveMode === 'predicted' ? (
        <PredictedMovers data={data} teamsById={teamsById} />
      ) : (
        <RecentChanges data={data} teamsById={teamsById} />
      )}
    </div>
  );
}

function PredictedMovers({
  data,
  teamsById,
}: {
  data: PlannerData;
  teamsById: Map<number, PlannerData['teams'][number]>;
}) {
  const [count, setCount] = useState<number>(20);

  // "Nearest the threshold" = largest magnitude toward each direction.
  const { rises, drops } = useMemo(() => {
    const rises = data.players
      .filter((p) => p.price_change_percent > 0)
      .sort((a, b) => b.price_change_percent - a.price_change_percent)
      .slice(0, count);
    const drops = data.players
      .filter((p) => p.price_change_percent < 0)
      .sort((a, b) => a.price_change_percent - b.price_change_percent)
      .slice(0, count);
    return { rises, drops };
  }, [data.players, count]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[0.7rem] text-muted">
          Progress to the next price change · 100% = threshold · applied 00:00 UK.
        </p>
        <label className="flex items-center gap-1.5 text-sm text-muted">
          Show top
          <select
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="rounded-md border border-edge bg-raised px-2 py-1 text-sm text-body"
          >
            {PREDICT_COUNT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <PredictedList title="Predicted rises ▲" up players={rises} teamsById={teamsById} />
        <PredictedList title="Predicted drops ▼" up={false} players={drops} teamsById={teamsById} />
      </div>
    </div>
  );
}

function PredictedList({
  title,
  up,
  players,
  teamsById,
}: {
  title: string;
  up: boolean;
  players: PlayerRow[];
  teamsById: Map<number, PlannerData['teams'][number]>;
}) {
  return (
    <Card>
      <h3 className={`mb-2 font-bold ${up ? 'text-positive' : 'text-negative'}`}>{title}</h3>
      {players.length === 0 ? (
        <p className="text-sm text-faint">None.</p>
      ) : (
        <div className="flex flex-col divide-y divide-edge">
          {players.map((p) => (
            <div key={p.id} className="flex items-center gap-2 py-1.5 text-sm">
              <span className="w-9 shrink-0 text-xs font-semibold text-muted">
                {teamsById.get(p.team)?.short_name ?? '???'}
              </span>
              <span className="flex-1 truncate font-semibold">{p.web_name}</span>
              <span className="shrink-0 tabular-nums text-muted">{formatPrice(p.now_cost)}</span>
              <PricePctBadge pct={p.price_change_percent} />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// A signed price-change-progress %. Magnitude toward 100 (threshold); at/over
// 100 it's expected to cross at the next 00:00 UK update, so we emphasise it.
function PricePctBadge({ pct }: { pct: number }) {
  const up = pct > 0;
  const crossing = Math.abs(pct) >= 100;
  return (
    <span
      className={`w-14 shrink-0 text-right font-bold tabular-nums ${up ? 'text-positive' : 'text-negative'} ${crossing ? 'underline decoration-dotted' : ''}`}
      title={crossing ? 'Over threshold: expected to change at 00:00 UK' : undefined}
    >
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%
    </span>
  );
}

function RecentChanges({
  data,
  teamsById,
}: {
  data: PlannerData;
  teamsById: Map<number, PlannerData['teams'][number]>;
}) {
  const [scope, setScope] = useState<PriceScope>('cost_change_event');

  const { risers, fallers } = useMemo(() => {
    const net = (p: PlayerRow) => p.transfers_in_event - p.transfers_out_event;
    const risers = data.players
      .filter((p) => p[scope] > 0)
      .sort((a, b) => b[scope] - a[scope] || net(b) - net(a));
    const fallers = data.players
      .filter((p) => p[scope] < 0)
      .sort((a, b) => a[scope] - b[scope] || net(a) - net(b));
    return { risers, fallers };
  }, [data.players, scope]);

  const anyChanges = risers.length > 0 || fallers.length > 0;

  return (
    <div>
      <div className="mb-3 flex rounded-lg border border-edge bg-surface p-1">
        {(['cost_change_event', 'cost_change_start'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setScope(s)}
            className={`rounded-md px-3 py-1 text-sm font-bold ${scope === s ? 'bg-accent text-accent-fg' : 'text-muted'}`}
          >
            {s === 'cost_change_event' ? 'This GW' : 'Season'}
          </button>
        ))}
      </div>
      {!anyChanges ? (
        <Card>
          <p className="text-sm text-muted">
            No price changes {scope === 'cost_change_event' ? 'this gameweek' : 'yet this season'}. Prices
            move once managers start transferring players in and out. This fills in during the season.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <RecentList title="Risers ▲" up players={risers} scope={scope} teamsById={teamsById} />
          <RecentList title="Fallers ▼" up={false} players={fallers} scope={scope} teamsById={teamsById} />
        </div>
      )}
    </div>
  );
}

function RecentList({
  title,
  up,
  players,
  scope,
  teamsById,
}: {
  title: string;
  up: boolean;
  players: PlayerRow[];
  scope: PriceScope;
  teamsById: Map<number, PlannerData['teams'][number]>;
}) {
  return (
    <Card>
      <h3 className={`mb-2 font-bold ${up ? 'text-positive' : 'text-negative'}`}>{title}</h3>
      {players.length === 0 ? (
        <p className="text-sm text-faint">None.</p>
      ) : (
        <div className="flex flex-col divide-y divide-edge">
          {players.slice(0, 30).map((p) => {
            const change = p[scope];
            return (
              <div key={p.id} className="flex items-center gap-2 py-1.5 text-sm">
                <span className="w-9 shrink-0 text-xs font-semibold text-muted">
                  {teamsById.get(p.team)?.short_name ?? '???'}
                </span>
                <span className="flex-1 truncate font-semibold">{p.web_name}</span>
                <span className="shrink-0 tabular-nums text-muted">{formatPrice(p.now_cost)}</span>
                <span
                  className={`w-11 shrink-0 text-right font-bold tabular-nums ${change > 0 ? 'text-positive' : 'text-negative'}`}
                >
                  {change > 0 ? '+' : '−'}
                  {(Math.abs(change) / 10).toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function TransferFooter({
  state,
  week,
  playersById,
  onUndo,
  onReset,
  saved,
}: {
  state: GwState;
  week: PlannerWeek | undefined;
  playersById: Map<number, any>;
  onUndo: (index: number) => void;
  onReset: () => void;
  saved: boolean;
}) {
  const transfers = week?.transfers ?? [];
  const name = (el: number) => playersById.get(el)?.web_name ?? `#${el}`;
  return (
    <Card className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-bold">GW{state.gw} transfers</h3>
        <span className="flex items-center gap-3 text-sm">
          {saved && <span className="text-positive">Saved ✓</span>}
          {transfers.length > 0 && (
            <button onClick={onReset} className="text-muted hover:text-negative">
              Reset GW
            </button>
          )}
        </span>
      </div>
      {transfers.length > 0 && (
        <div className="mb-2 flex flex-col divide-y divide-edge">
          {transfers.map((t, i) => (
            <div key={`${t.out}-${t.in}-${i}`} className="flex items-center gap-2 py-1.5 text-sm">
              <span className="font-semibold text-negative">{name(t.out)}</span>
              <span className="text-faint" aria-hidden>
                →
              </span>
              <span className="flex-1 font-semibold text-positive">{name(t.in)}</span>
              <button
                onClick={() => onUndo(i)}
                title="Undo this transfer"
                className="rounded border border-edge px-1.5 text-xs text-muted hover:border-negative hover:text-negative"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {state.hits > 0 && <Badge tone="negative">Cost: -{state.hits} pts</Badge>}
      <p className="mt-2 text-sm text-muted">
        {state.unlimited ? (
          <>
            {state.used} change{state.used === 1 ? '' : 's'} made. Squad changes before the GW1 deadline are
            free and don’t count towards your season’s transfers. Tap a player on the pitch to swap them out.
          </>
        ) : (
          <>
            Used {state.used} transfer{state.used === 1 ? '' : 's'} · {state.freeTransfers} free entering this GW.
            Tap a player on the pitch to transfer them out.
          </>
        )}
      </p>
    </Card>
  );
}

function PlayerBrowser({
  data,
  owned,
  position,
  outElement,
  maxPrice,
  onPick,
  onClose,
  browseOnly,
  title,
  preSeason,
}: {
  data: PlannerData;
  /** Element ids already in the squad — excluded from the list. */
  owned: number[];
  position: number | undefined;
  /** Player being transferred out (frees up his club slot), null when browsing. */
  outElement: number | null;
  maxPrice: number;
  onPick: (inEl: number) => void;
  onClose: () => void;
  browseOnly: boolean;
  title?: string;
  /** Pre-season every points/form column is 0, so price is the useful sort. */
  preSeason?: boolean;
}) {
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<number | 'all'>(position ?? 'all');
  const [team, setTeam] = useState<number | 'all'>('all');
  const [sort, setSort] = useState<'price' | 'points' | 'form' | 'ownership'>(
    preSeason ? 'price' : 'points',
  );
  const [limit, setLimit] = useState(50);

  const rows = useMemo(() => {
    const ownedSet = new Set(owned);
    let list = data.players.filter((p) => !ownedSet.has(p.id));
    if (pos !== 'all') list = list.filter((p) => p.element_type === pos);
    if (team !== 'all') list = list.filter((p) => p.team === team);
    if (!browseOnly && position != null) {
      list = list.filter((p) => p.element_type === position && p.now_cost <= maxPrice);
      // 3-per-club rule: hide players whose club is already full once the
      // outgoing player leaves, instead of surfacing a post-hoc error.
      const clubCounts = new Map<number, number>();
      for (const el of owned) {
        if (el === outElement) continue;
        const t = data.players.find((pl) => pl.id === el)?.team;
        if (t != null) clubCounts.set(t, (clubCounts.get(t) ?? 0) + 1);
      }
      list = list.filter((p) => (clubCounts.get(p.team) ?? 0) < 3);
    }
    if (q) list = list.filter((p) => p.web_name.toLowerCase().includes(q.toLowerCase()));
    const num = (s: string) => parseFloat(s) || 0;
    list = [...list].sort((a, b) => {
      switch (sort) {
        case 'price':
          return b.now_cost - a.now_cost;
        case 'form':
          return num(b.form) - num(a.form);
        case 'ownership':
          return num(b.selected_by_percent) - num(a.selected_by_percent);
        default:
          return b.total_points - a.total_points;
      }
    });
    return list;
  }, [data.players, owned, pos, team, q, sort, position, maxPrice, browseOnly, outElement]);

  return (
    <Modal
      title={
        title ??
        (browseOnly ? 'Browse players' : `Transfer in ${position != null ? POSITION_NAMES[position] : ''}`)
      }
      onClose={onClose}
      wide
    >
      {!browseOnly && (
        <p className="mb-2 text-sm text-muted">Budget: {formatPrice(maxPrice)}</p>
      )}
      {preSeason && (
        <p className="mb-2 text-xs text-faint">
          Points, form and ownership are all zero until the season starts.
        </p>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="flex-1 rounded-md border border-edge bg-raised px-2 py-1.5 text-sm"
        />
        {browseOnly && (
          <select value={pos} onChange={(e) => setPos(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="rounded-md border border-edge bg-raised px-2 py-1.5 text-sm">
            <option value="all">All pos</option>
            {[1, 2, 3, 4].map((t) => (
              <option key={t} value={t}>
                {POSITION_NAMES[t]}
              </option>
            ))}
          </select>
        )}
        <select value={team} onChange={(e) => setTeam(e.target.value === 'all' ? 'all' : Number(e.target.value))} className="rounded-md border border-edge bg-raised px-2 py-1.5 text-sm">
          <option value="all">All teams</option>
          {data.teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.short_name}
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as any)} className="rounded-md border border-edge bg-raised px-2 py-1.5 text-sm">
          <option value="points">Points</option>
          <option value="form">Form</option>
          <option value="price">Price</option>
          <option value="ownership">Owned %</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="text-left">Player</th>
              <th className="text-center">£</th>
              <th className="text-center">Pts</th>
              <th className="text-center">Form</th>
              <th className="text-center">Own%</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, limit).map((p) => (
              <tr key={p.id}>
                <td className="whitespace-nowrap font-semibold">
                  {p.web_name} <span className="text-xs text-muted">{data.teams.find((t) => t.id === p.team)?.short_name}</span>
                </td>
                <td className="text-center">{formatPrice(p.now_cost)}</td>
                <td className="text-center">{p.total_points}</td>
                <td className="text-center">{p.form}</td>
                <td className="text-center">{p.selected_by_percent}</td>
                <td className="text-right">
                  {!browseOnly && (
                    <button onClick={() => onPick(p.id)} className="rounded bg-accent px-2 py-1 text-xs font-bold text-accent-fg">
                      In
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > limit && (
        <button onClick={() => setLimit((l) => l + 50)} className="mt-3 w-full rounded-md border border-edge py-2 text-sm text-muted">
          Show more ({rows.length - limit} more)
        </button>
      )}
    </Modal>
  );
}
