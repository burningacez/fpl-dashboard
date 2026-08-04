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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  DataTable,
  EmptyBlock,
  ErrorBlock,
  LoadingBlock,
  Modal,
  PageHeader,
  SortHeader,
  renderTwoLineName,
  type Column,
  type SortState,
} from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useIsMe, useMyTeam, useSeason } from '@/components/providers';
import { chipAbbr } from '@/lib/chips';
import { DEFAULT_SEASON, getSeasonConfig } from '@/lib/season-config';
import { TourButton, useTourHost } from '@/components/tour/TourProvider';
import { buildLosersTour } from './losersTour';
import { liveLoser, sortLive } from './liveLoser';
// Type-only, so the demo payloads stay behind the dynamic import in enterDemo.
import type { DemoLosersData } from './demoLosers';

// Render a name on two lines when it contains a space (split at the first
// space) so multi-word names fill the reserved two-line slot instead of
// wrapping awkwardly or truncating.


// ---------------------------------------------------------------------------
// Sorting (legacy sortModalTable)
// ---------------------------------------------------------------------------


const SORT_KEYS: Record<string, (p: any) => string | number> = {
  rank: (p) => p.rank,
  manager: (p) => String(p.name).toLowerCase(),
  points: (p) => p.points,
  goals: (p) => p.goals || 0,
  assists: (p) => p.assists || 0,
  transfers: (p) => p.transfers || 0,
};



