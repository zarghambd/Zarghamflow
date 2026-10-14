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

  it('rejects missing callback origin', () => {
    expect(() => parseConfig({ ...validVercelEnvironment, APP_URL: undefined })).toThrow('APP_URL');
  });

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
});
