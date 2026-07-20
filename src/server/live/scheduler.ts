import 'server-only';

/**
 * Live-polling scheduler — port of legacy/server.js:6120-6565
 * (startLivePolling, stopLivePolling, scheduleBonusConfirmationCheck,
 * checkAndStopPolling, scheduleRefreshes).
 *
 * Module state (livePollingInterval, isLivePolling, scheduledJobs, bonus
 * confirmation tracking) lives on a globalThis holder so dev-mode module
 * re-instantiation can't double-start timers.
 */

import { dataCache } from '@/server/data-cache';
import {
  fetchBootstrap,
  fetchBootstrapFresh,
  fetchFixtures,
  getCompletedGameweeks,
} from '@/server/fpl/client';
import {
  refreshAllData,
  morningRefreshWithAlert,
  getFixturesForCurrentGW,
} from '@/server/services/refresh';
import { refreshWeekData } from '@/server/services/week';
import { liveState, savePreviousPlayerState } from '@/server/live/state';
import { broadcastSSE } from '@/server/live/sse-hub';
import { groupFixturesIntoWindows, getMatchEndTime } from '@/lib/utils';

interface ScheduledJob {
  stop: () => void;
}

interface SchedulerState {
  // legacy/server.js:619 — SCHEDULED REFRESH TRACKING
  scheduledJobs: ScheduledJob[];
  // legacy/server.js:6066-6067 — FIXTURE TRACKING AND SCHEDULING
  livePollingInterval: ReturnType<typeof setInterval> | null;
  isLivePolling: boolean;
  // legacy/server.js:6184-6185
  bonusConfirmationTimeout: ReturnType<typeof setTimeout> | null;
  bonusConfirmationGW: number | null;
  // Re-entrancy guard for scheduleRefreshes (boot can run more than once in dev)
  isScheduling: boolean;
}

declare global {
  var __fplScheduler: SchedulerState | undefined;
}

const sched: SchedulerState = (globalThis.__fplScheduler ??= {
  scheduledJobs: [],
  livePollingInterval: null,
  isLivePolling: false,
  bonusConfirmationTimeout: null,
  bonusConfirmationGW: null,
  isScheduling: false,
});

// Note: getMatchEndTime and groupFixturesIntoWindows are imported from lib/utils.js

export function startLivePolling(reason: string): void {
  if (sched.isLivePolling) {
    console.log('[Live] Already polling - skipping start');
    return;
  }

  sched.isLivePolling = true;
  console.log(`[Live] Starting live polling (60s interval) - ${reason}`);
  broadcastSSE('status', { isLive: true, reason });

  // Cancel any pending bonus confirmation checks (new matches starting)
  if (sched.bonusConfirmationTimeout) {
    clearTimeout(sched.bonusConfirmationTimeout);
    sched.bonusConfirmationTimeout = null;
    sched.bonusConfirmationGW = null;
  }

  // Immediate refresh when starting
  refreshAllData(`live-start-${reason}`);
  refreshWeekData().catch((e: any) => console.error('[Live] Week refresh failed:', e.message));

  // Poll every 60 seconds
  sched.livePollingInterval = setInterval(async () => {
    await refreshAllData('live-poll');
    await refreshWeekData().catch((e: any) => console.error('[Live] Week refresh failed:', e.message));
  }, 60 * 1000);
}

export async function stopLivePolling(reason: string): Promise<void> {
  if (!sched.isLivePolling) return;

  sched.isLivePolling = false;
  broadcastSSE('status', { isLive: false, reason });
  if (sched.livePollingInterval) {
    clearInterval(sched.livePollingInterval);
    sched.livePollingInterval = null;
  }

  console.log(`[Live] Stopped live polling - ${reason}`);

  // Save previous state for restart recovery before stopping
  if (liveState.liveEventState.lastGW) {
    await savePreviousPlayerState(liveState.liveEventState.lastGW);
    console.log(`[Live] Saved previous state for GW${liveState.liveEventState.lastGW}`);
  }

  // Do one final refresh to capture final scores
  refreshAllData(`live-end-${reason}`);
  refreshWeekData().catch((e: any) => console.error('[Live] Week refresh failed:', e.message));

  // Start checking for official bonus confirmation (GW finished)
  // FPL confirms bonus shortly after all matches end - poll until confirmed
  // Pass the specific GW ID so we track it even after is_current moves to next GW
  const gwToConfirm = liveState.liveEventState.lastGW;
  if (gwToConfirm) {
    scheduleBonusConfirmationCheck(gwToConfirm);
  }
}

