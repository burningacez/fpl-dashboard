import { serveApiRoute } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

export async function GET() {
  return serveApiRoute('/api/health', () => {
    // Lightweight health check endpoint for keep-alive pings and monitoring
    // Returns minimal data to keep response fast
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });
}
