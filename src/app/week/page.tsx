'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useMyTeam } from '@/components/providers';
import { isMyTeam } from '@/lib/identity';
import { PageHeader, DataTable, Badge, Modal, LoadingBlock, ErrorBlock, type Column } from '@/components/ui';
import { PitchView } from '@/components/pitch/PitchView';

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
  const managers: any[] = viewingLive ? (week.managers ?? []) : (history?.managers ?? []);

  const columns: Column<any>[] = [
    { key: 'gwRank', header: '#', render: (m) => m.gwRank ?? m.rank },
    {
      key: 'manager',
      header: 'Manager',
      render: (m) => (
        <button className="text-left" onClick={() => setOpenEntry({ id: m.entryId, name: m.name })}>
          <span className={`font-bold ${isMyTeam(me, { entryId: m.entryId, name: m.name }) ? 'my-team-name' : ''}`}>
            {m.name}
          </span>
          <div className="text-xs text-muted">{m.team}</div>
        </button>
      ),
    },
    {
      key: 'gwScore',
      header: 'GW',
      align: 'right',
      render: (m) => (
        <span>
          <strong>{m.gwScore}</strong>
          {m.transferCost > 0 && <span className="text-negative"> (-{m.transferCost})</span>}
        </span>
      ),
    },
    { key: 'playersLeft', header: 'Left', align: 'right', render: (m) => `${m.activePlayers ?? '–'}/${(m.activePlayers ?? 0) + (m.playersLeft ?? 0)}` },
    { key: 'chip', header: 'Chip', align: 'center', render: (m) => (m.activeChip ? <Badge tone="accent">{chipLabel(m.activeChip)}</Badge> : '') },
    { key: 'captain', header: 'Captain', render: (m) => <span className="text-sm text-muted">{m.captainName ?? '–'}</span> },
    { key: 'overall', header: 'Total', align: 'right', render: (m) => m.overallPoints },
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
        </button>
      ),
    },
    {
      key: 'gwScore',
      header: 'GW',
      align: 'right',
      render: (m) => (
        <span>
          <strong>{m.gwScore}</strong>
          {m.transferCost > 0 && <span className="text-negative"> (-{m.transferCost})</span>}
        </span>
      ),
    },
    { key: 'chip', header: 'Chip', align: 'center', render: (m) => (m.activeChip ? <Badge tone="accent">{chipLabel(m.activeChip)}</Badge> : '') },
    { key: 'captain', header: 'Captain', render: (m) => <span className="text-sm text-muted">{m.captainName ?? '–'}</span> },
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
    </main>
  );
}

function chipLabel(chip: string): string {
  return { wildcard: 'WC', freehit: 'FH', bboost: 'BB', '3xc': 'TC' }[chip] ?? chip;
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
            <span>Formation {picks.formation}</span>
            <span>GW points <strong className="text-body">{picks.calculatedPoints ?? picks.points}</strong></span>
            <span>Bench {picks.pointsOnBench}</span>
          </div>
          <PitchView players={picks.players ?? []} />
        </>
      )}
    </Modal>
  );
}
