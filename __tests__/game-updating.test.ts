/**
 * FPL's deadline-maintenance window: every endpoint 503s with "The game is
 * being updated." for up to an hour around each deadline. These tests pin the
 * two halves of the graceful path: the fetch layer tagging the failure, and
 * the shared route helper turning it into the typed `updating` envelope the
 * client renders as a friendly holding state (never a raw upstream error).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithTimeout, FplApiError, isGameUpdating } from '@/server/fpl/client';
import { routeErrorResponse, stripUpstreamUrl, GAME_UPDATING_MESSAGE } from '@/server/api-envelope';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(body: string, status: number) {
  globalThis.fetch = vi.fn(async () => new Response(body, { status })) as any;
}

describe('fetchWithTimeout game-updating detection', () => {
  it('tags 503 maintenance responses as gameUpdating', async () => {
    mockFetch('"The game is being updated."', 503);
    const err = await fetchWithTimeout('https://fantasy.premierleague.com/api/entry/1/').catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FplApiError);
    expect(err.status).toBe(503);
    expect(isGameUpdating(err)).toBe(true);
  });

  it('tags the maintenance body as gameUpdating even on other statuses', async () => {
    mockFetch('"The game is being updated."', 500);
    const err = await fetchWithTimeout('https://fantasy.premierleague.com/api/x/').catch((e) => e);
    expect(isGameUpdating(err)).toBe(true);
  });

  it('does not tag ordinary failures', async () => {
    mockFetch('Not Found', 404);
    const err = await fetchWithTimeout('https://fantasy.premierleague.com/api/x/').catch((e) => e);
    expect(err).toBeInstanceOf(FplApiError);
    expect(isGameUpdating(err)).toBe(false);
  });

  it('is not fooled by non-FplApiError values', () => {
    expect(isGameUpdating(new Error('The game is being updated.'))).toBe(false);
    expect(isGameUpdating(null)).toBe(false);
  });
});

describe('routeErrorResponse', () => {
  it('maps the maintenance window to a typed updating envelope with friendly copy', async () => {
    const err = new FplApiError(
      'HTTP 503: The game is being updated. for https://fantasy.premierleague.com/api/entry/1/',
      503,
      true,
    );
    const res = routeErrorResponse(err);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.updating).toBe(true);
    expect(body.error).toBe(GAME_UPDATING_MESSAGE);
    // The raw upstream URL from the screenshot bug must never reach the client.
    expect(JSON.stringify(body)).not.toContain('https://fantasy.premierleague.com');
  });

  it('strips the upstream URL suffix from other errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = routeErrorResponse(
      new Error('HTTP 500: Internal Server Error for https://fantasy.premierleague.com/api/x/'),
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.updating).toBeUndefined();
    expect(body.error).toBe('HTTP 500: Internal Server Error');
  });
});

describe('stripUpstreamUrl', () => {
  it('leaves messages without a URL suffix alone', () => {
    expect(stripUpstreamUrl('boom')).toBe('boom');
    expect(stripUpstreamUrl('see https://x.test/ mid-sentence')).toBe(
      'see https://x.test/ mid-sentence',
    );
  });
});
