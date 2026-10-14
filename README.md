# ZarghamFlow

ZarghamFlow is a multi-user meeting and task planner with email-verified signup and administrator-managed accounts. The production app is a Next.js application with API route handlers, Neon/PostgreSQL, email magic links, reminders, Web Push, and an offline IndexedDB outbox. SQLite remains available for local development. The original `index.html` remains in the repository as the legacy app and localStorage backup reference.

**Stack choice:** Node 22, Next.js, Zod, SQLite for local development, Neon/PostgreSQL for Vercel, Nodemailer/Resend SMTP, and Web Push.

## Structure

- `apps/server`: API handlers, auth, database access, reminder scheduler, and backup/seed tools. The API handlers run inside the Next.js application; this package is not a separately deployed service.
- `apps/server/migrations`: versioned SQL migrations.
- `apps/web`: Next.js application, PWA client, IndexedDB cache/outbox, service worker, and API route handlers.
- `packages/shared`: shared TypeScript types and Zod validation schemas.
- `openapi.yaml`: versioned REST contract; API schema JSON is available at `/api/v1/openapi.json`.
- `index.html`, `Code.gs`: preserved legacy application and old Google Apps Script companion.

## Local Development

Prerequisites: Node.js 20+ (Node 22 recommended) and npm.

1. Copy `.env.example` to `.env` and set `ADMIN_EMAIL`, `SESSION_SECRET`, and `LOGIN_SECRET`. Make both secrets independently random and at least 32 characters. Anyone can create an account by verifying their email; only the designated admin address receives administrator privileges automatically.
2. Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` for a mail provider. For local development, if mail delivery is unavailable, development mode displays a one-time sign-in link instead.
3. Run `npm ci`.
4. Run `npm run dev`. The app and API are both available at `http://127.0.0.1:3001`; health is at `/api/health`.
5. Open the app, enter an email address, and follow the emailed verification link. The first verified user becomes admin if `ADMIN_EMAIL` is unset; otherwise the matching `ADMIN_EMAIL` user becomes admin. Admins can manage roles and disable accounts from the **Users** tab.

Database migrations are applied when the API is first used. For explicit migration, run `npm run db:migrate`. Use `npm run db:seed` only in development/test mode to add sample records.

## Environment Variables

| Variable | Purpose | Default/example |
|---|---|---|
| `NODE_ENV` | Runtime mode | `development` |
| `HOST` / `PORT` | Legacy standalone server bind settings (not used by Next.js) | `127.0.0.1` / `3000` |
| `DATABASE_PATH` | SQLite file location | `./data/zarghamflow.sqlite` |
| `DATABASE_URL` | PostgreSQL connection URL for Neon deployments | Unset for local SQLite |
| `ADMIN_EMAIL` | Designated initial administrator email; if unset, the first verified account becomes admin | Optional but recommended |
| `OWNER_EMAIL` | Legacy compatibility email; no longer restricts signup | Optional |
| `APP_URL` | Public app origin for sign-in/action links | `http://127.0.0.1:3001` |
| `SESSION_SECRET` | Session-related secret material | Required, 32+ random chars |
| `LOGIN_SECRET` | IP hashing/auth secret material | Required, different 32+ chars |
| `CRON_SECRET` | Bearer token protecting scheduled reminder processing | Required when enabling reminders on Vercel |
| `SMTP_HOST`, `SMTP_PORT` | SMTP endpoint | `127.0.0.1`, `1025` locally; `smtp.gmail.com`, `465` for Google Workspace |
| `SMTP_USER`, `SMTP_PASS` | SMTP account and app password | Optional locally; Google Workspace requires an App Password |
| `SMTP_FROM` | From identity; use the authenticated address for Google Workspace | `ZarghamFlow <no-reply@localhost>` locally |
| `RESEND_API_KEY`, `RESEND_FROM` | Use Resend SMTP instead of `SMTP_*` | Optional; API key and verified sender from Resend |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push credentials | Optional until push enabled |
| `VAPID_SUBJECT` | VAPID contact identity | `mailto:you@example.com` |
| `TRUST_PROXY` | Trust reverse-proxy headers | `false`; set `true` behind Caddy |
| `RATE_LIMIT_MAX` | General API requests per minute/IP | `60` |

