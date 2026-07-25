'use client';

import Link from 'next/link';
import { PLANNER_ENABLED } from '@/lib/features';

// `enabled: false` drops a tile from the gallery (feature-flagged pages not yet released).
// `fullWidth: true` spans the tile across the whole grid row; `wide: true` spans two columns.
const CARDS: { href: string; tag: string; title: string; desc: string; enabled?: boolean; fullWidth?: boolean; wide?: boolean }[] = [
  { href: '/week', tag: 'Matchday', title: 'Scores', desc: 'Gameweek scores, league standings, and pitch views' },
  { href: '/losers', tag: 'Shame', title: 'Weekly Losers', desc: 'See who scored the lowest each gameweek' },
  { href: '/motm', tag: 'Awards', title: 'Manager of the Month', desc: 'Period rankings and monthly winners' },
  { href: '/cup', tag: 'Knockout', title: 'Cup', desc: 'Knockout cup competition and bracket' },
  { href: '/earnings', tag: 'Money', title: 'Earnings', desc: 'Financial breakdown for each manager' },
  { href: '/planner', tag: 'Strategy', title: 'Team Planner', desc: 'Plan transfers, prices and fixtures weeks ahead', enabled: PLANNER_ENABLED, fullWidth: true },
  { href: '/h2h', tag: 'Rivalry', title: 'Head to Head', desc: 'Compare any two managers side by side' },
  { href: '/set-and-forget', tag: 'What if', title: 'Set & Forget', desc: 'What if you never changed your GW1 team?' },
  { href: '/hall-of-fame', tag: 'History', title: 'Hall of Fame', desc: 'League records, highlights and lowlights' },
  { href: '/analytics', tag: 'Deep dive', title: 'Analytics', desc: 'Season trends and manager statistics' },
  { href: '/rules', tag: 'Small print', title: 'Rules', desc: 'League rules and prize structure', wide: true },
];

// On touch devices CSS :hover never fires and :active is deliberately withheld by the
// browser while it decides whether a touch is a tap or a scroll — so the accent either
// lagged behind a held finger or flashed and vanished on a scroll flick. Driving the
// accent from touchstart instead lights the tile the instant a finger lands, every time,
// even when the touch immediately turns into a scroll. We toggle a `data-touched`
// attribute imperatively (no re-render) and mirror the hover styles via data-[touched]
// variants. touchend/touchcancel clear it; touchcancel is what fires when a scroll takes over.
function markTouched(el: HTMLElement) {
  el.setAttribute('data-touched', 'true');
}
function clearTouched(el: HTMLElement) {
  el.removeAttribute('data-touched');
}

export function HomeCards() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      {CARDS.filter((card) => card.enabled !== false).map((card, i) => {
        const featured = i === 0;
        return (
          <Link
            key={card.href}
            href={card.href}
            onTouchStart={(e) => markTouched(e.currentTarget)}
            onTouchEnd={(e) => clearTouched(e.currentTarget)}
            onTouchCancel={(e) => clearTouched(e.currentTarget)}
            className={`group relative isolate flex flex-col justify-between overflow-hidden rounded-2xl border bg-gradient-to-br from-surface to-raised p-4 transition-all duration-200 hover:-translate-y-1 hover:shadow-[0_0_28px_var(--accent-soft)] data-[touched=true]:-translate-y-1 data-[touched=true]:shadow-[0_0_28px_var(--accent-soft)] sm:p-5 ${
              featured
                ? 'col-span-2 min-h-36 border-accent/40 sm:min-h-40'
                : card.fullWidth
                  ? 'col-span-2 min-h-32 border-edge hover:border-edge-strong data-[touched=true]:border-edge-strong sm:min-h-36 lg:col-span-4'
                  : card.wide
                    ? 'col-span-2 min-h-32 border-edge hover:border-edge-strong data-[touched=true]:border-edge-strong sm:min-h-36'
                    : 'min-h-32 border-edge hover:border-edge-strong data-[touched=true]:border-edge-strong sm:min-h-36'
            }`}
          >
            {/* Ghosted serial number, tucked into the corner. */}
            <span
              aria-hidden
              className="absolute -bottom-4 -right-1 z-[-1] select-none text-7xl font-black tracking-tighter text-body/[0.05] transition-colors duration-300 group-hover:text-accent/15 group-data-[touched=true]:text-accent/15 sm:text-8xl"
            >
              {String(i + 1).padStart(2, '0')}
            </span>
            {/* Accent bar sweeps in along the top edge on hover. */}
            <span
              aria-hidden
              className="absolute inset-x-0 top-0 h-0.5 origin-left scale-x-0 bg-accent transition-transform duration-300 group-hover:scale-x-100 group-data-[touched=true]:scale-x-100"
            />
            <span>
              <span
                className={`mb-1.5 block text-[10px] font-bold uppercase tracking-[0.2em] transition-colors group-hover:text-accent group-data-[touched=true]:text-accent ${
                  featured ? 'text-accent' : 'text-faint'
                }`}
              >
                {card.tag}
              </span>
              <span className="flex items-start justify-between gap-3">
                <span
                  className={`font-extrabold leading-snug tracking-tight transition-colors group-hover:text-accent group-data-[touched=true]:text-accent ${
                    featured ? 'text-xl sm:text-2xl' : 'sm:text-lg'
                  }`}
                >
                  {card.title}
                </span>
                <span
                  aria-hidden
                  className="mt-0.5 text-faint transition-all duration-200 group-hover:translate-x-1 group-hover:text-accent group-data-[touched=true]:translate-x-1 group-data-[touched=true]:text-accent"
                >
                  &rarr;
                </span>
              </span>
            </span>
            <span className={`mt-3 leading-relaxed text-muted ${featured ? 'text-sm' : 'text-xs sm:text-sm'}`}>
              {card.desc}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
