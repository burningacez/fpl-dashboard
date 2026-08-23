/**
 * /api/planner/squad/[entryId] — exact-price reconstruction.
 *
 * FPL's public picks endpoint routinely omits purchase_price/selling_price
 * (they're only guaranteed on the authenticated my-team call). The route now
 * rebuilds exact purchase prices from the public transfer feed plus season-
 * start prices, so the "Approximate prices" banner is reserved for the one
 * case with nothing to reconstruct from: the transfer feed itself failing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/planner/squad/[entryId]/route';
import { invalidateRawCaches } from '@/server/fpl/client';

const realFetch = globalThis.fetch;

// In-season bootstrap: GW3 current, prices moved since the season started.
const bootstrap = {
  events: [
    { id: 1, is_current: false, is_next: false, finished: true },
    { id: 2, is_current: false, is_next: false, finished: true },
    { id: 3, is_current: true, is_next: false, finished: false },
  ],
  // Element 10: started 50, now 52. Element 20: started 80, now 79.
  elements: [
    { id: 10, now_cost: 52, cost_change_start: 2 },
    { id: 20, now_cost: 79, cost_change_start: -1 },
  ],
};

const picks = {
  entry_history: { bank: 15, value: 1002 },
  active_chip: null,
  // No purchase_price / selling_price — the shape that used to force the banner.
  picks: [
    { element: 10, position: 1, is_captain: false, is_vice_captain: false },
    { element: 20, position: 2, is_captain: true, is_vice_captain: false },
  ],
};

const history = {
  current: [
    { event: 1, event_transfers: 0, event_transfers_cost: 0 },
    { event: 2, event_transfers: 1, event_transfers_cost: 0 },
  ],
  chips: [],
};

// Element 20 was bought in GW2 at 78; element 10 has been owned since GW1.
const transfers = [
  { element_in: 20, element_in_cost: 78, element_out: 30, element_out_cost: 60, entry: 7, event: 2, time: '2026-08-20T10:00:00Z' },
];

function serveFpl(overrides: Record<string, () => Response> = {}) {
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = String(input);
    const routes: Record<string, unknown> = {
      'bootstrap-static': bootstrap,
      'picks': picks,
      'history': history,
      'transfers': transfers,
    };
    for (const [key, make] of Object.entries(overrides)) {
      if (url.includes(key)) return make();
    }
    for (const [key, body] of Object.entries(routes)) {
      if (url.includes(key)) return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  }) as any;
}

async function getSquad() {
  const res = await GET({} as any, { params: Promise.resolve({ entryId: '7' }) });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => invalidateRawCaches());

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('GET /api/planner/squad/[entryId]', () => {
  it('reconstructs exact prices from the transfer feed when picks omit them', async () => {
    serveFpl();
    const { status, body } = await getSquad();
    expect(status).toBe(200);
    expect(body.approximatePrices).toBe(false);

    const [p10, p20] = body.picks;
    // Owned since GW1 → season-start price; rose 50→52, sells at 51 (half profit).
    expect(p10.purchasePrice).toBe(50);
    expect(p10.sellingPrice).toBe(51);
    // Bought at 78 in GW2; rose 78→79, half of +1 rounds down to 0, sells at 78.
    expect(p20.purchasePrice).toBe(78);
    expect(p20.sellingPrice).toBe(78);
  });

  it('falls back to now_cost with the approximate-prices flag when the transfer feed fails', async () => {
    serveFpl({ transfers: () => new Response('Internal Server Error', { status: 500 }) });
    const { status, body } = await getSquad();
    expect(status).toBe(200);
    expect(body.approximatePrices).toBe(true);
    expect(body.picks[0].purchasePrice).toBe(52);
    expect(body.picks[1].purchasePrice).toBe(79);
  });

  it('prices an ACTIVE free-hit squad at this week’s buy costs', async () => {
    // GW3 is a live free hit: element 20 is a rental bought this week at 79.
    // Its buy must count (the picks being priced ARE the free-hit squad), even
    // though free-hit-week transfers are normally excluded as reverted.
    serveFpl({
      picks: () =>
        new Response(JSON.stringify({ ...picks, active_chip: 'freehit' }), { status: 200 }),
      history: () =>
        new Response(
          JSON.stringify({ ...history, chips: [{ name: 'freehit', event: 3 }] }),
          { status: 200 },
        ),
      transfers: () =>
        new Response(
          JSON.stringify([
            { element_in: 20, element_in_cost: 79, element_out: 30, element_out_cost: 60, entry: 7, event: 3, time: '2026-08-30T10:00:00Z' },
          ]),
          { status: 200 },
        ),
    });
    const { body } = await getSquad();
    expect(body.approximatePrices).toBe(false);
    expect(body.picks[1].purchasePrice).toBe(79);
    expect(body.picks[1].sellingPrice).toBe(79);
  });

  it('trusts prices supplied by the picks endpoint over the reconstruction', async () => {
    serveFpl({
      picks: () =>
        new Response(
          JSON.stringify({
            ...picks,
            picks: [
              { element: 10, position: 1, is_captain: false, is_vice_captain: false, purchase_price: 49, selling_price: 50 },
              { element: 20, position: 2, is_captain: true, is_vice_captain: false, purchase_price: 78, selling_price: 78 },
            ],
          }),
          { status: 200 },
        ),
    });
    const { body } = await getSquad();
    expect(body.approximatePrices).toBe(false);
    expect(body.picks[0].purchasePrice).toBe(49);
    expect(body.picks[0].sellingPrice).toBe(50);
  });
});
