import nodemailer from 'nodemailer';
import type { Attachment } from 'nodemailer/lib/mailer';
import { getToken } from '@vercel/connect';
import { config } from './config.js';

const transport = config.RESEND_API_KEY
  ? nodemailer.createTransport({ host: 'smtp.resend.com', port: 465, secure: true, auth: { user: 'resend', pass: config.RESEND_API_KEY } })
  : nodemailer.createTransport({
      host: config.SMTP_HOST ?? '127.0.0.1', port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      ...(config.SMTP_USER && config.SMTP_PASS ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } : {})
    });
type MailTransport = ReturnType<typeof nodemailer.createTransport>;
let vercelTransport: Promise<MailTransport> | undefined;
  const usesResend = process.env.VERCEL === '1' || Boolean(config.RESEND_API_KEY);

function getDeliveryTransport(): Promise<MailTransport> {
  if (process.env.VERCEL !== '1') return Promise.resolve(transport);

  vercelTransport ??= getToken('resend/zarghamflow', { subject: { type: 'app' } }).then((apiKey) =>
    nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,
      secure: true,
      auth: { user: 'resend', pass: apiKey },
    })
  );

  return vercelTransport.catch((error: unknown) => {
    vercelTransport = undefined;
    throw error;
  });
}

export type TestMail = { to: string; subject: string; text: string; html?: string; attachments?: Attachment[] };
const testMailQueue: TestMail[] = [];
let testMailFailures = 0;

export async function sendMail(to: string, subject: string, text: string, html?: string, attachments?: Attachment[]): Promise<void> {
  if (config.NODE_ENV === 'test') {
    if (testMailFailures > 0) {
      testMailFailures--;
      throw new Error('Simulated test-mail transport failure');
    }
    testMailQueue.push({ to, subject, text, ...(html ? { html } : {}), ...(attachments ? { attachments } : {}) });
    return;
  }
  const deliveryTransport = await getDeliveryTransport();
  await deliveryTransport.sendMail({
    from: usesResend ? config.RESEND_FROM : config.SMTP_FROM,
    to,
    subject,
    text,
    ...(html ? { html } : {}),
    ...(attachments ? { attachments } : {})
  });
}

export function takeTestMails(): TestMail[] {
  return testMailQueue.splice(0);
}

export function failNextTestEmails(count = 1): void {
  if (config.NODE_ENV !== 'test') throw new Error('Test mail failure injection is only available in test mode.');
  testMailFailures = Math.max(0, Math.floor(count));
}

export async function verifyMail(): Promise<void> {
  const deliveryTransport = await getDeliveryTransport();
  await deliveryTransport.verify();
}
