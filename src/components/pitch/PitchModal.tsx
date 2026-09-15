'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from 'react';
import { EmptyBlock, ErrorBlock, GameUpdatingBlock, LoadingBlock, Modal } from '@/components/ui';
import { PitchView } from './PitchView';
import { TinkeringImpact } from './TinkeringImpact';
import type { SeasonStatsMap } from './seasonStats';
import { BankedSummary, LedgerTable } from './BankedLedger';
import { byPlayerId, type LedgerTotals, type PlayerLedger } from './ledger';

/** Season points of all fifteen, at face value — no captain, no bench split. */
function squadSeasonPoints(players: any[] = [], seasonStats: SeasonStatsMap): number {
  return players.reduce((sum: number, p: any) => sum + (seasonStats[p.id]?.totalPoints ?? 0), 0);
}

/**
 * A manager's squad for one gameweek, as a pitch. Shared by /week (the
 * clicked manager's current squad) and /set-and-forget (the GW1 squad the
 * whole page is about), so both open the same screen from a table row.
 *
 * Reads /api/manager/{id}/picks, which only serves the live season — callers
 * gate the click on an archived season being selected.
 */
export function PitchModal({
  entry,
  gw,
  onClose,
  subtitle,
  showMoves = true,
  seasonStats,
  ledger,
  ledgerTotals,
}: {
  entry: { id: number; name: string };
  gw: number;
  onClose: () => void;
  /** Extra line under the manager name (e.g. which gameweek is on show). */
  subtitle?: string;
  /** The tinkering ledger is meaningless for a fixed GW1 squad. */
  showMoves?: boolean;
  /**
   * Season totals per player id. Set & Forget passes these so its frozen GW1
   * squad reports what those fifteen did all season, not what they did in the
   * one gameweek the picks were taken from.
   */
  seasonStats?: SeasonStatsMap;
  /**
   * Per-player contribution for a frozen Set & Forget squad. Passing it turns
   * this modal into the two-view screen: the pitch shows what each player
   * banked, and the ledger tab lays the same numbers out as a table that adds
   * up to the manager's S&F total.
   */
  ledger?: PlayerLedger[];
  ledgerTotals?: LedgerTotals;
}) {
  const [picks, setPicks] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [empty, setEmpty] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);
  // Pitch first: the squad shape is what someone came to look at, and the
  // ledger is the follow-up question once they have seen it.
  const [view, setView] = useState<'pitch' | 'ledger'>('pitch');
  const ledgerById = byPlayerId(ledger);

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      fetch(`/api/manager/${entry.id}/picks?gw=${gw}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          if (d.available === false) return setEmpty(d.reason ?? 'Not available yet.');
          // FPL's "game is being updated" window: hold the friendly state and
          // re-check until squads come back.
          if (d.updating) {
            setUpdating(true);
            retry = setTimeout(load, 60_000);
            return;
          }
          if (d.error) return setErr(d.error);
          setUpdating(false);
          setPicks(d);
        })
        .catch((e) => !cancelled && setErr(e.message));
    };
    load();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [entry.id, gw]);

  return (
    <Modal
      title={
        subtitle ? (
          <span>
            {entry.name}
            <span className="block text-sm font-normal text-muted">{subtitle}</span>
          </span>
        ) : (
          entry.name
        )
      }
      onClose={onClose}
      wide
      anchor="modal-pitch"
    >
      {err && <ErrorBlock message={err} />}
      {updating && !picks && <GameUpdatingBlock />}
      {empty && <EmptyBlock message={empty} />}
      {!picks && !err && !empty && !updating && <LoadingBlock label="Loading squad…" />}
      {picks && (
        <>
          {ledgerTotals && <BankedSummary totals={ledgerTotals} />}

          {ledger && ledger.length > 0 && (
            <div
              className="mb-4 flex gap-1 rounded-xl border border-edge bg-raised p-1"
              role="tablist"
              data-tour="saf-view-switch"
            >
              {(['pitch', 'ledger'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={view === tab}
                  onClick={() => setView(tab)}
                  className={`flex-1 cursor-pointer rounded-lg py-2 text-sm font-bold capitalize ${
                    view === tab ? 'bg-accent text-accent-fg' : 'text-muted hover:text-body'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          )}

          {/* The banked summary above says all of this and more, so the plain
              points line only appears when there is no ledger. */}
          {!ledgerTotals && (
          <div className="mb-3 flex flex-wrap gap-4 text-sm text-muted">
            {seasonStats ? (
              /*
                The squad's raw season haul: every player's season points added
                up, captaincy and benching left out of it deliberately. Those
                are gameweek decisions and this squad never made another one —
                what the S&F table scores is on the /set-and-forget page beside
                the manager's name.
              */
              <span>
                Squad season points{' '}
                <strong className="text-body">{squadSeasonPoints(picks.players, seasonStats)}</strong>
              </span>
            ) : (
              /* Same formula as the week table's gwScore so the two never disagree */
              <span>
                GW points{' '}
                <strong className="text-body">
                  {(picks.calculatedPoints ?? picks.points) + (picks.totalProvisionalBonus || 0) - (picks.transfersCost || 0)}
                </strong>
                {(picks.transfersCost || 0) > 0 && <span className="text-negative"> (−{picks.transfersCost} hit)</span>}
              </span>
            )}
          </div>
          )}
          {!seasonStats && (picks.autoSubs ?? []).length > 0 && (
            <p className="mb-2 rounded-lg bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent">
              ⟳ Auto-sub: {picks.autoSubs.map((s: any) => `${s.in.name} for ${s.out.name}`).join(', ')}
            </p>
          )}
          {view === 'ledger' && ledger && ledgerTotals ? (
            <LedgerTable ledger={ledger} totals={ledgerTotals} players={picks.players ?? []} />
          ) : (
            <PitchView
              players={picks.players ?? []}
              pointsOnBench={picks.pointsOnBench}
              seasonStats={seasonStats}
              ledger={ledger ? ledgerById : undefined}
            />
          )}
          {showMoves && <TinkeringImpact entryId={entry.id} gw={gw} />}
        </>
      )}
    </Modal>
  );
}
