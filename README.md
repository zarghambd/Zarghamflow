# ZarghamFlow

ZarghamFlow is a multi-user meeting and task planner with email-verified signup and administrator-managed accounts. The production app is a Fastify/TypeScript service with SQLite, a Vite TypeScript PWA, email magic links, server-side reminders, Web Push, and an offline IndexedDB outbox. The original `index.html` remains in the repository as the legacy app and localStorage backup reference.

**Stack choice:** Node 22, Fastify, Zod, Drizzle/SQLite, Vite/vanilla TypeScript, Nodemailer/Resend SMTP, and Web Push. SQLite is a good fit for a small team on one VPS; keep its persistent volume backed up and do not run multiple independent app instances against a local file.

## Structure

- `apps/server`: Fastify API, auth, SQLite access, reminder scheduler, and backup/seed tools.
- `apps/server/migrations`: versioned SQL migrations.
- `apps/web`: PWA client, static shell, IndexedDB cache/outbox, and service worker.
- `packages/shared`: shared TypeScript types and Zod validation schemas.
- `openapi.yaml`: versioned REST contract. Fastify Swagger UI is available at `/docs`.
- `index.html`, `Code.gs`: preserved legacy application and old Google Apps Script companion.

## Local Development

Prerequisites: Node.js 20+ (Node 22 recommended) and npm. Docker is optional for the Node app; it is used for Mailpit and Compose deployments.

1. Copy `.env.example` to `.env` and set `ADMIN_EMAIL`, `SESSION_SECRET`, and `LOGIN_SECRET`. Make both secrets independently random and at least 32 characters. Anyone can create an account by verifying their email; only the designated admin address receives administrator privileges automatically.
2. For local email testing, run `docker compose --profile local-mail up mailpit`; use `SMTP_HOST=127.0.0.1` in `.env`. Mailpit UI is at `http://localhost:8025`. Without Docker, point SMTP settings at a development SMTP relay; if mail delivery is unavailable, development mode displays a one-time local sign-in link instead.
3. Run `npm install`, then `npm install-scripts approve better-sqlite3 esbuild` and `npm rebuild better-sqlite3 esbuild` if npm 11 reports lifecycle scripts blocked.
4. Run `npm run dev`. The web app is at `http://127.0.0.1:3001`, API at `http://127.0.0.1:3000`, OpenAPI docs at `http://127.0.0.1:3000/docs`, and health at `/health`.
5. Open the app, enter an email address, and follow the emailed verification link. The first verified user becomes admin if `ADMIN_EMAIL` is unset; otherwise the matching `ADMIN_EMAIL` user becomes admin. Admins can manage roles and disable accounts from the **Users** tab.

The database migration is applied automatically by the API on startup. For explicit migration, run `npm run db:migrate`. Use `npm run db:seed` only in development/test mode to add sample records.

## Environment Variables

| Variable | Purpose | Default/example |
|---|---|---|
| `NODE_ENV` | Runtime mode | `development` |
| `HOST` / `PORT` | API bind address | `127.0.0.1` / `3000` |
| `DATABASE_PATH` | SQLite file location | `./data/zarghamflow.sqlite` |
| `ADMIN_EMAIL` | Designated initial administrator email; if unset, the first verified account becomes admin | Optional but recommended |
| `OWNER_EMAIL` | Legacy compatibility email; no longer restricts signup | Optional |
| `APP_URL` | Public app origin for sign-in/action links | `http://localhost:5173` |
| `SESSION_SECRET` | Session-related secret material | Required, 32+ random chars |
| `LOGIN_SECRET` | IP hashing/auth secret material | Required, different 32+ chars |
| `SMTP_HOST`, `SMTP_PORT` | SMTP endpoint | `127.0.0.1`, `1025` |
| `SMTP_USER`, `SMTP_PASS` | Optional SMTP credentials | Optional |
| `SMTP_FROM` | From identity | `ZarghamFlow <no-reply@localhost>` |
| `RESEND_API_KEY` | Use Resend SMTP instead of `SMTP_*` | Optional; API key from Resend |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push credentials | Optional until push enabled |
| `VAPID_SUBJECT` | VAPID contact identity | `mailto:you@example.com` |
| `TRUST_PROXY` | Trust reverse-proxy headers | `false`; set `true` behind Caddy |
| `RATE_LIMIT_MAX` | General API requests per minute/IP | `60` |
| `PUBLIC_DOMAIN` | HTTPS hostname for Compose/Caddy | Required for a public server |

