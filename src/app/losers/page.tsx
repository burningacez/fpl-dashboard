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
import React, { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Card,
  DataTable,
  ErrorBlock,
  LoadingBlock,
  Modal,
  PageHeader,
  type Column,
} from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useMyTeam } from '@/components/providers';
import { isMyTeam } from '@/lib/identity';

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
  const { data, loading, error } = useApi<any>('/api/losers');
  // Live data — legacy fetched /api/week alongside and tolerated failure.
  const { data: week } = useApi<any>('/api/week');
  const { me } = useMyTeam();

  const [modalGw, setModalGw] = useState<number | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);
  const [sort, setSort] = useState<SortState>({ col: 'points', asc: true });

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

  // ---- Wall of Shame (legacy render(): loss counts, top 3) ----
  const shame = useMemo(() => {
    const losers: any[] = data?.losers || [];
    const counts: Record<string, { count: number; entry?: number }> = {};
    losers.forEach((l) => {
      counts[l.name] = { count: (counts[l.name]?.count || 0) + 1, entry: l.entry };
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1].count - a[1].count);
    return {
      top3: sorted.slice(0, 3),
      topCount: sorted[0]?.[1].count || 0,
    };
  }, [data]);

  // ---- Live loser info (legacy render() liveLoserInfo) ----
  const liveGW: number | null = week?.isLive ? week.currentGW : null;
  const liveLoserInfo = useMemo(() => {
    if (!liveGW || !week?.managers) return null;
    const sortedByScore = [...week.managers].sort((a: any, b: any) => a.gwScore - b.gwScore);
    const lowestScore = sortedByScore[0]?.gwScore;
    const tiedAtBottom = sortedByScore.filter((m: any) => m.gwScore === lowestScore);
    tiedAtBottom.sort((a: any, b: any) => (b.transfersMade || 0) - (a.transfersMade || 0));
    const loserTransfers = tiedAtBottom[0]?.transfersMade || 0;
    const stillTied = tiedAtBottom.filter((m: any) => (m.transfersMade || 0) === loserTransfers);
    return {
      name: tiedAtBottom[0]?.name || 'Unknown',
      entryId: tiedAtBottom[0]?.entryId,
      score: lowestScore,
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
      render: (p) => p.rank,
    },
    {
      key: 'manager',
      header: <SortHeader label="Manager" col="manager" sort={sort} onSort={onSort} />,
      render: (p) => {
        const isLoser = modalLoserName != null && p.name === modalLoserName;
        const mine = isMyTeam(me, { entryId: p.entry, name: p.name });
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
      align: 'right',
      render: (p) => (p.transfers != null ? p.transfers : 0),
    },
    {
      key: 'points',
      header: <SortHeader label="Pts" col="points" sort={sort} onSort={onSort} />,
      align: 'right',
      render: (p) => (
        <Badge tone={modalLoserName != null && p.name === modalLoserName ? 'negative' : 'neutral'}>
          {p.points}
        </Badge>
      ),
    },
  ];

  // ---- Columns for the live modal table ----
  const liveColumns: Column<any>[] = [
    { key: 'rank', header: '#', render: (_m, i) => i + 1 },
    {
      key: 'manager',
      header: 'Manager',
      render: (m) => {
        const isLosing = m.gwScore === liveLowestScore;
        const mine = isMyTeam(me, { entryId: m.entryId, name: m.name });
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
    { key: 'transfers', header: 'Trf', align: 'right', render: (m) => m.transfersMade || 0 },
    {
      key: 'points',
      header: 'Pts',
      align: 'right',
      render: (m) => <Badge tone={m.gwScore === liveLowestScore ? 'negative' : 'neutral'}>{m.gwScore}</Badge>,
    },
  ];

  // ---- GW tile builder (legacy render() gw loop) ----
  const renderTile = (gw: number) => {
    const loser = data.losers.find((l: any) => l.gameweek === gw);
    const isComplete = !!loser;
    const isLive = gw === liveGW && !isComplete;

    let stateCls = 'border-edge opacity-50';
    let onClick: (() => void) | undefined;
    if (isComplete) {
      stateCls = 'cursor-pointer border-negative transition-transform hover:-translate-y-0.5';
      onClick = () => openModal(gw);
    } else if (isLive) {
      stateCls = 'cursor-pointer border-warning transition-transform hover:-translate-y-0.5';
      onClick = () => setLiveOpen(true);
    }

    const mine = isComplete
      ? isMyTeam(me, { entry: loser.entry, name: loser.name })
      : isLive && liveLoserInfo
        ? isMyTeam(me, { entryId: liveLoserInfo.entryId, name: liveLoserInfo.name })
        : false;

    let content: React.ReactNode = <div className="text-xs font-bold text-faint">-</div>;
    if (isComplete) {
      // Tie context (legacy tiedText) — skipped for overridden GWs
      const gwData = data.allGameweeks?.[gw];
      let tiedText = '';
      if (gwData?.managers && !gwData.overrideName) {
        const lowestScore = Math.min(...gwData.managers.map((m: any) => m.points));
        const tiedAtBottom = gwData.managers.filter((m: any) => m.points === lowestScore);
        if (tiedAtBottom.length === 2) {
          const loserManager = tiedAtBottom.find((m: any) => m.name === loser.name);
          const other = tiedAtBottom.find((m: any) => m.name !== loser.name);
          if (loserManager && other) {
            if (loserManager.transfers > other.transfers) {
              const diff = loserManager.transfers - other.transfers;
              tiedText = `+${diff} transfer${diff !== 1 ? 's' : ''} vs ${other.name}`;
            } else {
              tiedText = `Coinflip vs ${other.name}`;
            }
          }
        } else if (tiedAtBottom.length > 2) {
          tiedText = `+ ${tiedAtBottom.length - 1} others tied`;
        }
      }
      content = (
        <>
          <div className="break-words text-xs font-bold text-negative">{loser.name}</div>
          <div className="text-[0.7rem] text-muted">{loser.points} pts</div>
          <div className="text-[0.6rem] italic text-faint">{loser.context}</div>
          {tiedText && <div className="mt-0.5 text-[0.55rem] text-faint">{tiedText}</div>}
        </>
      );
    } else if (isLive && liveLoserInfo) {
      let runnerText = '';
      if (liveLoserInfo.tiedCount === 2) {
        runnerText = `Also: ${liveLoserInfo.runners[1]}`;
      } else if (liveLoserInfo.tiedCount > 2) {
        runnerText = `+ ${liveLoserInfo.tiedCount - 1} others tied`;
      }
      content = (
        <>
          <div className="break-words text-xs font-bold text-warning">{liveLoserInfo.name}</div>
          <div className="text-[0.7rem] text-muted">{liveLoserInfo.score} pts</div>
          <div className="text-[0.6rem] italic text-faint">Currently losing</div>
          {runnerText && <div className="mt-0.5 text-[0.55rem] text-faint">{runnerText}</div>}
        </>
      );
    }

    return (
      <div
        key={gw}
        onClick={onClick}
        className={`flex min-h-[110px] min-w-0 flex-col overflow-hidden rounded-xl border-2 bg-surface p-2 text-center ${stateCls} ${mine ? 'my-team-card' : ''}`}
      >
        <div className={`mb-1 text-[0.7rem] font-bold ${isLive ? 'text-warning' : 'text-muted'}`}>
          GW {gw}
          {isLive && (
            <span className="ml-1 inline-block animate-pulse rounded bg-warning px-1 py-0.5 align-middle text-[0.5rem] font-bold text-accent-fg">
              LIVE
            </span>
          )}
        </div>
        <div className="mt-auto">{content}</div>
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
          {/* Wall of Shame */}
          <Card className="mb-6">
            <div className="mb-3 text-center text-base font-bold">🏆 Wall of Shame</div>
            <div className="flex flex-wrap justify-center gap-3">
              {shame.top3.map(([name, info]) => {
                const isTop = info.count === shame.topCount;
                const mine = isMyTeam(me, { entryId: info.entry, name });
                return (
                  <div
                    key={name}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2 ${
                      isTop ? 'border-2 border-negative bg-negative-soft' : 'bg-raised'
                    }`}
                  >
                    <span className={`font-semibold ${mine ? 'my-team-name' : ''}`}>{name}</span>
                    <Badge tone="negative">{info.count}</Badge>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* GW tiles */}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-9">
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
