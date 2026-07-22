'use client';

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Card, ErrorBlock, LoadingBlock, PageHeader } from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { LineChart } from '@/components/charts/LineChart';
import { useMyTeam, useSeason } from '@/components/providers';
import { ArchivedUnavailable } from '@/components/layout/ArchivedUnavailable';

/**
 * Head to Head — port of legacy/h2h.html.
 *
 * Manager 1 is amber (accent), manager 2 is green (positive) — replaces the
 * legacy green/pink pairing with design-system tokens.
 *
 * Deliberate deviations from legacy (per spec):
 *  - the logged-in user's own <option> is labelled "(You)"
 *  - with no ?m1/?m2 URL params, manager 1 pre-selects to the logged-in user
 *  - the two Chart.js line charts (GW points, league rank history) are
 *    rendered as a single GW-by-GW table carrying the same data.
 */

const CHIP_TYPES = ['wildcard', 'freehit', 'bboost', '3xc'] as const;
const CHIP_MAP: Record<string, { name: string; abbr: string }> = {
  wildcard: { name: 'Wildcard', abbr: 'WC' },
  freehit: { name: 'Free Hit', abbr: 'FH' },
  bboost: { name: 'Bench Boost', abbr: 'BB' },
  '3xc': { name: 'Triple Cap', abbr: 'TC' },
};

// -----------------------------------------------------------------------------
// Manager colouring
// -----------------------------------------------------------------------------
//
// Each of the two manager slots is coloured by identity + result rather than a
// fixed left/right pairing:
//  - the logged-in manager (whichever slot they occupy) is always the teal
//    "you" identity colour used across the app;
//  - any other manager is green if they win the head-to-head, amber otherwise.
// Before a comparison has loaded (or on an exact tie) we fall back to the
// legacy left-amber / right-green pairing so the two slots stay distinct.

type ColorKind = 'me' | 'positive' | 'accent';

// Full literal class names so Tailwind picks them up during its source scan.
const KIND_TEXT: Record<ColorKind, string> = {
  me: 'text-me',
  positive: 'text-positive',
  accent: 'text-accent',
};
const KIND_BG: Record<ColorKind, string> = {
  me: 'bg-me',
  positive: 'bg-positive',
  accent: 'bg-accent',
};
const KIND_CHART: Record<ColorKind, string> = {
  me: 'var(--my-team)',
  positive: 'var(--positive)',
  accent: 'var(--accent)',
};

/** 1 → manager 1 wins the H2H, 2 → manager 2, 0 → undetermined / tie. */
function h2hWinner(data: any): 0 | 1 | 2 {
  const { headToHead, totals } = data;
  if (headToHead.m1Wins !== headToHead.m2Wins) return headToHead.m1Wins > headToHead.m2Wins ? 1 : 2;
  if (totals.m1 !== totals.m2) return totals.m1 > totals.m2 ? 1 : 2;
  return 0;
}

function h2hColorKinds(
  m1EntryId: number | string | undefined,
  m2EntryId: number | string | undefined,
  myEntryId: number | undefined,
  winner: 0 | 1 | 2,
): [ColorKind, ColorKind] {
  const isMe = (id: number | string | undefined) =>
    myEntryId != null && id != null && String(id) === String(myEntryId);
  const kind = (id: number | string | undefined, slot: 1 | 2): ColorKind => {
    if (isMe(id)) return 'me';
    if (winner === 0) return slot === 1 ? 'accent' : 'positive'; // undetermined / tie
    return winner === slot ? 'positive' : 'accent'; // green winner, amber loser
  };
  return [kind(m1EntryId, 1), kind(m2EntryId, 2)];
}

// -----------------------------------------------------------------------------
// Small pieces
// -----------------------------------------------------------------------------

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-4 text-xs font-bold uppercase tracking-wide text-muted">{children}</h3>;
}

