'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useState } from 'react';
import { Card, PageHeader } from '@/components/ui';

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
  const [logs, setLogs] = useState<any[] | null>(null);

  const runAction = useCallback(
    async (label: string, path: string) => {
      if (busy) return;
      setBusy(label);
      setStatus(null);
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
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

  const loadLogs = useCallback(async () => {
    const res = await fetch(`/api/admin/logs?password=${encodeURIComponent(password)}&limit=100`);
    const data = await res.json().catch(() => ({}));
    setLogs(data.entries ?? []);
  }, [password]);

  const actions: { label: string; path: string; desc: string }[] = [
    { label: 'Refresh gameweeks', path: '/api/admin/refresh-gameweeks', desc: 'Re-fetch and reprocess recent gameweek data.' },
    { label: 'Rebuild historical data', path: '/api/admin/rebuild-historical-data', desc: 'Full rebuild of all derived caches (slow).' },
    { label: 'Archive current season', path: '/api/archive-season', desc: 'Snapshot the current season into the archive.' },
  ];

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 pb-12">
      <PageHeader title="Admin" subtitle="Internal maintenance tools" />

      <div className="mb-4 flex flex-col gap-3">
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
      </div>

      {status && <div className="mb-4 rounded-lg border border-edge bg-raised p-3 text-sm">{status}</div>}

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-bold">Logs</h2>
          <button onClick={loadLogs} className="rounded-md border border-edge px-3 py-1.5 text-sm">
            Load recent
          </button>
        </div>
        {logs && (
          <div className="max-h-96 overflow-y-auto font-mono text-xs">
            {logs.length === 0 && <p className="text-muted">No log entries.</p>}
            {logs.map((l, i) => (
              <div key={i} className="border-b border-edge py-1">
                <span
                  className={
                    l.level === 'error' ? 'text-negative' : l.level === 'warn' ? 'text-warning' : 'text-muted'
                  }
                >
                  [{l.level}]
                </span>{' '}
                <span className="text-faint">{l.cat}</span> {l.msg}
              </div>
            ))}
          </div>
        )}
      </Card>
    </main>
  );
}
