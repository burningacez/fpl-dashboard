'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from 'react';
import { useApi } from '@/hooks/useApi';
import { useMyTeam } from '@/components/providers';
import { isMyTeam } from '@/lib/identity';
import { Card, PageHeader, DataTable, LoadingBlock, ErrorBlock, type Column } from '@/components/ui';

function formatImpact(val: number): string {
  return val > 0 ? `+${val}` : `${val}`;
}

const HIGHLIGHTS: { key: string; label: string; pick: (m: any[]) => any; value: (m: any) => string; detail: (m: any) => string }[] = [
  { key: 'tinkering', label: 'Best Tinkerer', pick: (m) => [...m].sort((a, b) => b.tinkering.netImpact - a.tinkering.netImpact)[0], value: (m) => formatImpact(m.tinkering.netImpact), detail: (m) => `Net impact over ${m.tinkering.gwCount} GWs` },
  { key: 'captain', label: 'Captain King', pick: (m) => [...m].sort((a, b) => b.captain.totalPoints - a.captain.totalPoints)[0], value: (m) => `${m.captain.totalPoints} pts`, detail: (m) => `Avg ${m.captain.avgPoints} per GW` },
  { key: 'consistent', label: 'Most Consistent', pick: (m) => [...m].sort((a, b) => a.consistency.stdDev - b.consistency.stdDev)[0], value: (m) => m.consistency.stdDev.toFixed(1), detail: () => 'Lowest std deviation' },
  { key: 'bench', label: 'Most Bench Pts', pick: (m) => [...m].sort((a, b) => b.benchPoints.total - a.benchPoints.total)[0], value: (m) => `${m.benchPoints.total} pts`, detail: (m) => `${m.benchPoints.perGW} per GW wasted` },
  { key: 'streak', label: 'Longest Hot Streak', pick: (m) => [...m].sort((a, b) => b.streaks.longestAboveAvg - a.streaks.longestAboveAvg)[0], value: (m) => `${m.streaks.longestAboveAvg} GWs`, detail: () => 'Consecutive GWs above avg' },
  { key: 'above-avg', label: 'Most Above Avg', pick: (m) => [...m].sort((a, b) => b.streaks.aboveAvgCount - a.streaks.aboveAvgCount)[0], value: (m) => `${m.streaks.aboveAvgCount}/${m.streaks.totalGWs}`, detail: () => 'GWs at or above league avg' },
];

