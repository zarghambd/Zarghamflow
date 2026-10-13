/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: false,
  },
  async rewrites() {
    const apiOrigin = process.env.FASTIFY_API_ORIGIN ?? 'http://127.0.0.1:3000';
    return [
      { source: '/api/v1/:path*', destination: `${apiOrigin}/api/v1/:path*` },
      { source: '/health', destination: `${apiOrigin}/health` },
    ];
  },
};

export default nextConfig;
