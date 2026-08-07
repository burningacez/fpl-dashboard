/**
 * Preview access — run a finished feature in production, against real data,
 * with only a named few able to see it, then release it to the league by
 * changing one line here.
 *
 * Two moving parts, deliberately separate:
 *
 * - `PREVIEW_GATED` (below, in code): whether a feature is *still* in preview.
 *   Flipping an entry to `false` releases it to every logged-in user and ships
 *   as a commit, so the release is reviewable and revertable.
 * - `PREVIEW_ENTRY_IDS` (environment): *who* gets in while a feature is gated.
 *   Entry ids stay out of the repo so no member identifiers ship in the bundle,
 *   and the list changes without a deploy.
 *
 * Keeping them apart is the point: releasing a feature never depends on
 * remembering to clear an environment variable, and the allowlist survives the
 * release ready to gate the next thing.
 *
 * To gate the next feature: add a key to `PREVIEW_GATED` with `true`, call
 * `previewAllowed('your-feature', entryId)` wherever the feature is served,
 * and set `PREVIEW_ENTRY_IDS` in the deployment to the entry ids that should
 * see it. To release it: set the key to `false` (leave the env var alone).
 *
 * Decide this server-side. A client-side check would ship the feature — and
 * the ids — to everyone who looks at the bundle.
 */

import config from '@/server/config';

/** Features that can be preview-gated. Keys are stable, kebab-case names. */
export type PreviewFeature = 'planner-squad-builder' | 'guided-walkthroughs';

/**
 * Whether each feature is still restricted to the preview allowlist.
 *
 * - `planner-squad-builder`: released 2026-08. The pre-season squad builder is
 *   open to every logged-in user; before that it ran gated through the 26/27
 *   pre-season while the builder and the GW1-unlimited fold were shaken out.
 * - `guided-walkthroughs`: released 2026-08. The guided demos on every page
 *   that has one. One flag for the feature rather than one per page, since they
 *   were meant to go out together; splitting it later is a one-line change.
 *   Before that it ran gated while the copy and pacing were shaken out on a
 *   real phone. Releasing it shows the walkthrough once to everyone who has not
 *   already been through it, including people who have used the page for
 *   months, since a device only records the walkthrough as seen by actually
 *   running it, and a gated-out device never did. See src/app/week/weekTour.ts.
 *
 * Nothing is gated right now: both entries are `false`, so `PREVIEW_ENTRY_IDS`
 * currently admits nobody to anything (it doesn't need clearing) and stays
 * ready for the next feature.
 */
const PREVIEW_GATED: Record<PreviewFeature, boolean> = {
  'planner-squad-builder': false,
  'guided-walkthroughs': false,
};

/**
 * The allowlist rule on its own: does this entry get into a gated feature?
 *
 * An empty allowlist means on in development and off in production, so local
 * testing needs no setup while production stays closed until someone opts in.
 */
export function allowlistAdmits(allowlist: number[], entryId: number): boolean {
  if (allowlist.length === 0) return config.server.NODE_ENV !== 'production';
  return allowlist.includes(entryId);
}

/**
 * Whether `entryId` may use `feature`. Released features are open to every
 * logged-in user — an entry id is what "logged in" means here, since a team is
 * claimed before any of this is reachable.
 *
 * `allowlist` is injectable for tests; production reads the environment.
 */
export function previewAllowed(
  feature: PreviewFeature,
  entryId: number,
  allowlist: number[] = config.preview.ENTRY_IDS,
): boolean {
  if (!PREVIEW_GATED[feature]) return true;
  return allowlistAdmits(allowlist, entryId);
}
