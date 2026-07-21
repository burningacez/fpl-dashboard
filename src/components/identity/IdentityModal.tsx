'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMyTeam } from '@/components/providers';
import type { Member } from '@/lib/identity';

/**
 * "Who are you?" member picker — first-launch identification, not
 * authentication. Pick your team from the current league (or enter your FPL
 * team ID, validated against the league). The choice is PERMANENT on this
 * device: confirm before locking in, and once claimed this modal is never
 * reachable again. Visitors can decline and claim a team later.
 */
export function IdentityModal({ onClose }: { onClose: () => void }) {
  const { status, members, membersLoaded, claimTeam, becomeVisitor } = useMyTeam();
  const [idInput, setIdInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Member | null>(null);

  const chooseId = () => {
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
    setError(null);
    setPending(match);
  };

  const confirmClaim = () => {
    if (!pending) return;
    claimTeam(pending);
    onClose();
  };

  const visit = () => {
    becomeVisitor();
    onClose();
  };

  // Portal to <body>: the sticky nav uses backdrop-blur, which creates a
  // containing block for position:fixed descendants — rendering the overlay
  // inside the header would size it to the header, not the viewport.
  if (typeof document === 'undefined') return null;

  const alreadyMember = status === 'member';

  return createPortal(
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

        {alreadyMember ? (
          // Defensive: the modal shouldn't be reachable once claimed, but if it
          // is, never show the picker — the choice is locked.
          <p className="py-6 text-center text-sm text-muted">
            You&apos;re locked in on this device. Your identity can&apos;t be changed here.
          </p>
        ) : pending ? (
          // Two-step confirm — claiming is permanent.
          <div>
            <p className="mb-4 text-sm text-muted">Lock in as this team? This can&apos;t be changed later.</p>
            <div className="mb-5 rounded-lg border border-me bg-me-soft px-4 py-3">
              <span className="block font-bold">{pending.name}</span>
              <span className="block text-sm text-muted">{pending.team}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setPending(null)}
                className="flex-1 rounded-md border border-edge px-3 py-2 font-semibold text-muted hover:border-body hover:text-body"
              >
                Back
              </button>
              <button
                onClick={confirmClaim}
                className="flex-1 rounded-md bg-accent px-4 py-2 font-bold text-accent-fg hover:bg-accent-hover"
              >
                Lock it in
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-muted">
              Pick your team to get highlighted across the whole dashboard. This is a one-time choice on this
              device — you <span className="font-semibold text-body">can&apos;t change it later</span>.
            </p>

            {!membersLoaded && <p className="py-6 text-center text-muted">Loading league members…</p>}

            <div className="flex flex-col gap-1.5">
              {members.map((m) => (
                <button
                  key={m.entryId}
                  onClick={() => setPending(m)}
                  className="rounded-lg border border-edge bg-raised px-3 py-2 text-left transition-colors hover:border-me"
                >
                  <span className="block font-bold">{m.name}</span>
                  <span className="block text-sm text-muted">{m.team}</span>
                </button>
              ))}
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
                  onKeyDown={(e) => e.key === 'Enter' && chooseId()}
                  placeholder="e.g. 1405359"
                  className="flex-1 rounded-md border border-edge bg-raised px-3 py-2 text-body placeholder:text-faint"
                />
                <button
                  onClick={chooseId}
                  className="rounded-md bg-accent px-4 py-2 font-bold text-accent-fg hover:bg-accent-hover"
                >
                  Go
                </button>
              </div>
              {error && <p className="mt-2 text-sm text-negative">{error}</p>}
            </div>

            <button
              onClick={visit}
              className="mt-4 w-full rounded-md border border-edge px-3 py-2 text-sm font-semibold text-muted hover:border-body hover:text-body"
            >
              Not playing / just visiting — claim a team later
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
