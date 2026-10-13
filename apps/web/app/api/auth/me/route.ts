import { proxyToFastify } from '@/lib/fastify-proxy';

export const runtime = 'nodejs';

export function GET(request: Request) {
  return proxyToFastify(request, ['auth', 'me']);
}
