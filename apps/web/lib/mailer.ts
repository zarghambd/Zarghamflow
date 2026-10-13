import nodemailer from 'nodemailer';
import { Resend } from 'resend';

const resendApiKey = process.env.RESEND_API_KEY?.trim();
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const resendFrom = process.env.RESEND_FROM ?? 'ZarghamFlow <onboarding@resend.dev>';
const smtpHost = process.env.SMTP_HOST ?? '127.0.0.1';
const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const from = process.env.SMTP_FROM ?? (smtpUser ? `ZarghamFlow <${smtpUser}>` : 'ZarghamFlow <no-reply@localhost>');

const transport = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  ...(smtpUser && smtpPass ? { auth: { user: smtpUser, pass: smtpPass } } : {})
});

const testMailQueue: Array<{ to: string; subject: string; text: string; html?: string }> = [];

export async function sendMagicLinkEmail(to: string, link: string): Promise<void> {
  const subject = 'Your ZarghamFlow sign-in link';
  const text = `Use this one-time link within 10 minutes to sign in or finish creating your account:\n\n${link}\n\nIf you did not request it, ignore this message.`;
  const html = `<p>Use this one-time link within 10 minutes to sign in or finish creating your account:</p><p><a href="${link}">Continue to ZarghamFlow</a></p><p>If you did not request it, ignore this message.</p>`;

  if (process.env.NODE_ENV === 'test') {
    testMailQueue.push({ to, subject, text, html });
    return;
  }

  if (resend) {
    const { error } = await resend.emails.send({ from: resendFrom, to, subject, text, html });
    if (error) throw new Error(`Resend email delivery failed: ${error.message}`);
    return;
  }

  await transport.sendMail({ from, to, subject, text, html });
}

export function takeTestMails() {
  const queue = [...testMailQueue];
  testMailQueue.splice(0, testMailQueue.length);
  return queue;
}
