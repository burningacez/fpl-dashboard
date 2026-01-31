# Match FT Status Fix Plan

**Overall Progress:** `100%`

## TLDR
Matches showing "90'" instead of "FT" after ending because polling stops based on time (kickoff + 115 mins) rather than checking if FPL has set the `finished_provisional` flag. Fix by extending polling until all started matches are actually finished.

## Critical Decisions
- **Polling end condition**: Change from pure time-based to status-based - don't stop until all started matches have `finished_provisional=true`
- **Safety timeout**: Add a maximum extension (30 mins past calculated end) to prevent infinite polling if FPL data is delayed
- **Implementation location**: Modify `stopLivePolling()` to check fixture status before actually stopping

## Root Cause Analysis

**Current behavior:**
1. Poll window ends at `kickoffTime + 115 minutes` (hardcoded)
2. When timer fires, `stopLivePolling('window-end')` is called
3. Final refresh happens, but FPL may not have set `finished_provisional` yet
4. Matches display "90'" because `finished` flag is still false

**User's scenario:**
- Matches kicked off at ~3:00 PM
- Calculated poll end: 3:00 PM + 115 mins = 4:55 PM
- Actual match end: ~4:53 PM
- FPL sets `finished_provisional` at ~4:55-5:00 PM (after final whistle + delay)
- Polling stopped at 4:55 PM before flag was set
- Result: Matches stuck showing "90'"

## Tasks

- [x] 🟩 **Step 1: Modify stopLivePolling to check fixture status**
  - [x] 🟩 Before stopping, fetch fresh fixtures and check if all started matches have `finished_provisional`
  - [x] 🟩 If matches still in progress, reschedule the stop check for 1 minute later
  - [x] 🟩 Add maximum extension limit (30 mins past original end time) as safety net
  - [x] 🟩 Log when polling is extended due to unfinished matches

- [x] 🟩 **Step 2: Pass window end time to stop scheduling**
  - [x] 🟩 Store the original calculated end time when scheduling the stop
  - [x] 🟩 Pass this to the stop handler so it can calculate the safety timeout

## Files to Modify

| File | Change |
|------|--------|
| `server.js` | Modify polling stop logic in `scheduleRefreshes()` to check fixture status |

## Implementation Detail

Replace the simple `stopLivePolling('window-end')` call with a status-checking function:

```javascript
async function checkAndStopPolling(originalEndTime, reason) {
    const maxExtension = 30 * 60 * 1000; // 30 minutes max extension
    const now = Date.now();

    // Safety: don't extend beyond 30 mins past original end
    if (now > originalEndTime.getTime() + maxExtension) {
        console.log('[Live] Max extension reached, stopping polling');
        await stopLivePolling(reason);
        setTimeout(scheduleRefreshes, 60000);
        return;
    }

    // Fetch fresh fixtures to check status
    const fixtures = await fetchFixtures();
    const currentGWFixtures = fixtures.filter(f => f.event === currentGW);
    const startedMatches = currentGWFixtures.filter(f => f.started);
    const unfinishedMatches = startedMatches.filter(f => !f.finished_provisional);

    if (unfinishedMatches.length > 0) {
        console.log(`[Live] ${unfinishedMatches.length} match(es) not yet finished, extending polling`);
        // Check again in 1 minute
        setTimeout(() => checkAndStopPolling(originalEndTime, reason), 60000);
        return;
    }

    // All matches finished, stop polling
    await stopLivePolling(reason);
    setTimeout(scheduleRefreshes, 60000);
}
```

## Verification

1. Start server during live matches
2. Wait for calculated poll end time
3. Console should show "extending polling" messages if matches not finished
4. Once FPL sets `finished_provisional`, polling stops
5. Matches should display "FT" not "90'"
