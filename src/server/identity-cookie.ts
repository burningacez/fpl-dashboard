import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import config from './config';
import { newDeviceToken } from './identity-store';

/**
 * Device-token cookie helpers. The token is an opaque id that ties a browser
 * to its claim in the registry; it is httpOnly so page JS can't read or forge
 * it. Clearing it makes the browser a fresh device (can claim an unclaimed
 * team, never one another device holds) — the documented, unavoidable residue
 * of enforcing identity without real logins.
 */

export const DEVICE_COOKIE = 'fpl-device';
const ONE_YEAR = 60 * 60 * 24 * 365;

export function readDeviceToken(req: NextRequest): string | null {
  return req.cookies.get(DEVICE_COOKIE)?.value ?? null;
}

/** Read the device token, minting a fresh one if absent. */
export function ensureDeviceToken(req: NextRequest): { token: string; isNew: boolean } {
  const existing = readDeviceToken(req);
  if (existing) return { token: existing, isNew: false };
  return { token: newDeviceToken(), isNew: true };
}

/** Attach the device cookie to a response (call when the token was minted). */
export function setDeviceCookie(res: NextResponse, token: string): void {
  res.cookies.set(DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: config.server.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: ONE_YEAR,
  });
}
