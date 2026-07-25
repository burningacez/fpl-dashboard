import 'server-only';

/**
 * Manual weekly-loser corrections: season → gameweek → FPL entry id.
 *
 * Server-only on purpose. These used to live in lib/season-config.ts keyed by
 * display name, which (a) shipped real names in the client JS bundle and
 * (b) silently stopped matching if a manager renamed their FPL account.
 * Entry ids are stable within a season and already appear in API payloads.
 */
export const LOSER_OVERRIDES: Record<string, Record<number, number>> = {
  '2025-26': {
    2: 4616587, // Grant Clark's entry — manual GW2 correction
    12: 1282728, // James Armstrong's entry — manual GW12 correction
  },
  '2026-27': {},
};

export function getLoserOverrides(season: string): Record<number, number> {
  return LOSER_OVERRIDES[season] ?? {};
}
