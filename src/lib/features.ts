/**
 * Feature flags for staged rollout.
 *
 * The team planner is fully built but withheld from the live app until it's
 * been tested. All of its code — the page, the API routes, the squad-rules
 * lib and its tests — stays in the tree; these flags only control whether it's
 * reachable. To switch it back on (locally or in production) set
 * NEXT_PUBLIC_PLANNER_ENABLED=true (e.g. in .env.local).
 */
export const PLANNER_ENABLED = process.env.NEXT_PUBLIC_PLANNER_ENABLED === 'true';
