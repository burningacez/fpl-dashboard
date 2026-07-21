'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMyTeam } from '@/components/providers';
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

// ---- types for the API payloads -----------------------------------------
interface PlannerData {
  currentGw: number;
  nextGw: number;
  events: { id: number; deadline_time: string; finished: boolean; is_current: boolean; is_next: boolean }[];
  teams: { id: number; name: string; short_name: string; code?: number }[];
  players: (PlannerPlayer & {
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

const SEASON = '2026-27';

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

  return <PlannerInner entryId={me.entryId} teamName={me.team} />;
}

function PlannerInner({ entryId, teamName }: { entryId: number; teamName: string }) {
  const [data, setData] = useState<PlannerData | null>(null);
  const [squad, setSquad] = useState<SquadData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlannerPlan | null>(null);
  const [activeGw, setActiveGw] = useState<number | null>(null);
  const [rebaseNeeded, setRebaseNeeded] = useState(false);
  const [view, setView] = useState<'pitch' | 'fixtures'>('pitch');
  const [browser, setBrowser] = useState<{ gw: number; outElement: number | null } | null>(null);
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const storageKey = `fpl-planner-${entryId}-${SEASON}`;

  // ---- load data + squad ----
  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      fetch('/api/planner/data').then((r) => r.json()),
      fetch(`/api/planner/squad/${entryId}`).then((r) => r.json()),
    ])
      .then(([d, s]) => {
        if (cancelled) return;
        if (d.error) throw new Error(d.error);
        if (s.error) throw new Error(s.error);
        setData(d);
        setSquad(s);
      })
      .catch((e) => !cancelled && setError(e.message));
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
      setPlan(freshPlan(entryId, squad.gw, freshHash));
      setRebaseNeeded(false);
    }
    setActiveGw((g) => g ?? squad.gw + 1);
  }, [data, squad, entryId, storageKey]);

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
    setPlan(freshPlan(entryId, squad.gw, squadHash(baseSquad, squad.bank)));
    setRebaseNeeded(false);
  }, [squad, entryId, baseSquad]);

  if (error) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <PageHeader title="Team Planner" />
        <ErrorBlock message={error} />
      </main>
    );
  }
  if (!data || !squad || !plan || !activeState || activeGw == null) {
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

      {/* view toggle */}
      <div className="mb-3 flex gap-2">
        <ViewToggle view={view} setView={setView} />
        <button
          onClick={() => setBrowser({ gw: activeGw, outElement: null })}
          className="ml-auto rounded-md border border-edge px-3 py-1.5 text-sm font-semibold hover:border-accent"
        >
          Browse players
        </button>
      </div>

      {view === 'pitch' ? (
        <PitchView
          state={activeState}
          data={data}
          playersById={playersById}
          onTransferOut={(el) => setBrowser({ gw: activeGw, outElement: el })}
          onCaptain={(el, role) => setCaptain(activeGw, el, role)}
        />
      ) : (
        <FixtureGrid state={activeState} data={data} playersById={playersById} baseGw={squad.gw} />
      )}

      {/* footer: transfer list */}
      <TransferFooter
        state={activeState}
        playersById={playersById}
        onReset={() => resetGw(activeGw)}
        saved={saved}
      />

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

function freshPlan(entryId: number, baseGw: number, baseSquadHash: string): PlannerPlan {
  return { version: 1, entryId, season: SEASON, baseGw, baseSquadHash, updatedAt: Date.now(), weeks: {} };
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

function ViewToggle({ view, setView }: { view: 'pitch' | 'fixtures'; setView: (v: 'pitch' | 'fixtures') => void }) {
  return (
    <div className="flex rounded-lg border border-edge bg-surface p-1">
      {(['pitch', 'fixtures'] as const).map((v) => (
        <button
          key={v}
          onClick={() => setView(v)}
          className={`rounded-md px-3 py-1 text-sm font-bold ${view === v ? 'bg-accent text-accent-fg' : 'text-muted'}`}
        >
          {v === 'pitch' ? 'Pitch' : 'Fixtures'}
        </button>
      ))}
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
  const byType = (t: number) => state.squad.filter((s) => playersById.get(s.element)?.element_type === t);

  return (
    <div
      className="rounded-xl border border-edge p-3"
      style={{ background: 'linear-gradient(to bottom, var(--pitch-from), var(--pitch-to))' }}
    >
      {[1, 2, 3, 4].map((type) => (
        <div key={type} className="mb-3 flex flex-wrap justify-center gap-2">
          {byType(type).map((slot) => {
            const p = playersById.get(slot.element);
            if (!p) return null;
            const fixtures = fixturesForTeam(data, p.team, state.gw);
            const teamCode = data.teams.find((t) => t.id === p.team)?.code;
            const isCap = state.captain === slot.element;
            const isVice = state.vice === slot.element;
            return (
              <button
                key={slot.element}
                onClick={() => setSheet(slot.element)}
                className="flex w-20 flex-col items-center rounded-lg border border-black/20 bg-surface/95 p-1 text-center shadow"
              >
                <ShirtImage teamCode={teamCode} positionId={p.element_type} className="h-9 w-9 object-contain" />
                <div className="flex items-center justify-center gap-1 text-xs font-bold text-body">
                  <span className="truncate">{p.web_name}</span>
                  {isCap && <span className="rounded bg-accent px-1 text-[0.6rem] text-accent-fg">C</span>}
                  {isVice && <span className="rounded bg-raised px-1 text-[0.6rem]">V</span>}
                </div>
                <div className="text-[0.65rem] text-muted">{formatPrice(p.now_cost)}</div>
                <div className="mt-0.5 flex flex-wrap justify-center gap-0.5">
                  {fixtures.length ? (
                    fixtures.map((f, i) => <FdrPill key={i} {...f} />)
                  ) : (
                    <span className="text-[0.6rem] text-faint">blank</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ))}

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

function FixtureGrid({
  state,
  data,
  playersById,
  baseGw,
}: {
  state: GwState;
  data: PlannerData;
  playersById: Map<number, any>;
  baseGw: number;
}) {
  const gws = Array.from({ length: HORIZON }, (_, i) => baseGw + 1 + i);
  return (
    <div className="overflow-x-auto rounded-xl border border-edge">
      <table className="data-table">
        <thead>
          <tr>
            <th className="text-left">Player</th>
            {gws.map((g) => (
              <th key={g} className="text-center">
                GW{g}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.squad.map((slot) => {
            const p = playersById.get(slot.element);
            if (!p) return null;
            return (
              <tr key={slot.element}>
                <td className="whitespace-nowrap font-semibold">
                  {p.web_name} <span className="text-xs text-muted">{POSITION_NAMES[p.element_type]}</span>
                </td>
                {gws.map((g) => {
                  const fx = fixturesForTeam(data, p.team, g);
                  return (
                    <td key={g} className="text-center">
                      <div className="flex flex-col items-center gap-0.5">
                        {fx.length ? fx.map((f, i) => <FdrPill key={i} {...f} />) : <span className="text-[0.6rem] text-faint">—</span>}
                      </div>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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
