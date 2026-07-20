import { dataCache } from '@/server/data-cache';
import {
  MAX_SSE_CLIENTS,
  addSseClient,
  removeSseClient,
  sseClientCount,
} from '@/server/live/sse-hub';

export const dynamic = 'force-dynamic';

// SSE endpoint for real-time live updates — port of legacy/server.js:6619-6647,
// adapted from res.write() on Node response objects to a ReadableStream.
export async function GET(request: Request): Promise<Response> {
  if (sseClientCount() >= MAX_SSE_CLIENTS) {
    return new Response(JSON.stringify({ error: 'Too many SSE connections' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const client = addSseClient(controller);
      if (!client) {
        // Raced past the pre-check while the hub filled up
        controller.close();
        return;
      }

      // Send current state as initial sync
      const weekData = dataCache.week;
      if (weekData) {
        controller.enqueue(encoder.encode(`event: sync\ndata: ${JSON.stringify(weekData)}\n\n`));
      }

      console.log(`[SSE] Client connected (${sseClientCount()} total)`);

      request.signal.addEventListener('abort', () => {
        removeSseClient(client);
        client.close();
        console.log(`[SSE] Client disconnected (${sseClientCount()} remaining)`);
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable Nginx buffering on Render
    },
  });
}
