import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const baseURL = 'http://127.0.0.1:3001';
const databasePath = join(tmpdir(), `zarghamflow-playwright-${process.pid}.sqlite`);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true
  },
  webServer: {
    command: 'npm run dev --workspace @zarghamflow/web',
    url: `${baseURL}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      APP_URL: baseURL,
      ADMIN_EMAIL: 'e2e-admin@example.test',
      DATABASE_PATH: databasePath,
      DATABASE_URL: '',
      LOGIN_SECRET: 'playwright-login-secret-0123456789abcdef',
      NODE_ENV: 'development',
      RESEND_API_KEY: '',
      SMTP_HOST: '127.0.0.1',
      SMTP_PASS: '',
      SMTP_PORT: '1',
      SMTP_USER: '',
      TRUST_PROXY: 'true',
      ZF_DISABLE_DOTENV: '1'
    }
  }
});
