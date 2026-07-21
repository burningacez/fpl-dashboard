'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMyTeam } from '@/components/providers';
import { isMyTeam } from '@/lib/identity';
import { PageHeader, DataTable, Modal, LoadingBlock, ErrorBlock, Tabs, type Column } from '@/components/ui';
import { PitchView } from '@/components/pitch/PitchView';
import { FixtureStrip, MatchModal } from '@/components/match/MatchModal';
import { StandingsView } from '@/components/views/StandingsView';
import { FormView } from '@/components/views/FormView';

/**
 * Live gameweek page. Fetches /api/week for the initial paint, then subscribes
 * to /api/live/events (SSE) for live score/ticker updates:
 *  - `sync`       → full week payload (replaces state)
 *  - `new-events` → chronological ticker events to prepend
 *  - `status`     → live/idle flag
 * Tapping a manager opens their pitch via /api/manager/{id}/picks.
 */
export default function WeekPage() {
  const { me } = useMyTeam();
  const [week, setWeek] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticker, setTicker] = useState<any[]>([]);
  const [live, setLive] = useState(false);
  const [openEntry, setOpenEntry] = useState<{ id: number; name: string } | null>(null);
  const [openFixture, setOpenFixture] = useState<any>(null);
  const [sort, setSort] = useState<SortState>({ col: 'gwRank', asc: true });
  const [view, setView] = useState<'scores' | 'standings' | 'form'>('scores');
  const [highlight, setHighlight] = useState<HighlightState>(NO_HIGHLIGHT);
  const [hlOpen, setHlOpen] = useState(false);
  const [viewGW, setViewGW] = useState<number | null>(null);
  const [history, setHistory] = useState<any>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const currentGW: number | null = week?.currentGW ?? null;
  const viewingLive = viewGW == null || viewGW === currentGW;

  const ingest = useCallback((data: any) => {
    if (!data) return;
    setWeek(data);
    setLive(Boolean(data.isLive));
    if (Array.isArray(data.chronologicalEvents)) {
      setTicker([...data.chronologicalEvents].reverse());
    } else if (Array.isArray(data.changeEvents)) {
      setTicker(data.changeEvents);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/week')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) throw new Error(d.error);
        ingest(d);
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [ingest]);

  // SSE subscription (mounted only on this page to respect the 50-client cap).
  useEffect(() => {
    const es = new EventSource('/api/live/events');
    esRef.current = es;
    es.addEventListener('sync', (e: MessageEvent) => {
      try {
        ingest(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('new-events', (e: MessageEvent) => {
      try {
        const payload = JSON.parse(e.data);
        const events = payload.events ?? [];
        if (events.length) setTicker((prev) => [...[...events].reverse(), ...prev].slice(0, 100));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('status', (e: MessageEvent) => {
      try {
        setLive(Boolean(JSON.parse(e.data).isLive));
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('data-update', () => {
      // A background refresh finished — pull the fresh week payload.
      fetch('/api/week')
        .then((r) => r.json())
        .then((d) => !d.error && ingest(d))
        .catch(() => {});
    });
    return () => es.close();
  }, [ingest]);

  // View toggle (legacy switchView): ?view=standings|form deep links.
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get('view');
    if (v === 'standings' || v === 'form') setView(v);
  }, []);
  const switchView = (v: string) => {
    setView(v as 'scores' | 'standings' | 'form');
    const url = new URL(window.location.href);
    if (v === 'scores') url.searchParams.delete('view');
    else url.searchParams.set('view', v);
    window.history.replaceState(null, '', url.toString());
  };

  // Deep links from other pages (legacy checkInitialView): /week?entry=X&gw=Y
  // opens that manager's pitch, optionally for a past gameweek.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (!week || deepLinked.current) return;
    deepLinked.current = true;
    const params = new URLSearchParams(window.location.search);
    const entry = Number(params.get('entry'));
    if (!entry) return;
    const gw = Number(params.get('gw'));
    if (gw && week.currentGW && gw !== week.currentGW) setViewGW(gw);
    const m = (week.managers ?? []).find((x: any) => x.entryId === entry);
    setOpenEntry({ id: entry, name: m?.name ?? '' });
  }, [week]);

  // On mobile the ticker sits below the table — start at the bottom so the
  // latest live events are what you see first. Skip when deep-linked to a
  // manager so the modal isn't opened over a scrolled page.
  const scrolledOnLoad = useRef(false);
  useEffect(() => {
    if (!week || scrolledOnLoad.current) return;
    scrolledOnLoad.current = true;
    const params = new URLSearchParams(window.location.search);
    if (params.get('entry') || params.get('view')) return;
    if (window.matchMedia('(max-width: 1023px)').matches) {
      window.scrollTo({ top: document.documentElement.scrollHeight });
    }
  }, [week]);

  // Fetch historical GW data when navigating to a past gameweek.
  useEffect(() => {
    if (viewGW == null || viewGW === currentGW) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    fetch(`/api/week/history?gw=${viewGW}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setHistory(d))
      .catch(() => !cancelled && setHistory({ error: 'Could not load that gameweek' }))
      .finally(() => !cancelled && setHistoryLoading(false));
    return () => {
      cancelled = true;
    };
  }, [viewGW, currentGW]);

  if (error) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageHeader title="Live" />
        <ErrorBlock message={error} />
      </main>
    );
  }
  if (!week) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageHeader title="Live" />
        <LoadingBlock label="Loading gameweek…" />
      </main>
    );
  }

  const shownGW = viewGW ?? currentGW ?? week.currentGW;
  const unsorted: any[] = viewingLive ? (week.managers ?? []) : (history?.managers ?? []);
  const key = SORT_KEYS[sort.col] ?? SORT_KEYS.gwRank;
  const managers = [...unsorted].sort((a, b) => {
    const av = key(a);
    const bv = key(b);
    const cmp = typeof av === 'string' || typeof bv === 'string' ? String(av).localeCompare(String(bv)) : (av as number) - (bv as number);
    return sort.asc ? cmp : -cmp;
  });
  const onSort = (col: string) => setSort((s) => (s.col === col ? { col, asc: !s.asc } : { col, asc: true }));

  const columns: Column<any>[] = [
    { key: 'gwRank', header: <SortHeader label="#" col="gwRank" sort={sort} onSort={onSort} />, render: (m) => m.gwRank ?? m.rank },
    {
      key: 'manager',
      header: <SortHeader label="Manager" col="manager" sort={sort} onSort={onSort} />,
      render: (m) => (
        <button className="text-left" onClick={() => setOpenEntry({ id: m.entryId, name: m.name })}>
          <span className={`font-bold ${isMyTeam(me, { entryId: m.entryId, name: m.name }) ? 'my-team-name' : ''}`}>
            {m.name}
          </span>
          <div className="text-xs text-muted">{m.team}</div>
          <ManagerPills
            manager={m}
            defCount={
              viewingLive && highlight.type === 'defense'
                ? highlightResult(m, highlight, week.squadPlayers).defCount
                : 0
            }
          />
        </button>
      ),
    },
    {
      key: 'gwScore',
      header: <SortHeader label="GW" col="gwScore" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (m) => (
        <span>
          <strong>{m.gwScore}</strong>
          {m.transferCost > 0 && <span className="text-negative"> (-{m.transferCost})</span>}
        </span>
      ),
    },
    {
      key: 'captain',
      header: <SortHeader label="Captain" col="captain" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (m) => (
        <span className="text-sm text-muted">
          {m.captainName ?? '–'}
          {m.viceCaptainName && <span className="block text-[0.65rem] text-faint">{m.viceCaptainName}</span>}
        </span>
      ),
    },
    { key: 'bench', header: <SortHeader label="Bench" col="bench" sort={sort} onSort={onSort} />, align: 'center', render: (m) => <span className="text-muted">{m.benchPoints ?? '–'}</span> },
    { key: 'overall', header: <SortHeader label="Total" col="overall" sort={sort} onSort={onSort} />, align: 'center', render: (m) => m.overallPoints },
  ];

  // Historical GWs return a reduced payload (no overall/players-left/gwRank).
  const historyColumns: Column<any>[] = [
    { key: 'idx', header: '#', render: (_m, i) => i + 1 },
    {
      key: 'manager',
      header: 'Manager',
      render: (m) => (
        <button className="text-left" onClick={() => setOpenEntry({ id: m.entryId, name: m.name })}>
          <span className={`font-bold ${isMyTeam(me, { entryId: m.entryId, name: m.name }) ? 'my-team-name' : ''}`}>{m.name}</span>
          <div className="text-xs text-muted">{m.team}</div>
          <ManagerPills manager={m} />
        </button>
      ),
    },
    {
      key: 'gwScore',
      header: 'GW',
      align: 'center',
      render: (m) => (
        <span>
          <strong>{m.gwScore}</strong>
          {m.transferCost > 0 && <span className="text-negative"> (-{m.transferCost})</span>}
        </span>
      ),
    },
    { key: 'captain', header: 'Captain', align: 'center', render: (m) => <span className="text-sm text-muted">{m.captainName ?? '–'}</span> },
  ];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <button
              aria-label="Previous gameweek"
              disabled={shownGW <= 1}
              onClick={() => setViewGW(Math.max(1, shownGW - 1))}
              className="rounded-md border border-edge px-2 py-0.5 text-base disabled:opacity-30"
            >
              ◀
            </button>
            GW{shownGW}
            <button
              aria-label="Next gameweek"
              disabled={shownGW >= (currentGW ?? shownGW)}
              onClick={() => setViewGW(Math.min(currentGW ?? shownGW, shownGW + 1))}
              className="rounded-md border border-edge px-2 py-0.5 text-base disabled:opacity-30"
            >
              ▶
            </button>
            {viewingLive && live && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-negative-soft px-2 py-0.5 text-sm text-negative">
                <span className="h-2 w-2 animate-pulse rounded-full bg-negative" /> LIVE
              </span>
            )}
            {!viewingLive && <span className="text-sm font-normal text-muted">(final)</span>}
          </span>
        }
        subtitle={week.leagueName}
      />

      <div className="mb-4 max-w-fit">
        <Tabs
          tabs={[
            { id: 'scores', label: 'Scores' },
            { id: 'standings', label: 'Standings' },
            { id: 'form', label: 'Form' },
          ]}
          active={view}
          onChange={switchView}
        />
      </div>

      {view === 'standings' && <StandingsView viewGW={viewingLive ? null : shownGW} />}
      {view === 'form' && <FormView asof={viewingLive ? null : shownGW} />}

      {view === 'scores' && (
      <>
      {viewingLive && (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            onClick={() => setHlOpen(true)}
            className={`rounded-full border px-3 py-1 text-xs font-bold ${
              highlight.type ? 'border-accent bg-accent-soft text-accent' : 'border-edge text-muted hover:text-body'
            }`}
          >
            ★ {highlightLabel(highlight, week)}
          </button>
        </div>
      )}
      {viewingLive && <FixtureStrip fixtures={week.fixtures ?? []} onOpen={setOpenFixture} />}

      {historyLoading && <LoadingBlock label={`Loading GW${shownGW}…`} />}
      {!viewingLive && history?.error && <ErrorBlock message={history.error} />}

      <div className={`grid grid-cols-1 gap-6 ${viewingLive ? 'lg:grid-cols-[1fr_20rem]' : ''}`}>
        <div>
          <DataTable
            columns={viewingLive ? columns : historyColumns}
            rows={managers}
            rowKey={(m) => m.entryId}
            rowRef={(m) => ({ entryId: m.entryId, name: m.name })}
            rowClass={(m) =>
              viewingLive && highlight.type
                ? highlightResult(m, highlight, week.squadPlayers).match
                  ? 'hl-match'
                  : 'hl-dimmed'
                : ''
            }
          />
        </div>

        {viewingLive && (
        <aside>
          <h2 className="mb-2 font-bold">Live ticker</h2>
          <div className="max-h-[32rem] overflow-y-auto rounded-xl border border-edge bg-surface p-2">
            {ticker.length === 0 && <p className="p-3 text-sm text-muted">No events yet.</p>}
            {ticker.map((ev, i) => (
              <div key={i} className="flex items-start gap-2 border-b border-edge px-2 py-1.5 text-sm last:border-0">
                <span aria-hidden>{ev.icon ?? '•'}</span>
                <span>
                  <span className="font-semibold">{ev.player ?? ev.team ?? ''}</span>
                  {ev.points != null && (
                    <span className={ev.points >= 0 ? 'text-positive' : 'text-negative'}> {ev.points >= 0 ? '+' : ''}{ev.points}</span>
                  )}
                  {ev.match && <span className="block text-xs text-muted">{ev.match}</span>}
                </span>
              </div>
            ))}
          </div>
        </aside>
        )}
      </div>
      </>
      )}

      {openEntry && <PitchModal entry={openEntry} gw={shownGW} onClose={() => setOpenEntry(null)} />}
      {openFixture && <MatchModal fixture={openFixture} onClose={() => setOpenFixture(null)} />}
      {hlOpen && (
        <HighlightModal
          week={week}
          highlight={highlight}
          onChange={setHighlight}
          onClose={() => setHlOpen(false)}
        />
      )}
    </main>
  );
}

function chipLabel(chip: string): string {
  return { wildcard: 'WC', freehit: 'FH', bboost: 'BB', '3xc': 'TC' }[chip] ?? chip;
}

// Sortable headers on the live table (legacy sortTable).
type SortState = { col: string; asc: boolean };

const SORT_KEYS: Record<string, (m: any) => string | number> = {
  gwRank: (m) => m.gwRank ?? m.rank ?? 0,
  manager: (m) => String(m.name).toLowerCase(),
  gwScore: (m) => m.gwScore ?? 0,
  captain: (m) => String(m.captainName ?? '').toLowerCase(),
  overall: (m) => m.overallPoints ?? 0,
  bench: (m) => m.benchPoints ?? 0,
};

function SortHeader({
  label,
  col,
  sort,
  onSort,
}: {
  label: string;
  col: string;
  sort: SortState;
  onSort: (col: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className="cursor-pointer select-none uppercase tracking-[0.06em] hover:text-body"
    >
      {label}
      {sort.col === col ? (sort.asc ? ' ↑' : ' ↓') : ''}
    </button>
  );
}

/** Chip and players-left pills under the team name (legacy manager-pills). */
function ManagerPills({ manager: m, defCount = 0 }: { manager: any; defCount?: number }) {
  const pills: ReactNode[] = [];
  if (defCount > 0) {
    pills.push(
      <span key="def" className="rounded-full bg-accent px-1.5 py-px text-[0.6rem] font-bold text-accent-fg">
        {defCount} DEF
      </span>,
    );
  }
  if (m.activeChip) {
    pills.push(
      <span key="chip" className="rounded-full bg-accent-soft px-1.5 py-px text-[0.6rem] font-bold text-accent">
        {chipLabel(m.activeChip)}
      </span>,
    );
  }
  if (m.playersLeft > 0) {
    pills.push(
      <span key="left" className="rounded-full bg-raised px-1.5 py-px text-[0.6rem] font-bold text-muted">
        {m.playersLeft}
        {m.activePlayers > 0 ? ` (+${m.activePlayers})` : ''} left
      </span>,
    );
  }
  if (pills.length === 0) return null;
  return <div className="mt-1 flex flex-wrap gap-1">{pills}</div>;
}

function PitchModal({ entry, gw, onClose }: { entry: { id: number; name: string }; gw: number; onClose: () => void }) {
  const [picks, setPicks] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/manager/${entry.id}/picks?gw=${gw}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : setPicks(d)))
      .catch((e) => setErr(e.message));
  }, [entry.id, gw]);

  return (
    <Modal title={entry.name} onClose={onClose} wide>
      {err && <ErrorBlock message={err} />}
      {!picks && !err && <LoadingBlock label="Loading squad…" />}
      {picks && (
        <>
          <div className="mb-3 flex flex-wrap gap-4 text-sm text-muted">
            <span>GW points <strong className="text-body">{picks.calculatedPoints ?? picks.points}</strong></span>
          </div>
          {(picks.autoSubs ?? []).length > 0 && (
            <p className="mb-2 rounded-lg bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent">
              ⟳ Auto-sub: {picks.autoSubs.map((s: any) => `${s.in.name} for ${s.out.name}`).join(', ')}
            </p>
          )}
          <PitchView players={picks.players ?? []} pointsOnBench={picks.pointsOnBench} />
          <TinkeringBar entryId={entry.id} gw={gw} />
        </>
      )}
    </Modal>
  );
}

// Tinkering bar (legacy renderTinkeringBar): actual vs "kept last week's team"
// score with per-change impact sections. Collapsed by default.
function TinkeringBar({ entryId, gw }: { entryId: number; gw: number }) {
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    fetch(`/api/manager/${entryId}/tinkering?gw=${gw}`)
      .then((r) => r.json())
      .then((d) => !cancelled && setData(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [entryId, gw]);

  if (!data) return null;
  if (!data.available) {
    return data.reason === 'gw1' ? (
      <p className="mt-3 rounded-lg bg-raised px-3 py-2 text-xs text-muted">
        No tinkering data for GW1 (no previous team to compare)
      </p>
    ) : null;
  }

  const { actualScore, hypotheticalScore, transferCost, netImpact, reason } = data;
  const impactCls = netImpact > 0 ? 'text-positive' : netImpact < 0 ? 'text-negative' : 'text-muted';
  const chipBadge = { freehit: 'FH', wildcard: 'WC', '3xc': 'TC', bboost: 'BB' }[reason as string];

  const item = (label: ReactNode, impact: number, key: string | number) => (
    <div key={key} className="flex justify-between py-0.5">
      <span>{label}</span>
      <span className={`font-bold ${impact > 0 ? 'text-positive' : impact < 0 ? 'text-negative' : 'text-muted'}`}>
        {impact > 0 ? '+' : ''}
        {impact} pts
      </span>
    </div>
  );

  const section = (title: string, rows: ReactNode[], total?: number) =>
    rows.length > 0 && (
      <div key={title} className="mt-2 rounded-lg bg-raised px-3 py-2 text-xs">
        <div className="mb-1 font-bold uppercase tracking-wide text-muted">{title}</div>
        {rows}
        {total !== undefined &&
          item(<span className="font-bold">Impact</span>, total, 'total')}
      </div>
    );

  const sumImpact = (arr: any[] | undefined, sign = 1) =>
    (arr ?? []).reduce((s, t) => s + sign * (t.impact || 0), 0);

  const cap = data.captainChange;
  const lineupRows = [
    ...(data.lineupChanges?.movedToStarting ?? []).map((p: any, i: number) => item(`Started ${p.name}`, p.impact || 0, `s${i}`)),
    ...(data.lineupChanges?.movedToBench ?? []).map((p: any, i: number) => item(`Benched ${p.name}`, p.impact || 0, `b${i}`)),
  ];
  const lineupTotal = sumImpact(data.lineupChanges?.movedToStarting) + sumImpact(data.lineupChanges?.movedToBench);

  return (
    <div className="mt-3 rounded-xl border border-edge bg-surface p-3">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between text-sm font-bold">
        <span>
          🔧 Tinkering Impact
          {chipBadge && <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 text-[0.6rem] text-accent">{chipBadge}</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className={impactCls}>
            {netImpact > 0 ? '+' : ''}
            {netImpact} pts
          </span>
          <span className="text-xs text-muted">{open ? '▲' : '▼'}</span>
        </span>
      </button>
      {open && (
        <div className="mt-2">
          <div className="rounded-lg bg-raised px-3 py-2 text-xs">
            <div className="flex justify-between py-0.5">
              <span>If you kept last week&apos;s team:</span>
              <span>{hypotheticalScore} pts</span>
            </div>
            <div className="flex justify-between py-0.5">
              <span>Your actual score:</span>
              <span>{actualScore} pts</span>
            </div>
            {transferCost > 0 && (
              <div className="flex justify-between py-0.5">
                <span>Transfer hits:</span>
                <span className="text-negative">-{transferCost} pts</span>
              </div>
            )}
            <div className="flex justify-between border-t border-edge pt-1 font-bold">
              <span>NET BENEFIT</span>
              <span className={impactCls}>
                {netImpact > 0 ? '+' : ''}
                {netImpact} pts
              </span>
            </div>
          </div>
          {section(
            'Transfers In',
            (data.transfersIn ?? []).map((t: any, i: number) =>
              item(`${t.player.name}${t.captained ? (reason === '3xc' ? ' (TC)' : ' (C)') : ''}`, t.impact || 0, i),
            ),
            sumImpact(data.transfersIn),
          )}
          {section(
            'Transfers Out',
            (data.transfersOut ?? []).map((t: any, i: number) =>
              item(`${t.player.name}${t.wasCaptain ? ' (was C)' : ''}`, -(t.impact || 0), i),
            ),
            sumImpact(data.transfersOut, -1),
          )}
          {cap?.changed &&
            section(
              'Captain Change',
              [item(`${cap.oldCaptain?.name} (${cap.oldCaptain?.points} pts) → ${cap.newCaptain?.name} (${cap.newCaptain?.points} pts)`, cap.impact, 'cap')],
            )}
          {section('Lineup Changes', lineupRows, lineupRows.length ? lineupTotal : undefined)}
          {section(
            'Auto-Sub Effects',
            (data.autoSubEffects ?? []).map((p: any, i: number) => item(p.name, p.impact || 0, i)),
            sumImpact(data.autoSubEffects),
          )}
          {data.chipImpact?.tripleCaptain &&
            section('Triple Captain Bonus', [
              item(
                `${data.chipImpact.tripleCaptain.playerName} (${data.chipImpact.tripleCaptain.basePoints} pts × 3)`,
                data.chipImpact.tripleCaptain.bonus,
                'tc',
              ),
            ])}
          {data.chipImpact?.benchBoost &&
            section(
              'Bench Boost',
              (data.chipImpact.benchBoost.players ?? []).map((p: any, i: number) => item(p.name, p.points, i)),
              data.chipImpact.benchBoost.totalBonus,
            )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Highlight modes (legacy toggleHighlightPopup/getHighlightResult): pick a
// player (owned/started/benched) or a club's defense and dim non-matching rows.
// =============================================================================

type HighlightState = {
  type: 'player' | 'defense' | null;
  playerId: number | null;
  playerMode: 'own' | 'started' | 'benched';
  teamId: number | null;
};

const NO_HIGHLIGHT: HighlightState = { type: null, playerId: null, playerMode: 'own', teamId: null };

function highlightResult(
  manager: any,
  hl: HighlightState,
  squadPlayers: Record<string, any> | undefined,
): { match: boolean; defCount: number } {
  if (hl.type === 'player' && hl.playerId != null) {
    const pid = hl.playerId;
    const inStarting = (manager.starting11 ?? []).includes(pid);
    const onBench = (manager.benchPlayerIds ?? []).includes(pid);
    const autoSubbedIn = (manager.autoSubsIn ?? []).includes(pid);
    const autoSubbedOut = (manager.autoSubsOut ?? []).includes(pid);
    const isBenchBoost = manager.activeChip === 'bboost';
    if (hl.playerMode === 'own') return { match: inStarting || onBench, defCount: 0 };
    if (hl.playerMode === 'started') {
      return { match: (inStarting && !autoSubbedOut) || autoSubbedIn || (onBench && isBenchBoost), defCount: 0 };
    }
    return { match: (onBench && !autoSubbedIn && !isBenchBoost) || (inStarting && autoSubbedOut), defCount: 0 };
  }
  if (hl.type === 'defense' && hl.teamId != null) {
    const allIds = [...(manager.starting11 ?? []), ...(manager.benchPlayerIds ?? [])];
    const count = allIds.filter((id) => {
      const p = squadPlayers?.[id];
      return p && p.teamId === hl.teamId && (p.positionId === 1 || p.positionId === 2);
    }).length;
    return { match: count > 0, defCount: count };
  }
  return { match: false, defCount: 0 };
}

function highlightLabel(hl: HighlightState, week: any): string {
  if (hl.type === 'player' && hl.playerId != null) {
    const p = week?.squadPlayers?.[hl.playerId];
    const mode = { own: 'Owned', started: 'Started', benched: 'Benched' }[hl.playerMode];
    if (p) return `${p.name} (${mode})`;
  }
  if (hl.type === 'defense' && hl.teamId != null) {
    const t = (week?.plTeams ?? []).find((t: any) => t.id === hl.teamId);
    if (t) return `${t.shortName} Defense`;
  }
  return 'Highlight';
}

function HighlightModal({
  week,
  highlight,
  onChange,
  onClose,
}: {
  week: any;
  highlight: HighlightState;
  onChange: (hl: HighlightState) => void;
  onClose: () => void;
}) {
  const squadPlayers: Record<string, any> = week?.squadPlayers ?? {};
  const players = Object.entries(squadPlayers)
    .map(([id, p]: [string, any]) => ({ id: Number(id), name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const teams: any[] = week?.plTeams ?? [];
  const selectCls = 'w-full rounded-md border border-edge bg-raised px-3 py-2 text-sm';

  return (
    <Modal title="Highlight Managers" onClose={onClose}>
      <div className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Player</div>
      <select
        value={highlight.type === 'player' ? String(highlight.playerId ?? '') : ''}
        onChange={(e) =>
          onChange(
            e.target.value
              ? { type: 'player', playerId: Number(e.target.value), playerMode: highlight.playerMode, teamId: null }
              : NO_HIGHLIGHT,
          )
        }
        className={selectCls}
      >
        <option value="">Select player…</option>
        {players.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      {highlight.type === 'player' && (
        <div className="mt-2 flex gap-1.5">
          {(['own', 'started', 'benched'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => onChange({ ...highlight, playerMode: mode })}
              className={`rounded-full border px-3 py-1 text-xs font-bold ${
                highlight.playerMode === mode
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-edge text-muted hover:text-body'
              }`}
            >
              {{ own: 'Owned', started: 'Started', benched: 'Benched' }[mode]}
            </button>
          ))}
        </div>
      )}

      <div className="mb-1 mt-4 text-xs font-bold uppercase tracking-wide text-muted">Club Defense (GK + DEF)</div>
      <select
        value={highlight.type === 'defense' ? String(highlight.teamId ?? '') : ''}
        onChange={(e) =>
          onChange(
            e.target.value
              ? { type: 'defense', playerId: null, playerMode: 'own', teamId: Number(e.target.value) }
              : NO_HIGHLIGHT,
          )
        }
        className={selectCls}
      >
        <option value="">Select club…</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => {
          onChange(NO_HIGHLIGHT);
          onClose();
        }}
        className="mt-5 w-full rounded-md border border-edge py-2 text-sm font-bold text-muted hover:bg-raised"
      >
        Clear Highlights
      </button>
    </Modal>
  );
}