/** Legacy statRow(): winner (higher, or lower when lowerIsBetter) renders larger. */
function StatRow({
  v1,
  label,
  v2,
  n1,
  n2,
  lowerIsBetter = false,
  c1 = 'text-accent',
  c2 = 'text-positive',
}: {
  v1: React.ReactNode;
  label: string;
  v2: React.ReactNode;
  n1?: number;
  n2?: number;
  lowerIsBetter?: boolean;
  c1?: string;
  c2?: string;
}) {
  const a = n1 !== undefined ? n1 : typeof v1 === 'number' ? v1 : parseFloat(String(v1));
  const b = n2 !== undefined ? n2 : typeof v2 === 'number' ? v2 : parseFloat(String(v2));
  let w1 = false;
  let w2 = false;
  if (!isNaN(a) && !isNaN(b) && a !== b) {
    w1 = lowerIsBetter ? a < b : a > b;
    w2 = !w1;
  }
  // NB: the non-winning side uses `text-[1rem]`, not `text-base`. This theme
  // defines a `--color-base` token, so Tailwind resolves `text-base` to
  // `color: var(--bg)` (near-black) rather than a font size — which silently
  // overrode the amber `text-accent` value and rendered losing stats as
  // invisible dark text. An explicit arbitrary size sidesteps the collision.
  return (
    <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-2 last:mb-0">
      <div className={`text-right font-bold ${c1} ${w1 ? 'text-lg' : 'text-[1rem]'}`}>{v1}</div>
      <div className="whitespace-nowrap text-center text-xs text-muted">{label}</div>
      <div className={`text-left font-bold ${c2} ${w2 ? 'text-lg' : 'text-[1rem]'}`}>{v2}</div>
    </div>
  );
}

/** Legacy getChipIcon(): status → icon text + tone classes. */
function chipIcon(chip: any): { text: React.ReactNode; cls: string; title: string } {
  if (!chip) return { text: '-', cls: 'bg-positive-soft text-positive', title: 'Available' };
  switch (chip.status) {
    case 'used':
      return { text: chip.gw, cls: 'bg-raised text-body', title: `Used GW${chip.gw}` };
    case 'expired':
      return { text: '✗', cls: 'bg-negative-soft text-negative', title: 'Expired' };
    case 'locked':
      return { text: '🔒', cls: 'bg-raised text-faint', title: 'Locked' };
    default:
      return { text: '✓', cls: 'bg-positive-soft text-positive', title: 'Available' };
  }
}

function ChipIconBox({ chip }: { chip: any }) {
  const icon = chipIcon(chip);
  return (
    <span
      title={icon.title}
      className={`inline-flex h-6 w-7 items-center justify-center rounded text-[0.65rem] font-bold ${icon.cls}`}
    >
      {icon.text}
    </span>
  );
}

function TcBadge() {
  return (
    <span className="mx-1 inline-block rounded bg-positive px-1 py-0.5 align-middle text-[0.55rem] font-bold text-accent-fg">
      TC
    </span>
  );
}

// -----------------------------------------------------------------------------
// Comparison view (legacy renderComparison)
// -----------------------------------------------------------------------------

