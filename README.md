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
- Protect submissions with Cloudflare Turnstile, using one app-wide key pair.
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

**Webhooks and export.** Owners can add up to 3 webhooks per show (show settings, then **Webhooks**): ListenerLoop POSTs a JSON message to your https address when a message is ready, a transcript finishes, or a reply is sent. Requests are signed (`X-ListenerLoop-Signature: sha256=` HMAC of `timestamp.body`), failures retry up to 5 times, and a **Send a test** button checks your server. Every inbox has **Export: CSV / JSON** links that respect the current tab or search and the user's show access.

Sign in at `https://YOUR-APP-DOMAIN/login`. The first owner is made with `create-admin`; after that, owners add people from **Users**: an emailed invitation link (valid 7 days) lets them choose their own password. Roles: **owner** (everything), **editor** (listen, star, archive, delete, reply, transcribe, download on assigned shows), **viewer** (read-only on assigned shows). Everyone can change their password and turn on two-step sign-in (authenticator app plus recovery codes) from **Account**; an owner can make a password reset link or switch off two-step for a locked-out user. Each show has its own inbox at `/shows/<slug>` (for example `/shows/bible-bytes`), and `/inbox` combines all of them. CLI helpers: `docker compose exec app node dist/cli.js` with `create-admin` (creates or resets the first owner), `add-show`, `list-shows`, `set-origins`, `rotate-key`.

- **Storage:** with the `s3` driver, use a private bucket and an access key made just for ListenerLoop, not your public podcast CDN. Audio is played through the app (a signed link that expires after 5 minutes), never from a public URL.
- **Turnstile:** create one widget in Cloudflare listing only your app's hostname. Embedding sites need no key of their own.
- **Local development:** `npm install && npm run dev` (Node 22+, ffmpeg on the PATH). Use Cloudflare's dummy Turnstile keys from `.env.example`.
- **Tests:** `npm test` (needs ffmpeg).

## Cover art

Each show can have its podcast RSS feed address in its settings (optional). ListenerLoop reads the feed once, downloads the cover image, shrinks it to a small square JPEG and keeps that copy in your storage, so the dashboard never loads images from anyone else's server. It appears next to the show name in the shows list, the inbox and the settings page; a letter tile is used until there is one. Press **Refresh cover art** after you change your artwork. Only public web addresses are fetched: private and internal network addresses are refused, redirects and sizes are limited, and the image is re-encoded, which also strips its metadata.

## Replying to listeners

If a listener shared an email address, open their message and use **Reply**. The email is sent from `REPLY_FROM_ADDRESS` (set it in `.env`, for example `replies@listenerloop.app`; its domain must be verified with your mail provider, and it falls back to the address in `MAIL_FROM`) with your show's name as the sender, and **Reply-To** is set to the show's email address from its settings, so the listener's answer lands in your own mailbox. Every show must have an email address (alerts go there too). Replies are kept with the message as a thread, can be retried if sending fails, and are removed when the message is deleted. Limits: 10 replies per message and 30 per hour.

## Transcription (optional)

ListenerLoop can turn each voicemail into text on your own server with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Audio never leaves the machine, and nothing is sent to a third party.

1. Add to `.env`:
   ```
   TRANSCRIPTION=whisper
   WHISPER_MODEL=small.en
   WHISPER_THREADS=2
   ```
2. Run `sudo ./scripts/update.sh --restart` (the first build compiles whisper.cpp, which takes a few minutes).
3. Open a show's settings and tick **Transcribe new messages**. The model downloads once, on first use, into the data volume.

Transcripts appear on the message page (with a .txt download and a "Transcribe again" button), and are searched by the inbox search box. They run after the email alert, one at a time, at low priority, so they never delay an alert or a new upload. Old messages can be transcribed one by one from their page.

Choosing a model: `base.en` is about real time on 2 CPU cores and fine for clear speech. `small.en` is more accurate but roughly 3 to 5 times slower than real time on 2 cores, and needs about 1 GB of free RAM. The time each transcript took is shown on the message page, so you can judge. Drop the `.en` for other languages (`small`). Transcripts are stored in the database (and so in backups), not in object storage, and are deleted with their message.

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
- Admin: sign in, per-show and combined inboxes, playback with speed control and download, star, archive, delete, private notes, search (name, email, notes, transcripts), optional on-server transcription, a waveform you can click to seek, bulk download of selected messages as a zip (MP3s, transcripts and a CSV index), optional per-show noise reduction and volume levelling (-19 LUFS, the mono podcast standard), cover art from the show's RSS feed, replies to listeners by email, and an email alert for each new message.

**Not built yet:** multiple users, webhooks. See the roadmap.

## Stack

| Area | Choice |
| --- | --- |
| Backend | Node.js + TypeScript with Fastify |
| Database | SQLite (better-sqlite3), portable migrations |
| Audio | ffmpeg and ffprobe, MP3 output |
| Storage | `s3` (any S3-compatible service) or `local` driver |
| Admin UI | Server-rendered pages with htmx, no SPA framework |
| Admin auth | Multiple users with owner, editor and viewer roles and per-show access (argon2, session cookie, optional TOTP) |
| Email | SMTP or Resend |
| Spam protection | Cloudflare Turnstile, one app-wide key for every show |
| Deploy | Docker Compose on Ubuntu Server (app + Caddy). A systemd guide is planned. |

## Roadmap

1. **MVP (built):** recorder, upload, MP3 conversion, storage drivers, admin inbox, email alert.
2. **Hardening (done):** abuse limits, retention, settings, live preview, backups, in-app browser check (Facebook tested, Instagram assumed).
3. **Quality of life (built):** search, bulk download, waveforms, optional transcription, loudness normalization.
4. **Built:** reply to listeners by email, cover art, multi-user admin with per-show access, webhooks and CSV/JSON export.

Details and acceptance criteria are in [PLAN.md](PLAN.md).

## License

ListenerLoop is licensed under the [GNU Affero General Public License v3.0](LICENSE.md). If you run a modified version as a network service, you must offer its source code to your users.
