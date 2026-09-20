import 'server-only';
import config from './config';

/**
 * Upstash Redis REST client — verbatim port of legacy redisGet/redisSet
 * (legacy/server.js:214-244). Keeping the wire format identical guarantees
 * blob compatibility with the legacy app (same keys, same JSON encoding),
 * which keeps rollback trivial.
 *
 * Redis is optional: without credentials the app runs purely in-memory.
 */

const UPSTASH_URL = config.redis.UPSTASH_URL;
const UPSTASH_TOKEN = config.redis.UPSTASH_TOKEN;

export async function redisGet<T = unknown>(key: string): Promise<T | null> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    console.log('[Redis] No credentials configured');
    return null;
  }
  try {
    const response = await fetch(`${UPSTASH_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      cache: 'no-store',
    });
    const data = (await response.json()) as { result?: string | null };
    return data.result ? (JSON.parse(data.result) as T) : null;
  } catch (error) {
    console.error('[Redis] GET error:', (error as Error).message);
    return null;
  }
}

export async function redisSet(key: string, value: unknown): Promise<boolean> {
  return redisSetRaw(key, JSON.stringify(value));
}

/**
 * SET a value that has already been serialised.
 *
 * Every write here leaves the box as an HTTP request body, and Render bills
 * that as service-initiated outbound bandwidth. Callers that need to decide
 * whether a write is worth making (by hashing the payload, say) would
 * otherwise stringify multi-megabyte blobs twice — once to inspect, once to
 * send. This lets them serialise once and hand the same string over.
 */
export async function redisSetRaw(key: string, json: string): Promise<boolean> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return false;
  try {
    const response = await fetch(`${UPSTASH_URL}/set/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
      body: json,
      cache: 'no-store',
    });
    return response.ok;
  } catch (error) {
    console.error('[Redis] SET error:', (error as Error).message);
    return false;
  }
}

export function redisConfigured(): boolean {
  return Boolean(UPSTASH_URL && UPSTASH_TOKEN);
}
