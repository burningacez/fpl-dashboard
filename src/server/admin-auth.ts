import 'server-only';
import { timingSafeEqual } from 'crypto';
import type { NextRequest } from 'next/server';
import config from './config';

/**
 * Constant-time admin password comparison. All admin checks route through
 * here so the string-equality timing side channel is closed in one place.
 */
export function isAdminPassword(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  const expected = Buffer.from(config.ADMIN_PASSWORD);
  const given = Buffer.from(value);
  // timingSafeEqual requires equal lengths; compare against self on mismatch
  // so the work done is the same either way.
  if (given.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(given, expected);
}

/**
 * Header-based auth for admin GET/DELETE endpoints. The password travels in
 * the x-admin-key request header — NEVER in the query string, which gets
 * recorded in access logs, proxy logs and browser history.
 */
export function adminAuthorized(req: NextRequest): boolean {
  return isAdminPassword(req.headers.get('x-admin-key'));
}
