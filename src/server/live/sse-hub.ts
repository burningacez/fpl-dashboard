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

// A reader that has stopped consuming accumulates queued bytes in its stream.
// Full week payloads arrive every poll, so a dead phone connection could pin
// megabytes; past this many queued bytes the client is disconnected instead.
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

interface SseClient {
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
  desiredSize: () => number | null;
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
    // desiredSize goes negative once the queue exceeds the high-water mark;
    // it's our only visibility into a reader that has stopped consuming.
    desiredSize: () => {
      try {
        return controller.desiredSize;
      } catch {
        return null;
      }
    },
  };
  sseClients.add(client);
  return client;
}

export function removeSseClient(client: SseClient): void {
  sseClients.delete(client);
}

function send(client: SseClient, payload: Uint8Array): void {
  const desired = client.desiredSize();
  // Backpressure: a deeply-negative desiredSize means megabytes are queued
  // for a reader that isn't reading. Drop the client (the browser's
  // EventSource auto-reconnects if it comes back to life).
  if (desired != null && desired < -MAX_QUEUED_BYTES) {
    sseClients.delete(client);
    client.close();
    return;
  }
  try {
    client.enqueue(payload);
  } catch {
    sseClients.delete(client);
  }
}

export function broadcastSSE(event: string, data: unknown): void {
  if (sseClients.size === 0) return;
  const payload = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const client of sseClients) {
    send(client, payload);
  }
}

/** Heartbeat to keep connections alive through proxies (Render uses Nginx) */
export function startSseHeartbeat(): void {
  if (globalThis.__fplSseHeartbeat) return;
  const heartbeat = encoder.encode(': heartbeat\n\n');
  globalThis.__fplSseHeartbeat = setInterval(() => {
    for (const client of sseClients) {
      send(client, heartbeat);
    }
  }, 30000);
}

/** Shutdown hook: stop the heartbeat and close every open stream. */
export function stopSseHub(): void {
  if (globalThis.__fplSseHeartbeat) {
    clearInterval(globalThis.__fplSseHeartbeat);
    globalThis.__fplSseHeartbeat = undefined;
  }
  for (const client of sseClients) {
    client.close();
  }
  sseClients.clear();
}
