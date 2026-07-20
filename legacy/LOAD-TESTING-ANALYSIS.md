# FPL Dashboard - Load Testing & Scalability Analysis

Analysis of how the application would perform under concurrent load (10s–100s of users).

---

## Architecture Summary

- **Server**: Single-process Node.js with native `http` module (no Express)
- **Frontend**: Vanilla HTML/CSS/JS, no build step
- **Data source**: FPL API (`fantasy.premierleague.com/api`)
- **Storage**: Upstash Redis via REST API (key-value caching only)
- **Hosting**: Render.com (single web service)
- **State**: All application state held in-memory in global objects

---

## Critical Bottlenecks

### 1. Single-Process Architecture

The server runs as a single Node.js process. There is no clustering (`cluster` module), no worker threads, and no horizontal scaling configuration. A single blocked operation stalls every concurrent request.

**Impact at scale**: With 100 concurrent users, a single slow operation (e.g., a 6-minute pre-calculation run) degrades response times for everyone.

### 2. Synchronous File I/O in Request Handlers

`server.js:5272-5288` — All static files (HTML, CSS, images) are served via `fs.readFileSync()`, which blocks the entire event loop for each request.

```
12 HTML pages + CSS + JS + 7 images = ~20 static assets
Each readFileSync blocks for 1-10ms depending on disk
```

**Impact at scale**: 100 users loading a page simultaneously means ~2,000 synchronous file reads competing for the event loop. Each blocks all other requests.

### 3. No Response Compression

`server.js:5290-5292` — The `serveJSON()` function sends raw JSON with no gzip/brotli compression. Estimated payload sizes:

| Endpoint | Estimated Size |
|----------|---------------|
| `/api/standings` | 500KB–1MB |
| `/api/week` | 2–3MB |
| `/api/motm` | ~800KB |
| `/api/hall-of-fame` | ~200KB |

**Impact at scale**: 100 users hitting `/api/week` = 200–300MB of bandwidth per refresh cycle. On Render's free/starter tiers, this saturates network quickly.

### 4. No HTTP Cache Headers

No `Cache-Control`, `ETag`, or `Last-Modified` headers are set on any response — static or dynamic. Browsers re-download everything on every navigation.

**Impact at scale**: Every page load generates full-size requests even when data hasn't changed. Doubles or triples effective load compared to proper caching.

### 5. FPL API Rate Limiting Risk

The FPL API reportedly enforces ~100 requests/second per IP. The server makes API calls on behalf of all users from a single IP.

During a data refresh, the server issues:
- 1 bootstrap + 1 fixtures + 1 league call
- Up to 375 `fetchManagerHistory()` calls (one per league member)
- Up to 375 `fetchManagerPicks()` calls

This totals **750+ requests per refresh cycle**. If two refresh cycles overlap (e.g., live polling + user-triggered rebuild), the server can hit rate limits and all requests start failing with no recovery logic.

`server.js:535-546` — `fetchWithTimeout()` has no retry logic, no 429 handling, and no backoff strategy.

### 6. Unbounded In-Memory Caches

Several global caches grow without limits throughout the season:

| Cache | Estimated Size at GW38 |
|-------|----------------------|
| `picksCache` (375 managers x 38 GWs) | ~70MB |
| `processedPicksCache` | ~140MB |
| `tinkeringCache` | ~55MB |
| **Total** | **~265MB** |

There is no eviction policy, no TTL on entries, and no memory monitoring. On a 512MB Render instance, this risks OOM crashes mid-season.

---

## Moderate Concerns

### 7. N+1 Fetch Patterns

Several data-building functions loop over all managers and make sequential API calls:

- `fetchStandingsWithTransfers()` (`server.js:1597-1644`): 375 sequential history + picks fetches
- `fetchWeeklyLosers()` (`server.js:1671-1780`): Nested loops across GWs and managers
- `preCalculatePicksData()` (`server.js:4618-4710`): Triple-nested loop, potentially 42,750 API calls on initial cache population

These are mitigated by the in-memory cache (completed GW data is cached permanently), so the cost is paid mainly at startup or after a cache clear. But a rebuild during peak traffic would be painful.

### 8. Data Fetching Waterfalls

`calculateTinkeringImpact()` (`server.js:1200-1214`) fetches bootstrap, then current picks, then previous picks, then live data — all sequentially. These could run in parallel via `Promise.all()`.

