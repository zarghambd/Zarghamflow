import { proxyToFastify } from '@/lib/fastify-proxy';

export const runtime = 'nodejs';

export function PATCH(request: Request, { params }: { params: { id: string } }) {
  return proxyToFastify(request, ['admin', 'users', params.id]);
}