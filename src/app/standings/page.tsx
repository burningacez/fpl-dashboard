import { redirect } from 'next/navigation';

// Standings lives on the Live page now (legacy week.html structure): the table
// is ranked by overall total with movement arrows. Forward query params so old
// /standings?profile=<id> deep links keep opening the profile modal.
export default async function StandingsRedirect({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    // 'view' was the legacy tab param; the merged page has no standings tab.
    if (typeof v === 'string' && k !== 'view') params.set(k, v);
  }
  const qs = params.toString();
  redirect(qs ? `/week?${qs}` : '/week');
}
