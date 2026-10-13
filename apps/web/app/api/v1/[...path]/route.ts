import { proxyToFastify } from '@/lib/fastify-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { path: string[] } };

const forward = (request: Request, { params }: RouteContext) => proxyToFastify(request, params.path);

export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const OPTIONS = forward;