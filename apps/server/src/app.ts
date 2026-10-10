import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fastifyStatic from '@fastify/static';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { config } from './config.js';
import { registerAuth } from './auth.js';
import { registerRoutes } from './routes.js';

export async function buildApp() {
  const app = Fastify({
    logger: config.NODE_ENV === 'test' ? false : { level: config.NODE_ENV === 'production' ? 'info' : 'debug', redact: ['req.headers.cookie', 'req.headers.authorization'] },
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1_000_000
  });

  await app.register(cookie);
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:', 'blob:'], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"],
        connectSrc: ["'self'"], fontSrc: ["'self'", 'data:'], manifestSrc: ["'self'"], workerSrc: ["'self'", 'blob:'], formAction: ["'self'"]
      }
    },
    hsts: config.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false
  });
  await app.register(rateLimit, { global: true, max: config.RATE_LIMIT_MAX, timeWindow: '1 minute' });
  await app.register(swagger, { openapi: { info: { title: 'ZarghamFlow API', version: '1.0.0' }, servers: [{ url: config.APP_URL }] } });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id || randomUUID());
    reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;
    const code = statusCode === 429 ? 'RATE_LIMITED' : statusCode === 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR';
    const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
    reply.code(statusCode).send({ error: { code, message: statusCode === 500 ? 'An unexpected error occurred.' : message } });
  });

  await app.register(async (api) => {
    registerAuth(api);
    await registerRoutes(api);
  });

  if (config.NODE_ENV === 'production') {
    await app.register(fastifyStatic, { root: resolve(process.cwd(), '../web/dist'), prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
      return reply.sendFile('index.html');
    });
  }

  return app;
}