Never commit `.env`. Generate secrets with a password manager or `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Rotate them by changing values, restarting, and invalidating active sessions when rotating `SESSION_SECRET` (sessions are stored as hashes; revoke all from Settings before rotation).

## Production Deployment

### Vercel frontend with Railway API (no Docker)

Vercel Functions have an ephemeral, read-only application filesystem, so they must not host this app's SQLite database. Keep the web service on Vercel and run the Fastify API as a single Railway service with a persistent volume:

1. Create a Railway service from the repository with the repository root (`/`) as its root directory. `railway.json` supplies the build, start, and `/health` check commands; it uses Railpack and does not require a Dockerfile.
2. Attach a Railway volume to the API service at `/data`. In Railway Variables set `NODE_ENV=production`, `HOST=0.0.0.0`, `DATABASE_PATH=/data/zarghamflow.sqlite`, `TRUST_PROXY=true`, `APP_URL=https://www.zargham-daily-update.website`, `ADMIN_EMAIL`, `SESSION_SECRET`, and `LOGIN_SECRET`. Use two distinct random secrets of at least 32 characters.
3. Configure outbound email on the API service with a verified provider, such as `RESEND_API_KEY` and `RESEND_FROM`; local Mailpit is not a production mailer. Set any optional VAPID variables only if enabling Web Push.
4. Generate a Railway public domain for the API and confirm its `/health` endpoint returns HTTP 200. Keep the API at one replica because its SQLite database is a single-file volume.
5. In the Vercel web project's Production environment variables, set `FASTIFY_API_URL` to the Railway API origin (for example, `https://your-api.up.railway.app`, without an API path). Redeploy the Vercel web service after setting it. Add the same variable for Preview only if Preview deployments should use that API.
6. Verify `https://www.zargham-daily-update.website/api/auth/csrf`, then request a fresh sign-in link. Set `APP_URL` to the exact public web origin so email links return to the deployed site.

Do not set `DATABASE_PATH` to `/tmp` on Vercel: it is not persistent or shared between function instances. The Vercel project should deploy only the web service; the Fastify service is deployed separately on Railway.

Docker Compose includes the app, Caddy TLS reverse proxy, a Mailpit service for local testing, and an optional daily backup service. Deploy on a small VPS with Docker Engine and Compose installed:

1. Point an A/AAAA DNS record for your hostname to the VPS. Open inbound TCP 80/443 (and UDP 443 if using HTTP/3).
2. Copy `.env.example` to `.env`; set `NODE_ENV=production`, `ADMIN_EMAIL`, two strong secrets, and `PUBLIC_DOMAIN`. Configure Resend by setting `RESEND_API_KEY` and a verified `SMTP_FROM` domain/address. Alternatively configure an SMTP provider with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS`.
3. Verify the sender domain with your email provider and publish its SPF and DKIM DNS records (and DMARC policy). The app does not configure DNS for you.
4. Start with `docker compose up -d --build`. Caddy obtains and renews HTTPS certificates. The app listens only on the Compose network; persist the `zarghamflow-data` volume.
5. Enable daily backups with `docker compose --profile backup up -d backup`. Backups are retained for 14 days in `zarghamflow-backups`; also copy encrypted backups off-host.
6. Check `https://your-domain/health`, sign in, then enable push in Settings after generating VAPID keys with `npx web-push generate-vapid-keys`.

