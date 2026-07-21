'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { POSITION_NAMES } from '@/lib/squad-rules';
import { Modal } from '@/components/ui';

/**
 * Shared pitch renderer for a manager's XI + bench. Consumes the player
 * shape from /api/manager/{id}/picks (web_name, positionId, points, multiplier,
 * isCaptain, isViceCaptain, isBench, benchOrder, subOut, subIn).
 */
export function PitchView({ players, pointsOnBench }: { players: any[]; pointsOnBench?: number }) {
  const [selected, setSelected] = useState<any>(null);
  // Auto-subs move players between pitch and bench.
  const starters = players.filter((p) => (!p.isBench && !p.subOut) || p.subIn);
  const bench = players
    .filter((p) => (p.isBench && !p.subIn) || p.subOut)
    .sort((a, b) => {
      if (a.positionId === 1 && b.positionId !== 1) return -1;
      if (a.positionId !== 1 && b.positionId === 1) return 1;
      return (a.isBench ? a.benchOrder : 99) - (b.isBench ? b.benchOrder : 99);
    });

  return (
    <div className="overflow-hidden rounded-xl border border-edge">
      <div
        className="relative py-3"
        style={{
          background:
            'repeating-linear-gradient(180deg, var(--pitch-from) 0, var(--pitch-from) 10%, var(--pitch-to) 10%, var(--pitch-to) 20%)',
        }}
      >
        {/* Pitch markings */}
        <div className="pointer-events-none absolute inset-x-4 inset-y-2 border-2 border-white/25">
          <div className="absolute inset-x-0 top-1/2 h-0.5 bg-white/25" />
          <div className="absolute left-1/2 top-1/2 h-12 w-12 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/25" />
          <div className="absolute left-1/2 top-0 h-9 w-32 -translate-x-1/2 border-2 border-t-0 border-white/25" />
          <div className="absolute bottom-0 left-1/2 h-9 w-32 -translate-x-1/2 border-2 border-b-0 border-white/25" />
        </div>
        {[1, 2, 3, 4].map((type) => {
          const row = starters.filter((p) => p.positionId === type);
          if (row.length === 0) return null;
          return (
            <div key={type} className="relative flex justify-center gap-1 py-2">
              {row.map((p) => (
                <PlayerChip key={p.id ?? p.element ?? p.name} player={p} onClick={() => setSelected(p)} />
              ))}
            </div>
          );
        })}
      </div>
      {bench.length > 0 && (
        <div className="bg-raised px-3 py-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">Substitutes</span>
            {pointsOnBench != null && <span className="text-xs font-bold text-muted">{pointsOnBench} pts</span>}
          </div>
          <div className="flex justify-around">
            {bench.map((p) => (
              <PlayerChip key={p.id ?? p.element ?? p.name} player={p} bench onClick={() => setSelected(p)} />
            ))}
          </div>
        </div>
      )}
      {selected && <PlayerBreakdown player={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

export function PlayerBreakdown({ player, onClose }: { player: any; onClose: () => void }) {
  const breakdown: any[] = player.pointsBreakdown ?? [];
  const basePoints = player.totalPoints ?? player.points ?? 0;
  const provisionalBonus = player.provisionalBonus ?? 0;
  return (
    <Modal
      title={
        <span className="flex items-center gap-3">
          <ShirtImage teamCode={player.teamCode} positionId={player.positionId} className="h-9 w-9 object-contain" />
          <span>
            {player.fullName ?? player.name}
            <span className="block text-xs font-normal text-muted">
              {player.teamName} · {player.position ?? POSITION_NAMES[player.positionId] ?? ''}
            </span>
          </span>
        </span>
      }
      onClose={onClose}
    >
      {player.playerNews ? (
        <p className="mb-3 rounded-lg bg-warning/15 px-3 py-2 text-sm text-warning">{player.playerNews}</p>
      ) : player.hasNoGame || player.playStatus === 'no_game' ? (
        <p className="mb-3 rounded-lg bg-raised px-3 py-2 text-sm text-muted">No fixture this gameweek</p>
      ) : null}
      <div className="divide-y divide-edge text-sm">
        {breakdown.length === 0 && <p className="py-2 text-muted">No points yet.</p>}
        {breakdown.map((item) => (
          <div key={item.identifier} className="flex items-center justify-between gap-2 py-1.5">
            <span>
              <span aria-hidden className="mr-1.5">{item.icon}</span>
              {item.stat}
            </span>
            <span className="flex items-center gap-4">
              <span className="text-muted">{item.value}</span>
              <span className={`w-14 text-right font-bold ${item.points < 0 ? 'text-negative' : 'text-positive'}`}>
                {item.points} pts
              </span>
            </span>
          </div>
        ))}
        {provisionalBonus > 0 && (
          <div className="flex items-center justify-between gap-2 py-1.5 text-positive">
            <span>
              <span aria-hidden className="mr-1.5">⭐</span>
              Provisional bonus
            </span>
            <span className="flex items-center gap-4">
              <span>[{player.bps} BPS]</span>
              <span className="w-14 text-right font-bold">+{provisionalBonus} pts</span>
            </span>
          </div>
        )}
        <div className="flex items-center justify-between gap-2 py-2 font-extrabold">
          <span>Total</span>
          <span>{provisionalBonus > 0 ? `${basePoints} + ${provisionalBonus}` : basePoints} pts</span>
        </div>
      </div>
    </Modal>
  );
}

/** FPL kit image. GK shirts use the `_1` suffix; falls back to the neutral
 *  shirt (code 0) if the team code is missing or the image fails to load. */
export function ShirtImage({
  teamCode,
  positionId,
  className = '',
}: {
  teamCode: number | undefined;
  positionId: number | undefined;
  className?: string;
}) {
  const suffix = positionId === 1 ? '_1' : '';
  const code = teamCode || 0;
  const src = `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_${code}${suffix}-110.webp`;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      className={className}
      onError={(e) => {
        const img = e.currentTarget;
        const fallback = `https://fantasy.premierleague.com/dist/img/shirts/standard/shirt_0${suffix}-110.webp`;
        if (img.src !== fallback) img.src = fallback;
      }}
    />
  );
}

/** Availability band behind the name (legacy getPlayerStatusClass): red for
 *  injured/suspended, orange doubtful (25%), yellow 50-75%, grey blank GW.
 *  Only shown before the player has minutes — irrelevant afterwards. */
function statusBandClass(p: any): string {
  if (p.hasNoGame || p.playStatus === 'no_game') return 'bg-neutral-500/85 text-white';
  if (p.minutes > 0) return '';
  const status = p.playerStatus;
  const chance = p.chanceOfPlaying;
  if (status === 'i' || status === 's' || status === 'u' || status === 'n') return 'bg-negative/85 text-white';
  if (chance != null) {
    if (chance === 0) return 'bg-negative/85 text-white';
    if (chance === 25) return 'bg-warning/85 text-black';
    if (chance <= 75) return 'bg-yellow-400/80 text-black';
  }
  if (status === 'd') return 'bg-warning/85 text-black';
  return '';
}

/** Points pill contents (legacy getPointsDisplay): opponent before kickoff,
 *  BLANK for no fixture, DGW split "pts | OPP", provisional bonus superscript. */
function PointsDisplay({ player: p, bench }: { player: any; bench: boolean }) {
  const base = p.totalPoints ?? p.points ?? 0;
  const opp = <span className="text-[0.6rem] font-semibold opacity-70">{p.opponent ?? '-'}</span>;

  if (p.playStatus === 'no_game') return <span className="text-[0.6rem] font-semibold opacity-70">BLANK</span>;
  if (p.playStatus === 'not_started') {
    if (p.hasDoubleGameweek && p.fixtureDetails) {
      return (
        <span className="text-[0.55rem] font-semibold opacity-70">
          {p.fixtureDetails.map((f: any) => f.oppName).join(', ')}
        </span>
      );
    }
    return opp;
  }
  if (p.playStatus === 'not_played_yet') {
    const next = p.hasDoubleGameweek
      ? p.fixtureDetails?.find((f: any) => !f.started) ?? p.fixtureDetails?.find((f: any) => !f.finished)
      : null;
    return next ? <span className="text-[0.6rem] font-semibold opacity-70">{next.oppName}</span> : opp;
  }

  const mult = bench ? 1 : p.multiplier || 1;
  const pts = base * mult;
  const bonus = (p.provisionalBonus ?? 0) * mult;
  const ptsNode = (
    <>
      {pts}
      {bonus > 0 && <sup className="text-[0.6rem] font-bold text-[#00ff85]">+{bonus}</sup>}
    </>
  );

  // DGW: played one fixture, another still to come → "pts | NEXT"
  if (p.hasDoubleGameweek && !p.allFixturesFinished && p.playStatus !== 'playing') {
    const next = p.fixtureDetails?.find((f: any) => !f.started);
    if (next) {
      return (
        <>
          {ptsNode} <span className="opacity-40">|</span>{' '}
          <span className="text-[0.55rem] font-semibold opacity-70">{next.oppName}</span>
        </>
      );
    }
  }
  return ptsNode;
}

function PlayerChip({
  player,
  bench = false,
  onClick,
}: {
  player: any;
  bench?: boolean;
  onClick?: () => void;
}) {
  const mult = player.multiplier ?? (player.isCaptain ? 2 : 1);
  const isDone =
    player.playStatus === 'played' || player.playStatus === 'benched' || player.playStatus === 'no_game';
  const finished =
    isDone && (!player.hasDoubleGameweek || player.allFixturesFinished || player.hasNoGame);
  const playing = player.playStatus === 'playing';
  const band = statusBandClass(player);
  const events: any[] = player.events ?? [];
  return (
    <button
      type="button"
      onClick={onClick}
      title={player.playerNews || undefined}
      className={`flex w-1/5 min-w-0 max-w-24 cursor-pointer flex-col items-center rounded-md text-center ${
        player.subOut ? 'opacity-40' : finished ? 'opacity-60' : ''
      } ${playing ? 'border-2 border-warning shadow-[0_0_8px_rgba(255,193,7,0.5)]' : ''}`}
    >
      <div className="relative">
        <ShirtImage
          teamCode={player.teamCode}
          positionId={player.positionId}
          className="h-12 w-12 object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.4)] sm:h-14 sm:w-14"
        />
        {player.subIn && (
          <span className="absolute -left-1 top-0 flex h-4 w-4 items-center justify-center rounded-full bg-positive text-[0.6rem] font-bold text-white">
            ↑
          </span>
        )}
        {player.isCaptain && (
          <span className="absolute -right-1 bottom-0 flex h-4 w-4 items-center justify-center rounded-full border border-white bg-black text-[0.55rem] font-bold text-white">
            {mult === 3 ? 'T' : 'C'}
          </span>
        )}
        {player.isViceCaptain && (
          <span className="absolute -right-1 bottom-0 flex h-4 w-4 items-center justify-center rounded-full border border-white bg-neutral-500 text-[0.55rem] font-bold text-white">
            V
          </span>
        )}
      </div>
      <span
        className={`w-full truncate rounded px-0.5 text-[0.68rem] font-bold ${
          band || (bench ? 'text-body' : 'text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.8)]')
        }`}
      >
        {player.name ?? player.web_name}
      </span>
      {bench && (
        <span className="text-[0.6rem] font-semibold text-muted">
          {player.position ?? POSITION_NAMES[player.positionId] ?? ''}
        </span>
      )}
      <span
        className={`text-sm font-extrabold ${
          bench ? 'text-body' : 'text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.8)]'
        }`}
      >
        <PointsDisplay player={player} bench={bench} />
      </span>
      {!bench && events.length > 0 && (
        <span className="flex gap-px text-[0.5rem] leading-none">
          {events.map((ev, i) => (
            <span key={i} title={ev.label}>
              {ev.icon}
              {ev.count > 1 ? `×${ev.count}` : ''}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}
