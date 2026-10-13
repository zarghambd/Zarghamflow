import { proxyToFastify } from '@/lib/fastify-proxy';

export const runtime = 'nodejs';

export function POST(request: Request) {
  return proxyToFastify(request, ['auth', 'verify']);
}
