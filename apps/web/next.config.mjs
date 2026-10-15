/** @type {import('next').NextConfig} */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const buildId = `${process.env.VERCEL_GIT_COMMIT_SHA ?? 'local'}-${Date.now().toString(36)}`;

const nextConfig = {
  output: 'standalone',
  generateBuildId: async () => buildId,
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
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
