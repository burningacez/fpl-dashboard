import { redirect } from 'next/navigation';

// Standings lives as a tab on the Live page now (legacy week.html structure).
// Forward query params so old /standings?profile=<id> deep links keep working.
export default async function StandingsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams({ view: 'standings' });
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === 'string') params.set(k, v);
  }
  redirect(`/week?${params.toString()}`);
}
