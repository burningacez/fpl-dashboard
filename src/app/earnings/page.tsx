'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Earnings / P&L — port of legacy/earnings.html.
 * Endpoint /api/earnings → { leagueName, managers[], seasonComplete, completedGWs }.
 * Each manager: { name, team, entryId, weeklyLosses, weeklyLossesCost, motmWins,
 * motmEarnings, leagueFinish, cupWin, totalPaid, totalEarnings, netEarnings }.
 */
import { DataTable, ManagerCell, PageHeader, LoadingBlock, ErrorBlock, type Column } from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useSeason } from '@/components/providers';
import {
  DEFAULT_SEASON,
  getSeasonConfig,
  motmPeriodCount,
  motmTotalPrize,
  totalPot,
  type SeasonConfig,
} from '@/lib/season-config';

function money(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}£${Math.abs(v)}`;
}

// League money rules come from the selected season's config entry.
function payoutStructure(cfg: SeasonConfig): { group: string; items: [string, string][] }[] {
  return [
    {
      group: 'League',
      items: cfg.prizes.league.map((amount, i) => [
        ['1st', '2nd', '3rd'][i] ?? `${i + 1}th`,
        `£${amount}`,
      ]),
    },
    { group: 'Cup', items: [['Winner', `£${cfg.prizes.cup}`]] },
    {
      group: 'MotM',
      items: [
        ['Per period', `£${cfg.prizes.motmPerPeriod}`],
        [`${motmPeriodCount(cfg)} periods`, `£${motmTotalPrize(cfg)}`],
      ],
    },
  ];
}

function PotHeader({ paidOut, cfg }: { paidOut: number; cfg: SeasonConfig }) {
  return (
    <div className="mb-6 grid gap-3 sm:grid-cols-[auto_1fr]">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-edge bg-surface px-5 py-4 text-center">
          <div className="text-2xl font-extrabold text-accent">£{totalPot(cfg)}</div>
          <div className="text-[0.7rem] font-bold uppercase tracking-wide text-muted">Total Pot</div>
          <div className="mt-0.5 text-[0.65rem] text-faint">
            {cfg.entrants} × £{cfg.entryFee} + {cfg.totalWeeks} × £{cfg.weeklyLoserFine}
          </div>
        </div>
        <div className="rounded-xl border border-edge bg-surface px-5 py-4 text-center">
          <div className="text-2xl font-extrabold text-positive">£{paidOut}</div>
          <div className="text-[0.7rem] font-bold uppercase tracking-wide text-muted">Paid Out</div>
          <div className="mt-0.5 text-[0.65rem] text-faint">Prizes so far</div>
        </div>
      </div>
      <div className="rounded-xl border border-edge bg-surface px-5 py-4">
        <div className="mb-2 text-[0.7rem] font-bold uppercase tracking-wide text-muted">Payout Structure</div>
        <div className="grid grid-cols-3 gap-4">
          {payoutStructure(cfg).map(({ group, items }) => (
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
  const { data, loading, error } = useApi<any>('/api/earnings');
  const { season, currentSeason } = useSeason();
  const cfg = getSeasonConfig(season ?? currentSeason) ?? getSeasonConfig(DEFAULT_SEASON)!;
  const managers: any[] = data?.managers ?? [];

  const columns: Column<any>[] = [
    { key: 'manager', header: 'Manager', render: (m) => <ManagerCell name={m.name} team={m.team} refOverride={{ entryId: m.entryId, name: m.name }} /> },
    { key: 'losses', header: 'Weekly Losses', align: 'center', render: (m) => <>{m.weeklyLosses}<span className="text-faint"> ({money(-m.weeklyLossesCost)})</span></> },
    { key: 'motm', header: 'MotM', align: 'center', render: (m) => <>{m.motmWins}<span className="text-positive"> ({money(m.motmEarnings)})</span></> },
    { key: 'league', header: 'League', align: 'center', render: (m) => (m.leagueFinish ? <span className="text-positive">{money(m.leagueFinish)}</span> : <span className="text-faint">–</span>) },
    { key: 'cup', header: 'Cup', align: 'center', render: (m) => (m.cupWin ? <span className="text-positive">{money(m.cupWin)}</span> : <span className="text-faint">–</span>) },
    { key: 'paid', header: 'Paid In', align: 'center', render: (m) => <span className="text-negative">{money(-m.totalPaid)}</span> },
    { key: 'earned', header: 'Earned', align: 'center', render: (m) => <span className="text-positive">{money(m.totalEarnings)}</span> },
    {
      key: 'net',
      header: 'Net',
      align: 'center',
      render: (m) => (
        <span className={`font-extrabold ${m.netEarnings > 0 ? 'text-positive' : m.netEarnings < 0 ? 'text-negative' : ''}`}>
          {money(m.netEarnings)}
        </span>
      ),
    },
  ];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <PageHeader
        title={data?.leagueName ?? 'Earnings'}
        subtitle={
          data?.seasonComplete
            ? 'Final season P&L'
            : `Provisional P&L${data ? ` · ${data.completedGWs} GWs completed` : ''} — league prizes settle at season end`
        }
      />
      {loading && <LoadingBlock label="Loading earnings…" />}
      {error && <ErrorBlock message={error} />}
      {data?.error && <ErrorBlock message={data.error} />}
      {managers.length > 0 && (
        <PotHeader paidOut={managers.reduce((sum, m) => sum + (m.totalEarnings ?? 0), 0)} cfg={cfg} />
      )}
      {managers.length > 0 && (
        <DataTable columns={columns} rows={managers} rowKey={(m) => m.entryId ?? m.name} rowRef={(m) => ({ entryId: m.entryId, name: m.name })} />
      )}
    </main>
  );
}
