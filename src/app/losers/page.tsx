'use client';

/**
 * Weekly Losers — port of legacy/losers.html.
 *
 * Endpoints: /api/losers → { leagueName, losers[], allGameweeks } plus
 * /api/week (tolerated failure, like legacy) for live-gameweek data.
 *
 * Replicates: Wall of Shame (top 3 loss counts, top item emphasised), the
 * 38 GW tile grid (complete / live / upcoming states, tie context lines),
 * the per-GW modal table (override fudging, loser tiebreaker sort, LOSER
 * badge + loser-row) and the live standings modal (LOSING badge, players-left
 * / chip detail). Manager names link to /week?entry=&gw= (legacy
 * openPitchModal). SSE/polling auto-refresh is not replicated.
 */

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  DataTable,
  ErrorBlock,
  LoadingBlock,
  Modal,
  PageHeader,
  type Column,
} from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useIsMe } from '@/components/providers';

// Render a name on two lines when it contains a space (split at the first
// space) so multi-word names fill the reserved two-line slot instead of
// wrapping awkwardly or truncating.
function renderName(name: string) {
  const i = name.indexOf(' ');
  if (i === -1) return name;
  return (
    <>
      {name.slice(0, i)}
      <br />
      {name.slice(i + 1)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Sorting (legacy sortModalTable)
// ---------------------------------------------------------------------------

type SortState = { col: string | null; asc: boolean };

const SORT_KEYS: Record<string, (p: any) => string | number> = {
  rank: (p) => p.rank,
  manager: (p) => String(p.name).toLowerCase(),
  points: (p) => p.points,
  transfers: (p) => p.transfers || 0,
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

function TiebreakerNote() {
  return (
    <div className="mt-4 rounded-lg bg-raised p-3 text-sm text-muted">
      <strong className="text-accent">Tiebreakers:</strong> 1) Most transfers → 2) Coin flip
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function LosersPage() {
  const { data, loading, error, refetch } = useApi<any>('/api/losers');
  // Live data — legacy fetched /api/week alongside and tolerated failure.
  const { data: weekApi } = useApi<any>('/api/week');
  const isMe = useIsMe();

  const [modalGw, setModalGw] = useState<number | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);
  const [sort, setSort] = useState<SortState>({ col: 'points', asc: true });
  const [weekLive, setWeekLive] = useState<any>(null);
  const week = weekLive ?? weekApi;

  // Live updates during an in-progress GW (legacy connectLosersSSE): SSE sync
  // events refresh the live tile/modal; on SSE failure fall back to 60s polling.
  useEffect(() => {
    if (!weekApi?.isLive) return;
    let poll: ReturnType<typeof setInterval> | null = null;
    const es = new EventSource('/api/live/events');
    es.addEventListener('sync', (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data);
        if (!d.error) setWeekLive(d);
        if (!d.isLive) {
          es.close();
          refetch(); // GW just finished — reload final loser data
        }
      } catch {
        /* ignore */
      }
    });
    es.onerror = () => {
      es.close();
      if (!poll) {
        poll = setInterval(() => {
          fetch('/api/week')
            .then((r) => r.json())
            .then((d) => !d.error && setWeekLive(d))
            .catch(() => {});
        }, 60000);
      }
    };
    return () => {
      es.close();
      if (poll) clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekApi?.isLive]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModalGw(null);
        setLiveOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- Live loser info (legacy render() liveLoserInfo) ----
  const liveGW: number | null = week?.isLive ? week.currentGW : null;
  const liveLoserInfo = useMemo(() => {
    if (!liveGW || !week?.managers) return null;
    const sortedByScore = [...week.managers].sort((a: any, b: any) => a.gwScore - b.gwScore);
    const lowestScore = sortedByScore[0]?.gwScore;
    const secondLowest = sortedByScore.find((m: any) => m.gwScore > lowestScore)?.gwScore ?? lowestScore;
    const tiedAtBottom = sortedByScore.filter((m: any) => m.gwScore === lowestScore);
    tiedAtBottom.sort((a: any, b: any) => (b.transfersMade || 0) - (a.transfersMade || 0));
    const loserTransfers = tiedAtBottom[0]?.transfersMade || 0;
    const stillTied = tiedAtBottom.filter((m: any) => (m.transfersMade || 0) === loserTransfers);
    return {
      name: tiedAtBottom[0]?.name || 'Unknown',
      entryId: tiedAtBottom[0]?.entryId,
      score: lowestScore,
      margin: secondLowest - lowestScore,
      tiedCount: stillTied.length,
      runners: stillTied.map((m: any) => m.name),
    };
  }, [week, liveGW]);

  // ---- GW modal rows (legacy openModal: override fudge + loser sort) ----
  const modalRows = useMemo(() => {
    if (!data || modalGw == null) return [];
    const gwInfo = data.allGameweeks?.[modalGw];
    if (!gwInfo?.managers?.length) return [];
    const managers = gwInfo.managers.map((m: any) => ({ ...m }));
    // If there's an override, fudge the override person's score to be lowest
    if (gwInfo.overrideName) {
      const lowest = Math.min(...managers.map((m: any) => m.points));
      const om = managers.find((m: any) => m.name === gwInfo.overrideName);
      if (om && om.points >= lowest) om.points = lowest - 1;
    }
    managers.sort((a: any, b: any) =>
      a.points !== b.points ? a.points - b.points : (b.transfers || 0) - (a.transfers || 0),
    );
    managers.forEach((m: any, i: number) => (m.rank = i + 1));
    return managers;
  }, [data, modalGw]);

  const sortedModalRows = useMemo(() => {
    if (!sort.col) return modalRows;
    const key = SORT_KEYS[sort.col];
    return [...modalRows].sort((a, b) => {
      const av = key(a);
      const bv = key(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        return sort.asc
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av));
      }
      return sort.asc ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [modalRows, sort]);

  const onSort = (col: string) =>
    setSort((s) => (s.col === col ? { col, asc: !s.asc } : { col, asc: col === 'points' }));

  const openModal = (gw: number) => {
    const gwInfo = data?.allGameweeks?.[gw];
    if (!gwInfo?.managers?.length) return;
    setSort({ col: 'points', asc: true });
    setModalGw(gw);
  };

  const modalLoser = modalGw != null ? data?.losers?.find((l: any) => l.gameweek === modalGw) : null;
  const modalLoserName: string | null = modalLoser?.name || null;

  // ---- Live modal rows (legacy openLiveModal) ----
  const liveRows = useMemo(() => {
    if (!week?.managers) return [];
    return [...week.managers].sort((a: any, b: any) => {
      if (a.gwScore !== b.gwScore) return a.gwScore - b.gwScore;
      return (b.transfersMade || 0) - (a.transfersMade || 0);
    });
  }, [week]);
  const liveLowestScore = liveRows[0]?.gwScore;

  // ---- Columns for the GW modal table ----
  const gwColumns: Column<any>[] = [
    {
      key: 'rank',
      header: <SortHeader label="#" col="rank" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (p) => p.rank,
    },
    {
      key: 'manager',
      header: <SortHeader label="Manager" col="manager" sort={sort} onSort={onSort} />,
      render: (p) => {
        const isLoser = modalLoserName != null && p.name === modalLoserName;
        const mine = isMe({ entryId: p.entry, name: p.name });
        return (
          <div>
            <Link
              href={`/week?entry=${p.entry}&gw=${modalGw}`}
              className={`font-bold hover:text-accent ${mine ? 'my-team-name' : ''}`}
            >
              {p.name}
            </Link>
            {isLoser && (
              <span className="ml-2 align-middle">
                <Badge tone="negative">LOSER</Badge>
              </span>
            )}
            <div className="text-xs text-muted">{p.team}</div>
          </div>
        );
      },
    },
    {
      key: 'transfers',
      header: <SortHeader label="Trf" col="transfers" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (p) => (p.transfers != null ? p.transfers : 0),
    },
    {
      key: 'points',
      header: <SortHeader label="Pts" col="points" sort={sort} onSort={onSort} />,
      align: 'center',
      render: (p) => (
        <Badge tone={modalLoserName != null && p.name === modalLoserName ? 'negative' : 'neutral'}>
          {p.points}
        </Badge>
      ),
    },
  ];

  // ---- Columns for the live modal table ----
  const liveColumns: Column<any>[] = [
    { key: 'rank', header: '#', align: 'center', render: (_m, i) => i + 1 },
    {
      key: 'manager',
      header: 'Manager',
      render: (m) => {
        const isLosing = m.gwScore === liveLowestScore;
        const mine = isMe({ entryId: m.entryId, name: m.name });
        let detail = '';
        if (m.playersLeft > 0) {
          const activeText = m.activePlayers > 0 ? ` (+${m.activePlayers})` : '';
          detail = `${m.playersLeft}${activeText} to play`;
        }
        if (m.activeChip) {
          const chipName =
            ({ wildcard: 'WC', freehit: 'FH', bboost: 'BB', '3xc': 'TC' } as Record<string, string>)[
              m.activeChip
            ] || m.activeChip;
          detail = detail ? `${detail} | ${chipName}` : chipName;
        }
        return (
          <div>
            <Link
              href={`/week?entry=${m.entryId}&gw=${liveGW}`}
              className={`font-bold hover:text-accent ${mine ? 'my-team-name' : ''}`}
            >
              {m.name}
            </Link>
            {isLosing && (
              <span className="ml-2 align-middle">
                <Badge tone="negative">LOSING</Badge>
              </span>
            )}
            <div className="text-xs text-muted">{m.team}</div>
            {detail && <div className="text-xs text-faint">{detail}</div>}
          </div>
        );
      },
    },
    { key: 'transfers', header: 'Trf', align: 'center', render: (m) => m.transfersMade || 0 },
    {
      key: 'points',
      header: 'Pts',
      align: 'center',
      render: (m) => <Badge tone={m.gwScore === liveLowestScore ? 'negative' : 'neutral'}>{m.gwScore}</Badge>,
    },
  ];

  // ---- GW tile builder (legacy render() gw loop) ----
  const renderTile = (gw: number) => {
    const loser = data.losers.find((l: any) => l.gameweek === gw);
    const isComplete = !!loser;
    const isLive = gw === liveGW && !isComplete;

    let stateCls = 'border-edge opacity-60';
    let onClick: (() => void) | undefined;
    if (isComplete) {
      stateCls = 'cursor-pointer border-negative transition-colors hover:border-accent';
      onClick = () => openModal(gw);
    } else if (isLive) {
      stateCls = 'cursor-pointer border-warning transition-colors hover:border-accent';
      onClick = () => setLiveOpen(true);
    }

    const mine = isComplete
      ? isMe({ entry: loser.entry, name: loser.name })
      : isLive && liveLoserInfo
        ? isMe({ entryId: liveLoserInfo.entryId, name: liveLoserInfo.name })
        : false;

    // Card body (matches the MOTM grid): loser name + margin (or 'Tiebreaker').
    // Each element gets a dedicated slot with reserved height so cards stay the
    // same shape regardless of name length.
    let name = '—';
    let nameColor = 'text-faint';
    let sub = '';
    if (isComplete) {
      const isTie = loser.context === 'Tiebreaker' || loser.context === 'More transfers';
      name = loser.name;
      nameColor = 'text-negative';
      // context is "Lost by N pts" — show just "By N" to match the MOTM grid.
      sub = isTie ? 'Tiebreaker' : `By ${loser.context.match(/\d+/)?.[0] ?? ''}`;
    } else if (isLive && liveLoserInfo) {
      name = liveLoserInfo.name;
      nameColor = 'text-warning';
      sub = liveLoserInfo.tiedCount > 1 ? 'Tiebreaker' : `By ${liveLoserInfo.margin}`;
    }
    const hasLoser = isComplete || (isLive && !!liveLoserInfo);

    return (
      <div
        key={gw}
        onClick={onClick}
        className={`flex h-full flex-col rounded-xl border p-4 text-center ${stateCls} ${mine ? 'my-team-card' : 'bg-surface'}`}
      >
        {/* Header: fixed row so the gameweek aligns across every card */}
        <div className="flex h-6 items-center justify-center gap-2">
          <span className="font-extrabold">GW {gw}</span>
          {isLive && <Badge tone="negative">LIVE</Badge>}
        </div>
        {/* Label: fixed row */}
        <div className="mt-2 h-4 text-xs uppercase tracking-wide">
          {isComplete ? (
            <span className="text-negative">💀 Loser</span>
          ) : isLive ? (
            <span className="text-warning">Losing</span>
          ) : null}
        </div>
        {/* Name: reserve two lines so single- and two-line names occupy equal space */}
        <div className={`mt-1 line-clamp-2 min-h-[2.25rem] break-words text-sm font-bold leading-tight ${nameColor} ${mine ? 'my-team-name' : ''}`}>
          {hasLoser ? renderName(name) : '—'}
        </div>
        {/* Margin / tiebreaker: fixed row */}
        <div className="mt-1 h-5 text-sm text-muted">{sub}</div>
      </div>
    );
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <PageHeader title={data?.leagueName ?? 'Weekly Losers'} subtitle="Weekly Losers" />
      {loading && <LoadingBlock label="Loading data…" />}
      {error && <ErrorBlock message={error} />}
      {data && (
        <>
          {/* GW cards */}
          <div className="grid grid-cols-3 gap-3">
            {Array.from({ length: 38 }, (_, i) => renderTile(i + 1))}
          </div>
        </>
      )}

      {/* Per-GW modal */}
      {modalGw != null && (
        <Modal
          title={
            <span>
              Gameweek {modalGw}
              {modalLoser && (
                <span className="block text-sm font-normal text-muted">
                  {modalLoser.name} - {modalLoser.context}
                </span>
              )}
            </span>
          }
          onClose={() => setModalGw(null)}
        >
          <DataTable
            columns={gwColumns}
            rows={sortedModalRows}
            rowKey={(p) => p.entry}
            rowRef={(p) => ({ entryId: p.entry, name: p.name })}
            rowClass={(p) => (modalLoserName != null && p.name === modalLoserName ? 'loser-row' : '')}
          />
          <TiebreakerNote />
        </Modal>
      )}

      {/* Live standings modal */}
      {liveOpen && liveGW != null && (
        <Modal title={`GW ${liveGW} Live Standings`} onClose={() => setLiveOpen(false)}>
          <DataTable
            columns={liveColumns}
            rows={liveRows}
            rowKey={(m) => m.entryId}
            rowRef={(m) => ({ entryId: m.entryId, name: m.name })}
            rowClass={(m) => (m.gwScore === liveLowestScore ? 'loser-row' : '')}
          />
          <TiebreakerNote />
        </Modal>
      )}
    </main>
  );
}