function TiebreakerNote({ showAttacking }: { showAttacking: boolean }) {
  return (
    <div className="mt-4 rounded-lg bg-raised p-3 text-sm text-muted" data-tour="losers-tiebreak">
      <strong className="text-accent">Tiebreakers:</strong>{' '}
      {showAttacking
        ? '1) Fewest goals → 2) Fewest assists → 3) Most transfers → 4) Coin flip'
        : '1) Most transfers → 2) Coin flip'}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function LosersPage() {
  const { data: dataApi, loading, error, empty, refetch } = useApi<any>('/api/losers');
  // Live data — legacy fetched /api/week alongside and tolerated failure.
  const { data: weekApi } = useApi<any>('/api/week');
  const isMe = useIsMe();
  const { me, features } = useMyTeam();
  const { season, currentSeason } = useSeason();
  const seasonCfg = getSeasonConfig(season ?? currentSeason) ?? getSeasonConfig(DEFAULT_SEASON)!;
  const totalGws = seasonCfg.totalWeeks;
  // Goals/assists only exist (and only count) from 2026-27.
  const showAttacking = seasonCfg.attackingTiebreakers;

  const [modalGw, setModalGw] = useState<number | null>(null);
  const [liveOpen, setLiveOpen] = useState(false);
  const [sort, setSort] = useState<SortState>({ col: 'points', asc: true });
  const [weekLive, setWeekLive] = useState<any>(null);

  // ---- walkthrough demo mode (see demoLosers.ts) ----
  // Nothing on this page fetches on open, so demo mode is purely a render-time
  // override: the real payloads stay untouched underneath and come straight back
  // when the tour ends.
  const [demo, setDemo] = useState<DemoLosersData | null>(null);
  /** Restore whatever panel was open when the tour started. */
  const prevModal = useRef<{ gw: number | null; live: boolean }>({ gw: null, live: false });
  const data = demo ? demo.losers : dataApi;
  const week = demo ? demo.week : (weekLive ?? weekApi);

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
  // Both the tile's verdict and the table below come out of liveLoser.ts, so
  // they cannot name different managers when a week is tied at the bottom.
  const liveGW: number | null = week?.isLive ? week.currentGW : null;
  const liveLoserInfo = useMemo(
    () => (liveGW ? liveLoser(week?.managers, showAttacking) : null),
    [week, liveGW, showAttacking],
  );

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
    managers.sort((a: any, b: any) => {
      if (a.points !== b.points) return a.points - b.points;
      if (showAttacking) {
        if ((a.goals || 0) !== (b.goals || 0)) return (a.goals || 0) - (b.goals || 0);
        if ((a.assists || 0) !== (b.assists || 0)) return (a.assists || 0) - (b.assists || 0);
      }
      return (b.transfers || 0) - (a.transfers || 0);
    });
    managers.forEach((m: any, i: number) => (m.rank = i + 1));
    return managers;
  }, [data, modalGw, showAttacking]);

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

  // The completed tile the walkthrough points at: in demo mode a week settled on
  // a tiebreak, otherwise simply the most recent one to finish.
  const focusTileGw: number = demo
    ? demo.focusGw
    : (data?.losers?.[data.losers.length - 1]?.gameweek ?? 0);

  // ---- walkthrough ----------------------------------------------------------
  const enterDemo = useCallback(async () => {
    const mod = await import('./demoLosers');
    const built = mod.buildDemoLosers(
      me ? { entryId: me.entryId, name: me.name, team: me.team } : null,
      dataApi?.leagueName ?? 'Example League',
    );
    prevModal.current = { gw: modalGw, live: liveOpen };
    setModalGw(null);
    setLiveOpen(false);
    setDemo(built);
  }, [me, dataApi?.leagueName, modalGw, liveOpen]);

  const exitDemo = useCallback(() => {
    setDemo(null);
    setModalGw(prevModal.current.gw);
    setLiveOpen(prevModal.current.live);
    prevModal.current = { gw: null, live: false };
  }, []);

  useTourHost(
    buildLosersTour({
      // Preview-gated server-side, same flag as the Scores walkthrough. An
      // archived season still has losers, so no season guard here.
      ready: Boolean(dataApi) && !error && !empty && features.walkthroughs,
      hasLive: demo ? true : liveGW != null,
      hasCompleted: demo ? true : (data?.losers?.length ?? 0) > 0,
      focusGw: focusTileGw || 1,
      onStart: enterDemo,
      onEnd: exitDemo,
      actions: {
        openGw: (gw: number) => openModal(gw),
        closeGw: () => setModalGw(null),
        setLiveOpen,
      },
    }),
  );

  const modalLoser = modalGw != null ? data?.losers?.find((l: any) => l.gameweek === modalGw) : null;
  const modalLoserName: string | null = modalLoser?.name || null;

  // ---- Live modal rows (legacy openLiveModal) ----
  const liveRows = useMemo(() => sortLive(week?.managers, showAttacking), [week, showAttacking]);
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
    ...(showAttacking
      ? ([
          {
            key: 'goals',
            header: <SortHeader label="⚽" col="goals" sort={sort} onSort={onSort} />,
            align: 'center',
            render: (p: any) => <span className={p.goals ? '' : 'text-faint'}>{p.goals || 0}</span>,
          },
          {
            key: 'assists',
            header: <SortHeader label="👟" col="assists" sort={sort} onSort={onSort} />,
            align: 'center',
            render: (p: any) => <span className={p.assists ? '' : 'text-faint'}>{p.assists || 0}</span>,
          },
        ] as Column<any>[])
      : []),
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
          const chip = chipAbbr(m.activeChip);
          detail = detail ? `${detail} | ${chip}` : chip;
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
    ...(showAttacking
      ? ([
          { key: 'goals', header: '⚽', align: 'center', render: (m: any) => <span className={m.gwGoals ? '' : 'text-faint'}>{m.gwGoals || 0}</span> },
          { key: 'assists', header: '👟', align: 'center', render: (m: any) => <span className={m.gwAssists ? '' : 'text-faint'}>{m.gwAssists || 0}</span> },
        ] as Column<any>[])
      : []),
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
      // Anything that isn't a "Lost by N pts" margin was settled on a tiebreak.
      const isTie = !String(loser.context ?? '').startsWith('Lost by');
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
        // The walkthrough points at one finished week and the live one. Only the
        // focus gameweek is named, so the selector cannot match six tiles.
        data-tour={
          isLive ? 'losers-tile-live' : isComplete && gw === focusTileGw ? 'losers-tile-done' : undefined
        }
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
          {hasLoser ? renderTwoLineName(name) : '—'}
        </div>
        {/* Margin / tiebreaker: fixed row */}
        <div className="mt-1 h-5 text-sm text-muted">{sub}</div>
      </div>
    );
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <div className="flex items-start justify-between gap-3">
        <PageHeader title={data?.leagueName ?? 'Weekly Losers'} subtitle="Weekly Losers" />
        <TourButton label="See demo" title="See a guided demo of this page" className="mt-1" />
      </div>

      {demo && (
        <p className="mb-4 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-xs font-semibold text-accent">
          Example data. A made-up season so every tile has something to show. Your real
          league comes back when the tour ends.
        </p>
      )}
      {loading && <LoadingBlock label="Loading data…" />}
      {error && <ErrorBlock message={error} />}
      {empty && <EmptyBlock message={empty} />}
      {data?.error && <ErrorBlock message={data.error} />}
      {data && !data.error && (
        <>
          {/* GW cards */}
          <div className="grid grid-cols-3 gap-3" data-tour="losers-grid">
            {Array.from({ length: totalGws }, (_, i) => renderTile(i + 1))}
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
          anchor="modal-losers-gw"
        >
          <div data-tour="losers-gw-table">
          <DataTable
            columns={gwColumns}
            rows={sortedModalRows}
            rowKey={(p) => p.entry}
            rowRef={(p) => ({ entryId: p.entry, name: p.name })}
            rowClass={(p) => (modalLoserName != null && p.name === modalLoserName ? 'loser-row' : '')}
          />
          </div>
          <TiebreakerNote showAttacking={showAttacking} />
        </Modal>
      )}

      {/* Live standings modal */}
      {liveOpen && liveGW != null && (
        <Modal title={`GW ${liveGW} Live Standings`} onClose={() => setLiveOpen(false)} anchor="modal-losers-live">
          <div data-tour="losers-live-table">
          <DataTable
            columns={liveColumns}
            rows={liveRows}
            rowKey={(m) => m.entryId}
            rowRef={(m) => ({ entryId: m.entryId, name: m.name })}
            rowClass={(m) => (m.gwScore === liveLowestScore ? 'loser-row' : '')}
          />
          </div>
          <TiebreakerNote showAttacking={showAttacking} />
        </Modal>
      )}
    </main>
  );
}
