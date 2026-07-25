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
}

/**
 * Client data-fetch hook matching the legacy pages' model (static shell +
 * fetch on load). Automatically appends ?season= when an archived season is
 * selected, and refetches when the season changes.
 */
export function useApi<T>(path: string | null): ApiState<T> & { refetch: () => void } {
  const { withSeason } = useSeason();
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: true, error: null, empty: null });
  const [nonce, setNonce] = useState(0);

  const url = path ? withSeason(path) : null;

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null, empty: null }));
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        // Typed "no data for this season" envelope (and legacy bare-null
        // bodies): a friendly empty state rather than a blank page.
        if (data == null || data.available === false) {
          setState({
            data: null,
            loading: false,
            error: null,
            empty: data?.reason ?? 'No data available for this season yet.',
          });
          return;
        }
        setState({ data, loading: false, error: null, empty: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ data: null, loading: false, error: (e as Error).message, empty: null });
      });
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);

  return { ...state, refetch: () => setNonce((n) => n + 1) };
}