export default function AnalyticsPage() {
  const { data, loading, error } = useApi<any>('/api/analytics');
  const { me } = useMyTeam();
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 }>({ col: 'totalPoints', dir: -1 });

  const managers: any[] = data?.managers ?? [];
  const hasTinkering = managers.some((m) => m.tinkering?.gwCount > 0);

  const sortFns: Record<string, (a: any, b: any) => number> = {
    rank: (a, b) => a.rank - b.rank,
    totalPoints: (a, b) => a.totalPoints - b.totalPoints,
    tinkering: (a, b) => a.tinkering.netImpact - b.tinkering.netImpact,
    captainPts: (a, b) => a.captain.totalPoints - b.captain.totalPoints,
    benchPts: (a, b) => a.benchPoints.total - b.benchPoints.total,
    consistency: (a, b) => a.consistency.stdDev - b.consistency.stdDev,
    aboveAvg: (a, b) => a.streaks.aboveAvgCount - b.streaks.aboveAvgCount,
    transfers: (a, b) => a.transfers.total - b.transfers.total,
    hitCost: (a, b) => a.transfers.hitCost - b.transfers.hitCost,
  };

  const sorted = useMemo(() => {
    const fn = sortFns[sort.col] ?? sortFns.totalPoints;
    return [...managers].sort((a, b) => fn(a, b) * sort.dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [managers, sort]);

  const columns: Column<any>[] = [
    { key: 'rank', header: '#', render: (m) => <span className={m.rank <= 3 ? `rank-${m.rank}` : ''}>{m.rank}</span> },
    {
      key: 'name',
      header: 'Manager',
      render: (m) => (
        <div>
          <span className={`font-bold ${isMyTeam(me, { entryId: m.entryId, name: m.name }) ? 'my-team-name' : ''}`}>{m.name}</span>
          <div className="text-xs text-muted">{m.team}</div>
        </div>
      ),
    },
    { key: 'totalPoints', header: 'Pts', align: 'right', render: (m) => <strong>{m.totalPoints}</strong> },
    ...(hasTinkering
      ? [{
          key: 'tinkering',
          header: 'Tinkering',
          align: 'right' as const,
          render: (m: any) => (
            <strong className={m.tinkering.netImpact > 0 ? 'text-positive' : m.tinkering.netImpact < 0 ? 'text-negative' : ''}>
              {formatImpact(m.tinkering.netImpact)}
            </strong>
          ),
        }]
      : []),
    { key: 'captainPts', header: 'Capt Pts', align: 'right', render: (m) => m.captain.totalPoints },
    { key: 'captainBlanks', header: 'Capt Blanks', align: 'right', render: (m) => <>{m.captain.blanks}<span className="text-faint">/{m.captain.gwCount}</span></> },
    { key: 'benchPts', header: 'Bench Wasted', align: 'right', render: (m) => <span className="text-negative">{m.benchPoints.total}</span> },
    { key: 'consistency', header: 'Consistency', align: 'right', render: (m) => m.consistency.stdDev },
    { key: 'aboveAvg', header: 'Above Avg', align: 'right', render: (m) => <>{m.streaks.aboveAvgCount}<span className="text-faint">/{m.streaks.totalGWs}</span></> },
    { key: 'hotStreak', header: 'Hot', align: 'right', render: (m) => m.streaks.longestAboveAvg },
    { key: 'coldStreak', header: 'Cold', align: 'right', render: (m) => m.streaks.longestBelowAvg },
    { key: 'transfers', header: 'Transfers', align: 'right', render: (m) => m.transfers.total },
    { key: 'hitCost', header: 'Hit Cost', align: 'right', render: (m) => (m.transfers.hitCost > 0 ? <span className="text-negative">-{m.transfers.hitCost}</span> : <span className="text-faint">0</span>) },
  ];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <PageHeader title="Analytics" subtitle="Season trends and manager statistics" />
      {loading && <LoadingBlock />}
      {error && <ErrorBlock message={error} />}
      {data?.error && <Card><p className="text-muted">{data.error}</p></Card>}
      {managers.length > 0 && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {HIGHLIGHTS.filter((h) => h.key !== 'tinkering' || hasTinkering).map((h) => {
              const m = h.pick(managers);
              if (!m) return null;
              return (
                <Card key={h.key} highlightMe={isMyTeam(me, { name: m.name })}>
                  <div className="text-xs font-bold uppercase tracking-wide text-muted">{h.label}</div>
                  <div className="mt-0.5 text-2xl font-extrabold text-accent">{h.value(m)}</div>
                  <div className={`font-semibold ${isMyTeam(me, { name: m.name }) ? 'my-team-name' : ''}`}>{m.name}</div>
                  <div className="text-xs text-muted">{h.detail(m)}</div>
                </Card>
              );
            })}
          </div>

          <div className="mb-2 flex flex-wrap gap-2 text-xs text-muted">
            <span>Sort:</span>
            {['totalPoints', 'tinkering', 'captainPts', 'benchPts', 'consistency', 'transfers'].filter((c) => c !== 'tinkering' || hasTinkering).map((c) => (
              <button
                key={c}
                onClick={() => setSort((s) => ({ col: c, dir: s.col === c ? (s.dir === 1 ? -1 : 1) : -1 }))}
                className={`rounded px-2 py-0.5 ${sort.col === c ? 'bg-accent-soft text-accent' : 'hover:bg-raised'}`}
              >
                {c}
                {sort.col === c ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
              </button>
            ))}
          </div>

          <DataTable columns={columns} rows={sorted} rowKey={(m) => m.entryId ?? m.name} rowRef={(m) => ({ entryId: m.entryId, name: m.name })} />

          <p className="mt-3 text-sm text-muted">
            GW{data.currentGW} · {data.completedGWs} gameweeks completed
          </p>
        </>
      )}
    </main>
  );
}