SQLite volume advice: restrict host filesystem permissions, encrypt the VPS disk/volume or use encrypted off-host backups, and limit access to the Docker host. Do not horizontally scale this SQLite deployment across hosts; migrate to PostgreSQL before that.

### Backup and Restore

A daily backup runs via the optional Compose profile. To create one manually from the project root, use `npm run db:backup --workspace @zarghamflow/server` (with the production environment and database volume available). The backup command uses SQLite's online backup API and prunes local snapshots older than 14 days.

To restore: stop the app (`docker compose stop app`), copy the chosen `.sqlite` file over the database file in the `zarghamflow-data` volume, ensure ownership/read permissions match the container, then run `docker compose up -d app`. Keep an untouched copy before replacement. For cross-version moves, start the app and allow migrations to apply, then validate `/health` and export a JSON backup from the UI.

The UI's JSON export is also suitable for migration. It accepts the old app format `{ meetings, tasks, settings? }`, including legacy `followUp`, `dueTime`, and meeting IDs; old non-UUID IDs are remapped and linked tasks are reconnected when possible. Import supports merge or replace via `/api/v1/import`.

## PWA and Offline Use

Use the HTTPS deployment URL, then choose **Install app** from Settings or the browser's install menu. The app shell and previously loaded assets are cached; records are cached in IndexedDB; offline edits are queued and synced on reconnect. Version conflicts are surfaced for review rather than silently overwriting newer records. On iOS, install through **Add to Home Screen**; Web Push requires iOS/iPadOS 16.4+ and the installed home-screen app. Browser push permission is user-initiated.

The service worker provides navigation fallback, static asset stale-while-revalidate, network-first API reads, push display, and a versioned cache cleanup. Browser storage is an offline working copy, not the authoritative database.

## API Summary

All application endpoints are under `/api/v1`; protected endpoints use the HttpOnly `zf_session` cookie. Mutations require the `zf_csrf` cookie echoed as `X-CSRF-Token`. `/health` is unauthenticated. `/docs` serves Swagger UI and `openapi.yaml` is the full source contract.

- Auth: `GET auth/csrf`, `POST auth/signup` (also `POST auth/request`), `POST auth/verify`, `GET auth/me`, `POST auth/logout`, `POST auth/logout-all`, `GET auth/sessions`.
- Admin: `GET admin/users`, `PATCH admin/users/:id` for role and activation management.
- Planner: CRUD `/meetings` and `/tasks`, `POST meetings/:id/duplicate`, `POST tasks/quick-add`, `GET dashboard`.
- Data: `POST import`, `GET export.json`, `GET export.csv`, `GET export.ics`.
- Reminders: `GET/PUT reminder-preferences`, `GET reminders`, `POST reminders/test`, push public key/subscribe endpoints.
- Health: `/health`.

## Reminder Behavior

Task lead reminders default to 24 hours and 1 hour; meeting reminders to 60 and 15 minutes; follow-up reminders target 08:00 local time. Date-only tasks are due at 23:59 local and notify at 09:00. All scheduled instants are stored as UTC and calculated with the user's IANA timezone. Spring-gap wall times are rejected; ambiguous fall-back times use Luxon's first occurrence. Quiet-hour reminders defer to the local quiet-end time, except meeting reminders when the event starts within 30 minutes. Meeting reminder emails include an `.ics` attachment; task emails include single-use, expiring Mark done and Snooze 1 hour links.

The worker claims due rows transactionally (`pending` → `processing`), records sent/failed state, and retries failures with exponential backoff up to six attempts. SQLite and SMTP cannot provide true distributed exactly-once delivery across a process crash between provider acceptance and database acknowledgement; this implementation is idempotent at the reminder-row level but SMTP is at-least-once in that narrow crash window. Configure your provider's delivery logs/alerts for stronger operational visibility.

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
