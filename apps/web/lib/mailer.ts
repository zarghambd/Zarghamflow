import nodemailer from 'nodemailer';

const smtpHost = process.env.SMTP_HOST ?? '127.0.0.1';
const smtpPort = Number(process.env.SMTP_PORT ?? 1025);
const from = process.env.SMTP_FROM ?? 'ZarghamFlow <no-reply@localhost>';

const transport = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465,
  ...(process.env.SMTP_USER && process.env.SMTP_PASS ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } } : {})
});

const testMailQueue: Array<{ to: string; subject: string; text: string; html?: string }> = [];

export async function sendMagicLinkEmail(to: string, link: string): Promise<void> {
  const text = `Use this one-time link within 10 minutes to sign in or finish creating your account:\n\n${link}\n\nIf you did not request it, ignore this message.`;
  const html = `<p>Use this one-time link within 10 minutes to sign in or finish creating your account:</p><p><a href="${link}">Continue to ZarghamFlow</a></p><p>If you did not request it, ignore this message.</p>`;

  if (process.env.NODE_ENV === 'test') {
    testMailQueue.push({ to, subject: 'Your ZarghamFlow sign-in link', text, html });
    return;
  }

  await transport.sendMail({ from, to, subject: 'Your ZarghamFlow sign-in link', text, html });
}

export function takeTestMails() {
  const queue = [...testMailQueue];
  testMailQueue.splice(0, testMailQueue.length);
  return queue;
}
