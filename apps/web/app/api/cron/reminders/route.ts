import { runReminderTick } from '../../../../../server/dist/reminders/scheduler.js';
import { safeEqual } from '../../../../../server/dist/security.js';
import { applyMigrations } from '../../../../../server/dist/db/migrations.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ error: { code: 'CRON_NOT_CONFIGURED', message: 'Reminder scheduling is not configured.' } }, { status: 503 });
  }
  if (!safeEqual(request.headers.get('authorization') ?? '', `Bearer ${secret}`)) {
    return Response.json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized.' } }, { status: 401 });
  }

  await applyMigrations();
  await runReminderTick();
  return Response.json({ ok: true });
}
