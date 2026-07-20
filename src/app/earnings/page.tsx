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

function money(v: number): string {
  const sign = v < 0 ? '-' : '';
  return `${sign}£${Math.abs(v)}`;
}

export default function EarningsPage() {
  const { data, loading, error } = useApi<any>('/api/earnings');
  const managers: any[] = data?.managers ?? [];

  const columns: Column<any>[] = [
    { key: 'manager', header: 'Manager', render: (m) => <ManagerCell name={m.name} team={m.team} refOverride={{ entryId: m.entryId }} /> },
    { key: 'losses', header: 'Weekly Losses', align: 'right', render: (m) => <>{m.weeklyLosses}<span className="text-faint"> ({money(-m.weeklyLossesCost)})</span></> },
    { key: 'motm', header: 'MotM', align: 'right', render: (m) => <>{m.motmWins}<span className="text-positive"> ({money(m.motmEarnings)})</span></> },
    { key: 'league', header: 'League', align: 'right', render: (m) => (m.leagueFinish ? <span className="text-positive">{money(m.leagueFinish)}</span> : <span className="text-faint">–</span>) },
    { key: 'paid', header: 'Paid In', align: 'right', render: (m) => <span className="text-negative">{money(-m.totalPaid)}</span> },
    { key: 'earned', header: 'Earned', align: 'right', render: (m) => <span className="text-positive">{money(m.totalEarnings)}</span> },
    {
      key: 'net',
      header: 'Net',
      align: 'right',
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
        <DataTable columns={columns} rows={managers} rowKey={(m) => m.entryId ?? m.name} rowRef={(m) => ({ entryId: m.entryId, name: m.name })} />
      )}
    </main>
  );
}
