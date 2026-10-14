import nodemailer from 'nodemailer';
import type { Attachment } from 'nodemailer/lib/mailer';
import { config } from './config.js';

const transport = config.RESEND_API_KEY
  ? nodemailer.createTransport({ host: 'smtp.resend.com', port: 465, secure: true, auth: { user: 'resend', pass: config.RESEND_API_KEY } })
  : nodemailer.createTransport({
      host: config.SMTP_HOST ?? '127.0.0.1', port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      ...(config.SMTP_USER && config.SMTP_PASS ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS } } : {})
    });
type MailTransport = ReturnType<typeof nodemailer.createTransport>;
const usesResend = Boolean(config.RESEND_API_KEY);

function getDeliveryTransport(): Promise<MailTransport> {
  if (!config.RESEND_API_KEY && Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASS)) {
    return Promise.reject(new Error('SMTP_USER and SMTP_PASS must both be configured for authenticated SMTP.'));
  }
  if (config.RESEND_API_KEY || config.SMTP_HOST) return Promise.resolve(transport);
  if (process.env.VERCEL !== '1') return Promise.resolve(transport);
  return Promise.reject(new Error('Email delivery is not configured. Set RESEND_API_KEY or the SMTP environment variables.'));
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
