import Link from 'next/link';
import config from '@/server/config';

const CARDS: { href: string; icon: string; title: string; desc: string }[] = [
  { href: '/week', icon: '⚽', title: 'Scores', desc: 'Gameweek scores, league standings, and pitch views' },
  { href: '/planner', icon: '🧠', title: 'Team Planner', desc: 'Plan transfers, prices and fixtures weeks ahead' },
  { href: '/cup', icon: '🏆', title: 'Cup', desc: 'Knockout cup competition and bracket' },
  { href: '/h2h', icon: '🥊', title: 'Head to Head', desc: 'Compare any two managers side by side' },
  { href: '/losers', icon: '📉', title: 'Weekly Losers', desc: 'See who scored the lowest each gameweek' },
  { href: '/motm', icon: '👑', title: 'Manager of the Month', desc: 'Period rankings and monthly winners' },
  { href: '/chips', icon: '🎯', title: 'Chips Tracker', desc: 'Track chip usage across all managers' },
  { href: '/earnings', icon: '💰', title: 'Earnings', desc: 'Financial breakdown for each manager' },
  { href: '/hall-of-fame', icon: '🌟', title: 'Hall of Fame', desc: 'League records, highlights and lowlights' },
  { href: '/set-and-forget', icon: '🔒', title: 'Set & Forget', desc: 'What if you never changed your GW1 team?' },
  { href: '/analytics', icon: '📊', title: 'Analytics', desc: 'Season trends and manager statistics' },
  { href: '/rules', icon: '📜', title: 'Rules', desc: 'League rules and prize structure' },
];

export default function HomePage() {
  const seasonLabel = config.CURRENT_SEASON.replace('-', '-20');
  return (
    <main className="mx-auto max-w-6xl px-4 pb-12">
      <div className="py-10 text-center">
        <h1 className="text-4xl font-extrabold tracking-tight text-accent sm:text-5xl">Si and chums</h1>
        <p className="mt-2 text-lg text-muted">Season {seasonLabel}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group flex items-center gap-4 rounded-xl border border-edge bg-surface p-4 transition-colors hover:border-accent"
          >
            <span className="text-3xl" aria-hidden>
              {card.icon}
            </span>
            <span>
              <span className="block font-extrabold group-hover:text-accent">{card.title}</span>
              <span className="block text-sm text-muted">{card.desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </main>
  );
}
