'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Manager of the Month — port of legacy/motm.html.
 * Endpoint /api/motm → { leagueName, periods: {1..9}, winners[], currentGW, isLive }.
 * Each period: { rankings[], startGW, endGW, periodComplete, isLive }.
 * Ranking item: { name, team, entryId, netScore, grossScore, transfers, transferCost, highestGW }.
 */
import { useState } from 'react';
import { DataTable, ManagerCell, PageHeader, Modal, Badge, LoadingBlock, ErrorBlock, type Column } from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useMyTeam } from '@/components/providers';
import { isMyTeam } from '@/lib/identity';

export default function MotmPage() {
  const { data, loading, error } = useApi<any>('/api/motm');
  const { me } = useMyTeam();
  const [openPeriod, setOpenPeriod] = useState<number | null>(null);

  const periods: any = data?.periods ?? {};
  const periodNums = Object.keys(periods).map(Number).sort((a, b) => a - b);

  const rankingColumns: Column<any>[] = [
    { key: 'rank', header: '#', render: (_r, i) => <span className={i < 3 ? `rank-${i + 1}` : ''}>{i + 1}</span> },
    { key: 'manager', header: 'Manager', render: (r) => <ManagerCell name={r.name} team={r.team} refOverride={{ entryId: r.entryId, name: r.name }} /> },
    { key: 'net', header: 'Net', align: 'right', render: (r) => <strong>{r.netScore}</strong> },
    { key: 'gross', header: 'Gross', align: 'right', render: (r) => r.grossScore },
    { key: 'trf', header: 'Trf', align: 'right', render: (r) => <>{r.transfers}{r.transferCost > 0 && <span className="text-negative"> (-{r.transferCost})</span>}</> },
  ];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <PageHeader title={data?.leagueName ?? 'Manager of the Month'} subtitle="9 periods across the season — highest net score wins each. Tap a period for full rankings." />
      {loading && <LoadingBlock label="Loading MOTM…" />}
      {error && <ErrorBlock message={error} />}
      {data?.error && <ErrorBlock message={data.error} />}

      {periodNums.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {periodNums.map((p) => {
            const period = periods[p];
            const winner = period.periodComplete ? period.rankings?.[0] : null;
            const leader = !winner ? period.rankings?.[0] : null;
            return (
              <button
                key={p}
                onClick={() => setOpenPeriod(p)}
                className={`rounded-xl border p-4 text-left transition-colors hover:border-accent ${
                  winner && isMyTeam(me, { entryId: winner.entryId, name: winner.name })
                    ? 'my-team-card'
                    : 'border-edge bg-surface'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-extrabold">Period {p}</span>
                  <span className="text-xs text-muted">GW {period.startGW}-{period.endGW}</span>
                </div>
                {period.isLive && <Badge tone="negative">LIVE</Badge>}
                {winner ? (
                  <div className="mt-2">
                    <div className="text-xs uppercase tracking-wide text-medal-gold">👑 Winner</div>
                    <div className={`font-bold ${isMyTeam(me, { entryId: winner.entryId, name: winner.name }) ? 'my-team-name' : ''}`}>{winner.name}</div>
                    <div className="text-sm text-muted">{winner.netScore} pts</div>
                  </div>
                ) : leader ? (
                  <div className="mt-2">
                    <div className="text-xs uppercase tracking-wide text-muted">Leading</div>
                    <div className={`font-bold ${isMyTeam(me, { entryId: leader.entryId, name: leader.name }) ? 'my-team-name' : ''}`}>{leader.name}</div>
                    <div className="text-sm text-muted">{leader.netScore} pts · in progress</div>
                  </div>
                ) : (
                  <div className="mt-2 text-sm text-faint">Not started</div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {openPeriod != null && periods[openPeriod] && (
        <Modal
          title={`Period ${openPeriod} · GW ${periods[openPeriod].startGW}-${periods[openPeriod].endGW}`}
          onClose={() => setOpenPeriod(null)}
          wide
        >
          <DataTable
            columns={rankingColumns}
            rows={periods[openPeriod].rankings ?? []}
            rowKey={(r) => r.entryId ?? r.name}
            rowRef={(r) => ({ entryId: r.entryId, name: r.name })}
            rowClass={(_r, i) => (i === 0 && periods[openPeriod].periodComplete ? 'winner-row' : '')}
          />
        </Modal>
      )}
    </main>
  );
}
