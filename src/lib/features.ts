/**
 * Feature flags.
 *
 * The team planner has shipped — it's on everywhere, no configuration needed.
 * Kept as a named constant only so the existing guards/imports keep compiling;
 * the flag (and its guards) can be removed entirely in a later cleanup.
 */
export const PLANNER_ENABLED = true;
