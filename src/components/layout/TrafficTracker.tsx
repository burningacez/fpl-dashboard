'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useMyTeam } from '@/components/providers';
import { TRAFFIC_OPTOUT_KEY } from '@/lib/traffic';

/**
 * Page-view beacon. App Router navigation is client-side, so the server never
 * sees page changes — this component watches the pathname and reports each
 * viewed page to /api/traffic/track (which reads the fpl-device cookie to
 * attribute the view). Renders nothing.
 */
export function TrafficTracker() {
  const pathname = usePathname();
  const { status } = useMyTeam();
  const lastTracked = useRef<string | null>(null);

  useEffect(() => {
    // Wait for the identity load so /api/identity/me has minted the device
    // cookie before the first beacon (otherwise two fresh tokens race).
    if (status === 'loading') return;
    if (pathname === lastTracked.current) return; // strict-mode double effect
    if (pathname.startsWith('/admin')) return;
    if (typeof navigator !== 'undefined' && navigator.webdriver) return;
    try {
      if (window.localStorage.getItem(TRAFFIC_OPTOUT_KEY) === '1') return;
    } catch {
      // localStorage unavailable (private mode) — still count the view
    }

    lastTracked.current = pathname;
    const payload = JSON.stringify({ path: pathname });
    if (!navigator.sendBeacon?.('/api/traffic/track', payload)) {
      fetch('/api/traffic/track', {
        method: 'POST',
        body: payload,
        keepalive: true,
      }).catch(() => {});
    }
  }, [pathname, status]);

  return null;
}
