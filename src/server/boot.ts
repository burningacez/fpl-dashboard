import 'server-only';

/**
 * Boot sequence for the long-lived Node process (Render runs `next start`
 * as a single persistent instance) — port of legacy/server.js startup()
 * (lines 7992-8052) and gracefulShutdown() (lines 8060-8078).
 *
 * Adaptations from legacy:
 * - No server.listen(): Next.js owns the HTTP server. In its place we start
 *   the SSE heartbeat (which legacy started at module load).
 * - loadVisitorStats() is SKIPPED: visitor tracking was deliberately dropped
 *   in the rewrite.
 * - gracefulShutdown has no HTTP server to close; it goes straight to the
 *   logger flush.
 */

import config from '@/server/config';
import * as logger from '@/server/logger';
import { redisGet, redisSet } from '@/server/redis';
import {
  dataCache,
  loadDataCache,
  loadCoinFlips,
  loadArchivedSeasons,
  CACHE_VERSION,
} from '@/server/data-cache';
import { refreshAllData } from '@/server/services/refresh';
import { refreshWeekData } from '@/server/services/week';
import { scheduleRefreshes } from '@/server/live/scheduler';
import { initEmailTransporter } from '@/server/email';
import { startSseHeartbeat } from '@/server/live/sse-hub';

declare global {
  // Idempotence guard: register() can run more than once in dev.
  var __fplBooted: boolean | undefined;
  var __fplShutdownHooked: boolean | undefined;
}

export async function bootServer(): Promise<void> {
  if (globalThis.__fplBooted) return;
  globalThis.__fplBooted = true;

  // Intercept console immediately so all subsequent console.log/error/warn are captured
  // (legacy did this at module load, right after requiring the logger)
  logger.interceptConsole();

  registerShutdownHooks();

  console.log('='.repeat(60));
  console.log('FPL Dashboard Server Starting');
  console.log('='.repeat(60));

  // Initialize logger with Redis persistence
  await logger.init({
    redisGet: redisGet,
    redisSet: redisSet,
    maxMemoryLogs: config.logging.MAX_MEMORY_LOGS,
    retentionMs: config.logging.RETENTION_MS,
    minLevel: config.logging.MIN_LEVEL,
  });
  console.log('[Logger] Initialized with 3-day retention');

  // Initialize email transporter
  initEmailTransporter();

  // Load archived seasons and cached data from Redis
  // (legacy also loaded visitor stats here; visitor tracking was dropped in the rewrite)
  await loadArchivedSeasons();
  await loadDataCache();
  await loadCoinFlips();

  // Legacy started the HTTP server here so Render detects the port quickly;
  // Next.js owns the server in the rewrite. Start the SSE heartbeat instead
  // (legacy ran it from module load).
  startSseHeartbeat();

  // Schedule refreshes based on fixtures
  await scheduleRefreshes();

  // Initial data refresh to populate caches.
  // Always run if weekHistoryCache is empty (it's built from processedPicksCache
  // which is not persisted to Redis, so it must be rebuilt on first deploy).
  // Also run if hallOfFame/setAndForget are missing (first-ever startup),
  // or if hallOfFame is stale (missing fields added in newer code),
  // or if persisted cacheVersion is behind CACHE_VERSION (calc logic changed).
  const hofStale = dataCache.hallOfFame && !dataCache.hallOfFame.highlights?.mostWeeklyWins;
  const cacheVersionStale = dataCache.cacheVersion !== CACHE_VERSION;
  const needsFullRefresh = !dataCache.hallOfFame || !dataCache.setAndForget
    || Object.keys(dataCache.weekHistoryCache).length === 0
    || hofStale
    || cacheVersionStale;
  if (needsFullRefresh) {
    if (cacheVersionStale) {
      console.log(`[Startup] Cache version stale (was ${dataCache.cacheVersion}, expected ${CACHE_VERSION}). Forcing full rebuild.`);
    } else {
      console.log('[Startup] Running initial data refresh...');
    }
    // A transient FPL API hiccup here would otherwise leave profiles/hall-of-fame
    // empty (404s) until the next scheduled refresh. Retries reuse the FPL
    // response caches warmed by earlier attempts, so they get progressively cheaper.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await refreshAllData('startup');
      if (result?.success) break;
      console.warn(`[Startup] Initial refresh attempt ${attempt}/3 failed: ${result?.error}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }

  // Always refresh week data on startup - the Redis-persisted week data may be stale
  // (e.g. bonus points added after last save, code fixes changing score calculations)
  console.log('[Startup] Refreshing week data...');
  await refreshWeekData().catch((e: any) => console.error('[Startup] Week refresh failed:', e.message));

  console.log('[Startup] Initialization complete');
}

// =============================================================================
// GRACEFUL SHUTDOWN
// =============================================================================

function gracefulShutdown(signal: string): void {
  console.log(`\n[Shutdown] Received ${signal}, shutting down gracefully...`);

  // Legacy closed its HTTP server here before flushing; Next.js owns the
  // server in the rewrite, so flush the logger directly.
  (async () => {
    await logger.shutdown();
    console.log('[Shutdown] Goodbye!');
    process.exit(0);
  })();

  // Force exit after 10 seconds if graceful shutdown fails
  setTimeout(() => {
    console.error('[Shutdown] Forced exit after timeout');
    process.exit(1);
  }, 10000);
}

export function registerShutdownHooks(): void {
  if (globalThis.__fplShutdownHooked) return;
  globalThis.__fplShutdownHooked = true;

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
