'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useMyTeam } from '@/components/providers';
import { isMyTeam } from '@/lib/identity';
import { PageHeader, DataTable, Modal, LoadingBlock, ErrorBlock, type Column } from '@/components/ui';
import { PitchView } from '@/components/pitch/PitchView';
import { FixtureStrip, MatchModal } from '@/components/match/MatchModal';

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
    if (new URLSearchParams(window.location.search).get('entry')) return;
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
          <ManagerPills manager={m} />
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
    { key: 'captain', header: <SortHeader label="Captain" col="captain" sort={sort} onSort={onSort} />, align: 'center', render: (m) => <span className="text-sm text-muted">{m.captainName ?? '–'}</span> },
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

      {openEntry && <PitchModal entry={openEntry} gw={shownGW} onClose={() => setOpenEntry(null)} />}
      {openFixture && <MatchModal fixture={openFixture} onClose={() => setOpenFixture(null)} />}
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
function ManagerPills({ manager: m }: { manager: any }) {
  const pills: ReactNode[] = [];
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
          <PitchView players={picks.players ?? []} pointsOnBench={picks.pointsOnBench} />
        </>
      )}
    </Modal>
  );
}
