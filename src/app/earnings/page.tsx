'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Earnings / P&L — port of legacy/earnings.html.
 * Endpoint /api/earnings → { leagueName, managers[], seasonComplete, completedGWs }.
 * Each manager: { name, team, entryId, weeklyLosses, weeklyLossesCost, motmWins,
 * motmEarnings, leagueFinish, cupWin, totalPaid, totalEarnings, netEarnings }.
 *
 * Every figure here is pot- or prize-derived, so the whole page stays on
 * cashConfirmed (season-config.ts): until the entrant list is final every £
 * value renders as a dash, while the counts (weekly losses, MotM wins) still
 * show. The Rules page publishes the entry fee and weekly fine earlier, off
 * feesConfirmed — those settle before entries close.
 */
import { useCallback, useState } from 'react';
import { DataTable, ManagerCell, PageHeader, LoadingBlock, EmptyBlock, ErrorBlock, type Column } from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useMyTeam, useSeason } from '@/components/providers';
import {
  DEFAULT_SEASON,
  getSeasonConfig,
  motmPeriodCount,
  motmTotalPrize,
  totalPot,
  type SeasonConfig,
} from '@/lib/season-config';
import { TourButton, useTourHost } from '@/components/tour/TourProvider';
import { buildEarningsTour } from './earningsTour';
// Type-only, so the demo payload stays behind the dynamic import in enterDemo.
import type { DemoEarningsData } from './demoEarnings';