Similarly, `preCalculatePicksData()` fetches live data per-GW sequentially, then picks per-manager-per-GW sequentially, when batching would be faster.

### 9. Large Unoptimized Static Assets

| File | Size | Could Be |
|------|------|----------|
| `favicon.png` | 92KB | <20KB |
| `favicon-192.png` | 60KB | <10KB |
| `week.html` | 235KB | Minified to ~150KB |
| `styles.css` | 33KB | Minified to ~22KB |

No WebP format, no minification, no asset fingerprinting for cache busting.

### 10. Redis via HTTP REST API

`server.js:131-161` — Redis is accessed through Upstash's HTTP REST API rather than a native binary protocol client. Each Redis operation involves full HTTP request/response overhead (DNS, TLS handshake, headers).

For read-heavy patterns during live polling, this adds 10-50ms latency per Redis call compared to <1ms with a native client like `ioredis`.

---

## What Works Well

Despite the concerns above, several design decisions help with load:

1. **Pre-calculation model**: Heavy computations (hall of fame, set-and-forget, manager profiles) run at startup and on a daily schedule — not per-request. API endpoints mostly serve from `dataCache`, which is fast.

2. **Completed GW caching**: Data for finished gameweeks is cached permanently in memory. Repeat requests for historical data are served instantly with zero API calls.

3. **Smart polling schedule**: Live polling only runs during matches (fixture-aware scheduling). Outside match windows, the server is mostly idle.

4. **Single data refresh → all clients benefit**: The server fetches FPL data once and serves it to all users from cache. 100 users don't mean 100x API calls — they all read the same `dataCache`.

5. **Graceful degradation**: If the FPL API is down, cached data is served rather than returning errors.

---

## Estimated Behavior Under Load

### 10 Concurrent Users
**Verdict: Works fine with minor sluggishness**

- Static file serving: slight event loop contention from `readFileSync` but tolerable
- API responses: served from in-memory cache, fast
- Bandwidth: ~30MB per full page cycle without compression (manageable)
- FPL API: single server-side polling, no per-user calls, well within rate limits

### 50 Concurrent Users
**Verdict: Noticeable degradation**

- Bandwidth becomes a real concern: ~150MB per refresh cycle without compression
- `readFileSync` contention causes tail latency spikes (P99 could hit 200-500ms for static files)
- Memory pressure from visitor tracking + caches may approach Render instance limits
- If a rebuild or pre-calculation runs during peak traffic, all users experience stalled requests

### 100+ Concurrent Users
**Verdict: Likely failures without changes**

- Bandwidth: 300MB+ per refresh cycle will saturate most hosting plans
- Event loop blocking from sync I/O causes cascading timeouts
- Memory: 265MB cache + Node.js overhead + 100 concurrent request buffers may OOM on 512MB instances
- No connection backpressure: server accepts unlimited connections, degrades rather than shedding load

---

## Recommended Fixes by Priority

### High Priority (needed for 50+ users)
1. **Add gzip compression** — Wrap responses with `zlib.createGzip()`. Reduces bandwidth 70-85%.
2. **Replace `readFileSync` with async reads** — Use `fs.promises.readFile()` or pre-load static files into memory at startup.
3. **Set HTTP cache headers** — `Cache-Control: public, max-age=60` for API data, `max-age=86400` for static assets.
4. **Add memory limits to caches** — Implement LRU eviction or cap cache entries.

### Medium Priority (needed for 100+ users)
5. **Add Node.js clustering** — Use `cluster` module to spawn one worker per CPU core.
6. **Switch Redis to native client** — Replace Upstash REST with `ioredis` for binary protocol performance.
7. **Add retry + backoff for FPL API** — Handle 429 responses, implement exponential backoff.
8. **Optimize images** — Convert to WebP, compress PNGs, add responsive sizes.

### Lower Priority (quality of life)
9. **Parallelize data fetching waterfalls** — `Promise.all()` where fetches are independent.
10. **Add request queuing/throttling** — Rate-limit outbound FPL API calls to stay under limits.
11. **Minify HTML/CSS/JS** — Add a simple build step with `terser`/`csso`.
12. **Add pagination to large endpoints** — `/api/standings` and `/api/motm` could paginate.
