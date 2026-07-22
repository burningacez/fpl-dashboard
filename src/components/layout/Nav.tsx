'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMyTeam, useSeason } from '@/components/providers';
import { IdentityModal } from '@/components/identity/IdentityModal';

const NAV_LINKS: { href: string; label: string }[] = [
  { href: '/', label: 'Home' },
  { href: '/week', label: 'Scores' },
  { href: '/planner', label: 'Planner' },
  { href: '/losers', label: 'Losers' },
  { href: '/motm', label: 'MOTM' },
  { href: '/earnings', label: 'Earnings' },
  { href: '/h2h', label: 'H2H' },
  { href: '/cup', label: 'Cup' },
  { href: '/hall-of-fame', label: 'Hall of Fame' },
  { href: '/set-and-forget', label: 'Set & Forget' },
  { href: '/analytics', label: 'Analytics' },
  { href: '/rules', label: 'Rules' },
  { href: '/admin', label: 'Admin' },
];

export function Nav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const { me, status, needsFirstRun } = useMyTeam();
  const { season, seasons, setSeason } = useSeason();

  const showSeasonSelector = seasons.length > 1;

  // Auto-open the picker once on first launch (never claimed a team yet).
  const autoOpened = useRef(false);
  useEffect(() => {
    if (needsFirstRun && !autoOpened.current) {
      autoOpened.current = true;
      setPickerOpen(true);
    }
  }, [needsFirstRun]);

  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
        <Link href="/" className="flex items-center" aria-label="Barry's Fantasy Premier League — Home">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/bfpl-banner.png" alt="Barry's Fantasy Premier League" className="h-11 w-auto" />
        </Link>

        <nav
          className={`${
            menuOpen ? 'flex' : 'hidden'
          } absolute right-2 top-full mt-1 max-h-[80vh] w-max min-w-32 flex-col gap-0.5 overflow-y-auto rounded-lg border border-edge bg-surface p-2 shadow-lg`}
        >
          {NAV_LINKS.map((link) => {
            const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className={`whitespace-nowrap rounded-md px-3 py-1.5 text-right text-sm font-semibold transition-colors ${
                  active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-raised hover:text-body'
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {showSeasonSelector && (
            <select
              aria-label="Season"
              value={season ?? ''}
              onChange={(e) => setSeason(e.target.value || null)}
              className="rounded-md border border-edge bg-raised px-2 py-1.5 text-sm text-body"
            >
              {seasons.map((s) => (
                <option key={s.id} value={s.isCurrent ? '' : s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          )}

          {status === 'member' ? (
            // Locked in — tap to switch (requires the admin code).
            <button
              onClick={() => setPickerOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-me px-3 py-1.5 text-sm font-bold text-me"
              title={`Locked in as ${me?.name} — tap to switch (needs the admin code)`}
            >
              <span aria-hidden>👤</span>
              <span className="max-w-28 truncate">{me?.name.split(' ')[0]}</span>
            </button>
          ) : status === 'ex-member' ? (
            // Claimed but not in the current league — tap to switch (admin code).
            <button
              onClick={() => setPickerOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-warning px-3 py-1.5 text-sm font-bold text-warning"
              title="Not in the current league this season — archives still highlight you. Tap to switch (needs the admin code)."
            >
              <span aria-hidden>👤</span>
              <span className="max-w-28 truncate">{me?.name.split(' ')[0]}</span>
            </button>
          ) : status === 'visitor' ? (
            // Visitor — can claim a team later (e.g. a new player who's joined).
            <button
              onClick={() => setPickerOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-edge-strong px-3 py-1.5 text-sm font-bold text-muted hover:border-me hover:text-me"
            >
              <span aria-hidden>👋</span>
              <span className="max-w-28 truncate">Claim team</span>
            </button>
          ) : (
            <button
              onClick={() => setPickerOpen(true)}
              className="flex items-center gap-1.5 rounded-full border border-edge-strong px-3 py-1.5 text-sm font-bold text-muted hover:border-me hover:text-me"
            >
              <span aria-hidden>👤</span>
              <span className="max-w-28 truncate">Who are you?</span>
            </button>
          )}

          <button
            className="rounded-md border border-edge px-2.5 py-1.5 text-sm"
            aria-label="Toggle menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            ☰
          </button>
        </div>
      </div>

      {pickerOpen && <IdentityModal onClose={() => setPickerOpen(false)} />}
    </header>
  );
}
