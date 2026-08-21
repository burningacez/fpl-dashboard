'use client';

import { useEffect, useState } from 'react';
import { useSeason } from '@/components/providers';

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Set when the server says the dataset legitimately doesn't exist
   *  ({ available: false, reason }) — an empty state, not an error. */
  empty: string | null;
  /** True while FPL's deadline-maintenance window has the API offline
   *  ({ updating: true } envelope). The hook refetches on its own until the
   *  window closes, so pages just render a friendly holding state. */
  updating: boolean;
}

/** How often to re-check while FPL's "game is being updated" window is open. */
const UPDATING_RETRY_MS = 60_000;

/**
 * Client data-fetch hook matching the legacy pages' model (static shell +
 * fetch on load). Automatically appends ?season= when an archived season is
 * selected, and refetches when the season changes.
 */
export function useApi<T>(path: string | null): ApiState<T> & { refetch: () => void } {
  const { withSeason } = useSeason();
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    loading: true,
    error: null,
    empty: null,
    updating: false,
  });
  const [nonce, setNonce] = useState(0);

  const url = path ? withSeason(path) : null;

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // While the updating window is open, retries happen behind the holding
    // state — don't flash the loading skeleton on every re-check.
    setState((s) => ({ ...s, loading: !s.updating, error: null, empty: null }));
    fetch(url)
      .then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }))
      .then(({ ok, status, body }: { ok: boolean; status: number; body: any }) => {
        if (cancelled) return;
        // Typed "FPL is updating the game" envelope: a known, temporary state,
        // not an error — hold the friendly state and re-check on a timer.
        if (body?.updating) {
          setState({ data: null, loading: false, error: null, empty: null, updating: true });
          retry = setTimeout(() => setNonce((n) => n + 1), UPDATING_RETRY_MS);
          return;
        }
        if (!ok) throw new Error(body?.error || `HTTP ${status}`);
        // Typed "no data for this season" envelope (and legacy bare-null
        // bodies): a friendly empty state rather than a blank page.
        if (body == null || body.available === false) {
          setState({
            data: null,
            loading: false,
            error: null,
            empty: body?.reason ?? 'No data available for this season yet.',
            updating: false,
          });
          return;
        }
        setState({ data: body as T, loading: false, error: null, empty: null, updating: false });
      })
      .catch((e) => {
        if (!cancelled)
          setState({ data: null, loading: false, error: (e as Error).message, empty: null, updating: false });
      });
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [url, nonce]);

  return { ...state, refetch: () => setNonce((n) => n + 1) };
}
