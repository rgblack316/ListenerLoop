# ListenerLoop: Project Plan

<p align="center">
  <img src="brand-assets/ListenerLoop-Full-Logo-gradient.svg" alt="ListenerLoop: Turn listener feedback into conversation" width="480">
</p>

*Turn listener feedback into conversation.*

Last updated: 2026-10-24. Tick the checkboxes below as work lands.

## Overview and goals

A self-hosted, open-source (AGPL) widget that lets listeners record a voice message from any podcast website, replacing SpeakPipe. One installation serves many shows, and every message lands in a private admin inbox as an MP3.

**Goals**

- Embed on any site with one script tag.
- Record in the browser using web standards only, on desktop and mobile (including iOS Safari).
- Normalize every recording to MP3.
- Store audio in S3-compatible buckets, with local disk as a fork-friendly option.
- Protect against spam with Cloudflare Turnstile.
- Alert the admin by email on each new message.

**Out of scope for v1**

- Multi-user admin accounts (planned for a later phase).
- Phone-in numbers via Twilio (separate effort, adds cost).
- Sharing logins or data with the admin's other podcast tools. This is its own repository and its own installation.

## Decisions locked in

| Area | Decision |
| --- | --- |
| Backend | Node.js + TypeScript with Fastify. Workload is I/O-bound, so language speed is a wash; Node gives a mature S3 SDK and one language across server, embed and admin UI. |
| Database | SQLite (better-sqlite3) for v1, with portable migrations so Postgres is possible later. |
| Audio format | Every upload normalized to MP3 with ffmpeg. The original is kept optionally (config flag). |
| Storage | Adapter interface with two drivers: `s3` (any S3-compatible service, including Cloudflare R2) preferred, and `local` for forks. |
| Processing | ffmpeg run inline after upload through a simple in-process queue. No Redis. |
| Admin auth | Single admin, argon2 password hash, session cookie. Multi-user later. The admin UI is server-rendered pages with htmx for small live updates, with no SPA framework. |
| Email alerts | SMTP or Resend, chosen by config. |
| Spam protection | Cloudflare Turnstile is required for public submissions. One app-wide Turnstile key pair, created once for the app's own domain, covers every show; embedding sites need no Turnstile key of their own. A show can optionally override it with its own key pair in the admin dashboard. |
| Transcription | Deferred to a later phase behind an optional adapter (whisper.cpp or an API). Off by default. |
| Deploy | Docker Compose on Ubuntu Server (app + Caddy for automatic HTTPS). A systemd install is documented for non-Docker users. |
| License | AGPL-3.0, matching PodSovereign. |
| Name | ListenerLoop. Tagline: "Turn listener feedback into conversation." Repository: `rgblack316/ListenerLoop`. Domain: `listenerloop.app`. |

## Architecture

```
Podcast website (embed.js adds a button)
        |  opens
        v
Widget iframe (recorder + Turnstile)
        |  POST recording
        v
App (Fastify): validates, converts to MP3 <---- Admin dashboard (inbox and playback)
   |            |             |
   v            v             v
Storage      Database      Email alert
(S3 or       (SQLite)      (SMTP or Resend)
local disk)
```

A listener's browser loads the widget from the app and posts one recording. The app validates it, converts it to MP3, stores the audio, saves the message record and sends an email alert. The admin dashboard reads from the same app, and audio is only reachable through authenticated requests.

## Embed contract

Site owners paste one line; everything else lives on the tool's own domain.

```html
<script src="https://voicemail.example.com/embed.js" data-site-key="pk_abc123" async></script>
```

1. `embed.js` (small, dependency-free) injects a button (or mounts into an element with `data-target`) styled by the show's config.
2. Clicking opens a modal containing an iframe pointing at `/widget?key=pk_abc123`, with `allow="microphone"`.
3. The iframe holds the recorder UI and the Turnstile challenge, so host-site CSS and JavaScript cannot interfere with it. Because the challenge runs on the app's own domain, embedding sites need no Turnstile key of their own.
4. The iframe posts events to the parent with `postMessage` (`vm:ready`, `vm:submitted`, `vm:error`, `vm:close`). The parent only accepts them from the widget origin.

**Per-show configuration** (managed in admin, fetched by site key): button label and colors, prompt text, maximum duration, optional Turnstile key override, whether the email field is shown (always optional for the listener; the name field is always shown and required), consent text, thank-you message, and the allowed origins list.

**Fallback link:** each show also gets a hosted page at `/s/<show-slug>` for newsletters, social bios and browsers where iframe microphone access is blocked.

## Recording and processing pipeline

**In the browser**

