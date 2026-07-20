'use client';

import { useMemo, useState } from 'react';
import { Card, ErrorBlock, LoadingBlock, PageHeader, YouBadge } from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { useMyTeam } from '@/components/providers';
import { isMyTeam } from '@/lib/identity';

// =============================================================================
// Round helpers — ported from legacy cup.html.
// =============================================================================

const ROUND_SHORT: Record<string, string> = {
  Final: 'F',
  'Semi-Finals': 'SF',
  'Quarter-Finals': 'QF',
  'Round of 16': 'R16',
  'Round of 32': 'R32',
  'Round of 64': 'R64',
};

const shortRound = (name: string) => ROUND_SHORT[name] || name;

type RoundState = 'live' | 'complete' | 'upcoming';

function roundStatus(round: any): RoundState {
  if (round.isLive) return 'live';
  if (round.isComplete) return 'complete';
  if (round.matches.every((m: any) => m.winner != null || m.isBye)) return 'complete';
  return 'upcoming';
}

function isFinalChampionDecided(round: any): boolean {
  if (round.name !== 'Final') return false;
  const m = round.matches[0];
  return Boolean(m && m.winner != null);
}

/** Score display: live score takes precedence during a live round, else final. */
function matchScores(match: any, isLive: boolean): [string | number, string | number] {
  const s1 = isLive
    ? (match.liveScore1 ?? match.score1 ?? '—')
    : (match.score1 ?? match.liveScore1 ?? '—');
  const s2 = isLive
    ? (match.liveScore2 ?? match.score2 ?? '—')
    : (match.score2 ?? match.liveScore2 ?? '—');
  return [s1, s2];
}

// =============================================================================
// Manager name inside a tile — my-team-name + YOU badge when it's the user.
// Match entry refs carry FPL entry ids ({ entry, name, team }), so matching is
// id-based via isMyTeam.
// =============================================================================

function TileName({ entry, check, checkFirst }: { entry: any; check?: boolean; checkFirst?: boolean }) {
  const { me } = useMyTeam();
  const mine = isMyTeam(me, entry);
  const checkMark = check ? <span className="text-xs text-accent">✓</span> : null;
  return (
    <>
      {checkFirst && checkMark}
      <span className={mine ? 'my-team-name' : ''}>
        {entry.name}
        {mine && <YouBadge />}
      </span>
      {!checkFirst && checkMark}
    </>
  );
}

// =============================================================================
// Match tile
// =============================================================================

