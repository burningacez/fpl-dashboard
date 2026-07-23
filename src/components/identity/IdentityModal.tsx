'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMyTeam } from '@/components/providers';
import type { Member } from '@/lib/identity';

/**
 * "Who are you?" modal. Identification, not authentication.
 *
 * - Unclaimed / visitor: pick a team (two-step confirm — the choice is
 *   enforced server-side and can't be self-changed) or decline as a visitor.
 * - Member / ex-member: locked. Opening it shows the switch flow — enter the
 *   rotating admin code (ask the league owner) to release the claim and re-pick.
 *
 * Ownership is server-enforced: a team can be held by only one device.
 */
export function IdentityModal({ onClose }: { onClose: () => void }) {
  const { status, members, membersLoaded, claimTeam, becomeVisitor, switchIdentity } = useMyTeam();
  const locked = status === 'member' || status === 'ex-member';

  // Locked users start in the switch (code) view; everyone else picks directly.
  const [view, setView] = useState<'switch' | 'pick'>(locked ? 'switch' : 'pick');
  const [idInput, setIdInput] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Member | null>(null);
  const [busy, setBusy] = useState(false);

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

  const confirmClaim = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    const res = await claimTeam(pending);
    setBusy(false);
    if (res.ok) {
      onClose();
      return;
    }
    // Stay on the confirm view so the refusal is visible right where the user
    // clicked — bouncing to the (scrolled-to-top) list hid the message.
    setError(
      res.reason === 'taken'
        ? 'That team is actively claimed on another device. If that device is yours, use it (or ask the admin to release the claim).'
        : res.reason === 'locked'
          ? 'This device already holds a team — use the switch code.'
          : 'Something went wrong. Try again.',
    );
  };

  const submitCode = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const ok = await switchIdentity(codeInput);
    setBusy(false);
    if (ok) {
      setCodeInput('');
      setView('pick'); // released + code rotated; let them re-pick
      return;
    }
    setError('That code is not valid. Ask the league admin for the current code.');
  };

  const visit = () => {
    becomeVisitor();
    onClose();
  };

  // Portal to <body>: the sticky nav uses backdrop-blur, which creates a
  // containing block for position:fixed descendants.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-edge bg-surface p-5 sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-extrabold">{view === 'switch' ? 'Switch team' : 'Who are you?'}</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-md px-2 py-1 text-muted hover:bg-raised">
            ✕
          </button>
        </div>

        {view === 'switch' ? (
          // Locked → require the rotating admin code to change teams.
          <div>
            <p className="mb-4 text-sm text-muted">
              Your team is locked in. To switch, ask the league admin for the current code — it changes after each
              use.
            </p>
            <div className="flex gap-2">
              <input
                autoFocus
                value={codeInput}
                onChange={(e) => {
                  setCodeInput(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && submitCode()}
                placeholder="Admin code"
                className="flex-1 rounded-md border border-edge bg-raised px-3 py-2 uppercase tracking-widest text-body placeholder:normal-case placeholder:tracking-normal placeholder:text-faint"
              />
              <button
                onClick={submitCode}
                disabled={busy || !codeInput.trim()}
                className="rounded-md bg-accent px-4 py-2 font-bold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                {busy ? '…' : 'Switch'}
              </button>
            </div>
            {error && <p className="mt-2 text-sm text-negative">{error}</p>}
          </div>
        ) : pending ? (
          // Two-step confirm — claiming locks the team to this device.
          <div>
            <p className="mb-4 text-sm text-muted">Lock in as this team? You&apos;ll need the admin code to change it.</p>
            <div className="mb-5 rounded-lg border border-me bg-me-soft px-4 py-3">
              <span className="block font-bold">{pending.name}</span>
              <span className="block text-sm text-muted">{pending.team}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setError(null);
                  setPending(null);
                }}
                disabled={busy}
                className="flex-1 rounded-md border border-edge px-3 py-2 font-semibold text-muted hover:border-body hover:text-body disabled:opacity-50"
              >
                Back
              </button>
              <button
                onClick={confirmClaim}
                disabled={busy}
                className="flex-1 rounded-md bg-accent px-4 py-2 font-bold text-accent-fg hover:bg-accent-hover disabled:opacity-50"
              >
                {busy ? 'Locking…' : 'Lock it in'}
              </button>
            </div>
            {error && <p className="mt-2 text-sm text-negative">{error}</p>}
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-muted">
              Pick your team to get highlighted across the whole dashboard. Once claimed, only the admin code can
              change it.
            </p>

            {!membersLoaded && <p className="py-6 text-center text-muted">Loading league members…</p>}

            <div className="flex flex-col gap-1.5">
              {members.map((m) => (
                <button
                  key={m.entryId}
                  onClick={() => {
                    setError(null);
                    setPending(m);
                  }}
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
