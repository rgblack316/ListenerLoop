<p align="center">
  <img src="brand-assets/ListenerLoop-Full-Logo-gradient.svg" alt="ListenerLoop: Turn listener feedback into conversation" width="480">
</p>

# ListenerLoop

**Turn listener feedback into conversation.**

ListenerLoop is a self-hosted, open-source widget that lets listeners record a voice message from any podcast website. It replaces services like SpeakPipe. One installation serves many shows, and every message lands in a private admin inbox as an MP3.

> **Status:** Phase 1 (MVP) is built and tested in headless Chromium. It has not yet been tried on real iOS Safari or Android devices, with a live Turnstile key, or against live S3 and email services. See [PLAN.md](PLAN.md) for the plan and progress checklist.

## Goals

- Embed on any site with one script tag.
- Record in the browser using web standards only (`getUserMedia` and `MediaRecorder`), on desktop and mobile, including iOS Safari.
- Normalize every recording to MP3 with ffmpeg.
- Store audio in S3-compatible buckets, with local disk as an option for forks.
- Protect submissions with Cloudflare Turnstile, using one app-wide key pair (a per-show override is optional).
- Email the admin on each new message (SMTP or Resend).
- Let listeners optionally share an email address, so a reply feature can follow later.

## How it works

1. A podcast site adds one line:

   ```html
   <script src="https://your-listenerloop-domain/embed.js" data-site-key="pk_abc123" async></script>
   ```

2. The script adds a button that opens the recorder in an iframe hosted by ListenerLoop.
3. The listener records (up to 3 minutes by default), plays it back, and submits. Name is required so you know who left the message; email is optional.
4. The server validates the upload, converts it to MP3, stores it, and emails the admin.
5. The admin listens and manages messages in the dashboard.

## Quick start (Ubuntu Server, Docker Compose)

```bash
git clone https://github.com/rgblack316/ListenerLoop.git && cd ListenerLoop
cp .env.example .env        # set APP_URL, APP_DOMAIN, SESSION_SECRET, Turnstile, storage, mail
docker compose up -d --build

# create the admin login, then add your first show
docker compose exec app node dist/cli.js create-admin you@example.com
docker compose exec app node dist/cli.js add-show --name "My Podcast" --origin https://mypodcast.com
```

`add-show` prints the show's site key. Paste the embed snippet into the podcast site:

```html
<script src="https://YOUR-APP-DOMAIN/embed.js" data-site-key="SITE_KEY" async></script>
```

Then sign in at `https://YOUR-APP-DOMAIN/login`. Each show has its own inbox at `/shows/<slug>` (for example `/shows/bible-bytes`), and `/inbox` combines all of them. Other CLI commands: `list-shows`, `set-origins`, `rotate-key`.

- **Turnstile:** create one widget in Cloudflare listing only your app's hostname. Embedding sites need no key of their own.
- **Behind a Cloudflare Tunnel:** run the app alone (see the comments in `docker-compose.yml`) and point the tunnel at port 3000. Keep `TRUST_PROXY=true`.
- **Local development:** `npm install && npm run dev` (Node 22+, ffmpeg on the PATH). Use Cloudflare's dummy Turnstile keys from `.env.example`.
- **Tests:** `npm test` (needs ffmpeg).

## Stack

| Area | Choice |
| --- | --- |
| Backend | Node.js + TypeScript with Fastify |
| Database | SQLite (better-sqlite3), portable migrations |
| Audio | ffmpeg and ffprobe, MP3 output |
| Storage | `s3` (any S3-compatible service) or `local` driver |
| Admin UI | Server-rendered pages with htmx, no SPA framework |
| Admin auth | Single admin to start (argon2, session cookie) |
| Email | SMTP or Resend |
| Spam protection | Cloudflare Turnstile, one app-wide key (per-show override optional) |
| Deploy | Docker Compose on Ubuntu Server (app + Caddy), with a systemd alternative |

## Roadmap

1. **MVP (built):** recorder, upload, MP3 conversion, storage drivers, admin inbox, email alert.
2. **Hardening:** rate limits, origin allowlist, upload fallback, backups, in-app browser testing.
3. **Quality of life:** star, archive, search, waveforms, optional transcription.
4. **Later:** reply to listeners by email, multi-user admin, webhooks, Postgres, phone-in via Twilio.

Details and acceptance criteria are in [PLAN.md](PLAN.md).

## License

ListenerLoop is licensed under the [GNU Affero General Public License v3.0](LICENSE.md). If you run a modified version as a network service, you must offer its source code to your users.
