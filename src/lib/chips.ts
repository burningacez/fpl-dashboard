/**
 * Canonical chip names — the single source for chip display labels.
 *
 * Four pages used to carry their own divergent maps, and only the cup page
 * knew about the Assistant Manager chip ('manager'), so everywhere else it
 * rendered as the raw API string. Unknown future chips fall back to the raw
 * code rather than disappearing.
 */

export const CHIP_META: Record<string, { name: string; abbr: string }> = {
  wildcard: { name: 'Wildcard', abbr: 'WC' },
  freehit: { name: 'Free Hit', abbr: 'FH' },
  bboost: { name: 'Bench Boost', abbr: 'BB' },
  '3xc': { name: 'Triple Captain', abbr: 'TC' },
  manager: { name: 'Assistant Manager', abbr: 'AM' },
};

/** Short badge form, e.g. 'WC'. Unknown chips return the raw code. */
export function chipAbbr(chip: string): string {
  return CHIP_META[chip]?.abbr ?? chip;
}

/** Full display name, e.g. 'Wildcard'. Unknown chips return the raw code. */
export function chipName(chip: string): string {
  return CHIP_META[chip]?.name ?? chip;
}
