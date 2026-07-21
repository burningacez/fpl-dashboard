'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Card, PageHeader } from '@/components/ui';
import { loadIdentity, clearIdentity } from '@/lib/identity';

/**
 * Admin console — password-gated internal tools. The password is held only
 * in component state (never persisted) and passed to each endpoint the way
 * the API expects (POST JSON body for actions, ?password= for logs).
 */
export default function AdminPage() {
  const [password, setPassword] = useState('');
  const [authed, setAuthed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const verify = async () => {
    setErr(null);
    const res = await fetch('/api/admin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) setAuthed(true);
    else setErr('Invalid password');
  };

  if (!authed) {
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <PageHeader title="Admin" />
        <Card>
          <label className="mb-1.5 block text-sm font-semibold text-muted" htmlFor="admin-pw">
            Admin password
          </label>
          <div className="flex gap-2">
            <input
              id="admin-pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && verify()}
              className="flex-1 rounded-md border border-edge bg-raised px-3 py-2"
            />
            <button onClick={verify} className="rounded-md bg-accent px-4 py-2 font-bold text-accent-fg">
              Unlock
            </button>
          </div>
          {err && <p className="mt-2 text-sm text-negative">{err}</p>}
        </Card>
      </main>
    );
  }

  return <AdminConsole password={password} />;
}

function AdminConsole({ password }: { password: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [gwInput, setGwInput] = useState('');

  const runAction = useCallback(
    async (label: string, path: string, extra?: Record<string, unknown>) => {
      if (busy) return;
      setBusy(label);
      setStatus(null);
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password, ...extra }),
        });
        const data = await res.json().catch(() => ({}));
        setStatus(`${label}: ${res.ok ? 'started' : `failed (${res.status})`} ${data.message || data.error || ''}`.trim());
      } catch (e: any) {
        setStatus(`${label}: ${e.message}`);
      } finally {
        setBusy(null);
      }
    },
    [busy, password],
  );

  const refreshGameweeks = () => {
    const gameweeks = gwInput
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => !isNaN(n));
    runAction('Refresh gameweeks', '/api/admin/refresh-gameweeks', { gameweeks });
  };

  const actions: { label: string; path: string; desc: string }[] = [
    { label: 'Rebuild historical data', path: '/api/admin/rebuild-historical-data', desc: 'Full rebuild of all derived caches (slow).' },
    { label: 'Archive current season', path: '/api/archive-season', desc: 'Snapshot the current season into the archive.' },
  ];

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 pb-12">
      <PageHeader title="Admin" subtitle="Internal maintenance tools" />

      <div className="mb-4 flex flex-col gap-3">
        <Card>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <div className="font-bold">Refresh specific gameweeks</div>
              <div className="mb-2 text-sm text-muted">Clear and re-fetch data for specific gameweeks only.</div>
              <input
                value={gwInput}
                onChange={(e) => setGwInput(e.target.value)}
                placeholder="e.g. 24, 27"
                className="w-40 rounded-md border border-edge bg-raised px-3 py-1.5 text-sm"
              />
            </div>
            <button
              onClick={refreshGameweeks}
              disabled={busy !== null || !gwInput.trim()}
              className="rounded-md bg-accent px-4 py-2 font-bold text-accent-fg disabled:opacity-50"
            >
              {busy === 'Refresh gameweeks' ? 'Working…' : 'Run'}
            </button>
          </div>
        </Card>
        {actions.map((a) => (
          <Card key={a.label}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-bold">{a.label}</div>
                <div className="text-sm text-muted">{a.desc}</div>
              </div>
              <button
                onClick={() => runAction(a.label, a.path)}
                disabled={busy !== null}
                className="rounded-md bg-accent px-4 py-2 font-bold text-accent-fg disabled:opacity-50"
              >
                {busy === a.label ? 'Working…' : 'Run'}
              </button>
            </div>
          </Card>
        ))}
        <ResetIdentityCard />
      </div>

      {status && <div className="mb-4 rounded-lg border border-edge bg-raised p-3 text-sm">{status}</div>}

      <LogViewer password={password} />
    </main>
  );
}

/**
 * Reset the locked "who are you?" identity stored in THIS browser. Identity
 * lives in localStorage (it's per-device, not server-side), so this only
 * affects the current device — a stuck league-mate has to do it on theirs.
 * Clearing it makes the first-launch picker reappear on reload.
 */
function ResetIdentityCard() {
  const [current, setCurrent] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const id = loadIdentity();
    setCurrent(
      id?.status === 'member' ? `${id.name} — locked` : id?.status === 'visitor' ? 'Visitor' : null,
    );
  }, []);

  const reset = () => {
    if (!window.confirm('Reset the saved identity on THIS device? The first-launch picker will reappear on reload.')) {
      return;
    }
    clearIdentity();
    window.location.reload();
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-bold">Reset identity (this device)</div>
          <div className="text-sm text-muted">
            Clears the locked &ldquo;who are you?&rdquo; choice saved in this browser so the first-launch picker
            shows again.{' '}
            {current === undefined ? '' : current ? `Currently: ${current}.` : 'Nothing stored yet.'}
          </div>
        </div>
        <button
          onClick={reset}
          disabled={!current}
          className="rounded-md border border-negative/50 px-4 py-2 font-bold text-negative hover:bg-negative-soft disabled:opacity-40"
        >
          Reset
        </button>
      </div>
    </Card>
  );
}

