'use client';

import { useApi } from '@/hooks/useApi';

interface LeagueResponse {
  league?: { name?: string };
}

/**
 * Home-page hero title. Shows the selected season's FPL league name (the
 * league's "title"), so a new season's name replaces the previous one with no
 * code change — and viewing an archive shows that season's own name. Styled in
 * the shadowed-gold treatment used by the icon/logo.
 */
export function HomeTitle() {
  const { data } = useApi<LeagueResponse>('/api/league');
  const name = data?.league?.name?.trim();

  return (
    <h1 className="title-gold relative text-4xl font-extrabold tracking-tight sm:text-6xl">
      {/* Non-breaking space holds the line height until the name loads. */}
      {name || ' '}
    </h1>
  );
}
