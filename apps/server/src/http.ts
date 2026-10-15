import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { registerAuth } from './auth.js';
import { registerRoutes } from './routes.js';
import { applyMigrations } from './db/migrations.js';
import type { ApiHandler, ApiHook, ApiReply, ApiRequest, ApiTestApp, CookieOptions, InjectResponse } from './http-types.js';

type RegisteredRoute = { method: string; path: string; handler: ApiHandler };
const defaultHeaders: Record<string, string> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; manifest-src 'self'; worker-src 'self' blob:; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-request-id': randomUUID(),
};

function parseCookies(header: string | null): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    try {
      result[name] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      result[name] = undefined;
    }
  }
  return result;
}

function routeMatch(pattern: string, pathname: string): Record<string, string> | undefined {
  const expected = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (expected.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index++) {
    const part = expected[index]!;
    const value = actual[index]!;
    if (part.startsWith(':')) {
      try {
        params[part.slice(1)] = decodeURIComponent(value);
      } catch {
        return undefined;
      }
    } else if (part !== value) {
      return undefined;
    }
  }
  return params;
}

function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`);
  return parts.join('; ');
}

class ApiRouter implements ApiTestApp {
  private readonly routes: RegisteredRoute[] = [];
  private readonly hooks: ApiHook[] = [];
  private readonly buckets = new Map<string, { start: number; count: number }>();

  get(path: string, handler: ApiHandler): void { this.add('GET', path, handler); }
  post(path: string, handler: ApiHandler): void { this.add('POST', path, handler); }
  put(path: string, handler: ApiHandler): void { this.add('PUT', path, handler); }
  patch(path: string, handler: ApiHandler): void { this.add('PATCH', path, handler); }
  delete(path: string, handler: ApiHandler): void { this.add('DELETE', path, handler); }
  addHook(name: 'preHandler', hook: ApiHook): void {
    if (name !== 'preHandler') throw new Error(`Unsupported API hook: ${name}`);
    this.hooks.push(hook);
  }
  swagger(): object {
    return { openapi: '3.0.3', info: { title: 'ZarghamFlow API', version: '1.0.0' }, paths: {} };
  }
  async ready(): Promise<void> {}
  async close(): Promise<void> {}

  async inject(options: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }): Promise<InjectResponse> {
    const requestHeaders = new Headers(options.headers);
    if (options.payload !== undefined && typeof options.payload !== 'string' && !requestHeaders.has('content-type')) {
      requestHeaders.set('content-type', 'application/json');
    }
    const response = await this.handle(new Request(new URL(options.url, 'http://localhost'), {
      method: options.method,
      headers: requestHeaders,
      ...(options.payload === undefined ? {} : {
        body: typeof options.payload === 'string' ? options.payload : JSON.stringify(options.payload),
      }),
    }));
    const headers: Record<string, string | string[] | undefined> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length) headers['set-cookie'] = setCookies;
    const body = await response.text();
    return { statusCode: response.status, headers, body, json: () => JSON.parse(body) as unknown };
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname === '/api/health'
      ? '/health'
      : url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/v1/')
        ? `/api/v1/${url.pathname.slice('/api/'.length)}`
        : url.pathname;
    const method = request.method.toUpperCase();
    const matched = this.routes
      .map((route) => ({ route, params: route.method === method || (method === 'HEAD' && route.method === 'GET') ? routeMatch(route.path, pathname) : undefined }))
      .find((entry) => entry.params !== undefined);
    if (!matched) return Response.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, { status: 404, headers: defaultHeaders });

    const current = Date.now();
    const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const ip = (config.TRUST_PROXY || process.env.VERCEL === '1') && forwardedFor ? forwardedFor : 'unknown';
    const bucket = this.buckets.get(ip);
    if (!bucket || current - bucket.start >= 60_000) this.buckets.set(ip, { start: current, count: 1 });
    else bucket.count++;
    if ((this.buckets.get(ip)?.count ?? 0) > config.RATE_LIMIT_MAX) {
      return Response.json({ error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' } }, { status: 429, headers: defaultHeaders });
    }
    if (this.buckets.size > 10_000) {
      for (const [key, value] of this.buckets) if (current - value.start >= 60_000) this.buckets.delete(key);
    }

    let body: unknown;
    if (!['GET', 'HEAD'].includes(method)) {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > 1_000_000) {
        return Response.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } }, { status: 413, headers: defaultHeaders });
      }
      if (raw) {
        try {
          body = request.headers.get('content-type')?.includes('application/json') ? JSON.parse(raw) as unknown : raw;
        } catch {
          return Response.json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } }, { status: 400, headers: defaultHeaders });
        }
      }
    }
    const headers = Object.fromEntries(Array.from(request.headers.entries()).map(([key, value]) => [key.toLowerCase(), value]));
    const apiRequest: ApiRequest = {
      method,
      url: `${pathname}${url.search}`,
      headers,
      cookies: parseCookies(request.headers.get('cookie')),
      body,
      params: matched.params!,
      query: Object.fromEntries(url.searchParams.entries()),
      ip,
      log: { error: (details, message) => console.error(message, details) },
    };
    const responseHeaders = new Headers(defaultHeaders);
    responseHeaders.set('x-request-id', randomUUID());
    const cookies: string[] = [];
    let status = 200;
    let payload: unknown;
    let hasPayload = false;
    const reply: ApiReply = {
      sent: false,
      code(nextStatus) { status = nextStatus; return this; },
      send(value) { payload = value; hasPayload = value !== undefined; this.sent = true; return this; },
      setCookie(name, value, options) { cookies.push(serializeCookie(name, value, options)); return this; },
      clearCookie(name, options) { cookies.push(serializeCookie(name, '', { ...options, maxAge: 0 })); return this; },
      header(name, value) { responseHeaders.set(name, value); return this; },
      type(value) { responseHeaders.set('content-type', value); return this; },
    };

    try {
      for (const hook of this.hooks) {
        await hook(apiRequest, reply);
        if (reply.sent) break;
      }
      if (!reply.sent) {
        const result = await matched.route.handler(apiRequest, reply);
        if (!reply.sent) {
          payload = result;
          hasPayload = result !== undefined;
        }
      }
    } catch (error) {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
        ? error.code
        : statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR';
      apiRequest.log.error({ error: error instanceof Error ? error.message : 'Unknown error' }, 'API request failed');
      status = statusCode;
      payload = { error: { code, message: statusCode >= 500 ? 'An unexpected error occurred.' : error instanceof Error ? error.message : 'Request failed.' } };
      hasPayload = true;
    }
    for (const cookie of cookies) responseHeaders.append('set-cookie', cookie);
    if (status === 204 || status === 304 || method === 'HEAD') return new Response(null, { status, headers: responseHeaders });
    if (!hasPayload) return new Response(null, { status, headers: responseHeaders });
    if (typeof payload === 'string') {
      if (!responseHeaders.has('content-type')) responseHeaders.set('content-type', 'text/plain; charset=utf-8');
      return new Response(payload, { status, headers: responseHeaders });
    }
    responseHeaders.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
  }

  private add(method: string, path: string, handler: ApiHandler): void {
    this.routes.push({ method, path, handler });
  }
}

export async function buildApp(): Promise<ApiTestApp> {
  await applyMigrations();
  const app = new ApiRouter();
  registerAuth(app);
  await registerRoutes(app);
  return app;
}

let appPromise: Promise<ApiTestApp> | undefined;
export function handleApiRequest(request: Request): Promise<Response> {
  appPromise ??= buildApp().catch((error: unknown) => {
    appPromise = undefined;
    throw error;
  });
  return appPromise.then((router) => router.handle(request));
}
