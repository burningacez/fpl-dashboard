'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Manager of the Month — port of legacy/motm.html.
 * Endpoint /api/motm → { leagueName, periods: {1..9}, winners[], currentGW, isLive }.
 * Each period: { rankings[], startGW, endGW, periodComplete, isLive }.
 * Ranking item: { name, team, entryId, netScore, grossScore, transfers, transferCost, highestGW }.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { DataTable, ManagerCell, PageHeader, Modal, LoadingBlock, EmptyBlock, ErrorBlock, type Column, renderTwoLineName } from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useIsMe, useMyTeam, useSeason } from '@/components/providers';
import { DEFAULT_SEASON, getSeasonConfig, motmPeriodCount } from '@/lib/season-config';
import { TourButton, useTourHost } from '@/components/tour/TourProvider';
import { buildMotmTour } from './motmTour';
// Type-only, so the demo payload stays behind the dynamic import in enterDemo.
import type { DemoMotmData } from './demoMotm';

// Render a name on two lines when it contains a space (split at the first
// space) so multi-word names fill the reserved two-line slot instead of
// wrapping awkwardly or truncating.


export default function MotmPage() {
  const { data: dataApi, loading, error, empty } = useApi<any>('/api/motm');
  const isMe = useIsMe();
  const { me, features } = useMyTeam();
  const { season, currentSeason } = useSeason();
  const [openPeriod, setOpenPeriod] = useState<number | null>(null);

  // ---- walkthrough demo mode (see demoMotm.ts) ----
  // Nothing on this page fetches on open, so demo mode is purely a render-time
  // override: the real payload stays untouched underneath and comes straight
  // back when the tour ends.
  const [demo, setDemo] = useState<DemoMotmData | null>(null);
  /** Restore whatever period was open when the tour started. */
  const prevOpen = useRef<number | null>(null);
  const data = demo ? demo.motm : dataApi;

  const periods: any = data?.periods ?? {};
  const periodNums = Object.keys(periods).map(Number).sort((a, b) => a - b);
  const cfg = getSeasonConfig(season ?? currentSeason) ?? getSeasonConfig(DEFAULT_SEASON)!;
  const periodCount = motmPeriodCount(cfg);
  // Goals/assists became MotM tiebreakers in 2026-27; earlier periods were
  // decided without them and their archives carry no such numbers.
  const showAttacking = cfg.attackingTiebreakers;

  // Deep link (legacy handleUrlParams): ?period=N opens that period's rankings.
  // Keyed on the real payload rather than the rendered one, so entering demo
  // mode can't reopen a period the walkthrough has just closed.
  useEffect(() => {
    if (!dataApi?.periods) return;
    const p = Number(new URLSearchParams(window.location.search).get('period'));
    if (p && dataApi.periods[p]?.rankings?.length) setOpenPeriod(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataApi]);

  const rankingColumns: Column<any>[] = [
    { key: 'rank', header: '#', align: 'center', render: (_r, i) => <span className={i < 3 ? `rank-${i + 1}` : ''}>{i + 1}</span> },
    { key: 'manager', header: 'Manager', render: (r) => <ManagerCell name={r.name} team={r.team} refOverride={{ entryId: r.entryId, name: r.name }} /> },
    { key: 'net', header: 'Net', align: 'center', render: (r) => <strong>{r.netScore}</strong> },
    { key: 'gross', header: 'Gross', align: 'center', render: (r) => r.grossScore },
    ...(showAttacking
      ? ([
          { key: 'goals', header: '⚽', align: 'center', render: (r: any) => <span className={r.goals ? '' : 'text-faint'}>{r.goals || 0}</span> },
          { key: 'assists', header: '👟', align: 'center', render: (r: any) => <span className={r.assists ? '' : 'text-faint'}>{r.assists || 0}</span> },
        ] as Column<any>[])
      : []),
    { key: 'trf', header: 'Trf', align: 'center', render: (r) => <>{r.transfers}{r.transferCost > 0 && <span className="text-negative"> (-{r.transferCost})</span>}</> },
    { key: 'best', header: 'Best', align: 'center', render: (r) => r.highestGW ?? '–' },
    {
      key: 'low',
      header: 'Low',
      align: 'center',
      render: (r) => (r.lowestTwo?.length ? Math.min(...r.lowestTwo) : '–'),
    },
  ];

  // ---- walkthrough ----------------------------------------------------------
  // The finished period the walkthrough points at and opens: the most recent one
  // to complete, so it is the tile with the most context behind it.
  const completePeriods = periodNums.filter((p) => periods[p].periodComplete && periods[p].rankings?.length);
  const focusPeriod = demo ? demo.focusPeriod : (completePeriods[completePeriods.length - 1] ?? 0);
  const livePeriod = demo
    ? demo.livePeriod
    : (periodNums.find((p) => periods[p].isLive && periods[p].rankings?.length) ?? 0);

  const enterDemo = useCallback(async () => {
    const mod = await import('./demoMotm');
    const built = mod.buildDemoMotm(
      me ? { entryId: me.entryId, name: me.name, team: me.team } : null,
      dataApi?.leagueName ?? 'Example League',
      cfg.motmPeriods,
    );
    prevOpen.current = openPeriod;
    setOpenPeriod(null);
    setDemo(built);
  }, [me, dataApi?.leagueName, cfg.motmPeriods, openPeriod]);

  const exitDemo = useCallback(() => {
    setDemo(null);
    setOpenPeriod(prevOpen.current);
    prevOpen.current = null;
  }, []);

  useTourHost(
    buildMotmTour({
      // Preview-gated server-side, same flag as the other walkthroughs. An
      // archived season has periods of its own, so no season guard here.
      ready: Boolean(dataApi) && !error && !empty && features.walkthroughs,
      hasComplete: demo ? true : focusPeriod > 0,
      hasLive: demo ? true : livePeriod > 0,
      periodCount,
      showAttacking,
      onStart: enterDemo,
      onEnd: exitDemo,
      actions: { closePeriod: () => setOpenPeriod(null) },
    }),
  );

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <div className="flex items-start justify-between gap-3">
        <PageHeader
          title={data?.leagueName ?? 'Manager of the Month'}
          subtitle={`${periodCount} periods across the season. Highest net score wins each. Tap a period for full rankings.`}
        />
        <TourButton label="See demo" title="See a guided demo of this page" className="mt-1" />
      </div>

      {demo && (
        <p className="mb-4 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-xs font-semibold text-accent">
          Example data. A made-up season so every period has something to show. Your real
          league comes back when the tour ends.
        </p>
      )}
      {loading && <LoadingBlock label="Loading MOTM…" />}
      {error && <ErrorBlock message={error} />}
      {empty && <EmptyBlock message={empty} />}
      {data?.error && <ErrorBlock message={data.error} />}
      {data && !data.error && periodNums.length === 0 && (
        <EmptyBlock message="No periods to show yet. Check back once GW1 is underway." />
      )}

      {periodNums.length > 0 && (
        <div className="grid grid-cols-3 gap-3" data-tour="motm-grid">
          {periodNums.map((p) => {
            const period = periods[p];
            const winner = period.periodComplete ? period.rankings?.[0] : null;
            const leader = !winner ? period.rankings?.[0] : null;
            const runnerUp = period.rankings?.[1];
            const margin = runnerUp ? (period.rankings[0].netScore - runnerUp.netScore) : null;
            return (
              <button
                key={p}
                onClick={() => setOpenPeriod(p)}
                // The walkthrough points at one finished period and the live one.
                // Only those two are named, so the selector cannot match nine tiles.
                data-tour={
                  p === livePeriod ? 'motm-tile-live' : p === focusPeriod ? 'motm-tile-done' : undefined
                }
                // A gold border is the whole marker for the period in progress: a
                // badge and an "in progress" line both wrapped onto second lines
                // at 390px and knocked every row of the tile out of line.
                className={`flex h-full flex-col rounded-xl border p-4 text-center transition-colors hover:border-accent ${
                  winner && isMe({ entryId: winner.entryId, name: winner.name })
                    ? 'my-team-card'
                    : `bg-surface ${
                        period.isLive
                          ? // A glow as well as the border, because every tile
                            // takes a gold border on hover: without it the live
                            // period is indistinguishable from whichever tile the
                            // cursor happens to be over.
                            'border-accent shadow-[0_0_12px_rgba(245,158,11,0.35)]'
                          : 'border-edge'
                      }`
                }`}
              >
                {/* Header: fixed row so the gameweek range aligns across every card */}
                <div className="flex h-6 items-center justify-center">
                  <span className="whitespace-nowrap font-extrabold">
                    GW {period.startGW}-{period.endGW}
                  </span>
                </div>
                {/* Label: fixed row */}
                <div className="mt-2 h-4 text-xs uppercase tracking-wide">
                  {winner ? (
                    <span className="text-medal-gold">👑 Winner</span>
                  ) : leader ? (
                    <span className="text-muted">Leading</span>
                  ) : null}
                </div>
                {/* Name: reserve two lines so single- and two-line names occupy equal space */}
                <div
                  className={`mt-1 line-clamp-2 min-h-[2.25rem] text-sm font-bold leading-tight ${
                    (winner && isMe({ entryId: winner.entryId, name: winner.name })) ||
                    (leader && isMe({ entryId: leader.entryId, name: leader.name }))
                      ? 'my-team-name'
                      : ''
                  } ${winner || leader ? '' : 'text-faint'}`}
                >
                  {winner ? renderTwoLineName(winner.name) : leader ? renderTwoLineName(leader.name) : 'Not started'}
                </div>
                {/* Sub: fixed row, and one line in every state so it cannot wrap */}
                <div className="mt-1 h-5 whitespace-nowrap text-sm text-muted">
                  {winner || leader
                    ? margin != null
                      ? `By ${margin}`
                      : `${(winner ?? leader).netScore} pts`
                    : ''}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {openPeriod != null && periods[openPeriod] && (
        <Modal
          title={`Period ${openPeriod} · GW ${periods[openPeriod].startGW}-${periods[openPeriod].endGW}`}
          onClose={() => setOpenPeriod(null)}
          anchor="modal-motm-period"
          wide
        >
          <div data-tour="motm-rankings">
            <DataTable
              columns={rankingColumns}
              rows={periods[openPeriod].rankings ?? []}
              rowKey={(r) => r.entryId ?? r.name}
              rowRef={(r) => ({ entryId: r.entryId, name: r.name })}
              rowClass={(_r, i) => (i === 0 && periods[openPeriod].periodComplete ? 'winner-row' : '')}
            />
          </div>
        </Modal>
      )}
    </main>
  );
}