Never commit `.env`. Generate secrets with a password manager or `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Rotate them by changing values, restarting, and invalidating active sessions when rotating `SESSION_SECRET` (sessions are stored as hashes; revoke all from Settings before rotation).

## Production Deployment

### Vercel with Neon

Use one Vercel project for the Next.js app and its API routes. Set the Vercel project's **Root Directory** to `apps/web`. The included `apps/web/vercel.json` builds the shared package and web app from the repository root. Neon supplies the persistent PostgreSQL database; do not use SQLite or `DATABASE_PATH` on Vercel.

1. Create a Neon project and copy its pooled PostgreSQL connection string. Keep it private; do not paste it into source control or chat.
2. In the Vercel project, select Node.js 22 and set Production environment variables: `NODE_ENV=production`, `DATABASE_URL` (the Neon pooled connection string), `APP_URL` (the exact public web origin), `ADMIN_EMAIL`, `TRUST_PROXY=true`, distinct random values for `SESSION_SECRET` and `LOGIN_SECRET` (at least 32 characters each), and a random `CRON_SECRET`. Do not set `DATABASE_PATH`, `HOST`, or `PORT`.
3. Configure email using either Resend (`RESEND_API_KEY` and `RESEND_FROM`) or SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`). Use a newly generated provider app password and a sender address authorized by that provider.
4. Deploy the project. The first API request applies the PostgreSQL schema migrations automatically. Verify `/api/health`, then request a new sign-in link from the public app. The included Vercel Cron calls `/api/cron/reminders` every minute and authenticates using `CRON_SECRET`; the deployment plan must support minute-level cron jobs.
5. Add Preview variables only if Preview deployments should connect to a database. Do not point Preview at Production unless intentional.

The first API startup against a new Neon database creates an empty schema. No production SQLite file or export was available during this setup, so existing live records have not been migrated. Keep the old deployment untouched and do not treat the new database as a data-preserving cutover until those records have been recovered and imported. Vercel Functions do not keep an in-memory reminder worker alive; the scheduled route is the reminder worker for Vercel. For self-hosting, configure an external scheduler to call the same protected route once per minute.

The Docker Compose/Caddy instructions below are only for self-hosting on a VPS; they are not required for Vercel + Neon. SMTP uses your configured mail provider; it does not require a local Docker mail service.

Docker Compose includes the app, Caddy TLS reverse proxy, and an optional daily backup service. Deploy on a small VPS with Docker Engine and Compose installed:

1. Point an A/AAAA DNS record for your hostname to the VPS. Open inbound TCP 80/443 (and UDP 443 if using HTTP/3).
2. Copy `.env.example` to `.env`; set `NODE_ENV=production`, `ADMIN_EMAIL`, two strong secrets, and `PUBLIC_DOMAIN`. Configure Resend by setting `RESEND_API_KEY` and a verified `SMTP_FROM` domain/address. Alternatively configure an SMTP provider with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`.
3. Verify the sender domain with your email provider and publish its SPF and DKIM DNS records (and DMARC policy). The app does not configure DNS for you.
4. Start with `docker compose up -d --build`. Caddy obtains and renews HTTPS certificates. The app listens only on the Compose network; persist the `zarghamflow-data` volume.
5. Enable daily backups with `docker compose --profile backup up -d backup`. Backups are retained for 14 days in `zarghamflow-backups`; also copy encrypted backups off-host.
6. Check `https://your-domain/api/health`, sign in, then enable push in Settings after generating VAPID keys with `npx web-push generate-vapid-keys`.

SQLite volume advice: restrict host filesystem permissions, encrypt the VPS disk/volume or use encrypted off-host backups, and limit access to the Docker host. Do not horizontally scale this SQLite deployment across hosts; migrate to PostgreSQL before that.

### Backup and Restore

A daily SQLite backup runs via the optional Compose profile. To create one manually from the project root, use `npm run db:backup --workspace @zarghamflow/server` (with the production environment and database volume available). The command uses SQLite's online backup API and prunes local snapshots older than 14 days. For Neon, configure and verify database backup/point-in-time recovery in the Neon console; the local SQLite backup command does not back up PostgreSQL.

To restore: stop the app (`docker compose stop app`), copy the chosen `.sqlite` file over the database file in the `zarghamflow-data` volume, ensure ownership/read permissions match the container, then run `docker compose up -d app`. Keep an untouched copy before replacement. For cross-version moves, start the app and allow migrations to apply, then validate `/api/health` and export a JSON backup from the UI.

The UI's JSON export is also suitable for migration. It accepts the old app format `{ meetings, tasks, settings? }`, including legacy `followUp`, `dueTime`, and meeting IDs; old non-UUID IDs are remapped and linked tasks are reconnected when possible. Import supports merge or replace via `/api/v1/import`.