function formatMoney(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}£${Math.abs(v)}`;
}

// League money rules come from the selected season's config entry.
function payoutStructure(cfg: SeasonConfig, cash: (v: number) => string): { group: string; items: [string, string][] }[] {
  return [
    {
      group: 'League',
      items: cfg.prizes.league.map((amount, i) => [
        ['1st', '2nd', '3rd'][i] ?? `${i + 1}th`,
        cash(amount),
      ]),
    },
    { group: 'Cup', items: [['Winner', cash(cfg.prizes.cup)]] },
    {
      group: 'MotM',
      items: [
        ['Per period', cash(cfg.prizes.motmPerPeriod)],
        [`${motmPeriodCount(cfg)} periods`, cash(motmTotalPrize(cfg))],
      ],
    },
  ];
}

function PotHeader({ paidOut, cfg, cash }: { paidOut: number; cfg: SeasonConfig; cash: (v: number) => string }) {
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-[auto_1fr]">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-edge bg-surface px-5 py-4 text-center" data-tour="earnings-pot">
          <div className="text-2xl font-extrabold text-accent">{cash(totalPot(cfg))}</div>
          <div className="text-[0.7rem] font-bold uppercase tracking-wide text-muted">Total Pot</div>
          <div className="mt-0.5 text-[0.65rem] text-faint">
            {cfg.cashConfirmed
              ? `${cfg.entrants} × £${cfg.entryFee} + ${cfg.totalWeeks} × £${cfg.weeklyLoserFine}`
              : 'Confirmed before the season starts'}
          </div>
        </div>
        <div className="rounded-xl border border-edge bg-surface px-5 py-4 text-center" data-tour="earnings-paid-out">
          <div className="text-2xl font-extrabold text-positive">{cash(paidOut)}</div>
          <div className="text-[0.7rem] font-bold uppercase tracking-wide text-muted">Paid Out</div>
          <div className="mt-0.5 text-[0.65rem] text-faint">Prizes so far</div>
        </div>
      </div>
      <div className="rounded-xl border border-edge bg-surface px-5 py-4" data-tour="earnings-payouts">
        <div className="mb-2 text-[0.7rem] font-bold uppercase tracking-wide text-muted">Payout Structure</div>
        <div className="grid grid-cols-3 gap-4">
          {payoutStructure(cfg, cash).map(({ group, items }) => (
            <div key={group}>
              <h4 className="mb-1 text-xs font-bold text-accent">{group}</h4>
              {items.map(([place, amount]) => (
                <div key={place} className="flex justify-between text-xs">
                  <span className="text-muted">{place}</span>
                  <span className="font-semibold">{amount}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function EarningsPage() {
  const { data: dataApi, loading, error, empty } = useApi<any>('/api/earnings');
  const { me, features } = useMyTeam();
  const { season, currentSeason } = useSeason();
  const seasonCfg = getSeasonConfig(season ?? currentSeason) ?? getSeasonConfig(DEFAULT_SEASON)!;

  // ---- walkthrough demo mode (see demoEarnings.ts) ----
  // Nothing on this page fetches on open, so demo mode is purely a render-time
  // override. It replaces the season's money rules as well as the payload: with
  // this season's pot undeclared, every £ value on the real page is a dash, and
  // Net cannot be explained with dashes.
  const [demo, setDemo] = useState<DemoEarningsData | null>(null);
  const data = demo ? demo.earnings : dataApi;
  const cfg = demo ? demo.config : seasonCfg;
  const managers: any[] = data?.managers ?? [];

  const cash = (v: number) => (cfg.cashConfirmed ? formatMoney(v) : '—');
  const cashCell = (v: number, cls: string) =>
    cfg.cashConfirmed ? <span className={cls}>{formatMoney(v)}</span> : <span className="text-faint">—</span>;

  const columns: Column<any>[] = [
    { key: 'manager', header: 'Manager', render: (m) => <ManagerCell name={m.name} team={m.team} refOverride={{ entryId: m.entryId, name: m.name }} /> },
    { key: 'losses', header: 'Weekly Losses', align: 'center', render: (m) => <>{m.weeklyLosses}{cfg.cashConfirmed && <span className="text-faint"> ({formatMoney(-m.weeklyLossesCost)})</span>}</> },
    { key: 'motm', header: 'MotM', align: 'center', render: (m) => <>{m.motmWins}{cfg.cashConfirmed && <span className="text-positive"> ({formatMoney(m.motmEarnings)})</span>}</> },
    { key: 'league', header: 'League', align: 'center', render: (m) => (m.leagueFinish ? cashCell(m.leagueFinish, 'text-positive') : <span className="text-faint">–</span>) },
    { key: 'cup', header: 'Cup', align: 'center', render: (m) => (m.cupWin ? cashCell(m.cupWin, 'text-positive') : <span className="text-faint">–</span>) },
    { key: 'paid', header: 'Paid In', align: 'center', render: (m) => cashCell(-m.totalPaid, 'text-negative') },
    { key: 'earned', header: 'Earned', align: 'center', render: (m) => cashCell(m.totalEarnings, 'text-positive') },
    {
      key: 'net',
      header: 'Net',
      align: 'center',
      render: (m) =>
        cfg.cashConfirmed ? (
          <span className={`font-extrabold ${m.netEarnings > 0 ? 'text-positive' : m.netEarnings < 0 ? 'text-negative' : ''}`}>
            {formatMoney(m.netEarnings)}
          </span>
        ) : (
          <span className="text-faint">—</span>
        ),
    },
  ];

  // ---- walkthrough ----------------------------------------------------------
  const enterDemo = useCallback(async () => {
    const mod = await import('./demoEarnings');
    setDemo(
      mod.buildDemoEarnings(
        me ? { entryId: me.entryId, name: me.name, team: me.team } : null,
        dataApi?.leagueName ?? 'Example League',
        seasonCfg,
      ),
    );
  }, [me, dataApi?.leagueName, seasonCfg]);

  const exitDemo = useCallback(() => setDemo(null), []);

  useTourHost(
    buildEarningsTour({
      // Preview-gated server-side, same flag as the other walkthroughs.
      ready: Boolean(dataApi) && !error && !empty && features.walkthroughs,
      hasRows: managers.length > 0,
      cashConfirmed: seasonCfg.cashConfirmed,
      onStart: enterDemo,
      onEnd: exitDemo,
    }),
  );

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <div className="flex items-start justify-between gap-3">
        <PageHeader
          title={data?.leagueName ?? 'Earnings'}
          subtitle={
            data?.seasonComplete
              ? 'Final season P&L'
              : `Provisional P&L${data ? ` · ${data.completedGWs} GWs completed` : ''}. League prizes settle at season end`
          }
        />
        <TourButton label="See demo" title="See a guided demo of this page" className="mt-1" />
      </div>

      {demo && (
        <p className="mb-4 rounded-lg border border-accent/40 bg-accent-soft px-3 py-2 text-xs font-semibold text-accent">
          Example data. A finished season for a league of six, with the pot settled, so every
          figure has a value. Your real league comes back when the tour ends.
        </p>
      )}
      {loading && <LoadingBlock label="Loading earnings…" />}
      {error && <ErrorBlock message={error} />}
      {empty && <EmptyBlock message={empty} />}
      {data?.error && <ErrorBlock message={data.error} />}
      {data && !data.error && managers.length === 0 && (
        <EmptyBlock message="No earnings to show yet. Fines and prizes appear once GW1 is complete." />
      )}
      {!cfg.cashConfirmed && !loading && !error && (
        <p className="mb-4 rounded-lg border border-edge bg-raised px-4 py-2 text-sm text-muted">
          The pot and prizes for this season can&apos;t be set until every entry is in. £ values
          will appear once the entrant list is final.
        </p>
      )}
      {managers.length > 0 && (
        <PotHeader paidOut={managers.reduce((sum, m) => sum + (m.totalEarnings ?? 0), 0)} cfg={cfg} cash={cash} />
      )}
      {managers.length > 0 && (
        <div data-tour="earnings-table">
          <DataTable columns={columns} rows={managers} rowKey={(m) => m.entryId ?? m.name} rowRef={(m) => ({ entryId: m.entryId, name: m.name })} />
        </div>
      )}
    </main>
  );
}
