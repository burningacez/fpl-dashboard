'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState, type ReactNode } from 'react';
import { Modal, LoadingBlock, ErrorBlock } from '@/components/ui';
import { PlayerBreakdown } from '@/components/pitch/PitchView';

/** Horizontal strip of clickable fixtures (legacy fixtures bar + modal list). */
export function FixtureStrip({ fixtures, onOpen }: { fixtures: any[]; onOpen: (f: any) => void }) {
  if (!fixtures?.length) return null;
  return (
    <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
      {fixtures.map((f) => {
        const live = f.started && !f.finished;
        return (
          <button
            key={f.id}
            type="button"
            onClick={() => onOpen(f)}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-bold hover:bg-raised ${
              live ? 'border-live/60' : f.finished ? 'border-edge text-muted' : 'border-edge'
            }`}
          >
            <span>{f.home}</span>
            {f.started ? (
              <span className="text-accent">
                {f.homeScore ?? 0}–{f.awayScore ?? 0}
              </span>
            ) : (
              <span className="font-normal text-faint">{kickoffTime(f.kickoff)}</span>
            )}
            <span>{f.away}</span>
            {live && <span className="rounded bg-negative-soft px-1 text-[0.6rem] text-negative">{f.minutes ?? 0}&apos;</span>}
            {f.finished && <span className="text-[0.6rem] text-faint">FT</span>}
          </button>
        );
      })}
    </div>
  );
}

function kickoffTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return today ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Match detail modal (legacy openMatchModal/renderMatchStats): side-by-side
 *  lineups with event icons, plus defcon / keeper saves / bonus sections. */
export function MatchModal({ fixture, onClose }: { fixture: any; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<any>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setErr(null);
    fetch(`/api/fixture/${fixture.id}/stats`)
      .then((r) => r.json())
      .then((d) => !cancelled && (d.error ? setErr(d.error) : setData(d)))
      .catch((e) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [fixture.id]);

  const live = fixture.started && !fixture.finished;
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          {fixture.home}
          <span className="text-accent">
            {fixture.homeScore ?? 0}–{fixture.awayScore ?? 0}
          </span>
          {fixture.away}
          {live && (
            <span className="rounded-full bg-negative-soft px-2 py-0.5 text-xs text-negative">{fixture.minutes ?? 0}&apos;</span>
          )}
          {fixture.finished && <span className="text-xs font-normal text-muted">FT</span>}
        </span>
      }
      onClose={onClose}
      wide
    >
      {err && <ErrorBlock message={err} />}
      {!data && !err && <LoadingBlock label="Loading match data…" />}
      {data && (
        <>
          <Lineups data={data} homeName={fixture.home} awayName={fixture.away} onPlayer={setSelected} />
          <DefconSection data={data} />
          <SavesSection data={data} />
          <BonusSection data={data} />
        </>
      )}
      {selected && <PlayerBreakdown player={selected} onClose={() => setSelected(null)} />}
    </Modal>
  );
}

const POS_LETTER: Record<string, string> = { GKP: 'K', DEF: 'D', MID: 'M', FWD: 'F' };

function eventIcons(p: any): ReactNode[] {
  const icons: ReactNode[] = [];
  if (p.cleanSheet && p.position !== 'FWD') icons.push(<span key="cs" title="Clean sheet">🛡️</span>);
  if (p.goals) icons.push(<span key="g" title={`${p.goals} goal${p.goals > 1 ? 's' : ''}`}>⚽{p.goals > 1 ? `×${p.goals}` : ''}</span>);
  if (p.assists) icons.push(<span key="a" title={`${p.assists} assist${p.assists > 1 ? 's' : ''}`}>👟{p.assists > 1 ? `×${p.assists}` : ''}</span>);
  if (p.yellowCard) icons.push(<span key="y" title="Yellow card">🟨</span>);
  if (p.redCard) icons.push(<span key="r" title="Red card">🟥</span>);
  return icons;
}

function PlayerRow({ p, away = false, onClick }: { p: any; away?: boolean; onClick: () => void }) {
  if (!p) return <div className="py-1" />;
  const pts = (
    <span className={`shrink-0 font-bold ${p.points > 0 ? 'text-positive' : p.points < 0 ? 'text-negative' : 'text-faint'}`}>
      {p.points}
      {p.provisionalBonus > 0 && <sup className="text-[0.6rem] text-positive">+{p.provisionalBonus}</sup>}
    </span>
  );
  const name = (
    <span className="min-w-0 truncate">
      <span className="text-[0.6rem] text-faint">[{POS_LETTER[p.position] ?? '?'}]</span> {p.name}{' '}
      <span className="text-[0.65rem]">{eventIcons(p)}</span>
    </span>
  );
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 py-0.5 text-left text-xs hover:text-accent ${away ? 'flex-row-reverse text-right' : ''}`}
    >
      {name}
      <span className="grow" />
      {pts}
    </button>
  );
}

function Lineups({
  data,
  homeName,
  awayName,
  onPlayer,
}: {
  data: any;
  homeName: string;
  awayName: string;
  onPlayer: (p: any) => void;
}) {
  const cols: ['home', 'away'][number][] = ['home', 'away'];
  return (
    <div className="grid grid-cols-2 gap-4">
      {cols.map((side) => (
        <div key={side} className={side === 'away' ? 'text-right' : ''}>
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">
            {side === 'home' ? homeName : awayName}
          </h3>
          {(data[side]?.starters ?? []).map((p: any) => (
            <PlayerRow key={p.id} p={p} away={side === 'away'} onClick={() => onPlayer(p)} />
          ))}
          {(data[side]?.subs ?? []).length > 0 && (
            <div className="my-1 border-t border-edge pt-1 text-[0.6rem] font-bold uppercase text-faint">Substitutes</div>
          )}
          {(data[side]?.subs ?? []).map((p: any) => (
            <PlayerRow key={p.id} p={p} away={side === 'away'} onClick={() => onPlayer(p)} />
          ))}
        </div>
      ))}
    </div>
  );
}

function allPlayers(data: any, side: 'home' | 'away'): any[] {
  return [...(data[side]?.starters ?? []), ...(data[side]?.subs ?? [])];
}

function StatsSection({ icon, title, rows }: { icon: string; title: string; rows: [ReactNode, ReactNode][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-4">
      <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">
        <span aria-hidden>{icon}</span> {title}
      </h3>
      <div className="rounded-lg bg-raised px-3 py-1">
        {rows.map(([home, away], i) => (
          <div key={i} className="grid grid-cols-2 gap-4 border-b border-edge py-1 text-xs last:border-0">
            <div>{home}</div>
            <div className="text-right">{away}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Defcon thresholds: 10 for DEF, 12 for MID/FWD; GKP never scores defcon. */
function defconReached(p: any): boolean {
  if (p.position === 'GKP') return false;
  return p.defcon >= (p.position === 'DEF' ? 10 : 12);
}

function DefconSection({ data }: { data: any }) {
  const side = (s: 'home' | 'away') =>
    allPlayers(data, s).filter((p) => p.defcon > 0).sort((a, b) => b.defcon - a.defcon).slice(0, 12);
  const home = side('home');
  const away = side('away');
  const rows: [ReactNode, ReactNode][] = [];
  for (let i = 0; i < Math.max(home.length, away.length); i++) {
    const cell = (p: any) =>
      p ? (
        <span className={defconReached(p) ? 'font-bold text-positive' : ''}>
          {p.name} {p.defcon}
          {defconReached(p) && ' 🔒'}
        </span>
      ) : null;
    rows.push([cell(home[i]), cell(away[i])]);
  }
  return <StatsSection icon="🛡️" title="Defensive Contribution" rows={rows} />;
}

function SavesSection({ data }: { data: any }) {
  const gk = (s: 'home' | 'away') => allPlayers(data, s).find((p) => p.position === 'GKP' && p.saves > 0);
  const home = gk('home');
  const away = gk('away');
  if (!home && !away) return null;
  const cell = (p: any) =>
    p ? (
      <span className={p.saves >= 3 ? 'font-bold text-positive' : ''}>
        {p.name} {p.saves}
        {p.saves >= 3 && ' 🧤'}
      </span>
    ) : null;
  return <StatsSection icon="🧤" title="Keeper Saves" rows={[[cell(home), cell(away)]]} />;
}

function BonusSection({ data }: { data: any }) {
  const players = [...allPlayers(data, 'home'), ...allPlayers(data, 'away')]
    .filter((p) => p.bps > 0)
    .sort((a, b) => b.bps - a.bps);
  if (players.length === 0) return null;

  // Project 3/2/1 bonus from BPS ranks; ties share the rank (legacy bonusMap).
  const bonusMap: Record<number, number> = {};
  let rank = 1;
  for (const bps of [...new Set(players.map((p) => p.bps))].sort((a, b) => b - a)) {
    if (rank > 3) break;
    bonusMap[bps] = rank === 1 ? 3 : rank === 2 ? 2 : 1;
    rank += players.filter((p) => p.bps === bps).length;
  }

  const side = (s: 'home' | 'away') => {
    const ids = new Set(allPlayers(data, s).map((p) => p.id));
    return players.filter((p) => ids.has(p.id)).slice(0, 12);
  };
  const home = side('home');
  const away = side('away');
  const rows: [ReactNode, ReactNode][] = [];
  for (let i = 0; i < Math.max(home.length, away.length); i++) {
    const cell = (p: any) =>
      p ? (
        <span>
          {p.name} <span className="text-faint">[{p.bps}]</span>
          {(bonusMap[p.bps] ?? 0) > 0 && <span className="font-bold text-positive"> +{bonusMap[p.bps]}</span>}
        </span>
      ) : null;
    rows.push([cell(home[i]), cell(away[i])]);
  }
  const title = data.finished || data.finishedProvisional ? 'Bonus Points' : 'Projected Bonus';
  return <StatsSection icon="⭐" title={title} rows={rows} />;
}