function MatchTile({ match, round, isFinal }: { match: any; round: any; isFinal: boolean }) {
  const { me } = useMyTeam();
  const isLive = Boolean(round.isLive);
  const [s1, s2] = matchScores(match, isLive);
  const mine = isMyTeam(me, match.entry1) || isMyTeam(me, match.entry2);

  const sideClass = (side: 1 | 2) =>
    match.winner === side ? 'text-accent' : match.winner != null ? 'text-faint' : '';

  const leftPill = (left: any, active: any) => {
    if (left == null || left <= 0) return null;
    const hasActive = (active ?? 0) > 0;
    return (
      <div
        className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[0.6rem] font-semibold ${
          hasActive ? 'bg-accent-soft text-accent' : 'bg-raised text-muted'
        }`}
      >
        {left}
        {hasActive ? ` (+${active})` : ''} left
      </div>
    );
  };

  return (
    <Card
      highlightMe={mine}
      className={`flex flex-col gap-2 ${isFinal ? 'border-2 border-accent! bg-accent-soft sm:col-span-full' : ''} ${
        isLive && !isFinal ? 'border-live!' : ''
      }`}
    >
      {/* TODO: pitch modal once PitchView lands — legacy opens a squad/stat
          comparison modal (manager picks) when a match tile is clicked. */}
      <div className="flex items-center justify-between text-[0.7rem] font-bold uppercase tracking-wider text-muted">
        <span className={isFinal ? 'text-accent' : ''}>
          {isFinal ? '🏆 ' : ''}
          {shortRound(round.name)} · GW{round.event}
        </span>
        {isLive ? (
          <span className="animate-pulse rounded bg-live px-1.5 py-0.5 text-[0.65rem] font-bold text-accent-fg">
            LIVE
          </span>
        ) : match.winner != null ? (
          <span className="text-accent">✓ Final</span>
        ) : null}
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <div className="min-w-0 text-right">
          <div className={`flex items-center justify-end gap-1.5 truncate text-sm font-semibold ${sideClass(1)}`}>
            <TileName entry={match.entry1} check={match.winner === 1} checkFirst />
          </div>
          <div className="mt-0.5 truncate text-xs text-faint">{match.entry1.team}</div>
          {isLive && leftPill(match.playersLeft1, match.activePlayers1)}
        </div>
        <div className="whitespace-nowrap px-1 text-center text-xl font-extrabold tracking-wide">
          <span>{s1}</span>
          <span className="mx-1 font-medium text-faint">–</span>
          <span>{s2}</span>
          {isLive && (
            <span className="block text-[0.6rem] font-bold uppercase tracking-wider text-accent">
              Provisional
            </span>
          )}
        </div>
        <div className="min-w-0 text-left">
          <div className={`flex items-center justify-start gap-1.5 truncate text-sm font-semibold ${sideClass(2)}`}>
            <TileName entry={match.entry2} check={match.winner === 2} />
          </div>
          <div className="mt-0.5 truncate text-xs text-faint">{match.entry2.team}</div>
          {isLive && leftPill(match.playersLeft2, match.activePlayers2)}
        </div>
      </div>
      {match.tiebreak && (
        <div className="border-t border-edge pt-2 text-center text-xs italic text-muted">
          Decided on {match.tiebreak}
        </div>
      )}
    </Card>
  );
}

function ByeTile({ match, round }: { match: any; round: any }) {
  const { me } = useMyTeam();
  const mine = isMyTeam(me, match.entry1);
  return (
    <Card highlightMe={mine} className="flex flex-col gap-2 opacity-90">
      <div className="flex items-center justify-between text-[0.7rem] font-bold uppercase tracking-wider text-muted">
        <span>
          {shortRound(round.name)} · GW{round.event}
        </span>
        <span className="rounded bg-raised px-1.5 py-0.5 text-[0.65rem] font-bold text-muted">BYE</span>
      </div>
      <div className="text-center">
        <div className="flex items-center justify-center gap-1.5 text-sm font-semibold text-accent">
          <TileName entry={match.entry1} />
        </div>
        <div className="mt-0.5 truncate text-xs text-faint">{match.entry1.team}</div>
      </div>
    </Card>
  );
}

// =============================================================================
// Pre-draw placeholder + rules (legacy renderPreCup)
// =============================================================================

function PreCup({ data }: { data: any }) {
  return (
    <>
      <Card className="mb-6 px-8 py-12 text-center">
        <div className="mb-4 text-6xl" aria-hidden>
          🏆
        </div>
        <h2 className="mb-4 text-xl font-extrabold text-accent">Cup Competition</h2>
        <p className="mx-auto mb-4 max-w-lg leading-relaxed text-muted">
          The mini-league cup hasn&apos;t started yet. All 29 managers will compete in a single-elimination
          knockout tournament. The bracket will be drawn after Gameweek 33 ends.
        </p>
        <div className="mt-4 inline-block rounded-lg border border-accent/40 bg-accent-soft px-6 py-4">
          <div className="text-2xl font-bold text-accent">Gameweek {data.cupStartGW || '34'}</div>
          <div className="mt-1 text-sm text-muted">First Round</div>
        </div>
      </Card>
      <Card>
        <h3 className="mb-4 text-lg font-bold">Cup Rules</h3>
        <ul className="divide-y divide-edge">
          {[
            <>Single-elimination knockout format</>,
            <>
              <strong>Top 3 net scorers in GW33 receive a bye</strong> to the Round of 16
            </>,
            <>Remaining 26 managers play in the Round of 32 (13 matches)</>,
            <>Head-to-head matches each gameweek - highest GW score wins</>,
            <>Tiebreaker: Most goals scored by your players, then virtual coin toss</>,
            <>Winner receives £150 from the prize pot</>,
          ].map((rule, i) => (
            <li key={i} className="relative py-2 pl-6 text-sm text-muted">
              <span className="absolute left-0 font-bold text-accent">&gt;</span>
              {rule}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

// =============================================================================
// Champion hero card
// =============================================================================

function ChampionCard({ finalRound }: { finalRound: any }) {
  const { me } = useMyTeam();
  const m = finalRound.matches[0];
  const champ = m.winner === 1 ? m.entry1 : m.entry2;
  const runnerUp = m.winner === 1 ? m.entry2 : m.entry1;
  const champScore = m.winner === 1 ? (m.score1 ?? m.liveScore1) : (m.score2 ?? m.liveScore2);
  const otherScore = m.winner === 1 ? (m.score2 ?? m.liveScore2) : (m.score1 ?? m.liveScore1);
  const mine = isMyTeam(me, champ);
  return (
    <Card highlightMe={mine} className="mb-6 border-2 border-accent! bg-accent-soft p-6 text-center">
      <div className="mb-2 text-5xl" aria-hidden>
        🏆
      </div>
      <div className="mb-1 text-xs uppercase tracking-[0.2em] text-muted">Cup Champion</div>
      <div className={`mb-1 text-3xl font-extrabold ${mine ? 'my-team-name' : 'text-accent'}`}>
        {champ.name}
        {mine && <YouBadge />}
      </div>
      <div className="text-muted">{champ.team}</div>
      <div className="mt-3 text-sm text-muted">
        Beat <strong className={`text-body ${isMyTeam(me, runnerUp) ? 'my-team-name' : ''}`}>{runnerUp.name}</strong> in
        the final · <strong className="text-body">{champScore}–{otherScore}</strong>
      </div>
    </Card>
  );
}

// =============================================================================
// Page
// =============================================================================

export default function CupPage() {
  const { data, loading, error } = useApi<any>('/api/cup');
  const [selectedRound, setSelectedRound] = useState<number | null>(null);

  const rounds: any[] = data?.rounds || [];

  // Default round: live > most recent completed > first (legacy renderCup).
  const defaultRoundIdx = useMemo(() => {
    const liveIdx = rounds.findIndex((r) => r.isLive);
    if (liveIdx >= 0) return liveIdx;
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (roundStatus(rounds[i]) === 'complete') return i;
    }
    return 0;
  }, [rounds]);

  const activeRoundIdx = selectedRound ?? defaultRoundIdx;

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
        <PageHeader title="Cup" subtitle="Cup Competition" />
        <LoadingBlock label="Loading cup data…" />
      </main>
    );
  }

  if (error || !data || data.error) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
        <PageHeader title="Cup" subtitle="Cup Competition" />
        <ErrorBlock message={data?.error || error || 'Unknown error'} />
      </main>
    );
  }

  if (!data.cupStarted) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
        <PageHeader title="Cup" subtitle="Cup Competition" />
        <PreCup data={data} />
      </main>
    );
  }

  // ---- summary stats (legacy renderSummary) ----
  const finalRound = rounds.find((r) => r.name === 'Final');
  const championDecided = Boolean(
    finalRound &&
      isFinalChampionDecided(finalRound) &&
      !finalRound.isLive &&
      roundStatus(finalRound) === 'complete',
  );

  const liveRound = rounds.find((r) => r.isLive);
  let roundStat: string;
  let roundIsLive = false;
  if (championDecided) {
    roundStat = 'Champion';
  } else if (liveRound) {
    roundStat = shortRound(liveRound.name);
    roundIsLive = true;
  } else {
    let idx = 0;
    for (let i = rounds.length - 1; i >= 0; i--) {
      if (roundStatus(rounds[i]) === 'complete') {
        idx = i;
        break;
      }
    }
    roundStat = shortRound(rounds[idx]?.name || '—');
  }

  let remaining = data.totalManagers || 0;
  for (let i = 0; i < rounds.length; i++) {
    if (roundStatus(rounds[i]) !== 'complete') break;
    remaining = rounds[i].matches.filter((m: any) => m.winner != null).length;
  }
  if (championDecided) remaining = 1;

  const liveMatches = liveRound
    ? liveRound.matches.filter((m: any) => !m.isBye && m.winner == null).length
    : 0;

  const gw = data.currentGW != null ? data.currentGW : '—';
  const activeRound = rounds[activeRoundIdx];
  const isFinalView = activeRound?.name === 'Final';

  const statBox = (value: React.ReactNode, label: string, live: boolean) => (
    <div
      className={`rounded-lg border p-3 text-center ${
        live ? 'border-warning/50 bg-warning/10' : 'border-edge bg-surface'
      }`}
    >
      <div className={`text-xl font-bold leading-tight ${live ? 'text-warning' : 'text-accent'}`}>{value}</div>
      <div className="mt-1 text-[0.7rem] uppercase tracking-wide text-muted">{label}</div>
    </div>
  );

  const dotClass = (status: RoundState) =>
    status === 'complete' ? 'bg-accent' : status === 'live' ? 'animate-pulse bg-warning' : 'bg-faint';

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 pb-12">
      <PageHeader title="Cup" subtitle="Cup Competition" />

      {championDecided && finalRound && <ChampionCard finalRound={finalRound} />}

      {/* Tournament summary */}
      <div className="mb-6">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
          <h2 className="text-xl font-extrabold text-accent">{data.cupName || 'Mini-League Cup'}</h2>
          <div className="text-xs text-muted">
            {data.totalManagers} managers · started GW{data.cupStartGW}
            {data.hasByes ? ` · ${data.byeCount} bye${data.byeCount > 1 ? 's' : ''}` : ''}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {statBox(roundStat, 'Round', roundIsLive)}
          {statBox(remaining, 'Remaining', false)}
          {statBox(gw, 'Gameweek', false)}
          {statBox(liveMatches, 'Live Matches', liveMatches > 0)}
        </div>
      </div>

      {/* Round navigation strip */}
      <div className="mb-6 flex gap-2 overflow-x-auto pb-1" role="tablist">
        {rounds.map((r, i) => {
          const status = roundStatus(r);
          const isActive = i === activeRoundIdx;
          return (
            <button
              key={`${r.name}-${r.event}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setSelectedRound(i)}
              className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold transition-colors ${
                isActive
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-edge bg-surface text-muted hover:bg-raised hover:text-body'
              }`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${dotClass(status)}`} />
              <span>{shortRound(r.name)}</span>
              <span className={`text-[0.7rem] font-medium ${isActive ? 'text-accent/70' : 'text-faint'}`}>
                GW{r.event}
              </span>
            </button>
          );
        })}
      </div>

      {/* Matches for the active round */}
      {!activeRound ? (
        <p className="py-8 text-center text-muted">No matches in this round.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {activeRound.matches.map((match: any, idx: number) =>
            match.isBye ? (
              <ByeTile key={idx} match={match} round={activeRound} />
            ) : (
              <MatchTile key={idx} match={match} round={activeRound} isFinal={isFinalView} />
            ),
          )}
        </div>
      )}
    </main>
  );
}