1. Request the mic with `getUserMedia({ audio: true })` on a user click (required on iOS).
2. Record with `MediaRecorder`, choosing the first supported type from `audio/webm;codecs=opus`, `audio/mp4`, then the browser default.
3. Show a live level meter and timer; auto-stop at the configured maximum (default 3 minutes).
4. Ask for the listener's name (required) and, optionally, an email address. Let them play back, re-record, or submit once a name is entered.
5. Submit as `multipart/form-data` (audio blob, required name, optional email, consent flag, Turnstile token) in a single POST.
6. If the mic is unavailable or blocked (in-app browsers, permission denied), offer a file-upload input and a link to the hosted page.

**On the server**

1. Validate site key, origin, Turnstile token, a non-empty sender name (up to 100 characters), size cap (default 15 MB) and content type.
2. Write the upload to a temp file and create a `messages` row with status `processing`.
3. Probe with `ffprobe`: reject non-audio, enforce the duration cap, record the real duration.
4. Run `ffmpeg` to produce MP3 (mono, 64 kbps by default, configurable), with optional loudness normalization.
5. Hand the MP3 (and the original, if retention is on) to the storage adapter; set status `ready`; delete temp files.
6. Send the email notification. On failure, set status `failed` and keep the original so it can be retried from admin.

**Format notes:** Chrome and Firefox produce WebM/Opus, Safari and iOS produce MP4/AAC. The server never trusts the reported MIME type; `ffprobe` decides.

## Data model

Four tables for v1. IDs are ULIDs; timestamps are UTC.

| Table | Key fields |
| --- | --- |
| `shows` | id, name, slug, site_key (public), allowed_origins (list), notify_email, max_seconds, ask_email, consent_text, button_label, accent_color, prompt_text, thanks_text, retain_original, turnstile_site_key (optional override), turnstile_secret_key (optional override, stored encrypted), created_at |
| `messages` | id, show_id, status (`processing`, `ready`, `failed`), starred, archived, sender_name (required), sender_email (optional), consent_given, duration_seconds, mp3_key, original_key, size_bytes, original_mime, ip_hash, user_agent, transcript (nullable), notes, created_at, deleted_at |
| `admin` | id, email, password_hash (argon2id), created_at (single row in v1; becomes `users` with roles later) |
| `settings` | key, value (email provider, storage options changed in admin, retention days) |

**Notes**

- IP addresses are stored only as a salted hash, used for rate-limit review, never in plain text.
- Deletion is soft first (`deleted_at`), with a purge job that removes the files and row after a configurable grace period.
- Storage keys follow `shows/<show_id>/<yyyy>/<message_id>.mp3` so buckets stay browsable.

## API endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /embed.js` | none | Loader script (cacheable). |
| `GET /widget` | site key | Recorder iframe page. |
| `GET /s/:slug` | none | Hosted recording page for a show. |
| `GET /api/public/config?key=` | site key + origin check | Show display settings and Turnstile site key. |
| `POST /api/public/messages` | site key, origin, Turnstile | Submit a recording; returns message id and status. |
| `POST /api/admin/login`, `POST /api/admin/logout` | none / session | Session cookie auth with CSRF token. |
| `GET /api/admin/messages` | session | List with filters (show, status, starred, archived), search, pagination. |
| `GET /api/admin/messages/:id` | session | Detail, including a short-lived audio URL. |
| `PATCH /api/admin/messages/:id` | session | Star, archive, edit notes. |
| `DELETE /api/admin/messages/:id` | session | Soft delete. |
| `POST /api/admin/messages/:id/retry` | session | Re-run processing for a failed message. |
| `GET /api/admin/messages/:id/audio` | session | Stream or redirect to a signed URL. |
| `GET/POST/PATCH/DELETE /api/admin/shows` | session | Manage shows and site keys. |
| `GET/PUT /api/admin/settings` | session | Email provider, retention, storage status. |
| `GET /healthz` | none | Health check for Docker and uptime monitors. |

Public routes send CORS headers only for the show's allowed origins. The widget iframe itself is served with `frame-ancestors` limited to those same origins.

## Storage adapters

The app talks to one small interface, so a driver can be swapped with a single environment variable.

```ts
interface StorageDriver {
  put(key: string, file: string | Buffer, contentType: string): Promise<void>;
  getStream(key: string, range?: { start: number; end: number }): Promise<Readable>;
  getSignedUrl?(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}
```

| Driver | Details |
| --- | --- |
| `s3` | AWS SDK v3 against any S3-compatible endpoint (R2, Backblaze B2, MinIO, AWS). Private bucket; admin playback uses short-lived signed URLs. |
| `local` | Files under a mounted data directory. Audio is streamed through the app with HTTP range support so seeking works. |

