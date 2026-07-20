import 'server-only';

/**
 * Server-Sent Events hub — port of legacy/server.js:171-199, adapted from
 * res.write() on Node response objects to ReadableStream controllers (the
 * App Router route handler enqueues frames instead).
 *
 * Client registry lives on globalThis: one long-lived process in production,
 * survives dev-mode module re-instantiation.
 */

export const MAX_SSE_CLIENTS = 50;

interface SseClient {
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
}

declare global {
  var __fplSseClients: Set<SseClient> | undefined;
  var __fplSseHeartbeat: ReturnType<typeof setInterval> | undefined;
}

const sseClients: Set<SseClient> = (globalThis.__fplSseClients ??= new Set());
const encoder = new TextEncoder();

export function sseClientCount(): number {
  return sseClients.size;
}

export function addSseClient(controller: ReadableStreamDefaultController<Uint8Array>): SseClient | null {
  if (sseClients.size >= MAX_SSE_CLIENTS) return null;
  const client: SseClient = {
    enqueue: (chunk) => controller.enqueue(chunk),
    close: () => {
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  };
  sseClients.add(client);
  return client;
}

export function removeSseClient(client: SseClient): void {
  sseClients.delete(client);
}

export function broadcastSSE(event: string, data: unknown): void {
  if (sseClients.size === 0) return;
  const payload = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const client of sseClients) {
    try {
      client.enqueue(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

/** Heartbeat to keep connections alive through proxies (Render uses Nginx) */
export function startSseHeartbeat(): void {
  if (globalThis.__fplSseHeartbeat) return;
  const heartbeat = encoder.encode(': heartbeat\n\n');
  globalThis.__fplSseHeartbeat = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.enqueue(heartbeat);
      } catch {
        sseClients.delete(client);
      }
    }
  }, 30000);
}
