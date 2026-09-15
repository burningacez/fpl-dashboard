'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState } from 'react';
import { POSITION_NAMES } from '@/lib/squad-rules';
import { Modal } from '@/components/ui';
import { PitchSurface } from './PitchSurface';
import { BankedBar } from './BankedLedger';
import { BANKED_LABELS, type LedgerMap, type PlayerLedger } from './ledger';
import {
  formatAverage,
  perAppearance,
  seasonEventIcons,
  seasonStatRows,
  type PlayerSeasonTotals,
  type SeasonStatsMap,
} from './seasonStats';

/**
 * Shared pitch renderer for a manager's XI + bench. Consumes the player
 * shape from /api/manager/{id}/picks (web_name, positionId, points, multiplier,
 * isCaptain, isViceCaptain, isBench, benchOrder, subOut, subIn).
 *
 * `seasonStats` switches the numbers from that one gameweek to the whole
 * season: Set & Forget shows a frozen GW1 squad, where what matters is not what
 * those fifteen did in GW1 but what they went on to do for the rest of the
 * season. The pitch, the shirts and the layout are deliberately untouched —
 * only what the pill and the tapped-player panel count changes.
 */
export function PitchView({
  players,
  pointsOnBench,
  seasonStats,
  ledger,
}: {
  players: any[];
  pointsOnBench?: number;
  seasonStats?: SeasonStatsMap;
  /**
   * Per-player contribution for a frozen Set & Forget squad. When present the
   * chips show what each player BANKED for this manager rather than what they
   * scored — see ./ledger.ts for why those differ.
   */
  ledger?: LedgerMap;
}) {
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
    <div className="overflow-hidden rounded-xl border-2 border-accent/40" data-tour="pitch">
      <PitchSurface>
        {[1, 2, 3, 4].map((type) => {
          const row = starters.filter((p) => p.positionId === type);
          if (row.length === 0) return null;
          return (
            <div key={type} className="relative flex justify-center gap-1 py-2">
              {row.map((p) => (
                <PlayerChip
                  key={p.id ?? p.element ?? p.name}
                  player={p}
                  season={seasonStats?.[p.id]}
                  banked={ledger?.[p.id]}
                  onClick={() => setSelected(p)}
                />
              ))}
            </div>
          );
        })}
      </PitchSurface>
      {bench.length > 0 && (
        <div className="bg-raised px-3 py-2" data-tour="pitch-bench">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wide text-muted">Substitutes</span>
            {ledger ? (
              <BenchLedgerSummary players={bench} ledger={ledger} />
            ) : (
              pointsOnBench != null &&
              !seasonStats && <span className="text-xs font-bold text-muted">{pointsOnBench} pts</span>
            )}
          </div>
          <div className="flex justify-around">
            {bench.map((p) => (
              <PlayerChip
                key={p.id ?? p.element ?? p.name}
                player={p}
                season={seasonStats?.[p.id]}
                banked={ledger?.[p.id]}
                bench
                onClick={() => setSelected(p)}
              />
            ))}
          </div>
        </div>
      )}
      {selected && (
        <PlayerBreakdown
          player={selected}
          season={seasonStats?.[selected.id]}
          banked={ledger?.[selected.id]}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/**
 * The bench, totalled: what came off it, and what died on it.
 *
 * Under a frozen squad the second number is the interesting one — it is the
 * cost of a bench order nobody was allowed to change — so it gets the same
 * weight as the first rather than a footnote.
 */
function BenchLedgerSummary({ players, ledger }: { players: any[]; ledger: LedgerMap }) {
  let banked = 0;
  let wasted = 0;
  for (const p of players) {
    banked += ledger[p.id]?.offBench ?? 0;
    wasted += ledger[p.id]?.wasted ?? 0;
  }
  if (banked === 0 && wasted === 0) return null;
  return (
    <span className="text-xs font-bold">
      <span className="text-banked-bench">+{banked} on</span>
      <span className="text-faint"> · </span>
      <span className="text-negative">{wasted} lost</span>
    </span>
  );
}

export function PlayerBreakdown({
  player,
  season,
  banked,
  onClose,
}: {
  player: any;
  /** Season totals for this player; when present they replace the gameweek breakdown. */
  season?: PlayerSeasonTotals;
  /** What this player banked for a frozen squad; shown above their season. */
  banked?: PlayerLedger;
  onClose: () => void;
}) {
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
      anchor="modal-player"
    >
      {banked && <BankedBreakdown banked={banked} />}
      {season ? (
        <SeasonBreakdownBody season={season} />
      ) : (
        <>
      {player.playerNews ? (
        <p className="mb-3 rounded-lg bg-warning/15 px-3 py-2 text-sm text-warning">{player.playerNews}</p>
      ) : player.hasNoGame || player.playStatus === 'no_game' ? (
        <p className="mb-3 rounded-lg bg-raised px-3 py-2 text-sm text-muted">No fixture this gameweek</p>
      ) : null}
      <div className="divide-y divide-edge text-sm" data-tour="player-rows">
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
        </>
      )}
    </Modal>
  );
}

/**
 * What this player banked for the frozen squad, and what it left behind.
 *
 * Deliberately above the season totals rather than mixed into them: these are
 * two different questions about the same player, and only this one has an
 * answer that is specific to the manager whose pitch is open. A player's 142
 * points are the same for everyone in the league; what those points were worth
 * to a squad that could never move them depends on where they were sitting.
 */
function BankedBreakdown({ banked }: { banked: PlayerLedger }) {
  const rows = [
    { key: 'started', label: BANKED_LABELS.started, value: banked.started, className: 'bg-banked-started', text: '' },
    { key: 'captain', label: BANKED_LABELS.captain, value: banked.captain, className: 'bg-banked-captain', text: 'text-banked-captain' },
    {
      key: 'offBench',
      // Two ways onto the pitch from the bench, and which one it was matters:
      // an auto-sub is luck, a Bench Boost was a decision.
      label:
        banked.benchBoost > 0 && banked.subbedOn > 0
          ? 'Subbed on + Bench Boost'
          : banked.benchBoost > 0
            ? 'Bench Boost'
            : 'Subbed on',
      value: banked.offBench,
      className: 'bg-banked-bench',
      text: 'text-banked-bench',
    },
  ].filter((row) => row.value > 0);

  return (
    <div className="mb-4 rounded-xl border border-edge bg-raised p-3.5" data-tour="player-banked">
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        <span className="text-[0.7rem] font-bold uppercase tracking-[0.06em] text-muted">
          Banked for this squad
        </span>
        <span className="text-2xl font-extrabold tabular-nums">{banked.banked}</span>
      </div>

      <BankedBar row={banked} className="mb-2.5 h-2" />

      <div className="divide-y divide-edge text-sm">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-2 py-1.5">
            <span className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-sm ${row.className}`} aria-hidden />
              {row.label}
            </span>
            <span className={`font-bold tabular-nums ${row.text}`}>{row.value}</span>
          </div>
        ))}
        {banked.wasted > 0 && (
          <div className="flex items-center justify-between gap-2 py-1.5">
            <span className="flex items-center gap-2 text-muted">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm border border-dashed border-negative"
                aria-hidden
              />
              {BANKED_LABELS.wasted}
            </span>
            <span className="font-bold tabular-nums text-negative">{banked.wasted}</span>
          </div>
        )}
      </div>

      <p className="mt-2.5 text-xs text-faint">
        {banked.weeksStarted} start{banked.weeksStarted === 1 ? '' : 's'}
        {banked.weeksSubbedOn > 0 && `, ${banked.weeksSubbedOn} off the bench`}
        {banked.weeksBenched > 0 && `, ${banked.weeksBenched} benched`}
        {banked.weeksCaptained > 0 && ` · armband in ${banked.weeksCaptained}`}
      </p>
    </div>
  );
}

/**
 * What a player did across the season, totals first and per-game beside them.
 *
 * Both columns are shown together on purpose: the total is what the frozen
 * squad actually banked, the average is the only fair way to compare a player
 * who missed half the season with one who started every week. The average
 * divides by appearances (gameweeks with a minute played), not by gameweeks
 * elapsed, so an injury lay-off doesn't read as a player who went off the
 * boil — the appearances line above says how many games it is over.
 */
function SeasonBreakdownBody({ season }: { season: PlayerSeasonTotals }) {
  const rows = seasonStatRows(season);
  const pointsPerGame = perAppearance(season.totalPoints, season.appearances);
  const missed = Math.max(0, season.gamesAvailable - season.appearances);

  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-2 text-center" data-tour="player-season-summary">
        <div className="rounded-lg bg-raised px-3 py-2">
          <div className="text-xs font-bold uppercase tracking-wide text-muted">Season points</div>
          <div className="text-2xl font-extrabold">{season.totalPoints}</div>
        </div>
        <div className="rounded-lg bg-raised px-3 py-2">
          <div className="text-xs font-bold uppercase tracking-wide text-muted">Points per game</div>
          <div className="text-2xl font-extrabold">
            {pointsPerGame == null ? '—' : formatAverage(pointsPerGame)}
          </div>
        </div>
      </div>
      <p className="mb-3 text-center text-xs text-faint">
        {season.appearances} appearance{season.appearances === 1 ? '' : 's'}
        {missed > 0 && ` · missed ${missed}`}
      </p>
      <div className="divide-y divide-edge text-sm" data-tour="player-season-rows">
        <div className="flex items-center justify-between gap-2 pb-1 text-[0.7rem] font-bold uppercase tracking-wide text-muted">
          <span>Stat</span>
          <span className="flex items-center gap-4">
            <span className="w-14 text-right">Total</span>
            <span className="w-16 text-right">Per game</span>
          </span>
        </div>
        {rows.length === 0 && <p className="py-2 text-muted">No points yet this season.</p>}
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-2 py-1.5">
            <span>
              <span aria-hidden className="mr-1.5">{row.icon}</span>
              {row.label}
            </span>
            <span className="flex items-center gap-4">
              <span className="w-14 text-right font-bold">{row.total}</span>
              <span className="w-16 text-right text-muted">
                {row.perGame == null ? '—' : formatAverage(row.perGame, row.key)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </>
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

/**
 * `anchor` names this chip for a walkthrough step. The tour points at the
 * captain, which is both the most interesting tile and one we can identify
 * without counting positions.
 */
function PlayerChip({
  player,
  bench = false,
  season,
  banked,
  onClick,
}: {
  player: any;
  bench?: boolean;
  /** Season totals: shown on the pill instead of the gameweek's points. */
  season?: PlayerSeasonTotals;
  /** Contribution ledger: what this player banked for the frozen squad. */
  banked?: PlayerLedger;
  onClick?: () => void;
}) {
  const mult = player.multiplier ?? (player.isCaptain ? 2 : 1);
  const isDone =
    player.playStatus === 'played' || player.playStatus === 'benched' || player.playStatus === 'no_game';
  // Fading a player out because their GW1 fixture is over says nothing about a
  // season total, so season mode leaves every chip at full strength.
  const finished =
    !season &&
    !banked &&
    isDone &&
    (!player.hasDoubleGameweek || player.allFixturesFinished || player.hasNoGame);
  const playing = player.playStatus === 'playing';
  const band = statusBandClass(player);
  // In season mode the gameweek's own events would be a single week's worth of
  // icons under a season-long points total, so the icons follow the pill.
  const events: any[] = season ? seasonEventIcons(season) : player.events ?? [];
  // A frozen squad's chip answers "what did they bank for me", so the armband
  // badge below is history (who wore it in GW1) while this is the season's.
  const showBanked = Boolean(banked);
  return (
    <button
      type="button"
      onClick={onClick}
      title={player.playerNews || undefined}
      data-tour={player.isCaptain ? 'pitch-captain' : undefined}
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
        {showBanked ? banked!.banked : season ? season.totalPoints : <PointsDisplay player={player} bench={bench} />}
      </span>
      {showBanked && (
        <>
          <BankedBar row={banked!} className="mt-0.5 h-1 w-11" />
          {banked!.wasted > 0 && (
            <span className="text-[0.6rem] font-bold text-negative">−{banked!.wasted}</span>
          )}
        </>
      )}
      {!showBanked && (season || !bench) && events.length > 0 && (
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
