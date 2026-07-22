'use client';

import { Card, PageHeader } from '@/components/ui';
import { useSeason } from '@/components/providers';
import { seasonLabel } from '@/lib/season-config';

/**
 * Placeholder for live-only pages (H2H, Planner) while an archived season is
 * selected — without it they'd silently show current-season data under the
 * archived banner.
 */
export function ArchivedUnavailable({ title }: { title: string }) {
  const { season, currentSeason, setSeason } = useSeason();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <PageHeader title={title} />
      <Card>
        <p className="mb-4 text-body">
          {title} works off live FPL data, so it isn&apos;t available while viewing the{' '}
          {season ? seasonLabel(season) : 'archived'} archive.
        </p>
        <button
          type="button"
          onClick={() => setSeason(null)}
          className="rounded-md bg-accent px-4 py-2 font-bold text-accent-fg"
        >
          Back to {currentSeason ? seasonLabel(currentSeason) : 'current season'}
        </button>
      </Card>
    </main>
  );
}
