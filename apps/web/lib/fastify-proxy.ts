import { NextResponse } from 'next/server';

const requestHopHeaders = ['connection', 'content-length', 'host', 'transfer-encoding'];
const responseHopHeaders = ['connection', 'content-encoding', 'content-length', 'transfer-encoding'];

export async function proxyToFastify(request: Request, path: string[]): Promise<NextResponse> {
  const serviceUrl = process.env.FASTIFY_API_URL?.trim() ||
    (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:3000' : '');

  if (!serviceUrl) {
    return NextResponse.json(
      { error: { code: 'API_UNAVAILABLE', message: 'The API service binding is not configured.' } },
      { status: 503 }
    );
  }

  const incomingUrl = new URL(request.url);
  const baseUrl = serviceUrl.endsWith('/') ? serviceUrl : `${serviceUrl}/`;
  const upstreamUrl = new URL(
    `api/v1/${path.map((segment) => encodeURIComponent(segment)).join('/')}${incomingUrl.search}`,
    baseUrl
  );
  const headers = new Headers(request.headers);
  requestHopHeaders.forEach((header) => headers.delete(header));

  try {
    const method = request.method.toUpperCase();
    const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer();
    const upstream = await fetch(upstreamUrl, {
      method,
      headers,
      ...(body ? { body } : {}),
      redirect: 'manual',
      cache: 'no-store',
    });

    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!responseHopHeaders.includes(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') {
        responseHeaders.append(name, value);
      }
    });
    const upstreamHeaders = upstream.headers as Headers & { getSetCookie?: () => string[] };
    upstreamHeaders.getSetCookie?.().forEach((cookie) => responseHeaders.append('set-cookie', cookie));

    return new NextResponse(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error('Fastify service proxy failed', {
      path: upstreamUrl.pathname,
      error: error instanceof Error ? error.message : 'Unknown fetch error',
    });
    return NextResponse.json(
      { error: { code: 'API_UNAVAILABLE', message: 'The API service is temporarily unavailable.' } },
      { status: 502 }
    );
  }
}