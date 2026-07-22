'use client';

import { useSeason } from '@/components/providers';
import { seasonLabel } from '@/lib/season-config';

/**
 * Full-width strip shown under the nav whenever an archived season is
 * selected, so nobody mistakes old numbers for live ones.
 */
export function SeasonBanner() {
  const { season, currentSeason, setSeason } = useSeason();
  if (season === null) return null;

  return (
    <div className="border-b border-warning/40 bg-warning/10" role="status">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
        <span className="font-semibold text-warning">
          📦 Viewing archived season {seasonLabel(season)} — read-only
        </span>
        <button
          type="button"
          onClick={() => setSeason(null)}
          className="rounded-md border border-warning/50 px-3 py-1 text-xs font-bold text-warning hover:bg-warning/10"
        >
          Back to {currentSeason ? seasonLabel(currentSeason) : 'current season'}
        </button>
      </div>
    </div>
  );
}
