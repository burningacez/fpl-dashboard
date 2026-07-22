import Link from 'next/link';
import { SeasonHeading } from '@/components/layout/SeasonHeading';

const CARDS: { href: string; title: string; desc: string }[] = [
  { href: '/week', title: 'Scores', desc: 'Gameweek scores, league standings, and pitch views' },
  { href: '/planner', title: 'Team Planner', desc: 'Plan transfers, prices and fixtures weeks ahead' },
  { href: '/cup', title: 'Cup', desc: 'Knockout cup competition and bracket' },
  { href: '/h2h', title: 'Head to Head', desc: 'Compare any two managers side by side' },
  { href: '/losers', title: 'Weekly Losers', desc: 'See who scored the lowest each gameweek' },
  { href: '/motm', title: 'Manager of the Month', desc: 'Period rankings and monthly winners' },
  { href: '/earnings', title: 'Earnings', desc: 'Financial breakdown for each manager' },
  { href: '/hall-of-fame', title: 'Hall of Fame', desc: 'League records, highlights and lowlights' },
  { href: '/set-and-forget', title: 'Set & Forget', desc: 'What if you never changed your GW1 team?' },
  { href: '/analytics', title: 'Analytics', desc: 'Season trends and manager statistics' },
  { href: '/rules', title: 'Rules', desc: 'League rules and prize structure' },
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl px-4 pb-12">
      <div className="py-10 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight text-accent sm:text-5xl">Si and chums</h1>
        <SeasonHeading />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 lg:grid-cols-4">
        {CARDS.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group relative flex min-h-32 flex-col justify-between overflow-hidden rounded-2xl border border-edge bg-gradient-to-br from-surface to-raised p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-edge-strong hover:shadow-[0_0_24px_var(--accent-soft)] sm:p-5"
          >
            {/* Accent bar sweeps in along the top edge on hover. */}
            <span
              aria-hidden
              className="absolute inset-x-0 top-0 h-0.5 origin-left scale-x-0 bg-accent transition-transform duration-300 group-hover:scale-x-100"
            />
            <span className="flex items-start justify-between gap-3">
              <span className="font-extrabold leading-snug tracking-tight transition-colors group-hover:text-accent sm:text-lg">
                {card.title}
              </span>
              <span
                aria-hidden
                className="mt-0.5 text-faint transition-all duration-200 group-hover:translate-x-1 group-hover:text-accent"
              >
                &rarr;
              </span>
            </span>
            <span className="mt-3 text-xs leading-relaxed text-muted sm:text-sm">{card.desc}</span>
          </Link>
        ))}
      </div>
    </main>
  );
}