Buckets are always private. Audio is never publicly addressable; only authenticated admin requests can obtain a URL.

## Admin dashboard

Server-rendered pages, with htmx for small live updates such as starring or archiving without a page reload. The layout is mobile-friendly so messages can be reviewed from a phone.

- **Inbox:** all shows or one show; filter by new, starred, archived, failed; sort newest first; unread indicator; the sender's name appears on every row so you know who left a message before you play it.
- **Message view:** audio player with speed control, sender details, duration, date, private notes, star, archive, delete, download MP3.
- **Bulk actions:** select several to download as a zip, archive or delete.
- **Shows:** create and edit shows, copy the embed snippet, rotate the site key, edit allowed origins, adjust widget appearance with a live preview.
- **Settings:** email provider and test-send button, retention period, storage driver status, change password.
- **First run:** a setup screen (or CLI command) creates the admin account when none exists.

## Security and abuse protection

| Threat | Control |
| --- | --- |
| Bots and spam | Turnstile token verified server-side on every submission, using the app-wide secret key (or the show's override), and the returned hostname is checked against the app's domain; token is single use. |
| Flooding | Per-IP and per-show rate limits (default 5 submissions per hour per IP), plus a global daily cap per show. |
| Oversized or fake audio | Request size cap, duration cap, `ffprobe` validation, ffmpeg run with timeout and resource limits. |
| Site key misuse | Site keys are public by design, so the origin allowlist, Turnstile and rate limits do the real work. Keys can be rotated. |
| Clickjacking and framing | `frame-ancestors` restricted to a show's allowed origins on `/widget`; admin pages send `X-Frame-Options: DENY`. |
| Admin takeover | Argon2id hashing, login rate limiting, HttpOnly + Secure + SameSite session cookie, CSRF tokens, optional TOTP later. |
| Audio leakage | Private bucket, short-lived signed URLs, no public audio routes. |
| XSS from listener input | All names, emails and notes escaped on output; strict Content-Security-Policy on every page. |

**Privacy**

- A consent line is shown before recording, with configurable text per show.
- The email field is shown by default but is always optional, with a note that it is only used to reply. The name field is always shown and required, so the podcaster knows who left a message before listening. Only the email field can be hidden per show.
- Retention is configurable (for example, auto-delete after N days), and listeners can be given a contact address to request removal.
- Uploaded filenames and client metadata are never trusted or stored as paths.

## Notifications

A mail adapter with two providers, chosen by `MAIL_PROVIDER`:

- **`smtp`:** works with any provider through host, port, user and password.
- **`resend`:** a single API key, using Resend's HTTP API.

Each new message sends the show's `notify_email` a short note with the show name, duration, the sender's name (and email if shared), and a link to the admin page. Audio is not attached, which keeps the email small and the recording private. Sending is asynchronous, so an email failure never blocks or fails a submission; it is logged and shown in admin.

## Configuration reference

All settings come from environment variables (a `.env` file in Docker Compose).

| Variable | Purpose | Default |
| --- | --- | --- |
| `APP_URL` | Public base URL, used in embed code and emails | required |
| `SESSION_SECRET` | Signs admin session cookies | required |
| `DATABASE_PATH` | SQLite file location | `/data/app.db` |
| `STORAGE_DRIVER` | `s3` or `local` | `local` |
| `LOCAL_STORAGE_PATH` | Directory for the local driver | `/data/audio` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | S3-compatible bucket settings | none |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Bucket credentials | none |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | App-wide Turnstile keys. The key's hostname list needs only the app's own domain; a show can override it in admin | required |
| `MAIL_PROVIDER` | `smtp` or `resend` | `smtp` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | SMTP settings | none |
| `RESEND_API_KEY` | Resend API key | none |
| `MAX_UPLOAD_MB` | Upload size cap | `15` |
| `MAX_SECONDS_DEFAULT` | Default recording length per show | `180` |
| `MP3_BITRATE_KBPS` | Output bitrate | `64` |
| `KEEP_ORIGINALS` | Keep the uploaded original alongside the MP3 | `false` |
| `RATE_LIMIT_PER_HOUR` | Submissions per IP per hour | `5` |
| `RETENTION_DAYS` | Auto-delete after N days (0 = never) | `0` |
| `TRANSCRIBE_PROVIDER` | `none`, `whispercpp` or `api` (later phase) | `none` |

## Deployment

**Docker Compose (primary)**

- Services: `app` (Node image with ffmpeg and ffprobe included) and `caddy` (automatic HTTPS and reverse proxy).
- One volume for `/data` (SQLite and, with the local driver, audio); Caddy has its own volume for certificates.
- Image runs as a non-root user; `/healthz` backs the container health check.
- Upgrades: pull, rebuild, `docker compose up -d`; migrations run automatically at startup.

**systemd (alternative)**

- Documented steps for Ubuntu Server: install Node LTS and ffmpeg, build the app, run it under a service unit, and put Caddy or Nginx in front.

**Backups**

- SQLite: nightly `sqlite3 .backup` copy, shipped off-box.
- Audio: with the `s3` driver, rely on bucket versioning or replication; with `local`, include `/data/audio` in the backup.
- A documented restore procedure is part of the Phase 2 acceptance criteria.

## Phased milestones

Each phase is done only when its acceptance criteria pass.

### Phase 1: MVP

- [x] Project scaffold: Fastify, TypeScript, SQLite migrations, Docker Compose with Caddy.
- [x] Show and site-key management (seeded or CLI first).
- [x] Embed loader, modal and recorder iframe with Turnstile.
- [x] Upload endpoint with validation, ffprobe check and ffmpeg MP3 conversion.
- [x] Storage adapters: `local` and `s3`.
- [x] Admin login, inbox list and audio playback.
- [x] Email alert through SMTP or Resend.

**Acceptance (automated parts verified in headless Chromium with a fake microphone; real iOS Safari, Android Chrome, a live Turnstile key, S3 and email sends still to be checked by hand):** a message recorded on Chrome desktop, Android Chrome and iOS Safari through an embed on a test page appears in the inbox as a playable MP3 and triggers an email, using both storage drivers.

### Phase 2: Hardening

- [ ] Rate limits, origin allowlist, CSP and `frame-ancestors` enforced and tested.
- [ ] Per-show widget settings with live preview in admin.
- [ ] File-upload fallback and hosted `/s/:slug` page.
- [ ] Retry for failed processing; purge job and retention setting.
- [ ] Backup and restore documentation, tested once end to end.
- [ ] In-app browser testing (Facebook, Instagram, and similar).

**Acceptance:** scripted abuse tests (oversized file, wrong type, missing token, bad origin, rapid repeat) are all rejected; a restore from backup on a clean server succeeds.

### Phase 3: Quality of life

- [ ] Star, archive, notes, search, bulk zip download.
- [ ] Waveform display in the player.
- [ ] Optional transcription adapter (whisper.cpp or API), with transcript search.
- [ ] Loudness normalization option.

**Acceptance:** with transcription enabled, a new message gains a searchable transcript without delaying the email alert.

### Phase 4: Later

- Reply to listeners who chose to share an email address, from the message view in admin, sent through the configured mail provider.
- Multi-user admin with roles and invitations; optional TOTP.
- Webhooks and an RSS or JSON export of messages.
- Phone-in number via Twilio as a separate module.
- Postgres support.

## Risks and open questions

| Risk | Mitigation |
| --- | --- |
| Safari and iOS recording quirks (format, permission prompts, audio context) | Test on real devices from the first milestone; ffmpeg normalizes any format; file-upload fallback. |
| Microphone blocked inside iframes or in-app browsers | `allow="microphone"` on the iframe, plus the hosted page link and upload fallback. |
| Spam or abuse driving storage and bandwidth costs | Turnstile, rate limits, size and duration caps, daily per-show cap, retention setting. |
| Storage growth | 64 kbps mono MP3 is roughly 0.5 MB per minute; originals off by default; retention job. |
| ffmpeg as an attack surface | Run with timeouts, validate with ffprobe first, keep the container non-root and up to date. |
| AGPL obligations for forks | Document in the README that modified hosted versions must offer their source. |

**Open questions**

- Reply feature details: which address replies are sent from, and whether replies are stored with the message.

## Build notes (Phase 1)

- `messages` also has `read_at` and `error` columns; shows can hold an encrypted per-show Turnstile secret override (AES-256-GCM keyed from `SESSION_SECRET`).
- Storage drivers expose `put`, `getStream` (with range), `size`, `exists`, `delete` and an optional `getSignedUrl`. S3 playback redirects to a signed URL; local streams with HTTP Range.
- Security already in Phase 1: ffprobe container-format allowlist and `-protocol_whitelist file` for ffmpeg, a per-IP hourly limit, Origin check on submissions, Turnstile hostname check, CSRF tokens and a strict CSP on the admin.
- Extra settings: `DATA_DIR`, `TRUST_PROXY`, `LOG_LEVEL`, `S3_FORCE_PATH_STYLE`, `FFMPEG_PATH`, `FFPROBE_PATH` (see `.env.example`).
- The Docker image build has not been run yet (no Docker daemon was available while building).