// Poll for official GW completion (bonus confirmation) after all matches finish
// Checks every 2-5 mins for up to 12 hours until the specific GW's finished flag becomes true
// When confirmed, triggers full data refresh (profiles, hall of fame, earnings, etc.)
// IMPORTANT: We track the specific GW ID rather than relying on is_current, because
// when FPL confirms a GW as finished, is_current moves to the NEXT GW simultaneously.
export function scheduleBonusConfirmationCheck(gwId: number): void {
  if (sched.bonusConfirmationTimeout) {
    clearTimeout(sched.bonusConfirmationTimeout);
    sched.bonusConfirmationTimeout = null;
  }

  sched.bonusConfirmationGW = gwId;
  const startTime = Date.now();
  const maxDuration = 12 * 60 * 60 * 1000; // 12 hours max
  let checkCount = 0;

  async function checkBonusConfirmed(): Promise<void> {
    try {
      const elapsed = Date.now() - startTime;
      if (elapsed > maxDuration) {
        console.log(`[Bonus] Max wait time reached (12 hours) for GW${gwId}, running fallback full refresh`);
        // Run a full refresh anyway - the GW is very likely finished by now
        const refreshResult = await refreshAllData('gameweek-confirmed');
        if (!refreshResult.success) {
          console.error(`[Bonus] GW${gwId} fallback refresh failed: ${refreshResult.error}`);
        }
        await refreshWeekData();
        sched.bonusConfirmationTimeout = null;
        sched.bonusConfirmationGW = null;
        setTimeout(scheduleRefreshes, 60000);
        return;
      }

      checkCount++;
      // Bypass bootstrap cache to get fresh data for this critical check
      const bootstrap = await fetchBootstrapFresh();
      const gwEvent = bootstrap?.events?.find((e: any) => e.id === gwId);

      if (gwEvent?.finished) {
        console.log(`[Bonus] GW${gwId} officially finished - bonus confirmed, running full data refresh`);
        const refreshResult = await refreshAllData('gameweek-confirmed');
        if (!refreshResult.success) {
          console.error(`[Bonus] GW${gwId} refresh failed: ${refreshResult.error} - will retry`);
          sched.bonusConfirmationTimeout = setTimeout(checkBonusConfirmed, 2 * 60 * 1000);
          return;
        }
        await refreshWeekData();
        sched.bonusConfirmationTimeout = null;
        sched.bonusConfirmationGW = null;
        // Re-schedule to pick up next gameweek timing
        setTimeout(scheduleRefreshes, 60000);
        return;
      }

      // Back off polling interval: 2 mins for first hour, then 5 mins after
      const pollInterval = elapsed < 60 * 60 * 1000
        ? 2 * 60 * 1000    // Every 2 minutes for first hour
        : 5 * 60 * 1000;   // Every 5 minutes after that
      const minsElapsed = Math.round(elapsed / 60000);
      const nextMins = Math.round(pollInterval / 60000);
      console.log(`[Bonus] GW${gwId} not yet confirmed (${minsElapsed} mins elapsed, check #${checkCount}), checking again in ${nextMins} minutes`);

      // FPL pushes late bonus shifts and defcon corrections in the gap between
      // finished_provisional (FT) and finished (official bonus). Invalidate the
      // recent-GW caches and rerun the full refresh so derived views pick them up
      // instead of staying frozen on the FT snapshot until `finished` flips.
      const refreshResult = await refreshAllData('bonus-pending');
      if (!refreshResult.success) {
        console.error(`[Bonus] GW${gwId} bonus-pending refresh failed: ${refreshResult.error}`);
      } else {
        await refreshWeekData().catch((e: any) => console.error('[Bonus] Week refresh failed:', e.message));
      }

      sched.bonusConfirmationTimeout = setTimeout(checkBonusConfirmed, pollInterval);
    } catch (error: any) {
      console.error(`[Bonus] Error checking GW${gwId} status:`, error.message);
      sched.bonusConfirmationTimeout = setTimeout(checkBonusConfirmed, 2 * 60 * 1000);
    }
  }

  console.log(`[Bonus] Starting bonus confirmation checks for GW${gwId} (every 2-5 mins, up to 12 hours)`);
  sched.bonusConfirmationTimeout = setTimeout(checkBonusConfirmed, 2 * 60 * 1000);
}

