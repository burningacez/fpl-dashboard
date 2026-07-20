import { buildCupData } from '@/server/services/cup';
import { serveApiRoute } from '@/server/api-envelope';

export const dynamic = 'force-dynamic';

// The legacy '/api/cup' closure lives in the apiRoutes map and ignores the
// ?season= parameter, so no season guard here — just the shared envelope.
export async function GET() {
  return serveApiRoute('/api/cup', buildCupData);
}
