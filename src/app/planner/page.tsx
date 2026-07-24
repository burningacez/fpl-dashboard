'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { notFound } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMyTeam, useSeason } from '@/components/providers';
import { PLANNER_ENABLED } from '@/lib/features';
import { ArchivedUnavailable } from '@/components/layout/ArchivedUnavailable';
import { Card, PageHeader, StatTile, Modal, Tabs, Badge, LoadingBlock, ErrorBlock } from '@/components/ui';
import { ShirtImage } from '@/components/pitch/PitchView';
import {
  foldPlan,
  squadHash,
  formatPrice,
  POSITION_NAMES,
  type PlannerPlan,
  type PlannerPlayer,
  type SquadSlot,
  type GwState,
} from '@/lib/squad-rules';

const HORIZON = 5; // plan this many GWs ahead

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

  // Withheld from the live app until released — see src/lib/features.ts.
  if (!PLANNER_ENABLED) notFound();

  if (season !== null) return <ArchivedUnavailable title="Team Planner" />;

  if (!me) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <PageHeader title="Team Planner" />
        <Card>
          <p className="text-body">
            Plan your transfers, prices and fixtures weeks ahead — first, tap the{' '}
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
  const [squad, setSquad] = useState<SquadData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Squad failures are non-fatal: pre-season FPL doesn't publish squads until
  // GW1 locks, so we fall back to a fixtures-only view rather than erroring.
  const [squadError, setSquadError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlannerPlan | null>(null);
  const [activeGw, setActiveGw] = useState<number | null>(null);
  const [rebaseNeeded, setRebaseNeeded] = useState(false);
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
    // The squad is optional: FPL 404s the picks endpoint until GW1 locks, which
    // drops us into fixtures-only mode instead of breaking the whole planner.
    fetch(`/api/planner/squad/${entryId}`)
      .then((r) => r.json())
      .then((s) => {
        if (cancelled) return;
        if (s.error) {
          setSquadError(s.error);
          return;
        }
        setSquad(s);
      })
      .catch((e) => !cancelled && setSquadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [entryId]);

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
      if (raw) restored = JSON.parse(raw);
    } catch {
      /* ignore */
    }

    if (restored && restored.baseSquadHash === freshHash && restored.baseGw === squad.gw) {
      setPlan(restored);
      setRebaseNeeded(false);
    } else if (restored) {
      // A plan exists but the real squad changed — keep it but flag a rebase.
      setPlan(restored);
      setRebaseNeeded(true);
    } else {
      setPlan(freshPlan(entryId, season, squad.gw, freshHash));
      setRebaseNeeded(false);
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

  const playersById = useMemo(() => {
    const m = new Map<number, PlannerData['players'][number]>();
    data?.players.forEach((p) => m.set(p.id, p));
    return m;
  }, [data]);

  const baseSquad: SquadSlot[] = useMemo(
    () =>
      squad
        ? squad.picks.map((p) => ({ element: p.element, purchasePrice: p.purchasePrice, sellingPrice: p.sellingPrice }))
        : [],
    [squad],
  );

  const effectiveFt = plan?.ftOverride ?? squad?.freeTransfers ?? 1;

  const states: GwState[] = useMemo(() => {
    if (!plan || !squad || !data) return [];
    return foldPlan(
      { squad: baseSquad, bank: squad.bank, freeTransfers: effectiveFt, baseGw: squad.gw },
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
    mutateWeek(gw, (w) => ({ ...w, [role]: el }));
  }, [mutateWeek]);

  const resetGw = useCallback(
    (gw: number) => mutateWeek(gw, () => ({ transfers: [] })),
    [mutateWeek],
  );

  const rebase = useCallback(() => {
    if (!squad) return;
    setPlan(freshPlan(entryId, season, squad.gw, squadHash(baseSquad, squad.bank)));
    setRebaseNeeded(false);
  }, [squad, entryId, season, baseSquad]);

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
  // Squad couldn't be loaded (pre-season, before GW1 locks): show fixtures & FDR
  // only, with a notice about when transfer planning unlocks.
  if (squadError) {
    const firstGw = data.events.find((e) => !e.finished) ?? data.events[0];
    // The pitch/transfer view needs a squad; only fixtures & prices are available.
    const preView: PlannerView = view === 'prices' ? 'prices' : 'fixtures';
    return (
      <main className="mx-auto max-w-4xl px-4 py-8 pb-16">
        <PageHeader title="Team Planner" subtitle={teamName} />
        <Card className="mb-4 border-warning">
          <p className="text-sm text-body">
            Transfer planning unlocks once your squad is published — FPL releases it when{' '}
            <span className="font-bold text-me">GW{firstGw?.id}</span> locks
            {firstGw?.deadline_time ? ` (${formatDeadline(firstGw.deadline_time)})` : ''}. Until then,
            here are the upcoming fixtures, difficulty ratings and price changes.
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

      {squad.approximatePrices && (
        <div className="mb-3">
          <Badge tone="negative">Approximate prices — FPL didn’t return exact buy/sell values</Badge>
        </div>
      )}

      {rebaseNeeded && (
        <Card className="mb-4 border-warning">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-warning">Your real team changed since this plan was saved.</span>
            <button onClick={rebase} className="rounded-md bg-accent px-3 py-1.5 font-bold text-accent-fg">
              Rebase to current squad
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
                <span className="text-xl font-extrabold text-accent">{activeState.freeTransfers}</span>
                <FtOverride plan={plan} setPlan={setPlan} confident={squad.freeTransfersDerivation.confident} />
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
                const count = plan.weeks[String(e.id)]?.transfers.length ?? 0;
                const hasErrors = (st?.errors.length ?? 0) > 0;
                return {
                  id: String(e.id),
                  label: (
                    <span className="flex items-center gap-1.5">
                      GW{e.id}
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
            playersById={playersById}
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
          state={activeState}
          position={browsePosition}
          maxPrice={maxBrowsePrice}
          onPick={(inEl) =>
            browser.outElement != null
              ? doTransfer(browser.gw, browser.outElement, inEl)
              : setBrowser(null)
          }
          onClose={() => setBrowser(null)}
          browseOnly={browser.outElement == null}
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
  plan,
  setPlan,
  confident,
}: {
  plan: PlannerPlan;
  setPlan: (fn: (p: PlannerPlan | null) => PlannerPlan | null) => void;
  confident: boolean;
}) {
  const set = (delta: number) =>
    setPlan((p) => (p ? { ...p, ftOverride: Math.max(0, Math.min(5, (p.ftOverride ?? 1) + delta)) } : p));
  return (
    <span className="flex items-center gap-1" title={confident ? 'Adjust starting free transfers' : 'Derived value may be off — adjust it'}>
      <button onClick={() => set(-1)} className="rounded border border-edge px-1.5 text-sm leading-none">−</button>
      <button onClick={() => set(1)} className="rounded border border-edge px-1.5 text-sm leading-none">+</button>
      {!confident && <span className="text-[0.6rem] text-warning">check</span>}
    </span>
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
      title={crossing ? 'Over threshold — expected to change at 00:00 UK' : 'Progress to next price change'}
    >
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(0)}%
    </span>
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
  const byType = (t: number) => state.squad.filter((s) => playersById.get(s.element)?.element_type === t);

  return (
    <div className="overflow-hidden rounded-xl border border-edge">
      <div
        className="relative py-3"
        style={{
          background:
            'repeating-linear-gradient(180deg, var(--pitch-from) 0, var(--pitch-from) 10%, var(--pitch-to) 10%, var(--pitch-to) 20%)',
        }}
      >
        {/* Pitch markings */}
        <div className="pointer-events-none absolute inset-x-4 inset-y-2 border-2 border-white/25">
          <div className="absolute inset-x-0 top-1/2 h-0.5 bg-white/25" />
          <div className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/25" />
          <div className="absolute left-1/2 top-0 h-9 w-32 -translate-x-1/2 border-2 border-t-0 border-white/25" />
          <div className="absolute bottom-0 left-1/2 h-9 w-32 -translate-x-1/2 border-2 border-b-0 border-white/25" />
        </div>
        {[1, 2, 3, 4].map((type) => {
          const row = byType(type);
          if (row.length === 0) return null;
          return (
            <div key={type} className="relative flex justify-center gap-1 py-2">
              {row.map((slot) => {
                const p = playersById.get(slot.element);
                if (!p) return null;
                const fixtures = fixturesForTeam(data, p.team, state.gw);
                const teamCode = data.teams.find((t) => t.id === p.team)?.code;
                const isCap = state.captain === slot.element;
                const isVice = state.vice === slot.element;
                return (
                  <button
                    key={slot.element}
                    type="button"
                    onClick={() => setSheet(slot.element)}
                    className="flex w-1/5 min-w-0 max-w-24 cursor-pointer flex-col items-center rounded-md text-center"
                  >
                    <div className="relative">
                      <ShirtImage
                        teamCode={teamCode}
                        positionId={p.element_type}
                        className="h-12 w-12 object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.4)] sm:h-14 sm:w-14"
                      />
                      {isCap && (
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
                    <PitchPriceIndicator pct={p.price_change_percent} />
                    <div className="mt-0.5 flex flex-wrap justify-center gap-0.5">
                      {fixtures.length ? (
                        fixtures.map((f, i) => <FdrPill key={i} {...f} />)
                      ) : (
                        <span className="text-[0.6rem] font-semibold text-white/70 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
                          blank
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

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
          Fixture difficulty — scroll across. Upper case = home, lower case = away.
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
    </div>
  );
}

function FdrMatrix({ data, gws }: { data: PlannerData; gws: PlannerData['events'] }) {
  const rows = useMemo(() => {
    return data.teams
      .map((team) => {
        const cells = gws.map((e) => fixturesForTeam(data, team.id, e.id));
        const played = cells.flat();
        const avg = played.length ? played.reduce((sum, f) => sum + f.fdr, 0) / played.length : null;
        return { team, cells, avg };
      })
      .sort((a, b) => (a.avg ?? 99) - (b.avg ?? 99));
  }, [data, gws]);

  return (
    <div className="overflow-x-auto rounded-xl border border-edge">
      <table className="w-full border-collapse text-[0.65rem]">
        <thead>
          <tr className="bg-surface">
            <th className="sticky left-0 z-10 bg-surface px-2 py-1 text-left font-bold">Team</th>
            {gws.map((e) => (
              <th key={e.id} className="px-1 py-1 text-center font-semibold text-muted">
                {e.id}
              </th>
            ))}
            <th className="px-2 py-1 text-center font-bold">Avg</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ team, cells, avg }) => (
            <tr key={team.id} className="border-t border-edge">
              <td className="sticky left-0 z-10 whitespace-nowrap bg-raised px-2 py-0.5 font-bold">
                {team.short_name}
              </td>
              {cells.map((fx, i) => (
                <td key={i} className="px-0.5 py-0.5 text-center">
                  {fx.length ? (
                    <div className="flex flex-col items-center gap-0.5">
                      {fx.map((f, j) => (
                        <span
                          key={j}
                          className={`fdr-${f.fdr} block rounded px-1 py-0.5 font-bold leading-none`}
                        >
                          {f.home ? f.short.toUpperCase() : f.short.toLowerCase()}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-faint">—</span>
                  )}
                </td>
              ))}
              <td className="px-2 py-0.5 text-center font-bold">{avg != null ? avg.toFixed(1) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// =============================================================================
// Prices — two modes:
//  • Predicted: players nearest the price-change threshold, from the new
//    2026/27 `price_change_percent` field (100 = threshold, sign = direction).
//  • Recent: realized changes already applied (cost_change_event/start).
// Squad-independent. price_change_percent is all-zero until transfers begin, so
// Predicted falls back to a flagged sample list so the layout is testable now.
// =============================================================================

type PriceScope = 'cost_change_event' | 'cost_change_start';
type PlayerRow = PlannerData['players'][number];
const PREDICT_COUNT_OPTIONS = [20, 50] as const;

function PricesView({ data }: { data: PlannerData }) {
  const [mode, setMode] = useState<'predicted' | 'recent'>('predicted');

  const teamsById = useMemo(() => {
    const m = new Map<number, PlannerData['teams'][number]>();
    data.teams.forEach((t) => m.set(t.id, t));
    return m;
  }, [data.teams]);

  return (
    <div>
      <div className="mb-3 flex rounded-lg border border-edge bg-surface p-1">
        {(['predicted', 'recent'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-md px-3 py-1 text-sm font-bold ${mode === m ? 'bg-accent text-accent-fg' : 'text-muted'}`}
          >
            {m === 'predicted' ? 'Predicted' : 'Recent'}
          </button>
        ))}
      </div>
      {mode === 'predicted' ? (
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
  const hasPredictions = data.players.some((p) => p.price_change_percent !== 0);
  const { rises, drops, placeholder } = useMemo(() => {
    if (hasPredictions) {
      const rises = data.players
        .filter((p) => p.price_change_percent > 0)
        .sort((a, b) => b.price_change_percent - a.price_change_percent)
        .slice(0, count);
      const drops = data.players
        .filter((p) => p.price_change_percent < 0)
        .sort((a, b) => a.price_change_percent - b.price_change_percent)
        .slice(0, count);
      return { rises, drops, placeholder: false };
    }
    // All-zero pre-season: show an arbitrary sample so the layout is testable.
    const sample = data.players.slice(0, count * 2);
    return { rises: sample.slice(0, count), drops: sample.slice(count), placeholder: true };
  }, [data.players, count, hasPredictions]);

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
      {placeholder && (
        <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 p-2 text-[0.7rem] text-warning">
          Sample data — every player is at 0% pre-season. Real predictions appear once transfers begin;
          direction (rise/fall) is assumed from the sign and will be confirmed against live values.
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <PredictedList title="Predicted rises ▲" up players={rises} placeholder={placeholder} teamsById={teamsById} />
        <PredictedList title="Predicted drops ▼" up={false} players={drops} placeholder={placeholder} teamsById={teamsById} />
      </div>
    </div>
  );
}

function PredictedList({
  title,
  up,
  players,
  placeholder,
  teamsById,
}: {
  title: string;
  up: boolean;
  players: PlayerRow[];
  placeholder: boolean;
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
              {placeholder ? (
                <span className="w-14 shrink-0 text-right tabular-nums text-faint">—</span>
              ) : (
                <PricePctBadge pct={p.price_change_percent} />
              )}
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
      title={crossing ? 'Over threshold — expected to change at 00:00 UK' : undefined}
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
            move once managers start transferring players in and out — this fills in during the season.
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
  playersById,
  onReset,
  saved,
}: {
  state: GwState;
  playersById: Map<number, any>;
  onReset: () => void;
  saved: boolean;
}) {
  const week = state; // transfers list is derived from the diff vs prior; show planned transfers
  return (
    <Card className="mt-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-bold">GW{state.gw} transfers</h3>
        <span className="flex items-center gap-3 text-sm">
          {saved && <span className="text-positive">Saved ✓</span>}
          <button onClick={onReset} className="text-muted hover:text-negative">
            Reset GW
          </button>
        </span>
      </div>
      {week.hits > 0 && <Badge tone="negative">Cost: -{week.hits} pts</Badge>}
      <p className="mt-2 text-sm text-muted">
        Used {state.used} transfer{state.used === 1 ? '' : 's'} · {state.freeTransfers} free entering this GW.
        Tap a player on the pitch to transfer them out.
      </p>
    </Card>
  );
}

function PlayerBrowser({
  data,
  state,
  position,
  maxPrice,
  onPick,
  onClose,
  browseOnly,
}: {
  data: PlannerData;
  state: GwState;
  position: number | undefined;
  maxPrice: number;
  onPick: (inEl: number) => void;
  onClose: () => void;
  browseOnly: boolean;
}) {
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<number | 'all'>(position ?? 'all');
  const [team, setTeam] = useState<number | 'all'>('all');
  const [sort, setSort] = useState<'price' | 'points' | 'form' | 'ownership'>('points');
  const [limit, setLimit] = useState(50);

  const owned = new Set(state.squad.map((s) => s.element));

  const rows = useMemo(() => {
    let list = data.players.filter((p) => !owned.has(p.id));
    if (pos !== 'all') list = list.filter((p) => p.element_type === pos);
    if (team !== 'all') list = list.filter((p) => p.team === team);
    if (!browseOnly && position != null) list = list.filter((p) => p.element_type === position && p.now_cost <= maxPrice);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.players, pos, team, q, sort, position, maxPrice, browseOnly]);

  return (
    <Modal
      title={browseOnly ? 'Browse players' : `Transfer in ${position != null ? POSITION_NAMES[position] : ''}`}
      onClose={onClose}
      wide
    >
      {!browseOnly && (
        <p className="mb-2 text-sm text-muted">Budget: {formatPrice(maxPrice)}</p>
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