## PWA and Offline Use

Use the HTTPS deployment URL, then choose **Install app** from Settings or the browser's install menu. The app shell and previously loaded assets are cached; records are cached in IndexedDB; offline edits are queued and synced on reconnect. Version conflicts are surfaced for review rather than silently overwriting newer records. On iOS, install through **Add to Home Screen**; Web Push requires iOS/iPadOS 16.4+ and the installed home-screen app. Browser push permission is user-initiated.

The service worker provides navigation fallback, static asset stale-while-revalidate, network-first API reads, push display, and a versioned cache cleanup. Browser storage is an offline working copy, not the authoritative database.

## API Summary

All application endpoints are under `/api/v1`; protected endpoints use the HttpOnly `zf_session` cookie. Mutations require the `zf_csrf` cookie echoed as `X-CSRF-Token`. `/api/health` is unauthenticated. `openapi.yaml` is the full source contract.

- Auth: `GET auth/csrf`, `POST auth/signup` (also `POST auth/request`), `POST auth/verify`, `GET auth/me`, `POST auth/logout`, `POST auth/logout-all`, `GET auth/sessions`.
- Admin: `GET admin/users`, `PATCH admin/users/:id` for role and activation management.
- Planner: CRUD `/meetings` and `/tasks`, `POST meetings/:id/duplicate`, `POST tasks/quick-add`, `GET dashboard`.
- Data: `POST import`, `GET export.json`, `GET export.csv`, `GET export.ics`.
- Reminders: `GET/PUT reminder-preferences`, `GET reminders`, `POST reminders/test`, push public key/subscribe endpoints.
- Health: `/api/health`.

## Reminder Behavior

Task lead reminders default to 24 hours and 1 hour; meeting reminders to 60 and 15 minutes; follow-up reminders target 08:00 local time. Date-only tasks are due at 23:59 local and notify at 09:00. All scheduled instants are stored as UTC and calculated with the user's IANA timezone. Spring-gap wall times are rejected; ambiguous fall-back times use Luxon's first occurrence. Quiet-hour reminders defer to the local quiet-end time, except meeting reminders when the event starts within 30 minutes. Meeting reminder emails include an `.ics` attachment; task emails include single-use, expiring Mark done and Snooze 1 hour links.

The worker claims due rows transactionally (`pending` → `processing`), records sent/failed state, and retries failures with exponential backoff up to six attempts. On Vercel, the protected `/api/cron/reminders` route is invoked every minute by Vercel Cron; the `CRON_SECRET` environment variable must be set. On self-hosted deployments, configure a scheduler to invoke that route every minute. SQLite and SMTP cannot provide true distributed exactly-once delivery across a process crash between provider acceptance and database acknowledgement; this implementation is idempotent at the reminder-row level but SMTP is at-least-once in that narrow crash window. Configure your provider's delivery logs/alerts for stronger operational visibility.

## Checks

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run audit`

CI runs lint, typecheck, unit tests, build, and production dependency audit. Automated tests cover generic signup responses, CSRF, token expiry/reuse, multiple sessions, global sign-out, auth rate limits, first-admin bootstrap, regular-user access denial, admin deactivation, and last-admin protection; reminder tests cover timezone/DST and quiet-hours, rescheduling/deduplication, retry recovery, date-only timing, and ICS attachments. Full planner API coverage, provider-backed delivery, browser E2E, and measured Lighthouse 90+ acceptance still require additional tests and configured infrastructure.

## Requirement Coverage / Outstanding Configuration

Implemented in this repository: verified-email signup, role-aware sessions, admin user list/role/activation management, hashed one-use tokens and sessions, CSRF, security headers, SQLite schema and migrations, planner API and import/export, local IndexedDB/outbox, installable manifest/service worker, SMTP/Resend transport, VAPID push delivery, persistent reminder rows/retries, reminder preferences/log, action links, Compose/Caddy, backups, CI, and documented setup.

Configure manually: designated admin email and secrets, SMTP/Resend credentials, public domain/DNS/HTTPS, verified email sender with SPF/DKIM/DMARC, VAPID keys, Docker on the host, and off-site encrypted backup destination. Not implemented yet: Google OIDC/passkeys, optional Google Calendar OAuth/two-way sync, comprehensive planner API tests, Playwright E2E, and measured Lighthouse 90+ scores. Do not treat those items as production-complete until implemented and tested.