// Check if all matches are finished before stopping polling
// Extends polling up to 30 mins if FPL hasn't set finished_provisional yet
export async function checkAndStopPolling(originalEndTime: Date, reason: string): Promise<void> {
  const maxExtension = 30 * 60 * 1000; // 30 minutes max extension
  const now = Date.now();

  // Safety: don't extend beyond 30 mins past original end
  if (now > originalEndTime.getTime() + maxExtension) {
    console.log('[Live] Max extension reached (30 mins), stopping polling');
    await stopLivePolling(reason);
    setTimeout(scheduleRefreshes, 60000);
    return;
  }

  try {
    // Fetch fresh fixtures to check status
    const [fixtures, bootstrap] = await Promise.all([fetchFixtures(), fetchBootstrap()]);
    const currentGW = bootstrap.events.find((e: any) => e.is_current)?.id || 0;
    const currentGWFixtures = fixtures.filter((f: any) => f.event === currentGW);
    const startedMatches = currentGWFixtures.filter((f: any) => f.started);
    const unfinishedMatches = startedMatches.filter((f: any) => !f.finished_provisional);

    if (unfinishedMatches.length > 0) {
      const extendedMins = Math.round((now - originalEndTime.getTime()) / 60000);
      console.log(`[Live] ${unfinishedMatches.length} match(es) not yet finished (extended ${extendedMins}+ mins), continuing polling`);
      // Check again in 1 minute
      setTimeout(() => checkAndStopPolling(originalEndTime, reason), 60000);
      return;
    }

    // All matches finished, stop polling
    console.log('[Live] All matches finished (finished_provisional=true), stopping polling');
    await stopLivePolling(reason);
    setTimeout(scheduleRefreshes, 60000);
  } catch (error: any) {
    console.error('[Live] Error checking fixture status:', error.message);
    // On error, try again in 1 minute (up to max extension)
    setTimeout(() => checkAndStopPolling(originalEndTime, reason), 60000);
  }
}

export async function scheduleRefreshes(): Promise<void> {
  // Re-entrancy guard: boot can run more than once in dev, and overlapping
  // runs would double-schedule jobs. Later legitimate reschedules still run.
  if (sched.isScheduling) {
    console.log('[Scheduler] scheduleRefreshes already running - skipping');
    return;
  }
  sched.isScheduling = true;
  try {
    await scheduleRefreshesInner();
  } finally {
    sched.isScheduling = false;
  }
}

