<p align="center">
  <img src="brand-assets/ListenerLoop-Full-Logo-gradient.svg" alt="ListenerLoop: Turn listener feedback into conversation" width="480">
</p>

# ListenerLoop

**Turn listener feedback into conversation.**

ListenerLoop is a self-hosted, open-source widget that lets listeners record a voice message from any podcast website. It replaces services like SpeakPipe. One installation serves many shows, and every message lands in a private admin inbox as an MP3.

> **Status:** Phase 1 (MVP) is built and running in production behind a Cloudflare Tunnel. Several testers have recorded from different browsers and devices; recordings reach S3-compatible storage as MP3s and email alerts arrive. In-app browsers (Facebook, Instagram) are not tested yet. See [PLAN.md](PLAN.md) for the plan and progress checklist.

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

## Install (Ubuntu or Debian server)

```bash
git clone https://github.com/rgblack316/ListenerLoop.git && cd ListenerLoop
sudo ./scripts/install.sh
```

The installer checks for git, curl, openssl and Docker (installing anything missing from Docker's official repository), then asks about your domain, Cloudflare Turnstile keys, storage (S3 or local), and email (SMTP, Resend or none). It writes `.env`, builds and starts the app, and creates your admin login and first show. Run it again at any time to change settings: your current answers are offered as defaults, and pressing Enter keeps saved secrets. `sudo ./scripts/install.sh --yes` runs without questions, reading answers from environment variables (see the top of the script).

Choose how people reach the app:
- **Caddy HTTPS:** the server gets its own certificate. Point the domain's DNS at the server and open ports 80 and 443.
- **Cloudflare Tunnel or another proxy:** the app listens on `127.0.0.1:3000`; point the tunnel at `http://localhost:3000`.

## Update

```bash
cd ListenerLoop
sudo ./scripts/update.sh
```

The updater re-checks Docker and the other tools, backs up the database (inside the Docker volume, newest 7 kept), pulls the latest code, rebuilds and restarts, and tells you if the new version has settings your `.env` does not have yet. Your `.env` and recordings are not touched. Use `--restart` to rebuild after editing `.env`. It stops if you have local changes to tracked files.

## After installing

Paste the embed snippet from the **Shows** page into the podcast site:

```html
<script src="https://YOUR-APP-DOMAIN/embed.js" data-site-key="SITE_KEY" async></script>
```

Sign in at `https://YOUR-APP-DOMAIN/login`. Each show has its own inbox at `/shows/<slug>` (for example `/shows/bible-bytes`), and `/inbox` combines all of them. CLI helpers: `docker compose exec app node dist/cli.js` with `create-admin`, `add-show`, `list-shows`, `set-origins`, `rotate-key`.

- **Storage:** with the `s3` driver, use a private bucket and an access key made just for ListenerLoop, not your public podcast CDN. Audio is played through the app (a signed link that expires after 5 minutes), never from a public URL.
- **Turnstile:** create one widget in Cloudflare listing only your app's hostname. Embedding sites need no key of their own.
- **Local development:** `npm install && npm run dev` (Node 22+, ffmpeg on the PATH). Use Cloudflare's dummy Turnstile keys from `.env.example`.
- **Tests:** `npm test` (needs ffmpeg).

## Backup and restore

```sh
sudo ./scripts/backup.sh /var/backups/listenerloop    # default folder: ./backups
sudo ./scripts/restore.sh /var/backups/listenerloop/listenerloop-YYYYMMDD-HHMMSS.tar.gz
```

A backup is one `.tar.gz` holding a consistent database copy, the local audio files and your `.env` (it contains secrets, so it is created readable by root only). It is safe to run while the app is running, and the newest 14 are kept (`KEEP=30` to change). With `STORAGE_DRIVER=s3` the audio is not included: copy the bucket to a second bucket or provider on a schedule (for example `rclone sync`). Cloudflare R2 has no object versioning.

Run it nightly with cron (`sudo crontab -e`):

```
17 3 * * * /opt/ListenerLoop/scripts/backup.sh /var/backups/listenerloop >> /var/log/listenerloop-backup.log 2>&1
```

Then copy the folder off the server (rsync, rclone, or your provider's snapshots). A backup that lives only on the same disk is not a backup.

To restore on the same server, run `restore.sh` with the archive. It asks for confirmation (or pass `--yes`), stops the app, replaces the database and audio, and starts it again. Your current `.env` is kept. On a new server: install Docker and clone the repo, then run `sudo ./scripts/restore.sh backup.tar.gz --with-env` to bring the `.env` back as well, and point DNS or the tunnel at it.

## What works today

- One installation, many shows, each with its own site key, allowed sites, widget text and inbox.
- Embed button, recorder modal (name required, email optional, consent notice), Turnstile, MP3 conversion, local or S3 storage.
- Upload-a-file fallback when the microphone is blocked, and a hosted recorder page for each show at `/s/<slug>` for newsletters and social bios.
- Admin: sign in, per-show and combined inboxes, playback with speed control and download, star, archive, delete, private notes, and an email alert for each new message.

**Not built yet:** search, bulk download, replies to listeners, multiple users. See the roadmap.

## Stack

| Area | Choice |
| --- | --- |
| Backend | Node.js + TypeScript with Fastify |
| Database | SQLite (better-sqlite3), portable migrations |
| Audio | ffmpeg and ffprobe, MP3 output |
| Storage | `s3` (any S3-compatible service) or `local` driver |
| Admin UI | Server-rendered pages with htmx, no SPA framework |
| Admin auth | Single admin to start (argon2, session cookie); multi-user with per-show access later |
| Email | SMTP or Resend |
| Spam protection | Cloudflare Turnstile, one app-wide key (per-show override optional) |
| Deploy | Docker Compose on Ubuntu Server (app + Caddy). A systemd guide is planned. |

## Roadmap

1. **MVP (built):** recorder, upload, MP3 conversion, storage drivers, admin inbox, email alert.
2. **Hardening (done):** abuse limits, retention, settings, live preview, backups, in-app browser check on Facebook.
3. **Quality of life:** search, bulk download, waveforms, optional transcription.
4. **Later:** reply to listeners by email, multi-user admin (with per-show access), webhooks, Postgres, phone-in via Twilio.

Details and acceptance criteria are in [PLAN.md](PLAN.md).

## License

ListenerLoop is licensed under the [GNU Affero General Public License v3.0](LICENSE.md). If you run a modified version as a network service, you must offer its source code to your users.
