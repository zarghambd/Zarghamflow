import { z } from 'zod';
import { config as loadDotEnv } from 'dotenv';
import { resolve } from 'node:path';

if (process.env.NODE_ENV !== 'test') loadDotEnv({ path: resolve(process.cwd(), '../../.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default('./data/zarghamflow.sqlite'),
  DATABASE_URL: z.string().url().optional(),
  OWNER_EMAIL: z.string().email().optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  APP_URL: z.string().url().default('http://localhost:5173'),
  LOGIN_SECRET: z.string().min(32),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('ZarghamFlow <no-reply@localhost>'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default('ZarghamFlow <onboarding@resend.dev>'),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:owner@example.com'),
  TRUST_PROXY: z.coerce.boolean().default(false),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60)
});

export function parseConfig(env: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(env);
  if (parsed.NODE_ENV === 'production' && env.VERCEL === '1') {
    const missing: string[] = [];
    if (!parsed.DATABASE_URL) missing.push('DATABASE_URL');
    if (!env.APP_URL?.trim()) missing.push('APP_URL');
    if (!parsed.RESEND_API_KEY && !parsed.SMTP_HOST) missing.push('RESEND_API_KEY or SMTP_HOST');
    if (Boolean(parsed.SMTP_USER) !== Boolean(parsed.SMTP_PASS)) missing.push('SMTP_USER and SMTP_PASS must be configured together');
    if (missing.length) {
      throw new Error(`Invalid Vercel production configuration: ${missing.join(', ')}.`);
    }
  }
  return parsed;
}

export const config = parseConfig(process.env);
