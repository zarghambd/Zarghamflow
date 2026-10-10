import 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    owner?: { id: string; email: string; role: 'admin' | 'user'; sessionId: string };
    csrfToken?: string;
  }
}
