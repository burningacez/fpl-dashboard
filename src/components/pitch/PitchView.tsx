'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { POSITION_NAMES } from '@/lib/squad-rules';

/**
 * Shared pitch renderer for a manager's XI + bench. Consumes the player
 * shape from /api/manager/{id}/picks (web_name, positionId, points, multiplier,
 * isCaptain, isViceCaptain, isBench, subOut, subIn).
 */
export function PitchView({ players }: { players: any[] }) {
  const starters = players.filter((p) => !p.isBench);
  const bench = players.filter((p) => p.isBench);

  return (
    <div>
      <div
        className="rounded-xl border border-edge p-3"
        style={{ background: 'linear-gradient(to bottom, var(--pitch-from), var(--pitch-to))' }}
      >
        {[1, 2, 3, 4].map((type) => {
          const row = starters.filter((p) => p.positionId === type);
          if (row.length === 0) return null;
          return (
            <div key={type} className="mb-3 flex flex-wrap justify-center gap-2">
              {row.map((p) => (
                <PlayerChip key={p.id ?? p.element ?? p.name} player={p} />
              ))}
            </div>
          );
        })}
      </div>
      {bench.length > 0 && (
        <div className="mt-2 flex flex-wrap justify-center gap-2 rounded-xl border border-edge bg-surface p-3">
          <span className="self-center text-xs font-bold uppercase text-muted">Bench</span>
          {bench.map((p) => (
            <PlayerChip key={p.id ?? p.element ?? p.name} player={p} bench />
          ))}
        </div>
      )}
    </div>
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

function PlayerChip({ player, bench = false }: { player: any; bench?: boolean }) {
  const mult = player.multiplier ?? (player.isCaptain ? 2 : 1);
  const displayPoints = (player.points ?? 0) * (bench ? 1 : mult || 1);
  return (
    <div
      className={`flex w-20 flex-col items-center rounded-lg border p-1 text-center shadow ${
        player.subOut ? 'border-negative/50 opacity-60' : player.subIn ? 'border-positive/60' : 'border-black/20'
      } ${bench ? 'bg-raised' : 'bg-surface/95'}`}
    >
      <ShirtImage teamCode={player.teamCode} positionId={player.positionId} className="h-9 w-9 object-contain" />
      <div className="flex items-center justify-center gap-1 text-xs font-bold text-body">
        <span className="truncate">{player.name ?? player.web_name}</span>
        {player.isCaptain && <span className="rounded bg-accent px-1 text-[0.6rem] text-accent-fg">C</span>}
        {player.isViceCaptain && <span className="rounded bg-raised px-1 text-[0.6rem]">V</span>}
      </div>
      <div className="text-[0.6rem] text-muted">{player.position ?? POSITION_NAMES[player.positionId] ?? ''}</div>
      <div className="text-sm font-extrabold text-accent">{displayPoints}</div>
    </div>
  );
}
