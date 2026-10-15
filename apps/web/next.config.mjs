/** @type {import('next').NextConfig} */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  experimental: {
    typedRoutes: false,
    serverComponentsExternalPackages: ['better-sqlite3'],
    outputFileTracingRoot: rootDirectory,
    outputFileTracingIncludes: {
      '/api/*': ['../../apps/server/migrations/*.sql'],
    },
    outputFileTracingExcludes: {
      '/api/*': ['../../.env', './.env.local', '../../**/.env*'],
    },
  },
};

export default nextConfig;
