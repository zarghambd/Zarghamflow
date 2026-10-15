import { describe, expect, it } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.LOGIN_SECRET = 'config-test-login-secret-0123456789abcdef';

const { parseConfig } = await import('./config.js');

const validVercelEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  VERCEL: '1',
  DATABASE_URL: 'postgresql://user:password@example.test/database',
  APP_URL: 'https://taskora.example',
  LOGIN_SECRET: 'production-login-secret-0123456789abcdef',
  ADMIN_EMAIL: 'admin@example.test',
  RESEND_API_KEY: 're_test_key',
  RESEND_FROM: 'Taskora <login@example.test>'
};

describe('Vercel production configuration', () => {
  it('accepts the required database, callback origin, login secret, and mail provider', () => {
    expect(parseConfig(validVercelEnvironment).APP_URL).toBe('https://taskora.example');
  });

  it('rejects missing database configuration', () => {
    expect(() => parseConfig({ ...validVercelEnvironment, DATABASE_URL: undefined })).toThrow('DATABASE_URL');
  });

  it('requires ADMIN_EMAIL for production and Vercel deployments', () => {
    expect(() => parseConfig({ ...validVercelEnvironment, ADMIN_EMAIL: undefined })).toThrow('ADMIN_EMAIL is required');
    expect(() => parseConfig({
      NODE_ENV: 'development',
      VERCEL: '1',
      LOGIN_SECRET: 'production-login-secret-0123456789abcdef'
    })).toThrow('ADMIN_EMAIL is required');
    expect(() => parseConfig({
      NODE_ENV: 'production',
      LOGIN_SECRET: 'production-login-secret-0123456789abcdef'
    })).toThrow('ADMIN_EMAIL is required');
  });

  it('rejects missing callback origin', () => {
    expect(() => parseConfig({ ...validVercelEnvironment, APP_URL: undefined })).toThrow('APP_URL');
  });

  it.each(['http://taskora.example', 'https://taskora.example/signin', 'https://taskora.example/?token=bad'])(
    'rejects a non-origin production APP_URL: %s',
    (APP_URL) => {
      expect(() => parseConfig({ ...validVercelEnvironment, APP_URL })).toThrow('APP_URL must be the HTTPS origin');
    }
  );

  it('rejects missing email provider configuration', () => {
    expect(() => parseConfig({
      ...validVercelEnvironment,
      RESEND_API_KEY: undefined,
      RESEND_FROM: undefined
    })).toThrow('RESEND_API_KEY or SMTP_HOST');
  });

  it('rejects partial SMTP credentials', () => {
    expect(() => parseConfig({
      ...validVercelEnvironment,
      RESEND_API_KEY: undefined,
      RESEND_FROM: undefined,
      SMTP_HOST: 'smtp.example.test',
      SMTP_USER: 'mailer',
      SMTP_PASS: undefined
    })).toThrow('SMTP_USER and SMTP_PASS must be configured together');
  });

  it('defaults local development to the Next.js dev server origin', () => {
    expect(parseConfig({
      NODE_ENV: 'development',
      LOGIN_SECRET: 'local-development-login-secret-0123456789'
    }).APP_URL).toBe('http://127.0.0.1:3001');
  });
});