const PAGE_SIZE = 100;

/** System log viewer (legacy admin.html): level/category/time filters, search,
 *  pagination, 10s auto-refresh, and clear. */
function LogViewer({ password }: { password: string }) {
  const [level, setLevel] = useState('');
  const [category, setCategory] = useState('');
  const [since, setSince] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [data, setData] = useState<{ entries: any[]; total: number; categories: string[] } | null>(null);
  const [stats, setStats] = useState<any>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ password, limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    if (level) params.set('level', level);
    if (category) params.set('category', category);
    if (search) params.set('search', search);
    if (since) params.set('since', String(Date.now() - Number(since)));
    const [logsRes, statsRes] = await Promise.all([
      fetch(`/api/admin/logs?${params}`).then((r) => r.json()),
      fetch(`/api/admin/logs/stats?password=${encodeURIComponent(password)}`).then((r) => r.json()),
    ]);
    if (!logsRes.error) setData(logsRes);
    if (!statsRes.error) setStats(statsRes);
  }, [password, level, category, search, since, page]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(load, 10000);
    return () => clearInterval(id);
  }, [autoRefresh, load]);

  const onSearch = (v: string) => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      setPage(0);
      setSearch(v);
    }, 300);
  };

  const clearAll = async () => {
    if (!window.confirm('Clear all logs?')) return;
    await fetch(`/api/admin/logs?password=${encodeURIComponent(password)}`, { method: 'DELETE' });
    setPage(0);
    load();
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const selectCls = 'rounded-md border border-edge bg-raised px-2 py-1.5 text-xs';

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-bold">System Logs</h2>
        {stats && (
          <span className="text-xs text-muted">
            {stats.total} entries · <span className="text-negative">{stats.counts?.error ?? 0} err</span> ·{' '}
            <span className="text-warning">{stats.counts?.warn ?? 0} warn</span>
          </span>
        )}
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        <select value={level} onChange={(e) => { setLevel(e.target.value); setPage(0); }} className={selectCls}>
          <option value="">All Levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(0); }} className={selectCls}>
          <option value="">All Categories</option>
          {(data?.categories ?? []).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select value={since} onChange={(e) => { setSince(e.target.value); setPage(0); }} className={selectCls}>
          <option value="">All Time (3 days)</option>
          <option value="3600000">Last Hour</option>
          <option value="21600000">Last 6 Hours</option>
          <option value="86400000">Last 24 Hours</option>
        </select>
        <input
          placeholder="Search logs…"
          onChange={(e) => onSearch(e.target.value)}
          className={`${selectCls} min-w-32 flex-1`}
        />
      </div>

      <div className="mb-2 flex items-center justify-between text-xs">
        <label className="flex items-center gap-1.5 text-muted">
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh (10s)
        </label>
        <span className="flex gap-2">
          <button onClick={load} className="rounded-md border border-edge px-2.5 py-1 hover:bg-raised">Refresh</button>
          <button onClick={clearAll} className="rounded-md border border-negative/50 px-2.5 py-1 text-negative hover:bg-negative-soft">
            Clear Logs
          </button>
        </span>
      </div>

      <div className="max-h-96 overflow-y-auto rounded-lg bg-raised p-2 font-mono text-xs">
        {!data && <p className="p-2 text-muted">Loading logs…</p>}
        {data?.entries.length === 0 && <p className="p-2 text-muted">No log entries.</p>}
        {data?.entries.map((l, i) => (
          <div key={i} className="border-b border-edge/50 py-1 last:border-0">
            <span className="text-faint">{new Date(l.t).toLocaleTimeString()}</span>{' '}
            <span className={l.level === 'error' ? 'text-negative' : l.level === 'warn' ? 'text-warning' : 'text-muted'}>
              [{l.level}]
            </span>{' '}
            <span className="text-accent">{l.cat}</span> {l.msg}
          </div>
        ))}
      </div>

      <div className="mt-2 flex items-center justify-between text-xs text-muted">
        <button
          disabled={page === 0}
          onClick={() => setPage((p) => p - 1)}
          className="rounded-md border border-edge px-2.5 py-1 disabled:opacity-30"
        >
          « Newer
        </button>
        <span>
          Page {page + 1} of {totalPages}
        </span>
        <button
          disabled={page + 1 >= totalPages}
          onClick={() => setPage((p) => p + 1)}
          className="rounded-md border border-edge px-2.5 py-1 disabled:opacity-30"
        >
          Older »
        </button>
      </div>
    </Card>
  );
}
