'use client';

import { useState } from 'react';
import { useMyTeam } from '@/components/providers';

/**
 * "Who are you?" member picker. Identification, not authentication: pick
 * your team from the league list, or enter your FPL team ID — validated
 * against the league members; unknown IDs are rejected, nothing stored.
 */
export function IdentityModal({ onClose }: { onClose: () => void }) {
  const { me, members, membersLoaded, login, logout } = useMyTeam();
  const [idInput, setIdInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submitId = () => {
    const id = parseInt(idInput.trim(), 10);
    if (!Number.isInteger(id) || id <= 0) {
      setError('Enter a valid FPL team ID (a number).');
      return;
    }
    const match = members.find((m) => m.entryId === id);
    if (!match) {
      setError(`Team ID ${id} isn't in this league.`);
      return;
    }
    login(match);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-edge bg-surface p-5 sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-extrabold">Who are you?</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md px-2 py-1 text-muted hover:bg-raised">
            ✕
          </button>
        </div>

        <p className="mb-4 text-sm text-muted">
          Pick your team to get highlighted across the whole dashboard. This identifies you on this
          device only — it isn&apos;t a password login.
        </p>

        {!membersLoaded && <p className="py-6 text-center text-muted">Loading league members…</p>}

        <div className="flex flex-col gap-1.5">
          {members.map((m) => {
            const selected = me?.entryId === m.entryId;
            return (
              <button
                key={m.entryId}
                onClick={() => {
                  login(m);
                  onClose();
                }}
                className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                  selected ? 'border-me bg-me-soft' : 'border-edge bg-raised hover:border-me'
                }`}
              >
                <span className="block font-bold">
                  {m.name}
                  {selected && <span className="ml-2 text-xs font-extrabold text-me">YOU</span>}
                </span>
                <span className="block text-sm text-muted">{m.team}</span>
              </button>
            );
          })}
        </div>

        <div className="mt-5 border-t border-edge pt-4">
          <label className="mb-1.5 block text-sm font-semibold text-muted" htmlFor="fpl-team-id">
            Or enter your FPL team ID
          </label>
          <div className="flex gap-2">
            <input
              id="fpl-team-id"
              inputMode="numeric"
              value={idInput}
              onChange={(e) => {
                setIdInput(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && submitId()}
              placeholder="e.g. 1405359"
              className="flex-1 rounded-md border border-edge bg-raised px-3 py-2 text-body placeholder:text-faint"
            />
            <button
              onClick={submitId}
              className="rounded-md bg-accent px-4 py-2 font-bold text-accent-fg hover:bg-accent-hover"
            >
              Go
            </button>
          </div>
          {error && <p className="mt-2 text-sm text-negative">{error}</p>}
        </div>

        {me && (
          <button
            onClick={() => {
              logout();
              onClose();
            }}
            className="mt-4 w-full rounded-md border border-edge px-3 py-2 font-semibold text-muted hover:border-negative hover:text-negative"
          >
            Log out ({me.name})
          </button>
        )}
      </div>
    </div>
  );
}
