import 'server-only';

declare global {
  // Idempotence guard: register() can run more than once in dev.
  var __fplBooted: boolean | undefined;
}

/**
 * Boot sequence for the long-lived Node process (Render runs `next start`
 * as a single persistent instance): validate config, hydrate the data cache
 * from Redis, start the live-polling scheduler.
 *
 * Stages are wired in as their modules are ported.
 */
export async function bootServer(): Promise<void> {
  if (globalThis.__fplBooted) return;
  globalThis.__fplBooted = true;

  console.log('[boot] FPL dashboard server booting');
  // TODO(port): config.validate()
  // TODO(port): hydrate data cache from Redis + CACHE_VERSION check
  // TODO(port): refreshAllData('startup') + refreshWeekData()
  // TODO(port): start match-window live-polling scheduler
}