async function scheduleRefreshesInner(): Promise<void> {
  // Clear existing scheduled jobs
  sched.scheduledJobs.forEach((job) => job.stop());
  sched.scheduledJobs = [];

  // Stop any live polling
  await stopLivePolling('reschedule');

  console.log('[Scheduler] Calculating refresh schedule...');

  const fixtureData = await getFixturesForCurrentGW(true); // Force refresh fixture data
  if (!fixtureData) {
    console.log('[Scheduler] No fixture data available - will retry in 1 hour');
    const retryJob = setTimeout(scheduleRefreshes, 3600000);
    sched.scheduledJobs.push({ stop: () => clearTimeout(retryJob) });
    return;
  }

  const now = new Date();
  const { currentGWFixtures, currentGW, events, currentGWDone, nextGW, nextGWFixtures, nextGWEvent } = fixtureData;

  console.log(`[Scheduler] Current GW: ${currentGW}${currentGWDone ? ' (finished)' : ''}`);

  // When the current GW is fully done, use the next GW for scheduling.
  // The FPL API keeps is_current on the finished GW until the next GW's deadline
  // passes, creating a dead zone where nothing gets scheduled.
  const effectiveGW = currentGWDone && nextGW ? nextGW : currentGW;
  const effectiveFixtures = currentGWDone && nextGWFixtures.length > 0 ? nextGWFixtures : currentGWFixtures;
  const effectiveEvent = currentGWDone && nextGWEvent ? nextGWEvent : events.find((e: any) => e.id === currentGW);

  if (currentGWDone && nextGW) {
    console.log(`[Scheduler] Current GW${currentGW} is done, scheduling for next GW${nextGW}`);
  }

  // Get deadline from effective GW event
  const deadline = effectiveEvent ? new Date(effectiveEvent.deadline_time) : null;

  // Group fixtures into kickoff windows
  const windows = groupFixturesIntoWindows(effectiveFixtures);

  console.log(`[Scheduler] Found ${windows.length} match window(s) for GW ${effectiveGW}`);
  if (deadline) {
    console.log(`[Scheduler] GW${effectiveGW} deadline: ${deadline.toLocaleString('en-GB')}`);
  }

  // Check if we're in pre-match polling window (post-deadline, pre-kickoff)
  // FPL releases data shortly after deadline, not 5 mins before kickoff
  const firstKickoff = windows[0]?.start;
  const lastPollEnd = windows[windows.length - 1]?.end;
  const isPostDeadline = deadline && now >= deadline;
  const isPreFirstKickoff = firstKickoff && now < firstKickoff;
  const isInPreMatchWindow = isPostDeadline && isPreFirstKickoff;

  // Check if we're currently in a live window (during matches)
  let currentlyLive = false;
  windows.forEach((window, idx) => {
    const pollStart = new Date(window.start.getTime() - 5 * 60 * 1000); // 5 mins before kickoff
    const pollEnd = window.end;

    if (now >= pollStart && now <= pollEnd) {
      currentlyLive = true;
      const matchCount = window.fixtures.length;
      const kickoffTime = window.start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      startLivePolling(`${matchCount} match(es) at ${kickoffTime}`);

      // Schedule stop check at window end (will extend if matches not finished)
      const stopDelay = pollEnd.getTime() - now.getTime();
      if (stopDelay > 0) {
        const stopJob = setTimeout(() => {
          checkAndStopPolling(pollEnd, 'window-end');
        }, stopDelay);
        sched.scheduledJobs.push({ stop: () => clearTimeout(stopJob) });
        console.log(`[Scheduler] Will check for stop at ${pollEnd.toLocaleTimeString('en-GB')} (extends if matches not finished)`);
      }
    }
  });

  // Handle pre-match polling (post-deadline, pre-kickoff)
  // This allows data to refresh as soon as FPL releases it after deadline
  if (!currentlyLive && isInPreMatchWindow) {
    console.log(`[Scheduler] In pre-match window (post-deadline, pre-kickoff)`);
    startLivePolling('pre-match (post-deadline)');

    // Schedule transition to regular live polling at first kickoff
    const switchDelay = firstKickoff.getTime() - now.getTime();
    if (switchDelay > 0) {
      console.log(`[Scheduler] Will switch to match polling at ${firstKickoff.toLocaleString('en-GB')}`);
      const switchJob = setTimeout(() => {
        // Re-schedule to pick up normal match window logic
        scheduleRefreshes();
      }, switchDelay);
      sched.scheduledJobs.push({ stop: () => clearTimeout(switchJob) });
    }
  }

  // Schedule future windows
  if (!currentlyLive && !isInPreMatchWindow) {
    // Schedule pre-match polling from deadline if it's in the future
    if (deadline && deadline > now && firstKickoff) {
      const deadlineDelay = deadline.getTime() - now.getTime();
      if (deadlineDelay < 7 * 24 * 60 * 60 * 1000) { // Within 7 days
        console.log(`[Scheduler] Pre-match polling scheduled from: ${deadline.toLocaleString('en-GB')}`);
        const deadlineJob = setTimeout(() => {
          startLivePolling('pre-match (post-deadline)');

          // Schedule switch to regular polling at first kickoff
          const switchDelay = firstKickoff.getTime() - Date.now();
          if (switchDelay > 0) {
            const switchJob = setTimeout(() => {
              scheduleRefreshes();
            }, switchDelay);
            sched.scheduledJobs.push({ stop: () => clearTimeout(switchJob) });
          }
        }, deadlineDelay);
        sched.scheduledJobs.push({ stop: () => clearTimeout(deadlineJob) });
      }
    }

    windows.forEach((window, idx) => {
      const pollStart = new Date(window.start.getTime() - 5 * 60 * 1000);
      const pollEnd = window.end;

      // Skip scheduling if this window will be covered by pre-match polling from deadline
      // (deadline is scheduled above and will transition to match polling at first kickoff)
      const coveredByPreMatchPolling = deadline && deadline > now && idx === 0 && deadline < pollStart;

      if (pollStart > now && !coveredByPreMatchPolling) {
        // Schedule start of live polling
        const startDelay = pollStart.getTime() - now.getTime();
        const matchCount = window.fixtures.length;
        const kickoffTime = window.start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

        console.log(`[Scheduler] Window ${idx + 1}: ${matchCount} match(es) at ${kickoffTime}`);
        console.log(`  - Polling starts: ${pollStart.toLocaleString('en-GB')}`);
        console.log(`  - Polling ends: ${pollEnd.toLocaleString('en-GB')}`);

        if (startDelay < 7 * 24 * 60 * 60 * 1000) { // Within 7 days
          const startJob = setTimeout(() => {
            startLivePolling(`${matchCount} match(es) at ${kickoffTime}`);

            // Schedule stop check (will extend if matches not finished)
            const stopDelay = pollEnd.getTime() - Date.now();
            if (stopDelay > 0) {
              const stopJob = setTimeout(() => {
                checkAndStopPolling(pollEnd, 'window-end');
              }, stopDelay);
              sched.scheduledJobs.push({ stop: () => clearTimeout(stopJob) });
            }
          }, startDelay);
          sched.scheduledJobs.push({ stop: () => clearTimeout(startJob) });
        }
      }
    });
  }

  // When scheduling for a future GW (current GW done), also schedule a refresh
  // at the deadline so we immediately pick up picks data and transition the display.
  // This refresh runs in addition to the pre-match polling scheduled above - it
  // specifically triggers a week data refresh so the UI shows the new GW teams.
  if (currentGWDone && nextGW && deadline && deadline > now) {
    const deadlineRefreshDelay = deadline.getTime() - now.getTime();
    if (deadlineRefreshDelay < 7 * 24 * 60 * 60 * 1000) {
      console.log(`[Scheduler] GW${nextGW} deadline refresh scheduled: ${deadline.toLocaleString('en-GB')}`);
      const deadlineRefreshJob = setTimeout(async () => {
        console.log(`[Scheduler] GW${nextGW} deadline reached - refreshing week data for new GW`);
        await getFixturesForCurrentGW(true);
        await refreshWeekData();
      }, deadlineRefreshDelay);
      sched.scheduledJobs.push({ stop: () => clearTimeout(deadlineRefreshJob) });
    }
  }

  // Schedule morning-after refresh (8 AM day after last GW match)
  const allKickoffs: Date[] = effectiveFixtures
    .filter((f: any) => f.kickoff_time)
    .map((f: any) => new Date(f.kickoff_time));

  if (allKickoffs.length > 0) {
    const lastGWKickoff = new Date(Math.max(...allKickoffs.map((d) => d.getTime())));
    const lastMatchEnd = getMatchEndTime(lastGWKickoff);

    const morningAfter = new Date(lastMatchEnd);
    morningAfter.setDate(morningAfter.getDate() + 1);
    morningAfter.setHours(8, 0, 0, 0);

    if (morningAfter > now) {
      const delay = morningAfter.getTime() - now.getTime();
      if (delay < 7 * 24 * 60 * 60 * 1000) {
        console.log(`[Scheduler] Morning-after refresh: ${morningAfter.toLocaleString('en-GB')}`);
        const morningJob = setTimeout(async () => {
          await morningRefreshWithAlert();
          setTimeout(scheduleRefreshes, 60000);
        }, delay);
        sched.scheduledJobs.push({ stop: () => clearTimeout(morningJob) });
      }
    }
  }

  // Schedule daily fixture check at 6 AM if no windows scheduled within 24 hours
  const nextWindow = windows.find((w) => w.start > now);
  const hoursUntilNextWindow = nextWindow ? (nextWindow.start.getTime() - now.getTime()) / (1000 * 60 * 60) : Infinity;

  if (hoursUntilNextWindow > 24 || !nextWindow) {
    // Calculate next 6 AM
    const next6AM = new Date(now);
    next6AM.setHours(6, 0, 0, 0);
    if (next6AM <= now) {
      next6AM.setDate(next6AM.getDate() + 1);
    }

    const delay = next6AM.getTime() - now.getTime();
    console.log(`[Scheduler] Daily fixture check: ${next6AM.toLocaleString('en-GB')}`);

    const dailyJob = setTimeout(async () => {
      console.log('[Daily] Checking for fixture changes...');
      await getFixturesForCurrentGW(true);
      await refreshAllData('daily-check');
      await refreshWeekData();  // Also refresh week data to update timestamp
      scheduleRefreshes();
    }, delay);
    sched.scheduledJobs.push({ stop: () => clearTimeout(dailyJob) });
  }

  // Recovery: detect completed GWs (including provisionally complete) that haven't
  // been processed yet. This handles server restarts, missed bonus confirmations,
  // and the gap between finished_provisional and official finished confirmation.
  if (!sched.bonusConfirmationTimeout && !currentlyLive && !isInPreMatchWindow) {
    try {
      const [bootstrap, recoveryFixtures] = await Promise.all([fetchBootstrapFresh(), fetchFixtures()]);
      const completedGWs = getCompletedGameweeks(bootstrap, recoveryFixtures);
      const cachedLosers = dataCache.losers?.losers || [];
      const processedGWs = new Set(cachedLosers.map((l: any) => l.gameweek));
      const unprocessedGWs = completedGWs.filter((gw) => !processedGWs.has(gw));

      if (unprocessedGWs.length > 0) {
        console.log(`[Scheduler] Recovery: found ${unprocessedGWs.length} completed but unprocessed GW(s): [${unprocessedGWs.join(', ')}]. Running full refresh.`);
        const refreshResult = await refreshAllData('gameweek-confirmed');
        if (!refreshResult.success) {
          console.error(`[Scheduler] Recovery refresh failed: ${refreshResult.error}`);
        }
        await refreshWeekData();
      }

      // Also schedule bonus confirmation for any provisionally-complete GW
      // that isn't officially finished yet (scores may change when bonus is confirmed)
      const finishedGWs = new Set(bootstrap.events.filter((e: any) => e.finished).map((e: any) => e.id));
      const provisionalGW = completedGWs.find((gw) => !finishedGWs.has(gw));
      if (provisionalGW) {
        console.log(`[Scheduler] GW${provisionalGW} provisionally complete but not yet confirmed - starting bonus confirmation polling`);
        scheduleBonusConfirmationCheck(provisionalGW);
      }
    } catch (e: any) {
      console.error('[Scheduler] Recovery check failed:', e.message);
    }
  }

  // Summary
  const scheduledCount = sched.scheduledJobs.length;
  console.log(`[Scheduler] ${scheduledCount} job(s) scheduled. ${sched.isLivePolling ? 'LIVE POLLING ACTIVE' : 'Waiting for matches'}`);
}
