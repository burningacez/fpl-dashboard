'use client';

import { useSeason } from '@/components/providers';
import { seasonLabel } from '@/lib/season-config';

/**
 * Home-page season line. Client-side so it tracks the runtime season pointer
 * (a server component would bake the build-time season) and follows the
 * season dropdown when viewing an archive.
 */
export function SeasonHeading() {
  const { season, currentSeason } = useSeason();
  const id = season ?? currentSeason;
  return <p className="mt-2 text-lg text-muted">{id ? `Season ${seasonLabel(id)}` : ' '}</p>;
}
