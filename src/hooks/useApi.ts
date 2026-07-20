'use client';

import { useEffect, useState } from 'react';
import { useSeason } from '@/components/providers';

interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Client data-fetch hook matching the legacy pages' model (static shell +
 * fetch on load). Automatically appends ?season= when an archived season is
 * selected, and refetches when the season changes.
 */
export function useApi<T>(path: string | null): ApiState<T> & { refetch: () => void } {
  const { withSeason } = useSeason();
  const [state, setState] = useState<ApiState<T>>({ data: null, loading: true, error: null });
  const [nonce, setNonce] = useState(0);

  const url = path ? withSeason(path) : null;

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((e) => {
        if (!cancelled) setState({ data: null, loading: false, error: (e as Error).message });
      });
    return () => {
      cancelled = true;
    };
  }, [url, nonce]);

  return { ...state, refetch: () => setNonce((n) => n + 1) };
}