function Comparison({ data, myEntryId }: { data: any; myEntryId?: number }) {
  const { manager1: m1, manager2: m2, headToHead, totals, captains } = data;
  const totalGWs = headToHead.m1Wins + headToHead.m2Wins + headToHead.draws;
  const m1Pct = totalGWs > 0 ? (headToHead.m1Wins / totalGWs) * 100 : 0;
  const drawPct = totalGWs > 0 ? (headToHead.draws / totalGWs) * 100 : 0;
  const m2Pct = totalGWs > 0 ? (headToHead.m2Wins / totalGWs) * 100 : 0;

  const rank1 = new Map<number, number>((data.rankHistory?.m1 || []).map((r: any) => [r.gw, r.rank]));
  const rank2 = new Map<number, number>((data.rankHistory?.m2 || []).map((r: any) => [r.gw, r.rank]));

  // Identity/result-based colours for the two slots (see h2hColorKinds).
  const [k1, k2] = h2hColorKinds(m1.entryId, m2.entryId, myEntryId, h2hWinner(data));
  const t1 = KIND_TEXT[k1];
  const t2 = KIND_TEXT[k2];
  const bg1 = KIND_BG[k1];
  const bg2 = KIND_BG[k2];
  const chart1 = KIND_CHART[k1];
  const chart2 = KIND_CHART[k2];

  return (
    <div className="flex flex-col gap-6">
      {/* Scoreboard */}
      <Card className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 !p-6">
        <div className="text-right">
          <div className="text-lg font-bold sm:text-xl">{m1.name}</div>
          <div className="text-xs text-muted">{m1.team}</div>
        </div>
        <div className="px-3 text-center sm:px-6">
          <div className="text-2xl font-extrabold tracking-widest sm:text-3xl">
            <span className={t1}>{totals.m1}</span>
            <span className="mx-1.5 text-faint">-</span>
            <span className={t2}>{totals.m2}</span>
          </div>
          <div className="mt-1 text-xs text-muted">
            {headToHead.m1Wins}W {headToHead.draws}D {headToHead.m2Wins}L
          </div>
        </div>
        <div className="text-left">
          <div className="text-lg font-bold sm:text-xl">{m2.name}</div>
          <div className="text-xs text-muted">{m2.team}</div>
        </div>
      </Card>

      {/* GW Record bar */}
      <Card>
        <CardTitle>GW Record</CardTitle>
        <div className="flex h-7 overflow-hidden rounded-md bg-raised">
          {m1Pct > 0 && (
            <div
              className={`flex items-center justify-center ${bg1} text-xs font-bold text-accent-fg transition-[width] duration-500`}
              style={{ width: `${m1Pct}%` }}
            >
              {headToHead.m1Wins}
            </div>
          )}
          {drawPct > 0 && (
            <div
              className="flex items-center justify-center bg-edge-strong text-xs font-bold text-body transition-[width] duration-500"
              style={{ width: `${drawPct}%` }}
            >
              {headToHead.draws}
            </div>
          )}
          {m2Pct > 0 && (
            <div
              className={`flex items-center justify-center ${bg2} text-xs font-bold text-accent-fg transition-[width] duration-500`}
              style={{ width: `${m2Pct}%` }}
            >
              {headToHead.m2Wins}
            </div>
          )}
        </div>
        <div className="mt-1.5 flex justify-between text-xs text-muted">
          <span className={t1}>{m1.name}</span>
          <span>Draws</span>
          <span className={t2}>{m2.name}</span>
        </div>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Key stats */}
        <Card>
          <CardTitle>Season Stats</CardTitle>
          <StatRow v1={totals.m1} label="Total Points" v2={totals.m2} c1={t1} c2={t2} />
          <StatRow v1={data.form.m1.avg} label="Form (Last 5)" v2={data.form.m2.avg} c1={t1} c2={t2} />
          <StatRow
            v1={`${data.bestGW.m1.points} (GW${data.bestGW.m1.gw})`}
            label="Best GW"
            v2={`${data.bestGW.m2.points} (GW${data.bestGW.m2.gw})`}
            n1={data.bestGW.m1.points}
            n2={data.bestGW.m2.points}
            c1={t1}
            c2={t2}
          />
          <StatRow
            v1={`${data.worstGW.m1.points} (GW${data.worstGW.m1.gw})`}
            label="Worst GW"
            v2={`${data.worstGW.m2.points} (GW${data.worstGW.m2.gw})`}
            n1={data.worstGW.m1.points}
            n2={data.worstGW.m2.points}
            lowerIsBetter
            c1={t1}
            c2={t2}
          />
        </Card>

        {/* Transfer stats */}
        <Card>
          <CardTitle>Transfers</CardTitle>
          <StatRow v1={data.transfers.m1.total} label="Total Made" v2={data.transfers.m2.total} c1={t1} c2={t2} />
          <StatRow
            v1={data.transfers.m1.cost > 0 ? `-${data.transfers.m1.cost}` : '0'}
            label="Hit Cost"
            v2={data.transfers.m2.cost > 0 ? `-${data.transfers.m2.cost}` : '0'}
            n1={data.transfers.m1.cost}
            n2={data.transfers.m2.cost}
            lowerIsBetter
            c1={t1}
            c2={t2}
          />
          <StatRow v1={data.benchPoints.m1} label="Bench Points" v2={data.benchPoints.m2} c1={t1} c2={t2} />
        </Card>
      </div>

      {/* Points + rank trajectory charts (legacy renderPointsChart/renderRankChart) */}
      <Card>
        <CardTitle>GW Points</CardTitle>
        <LineChart
          series={[
            { label: m1.name, color: chart1, points: data.gwComparison.map((g: any) => ({ x: g.gw, y: g.m1Points })) },
            { label: m2.name, color: chart2, points: data.gwComparison.map((g: any) => ({ x: g.gw, y: g.m2Points })) },
          ]}
        />
      </Card>
      <Card>
        <CardTitle>League Rank</CardTitle>
        <LineChart
          invertY
          yLabel="rank 1 at top"
          series={[
            { label: m1.name, color: chart1, points: (data.rankHistory?.m1 ?? []).map((r: any) => ({ x: r.gw, y: r.rank })) },
            { label: m2.name, color: chart2, points: (data.rankHistory?.m2 ?? []).map((r: any) => ({ x: r.gw, y: r.rank })) },
          ]}
        />
      </Card>

      {/* GW-by-GW comparison table */}
      <Card>
        <CardTitle>GW-by-GW Comparison</CardTitle>
        <div className="max-h-96 overflow-y-auto overflow-x-auto rounded-lg border border-edge">
          <table className="data-table">
            <thead>
              <tr>
                <th className="text-center">GW</th>
                <th className="text-center">
                  <span className={t1}>{m1.name}</span>
                </th>
                <th className="text-center">Rank</th>
                <th className="text-center">
                  <span className={t2}>{m2.name}</span>
                </th>
                <th className="text-center">Rank</th>
              </tr>
            </thead>
            <tbody>
              {data.gwComparison.map((g: any) => (
                <tr key={g.gw}>
                  <td className="text-center text-muted">GW{g.gw}</td>
                  <td className={`text-center ${t1} ${g.m1Points > g.m2Points ? 'font-bold' : ''}`}>
                    {g.m1Points}
                  </td>
                  <td className="text-center text-muted">{rank1.get(g.gw) ?? '-'}</td>
                  <td className={`text-center ${t2} ${g.m2Points > g.m1Points ? 'font-bold' : ''}`}>
                    {g.m2Points}
                  </td>
                  <td className="text-center text-muted">{rank2.get(g.gw) ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Captains */}
      <Card>
        <CardTitle>Captain Comparison</CardTitle>
        <div className="mb-4 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className={`text-right font-bold ${t1} ${captains.m1Total >= captains.m2Total ? 'text-lg' : ''}`}>
            {captains.m1Total} pts
          </div>
          <div className="text-center text-xs text-muted">Total Captain Pts</div>
          <div className={`text-left font-bold ${t2} ${captains.m2Total >= captains.m1Total ? 'text-lg' : ''}`}>
            {captains.m2Total} pts
          </div>
        </div>
        <div className="mb-4 text-center text-xs text-muted">
          Same Captain {captains.sameCaptainCount}/{captains.totalGWs} GWs
        </div>
        {captains.data.length === 0 ? (
          <div className="text-sm text-faint">No captain data available</div>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className={`border-b border-edge p-1.5 text-right text-[0.7rem] font-bold uppercase ${t1}`}>
                    {m1.name}
                  </th>
                  <th className="border-b border-edge p-1.5 text-center text-[0.7rem] font-bold uppercase text-muted">
                    GW
                  </th>
                  <th className={`border-b border-edge p-1.5 text-left text-[0.7rem] font-bold uppercase ${t2}`}>
                    {m2.name}
                  </th>
                </tr>
              </thead>
              <tbody>
                {captains.data.map((gw: any) => (
                  <tr key={gw.gw}>
                    <td
                      className={`border-b border-edge/50 p-1.5 text-right ${t1} ${gw.same ? 'opacity-60' : ''} ${
                        gw.m1.points > gw.m2.points ? 'font-bold' : ''
                      }`}
                    >
                      {gw.m1.chip === '3xc' && <TcBadge />}
                      {gw.m1.name} ({gw.m1.points})
                    </td>
                    <td className="border-b border-edge/50 p-1.5 text-center text-muted">GW{gw.gw}</td>
                    <td
                      className={`border-b border-edge/50 p-1.5 text-left ${t2} ${gw.same ? 'opacity-60' : ''} ${
                        gw.m2.points > gw.m1.points ? 'font-bold' : ''
                      }`}
                    >
                      {gw.m2.name} ({gw.m2.points})
                      {gw.m2.chip === '3xc' && <TcBadge />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Chips */}
      <Card>
        <CardTitle>Chip Usage</CardTitle>
        <div className="flex flex-col gap-3">
          {CHIP_TYPES.map((chipType) => {
            const info = CHIP_MAP[chipType];
            return (
              <div key={chipType} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
                <div className="flex items-center justify-end gap-1">
                  <ChipIconBox chip={data.chips.m1.firstHalf[chipType]} />
                  <span className="mx-0.5 h-4 w-px bg-edge-strong" />
                  <ChipIconBox chip={data.chips.m1.secondHalf[chipType]} />
                </div>
                <div className="flex flex-col items-center gap-0.5">
                  <span
                    title={info.name}
                    className="inline-flex h-6 w-8 items-center justify-center rounded-md border border-edge bg-raised text-[0.65rem] font-bold text-body"
                  >
                    {info.abbr}
                  </span>
                  <div className="flex justify-center gap-5 text-[0.55rem] text-faint">
                    <span>H1</span>
                    <span>H2</span>
                  </div>
                </div>
                <div className="flex items-center justify-start gap-1">
                  <ChipIconBox chip={data.chips.m2.firstHalf[chipType]} />
                  <span className="mx-0.5 h-4 w-px bg-edge-strong" />
                  <ChipIconBox chip={data.chips.m2.secondHalf[chipType]} />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Page (selector bar + fetch orchestration, legacy init/populateSelectors/compare)
// -----------------------------------------------------------------------------

function H2HInner() {
  const searchParams = useSearchParams();
  const { me, members } = useMyTeam();

  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => a.name.localeCompare(b.name)),
    [members],
  );

  // Same URL params as legacy: ?m1=ENTRY_ID&m2=ENTRY_ID
  const [m1, setM1] = useState<string>(searchParams.get('m1') ?? '');
  const [m2, setM2] = useState<string>(searchParams.get('m2') ?? '');

  // NEW: with no URL params, pre-select manager 1 to the logged-in user.
  const didPreselect = useRef(false);
  useEffect(() => {
    if (didPreselect.current || !me) return;
    didPreselect.current = true;
    if (!searchParams.get('m1') && !searchParams.get('m2')) {
      setM1((cur) => cur || String(me.entryId));
    }
  }, [me, searchParams]);

  // Keep the URL shareable (legacy history.replaceState behaviour).
  useEffect(() => {
    if (m1 && m2 && m1 !== m2) {
      const url = new URL(window.location.href);
      url.searchParams.set('m1', m1);
      url.searchParams.set('m2', m2);
      window.history.replaceState({}, '', url);
    }
  }, [m1, m2]);

  const ready = Boolean(m1 && m2 && m1 !== m2);
  const { data, loading, error } = useApi<any>(ready ? `/api/h2h?m1=${m1}&m2=${m2}` : null);

  const youLabel = (entryId: number) => (me && me.entryId === entryId ? ' (You)' : '');

  // Match the selector dots to the colours the comparison will use. Before a
  // comparison has loaded the winner is undetermined, so the dots fall back to
  // the legacy left-amber / right-green pairing (with "you" overriding to teal).
  const winner = data && !data.error ? h2hWinner(data) : 0;
  const [dot1, dot2] = h2hColorKinds(m1, m2, me?.entryId, winner);

  const selectCls =
    'w-full min-w-0 max-w-52 cursor-pointer rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-body focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <>
      {/* Selector bar */}
      <Card className="mb-6">
        <div className="flex items-center justify-center gap-2 sm:gap-3">
          <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${KIND_BG[dot1]}`} aria-hidden />
            <select
              aria-label="Manager 1"
              className={selectCls}
              value={m1}
              onChange={(e) => setM1(e.target.value)}
              disabled={sortedMembers.length === 0}
            >
              <option value="">Select manager...</option>
              {sortedMembers.map((m) => (
                <option key={m.entryId} value={String(m.entryId)}>
                  {m.name}
                  {youLabel(m.entryId)}
                </option>
              ))}
            </select>
          </div>
          <span className="shrink-0 text-xs font-bold uppercase tracking-widest text-muted">vs</span>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <select
              aria-label="Manager 2"
              className={selectCls}
              value={m2}
              onChange={(e) => setM2(e.target.value)}
              disabled={sortedMembers.length === 0}
            >
              <option value="">Select manager...</option>
              {sortedMembers.map((m) => (
                <option key={m.entryId} value={String(m.entryId)}>
                  {m.name}
                  {youLabel(m.entryId)}
                </option>
              ))}
            </select>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${KIND_BG[dot2]}`} aria-hidden />
          </div>
        </div>
      </Card>

      {!ready && (
        <p className="py-10 text-center text-muted">Select two managers to compare.</p>
      )}
      {ready && loading && <LoadingBlock label="Loading comparison…" />}
      {ready && error && <ErrorBlock message={error} />}
      {ready && !loading && !error && data?.error && <ErrorBlock message={data.error} />}
      {ready && !loading && !error && data && !data.error && (
        <Comparison data={data} myEntryId={me?.entryId} />
      )}
    </>
  );
}

export default function H2HPage() {
  const { season } = useSeason();
  if (season !== null) return <ArchivedUnavailable title="Head to Head" />;
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <PageHeader title="Head to Head" subtitle="Manager Comparison" />
      <Suspense fallback={<LoadingBlock />}>
        <H2HInner />
      </Suspense>
    </main>
  );
}
