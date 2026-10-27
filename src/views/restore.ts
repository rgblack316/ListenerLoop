import { html } from '../lib/html.js';
import type { Backup } from '../db/repo.js';
import type { Inspection } from '../restore.js';
import { csrfField, layout, timeTag } from './layout.js';

export interface RestoreConfirmView {
  csrf: string;
  backup: Backup;
  info: Inspection;
  storage: 'local' | 's3';
  dataDir: string;
  error?: string;
}

const kb = (n: number): string => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

export function restoreConfirmPage(v: RestoreConfirmView): string {
  const { info } = v;
  return layout({
    title: 'Restore a backup',
    csrf: v.csrf,
    role: 'owner',
    nav: 'settings',
    body: html`<p><a href="/settings#backups">&larr; Back to settings</a></p>
    <h1>Restore this backup?</h1>
    ${v.error ? html`<div class="alert" role="alert"><p>${v.error}</p></div>` : ''}
    <section class="card">
      <dl class="details">
        <dt>Backup made</dt><dd>${info.created ? timeTag(info.created) : 'Unknown'}</dd>
        <dt>File</dt><dd>${v.backup.file} (${kb(v.backup.size_bytes ?? 0)})</dd>
        <dt>Contains</dt><dd>${info.shows} ${info.shows === 1 ? 'show' : 'shows'}, ${info.messages} ${info.messages === 1 ? 'message' : 'messages'}, ${info.users} ${info.users === 1 ? 'user' : 'users'}</dd>
        <dt>Audio files</dt><dd>${info.hasAudio ? (v.storage === 'local' ? 'Included, and will be restored' : 'Included, but this server uses S3 or R2 storage, so they are skipped') : v.storage === 'local' ? 'Not included' : 'Not included (audio stays in your bucket)'}</dd>
      </dl>
    </section>
    <section class="card">
      <h2>What will happen</h2>
      <ul>
        <li><strong>Everything now in the database is replaced</strong> by this backup: shows, messages, replies, users, settings and webhooks. Anything added since ${info.created ? 'then' : 'the backup'} is not in it.</li>
        <li>The app restarts for about 15 seconds. <strong>Everyone is signed out</strong>, and you sign in with an account that exists in the backup.</li>
        ${v.storage === 'local' && info.hasAudio ? html`<li>The current audio files are replaced by the ones in the backup.</li>` : ''}
        ${v.storage === 's3' ? html`<li>Messages point at audio in your bucket. Recordings made after the backup stay in the bucket but will not be listed.</li>` : ''}
        <li>The current database${v.storage === 'local' && info.hasAudio ? ' and audio' : ''} are set aside in a <code>pre-restore-…</code> folder inside <code>${v.dataDir}</code> (kept for 30 days) so this can be undone by hand.</li>
      </ul>
    </section>
    <section class="card">
      <form method="post" action="/settings/backups/${v.backup.id}/restore" class="stack">${csrfField(v.csrf)}
        <label>Your password<input type="password" name="password" autocomplete="current-password" required></label>
        <label>Type <strong>RESTORE</strong> to confirm<input name="confirm" autocomplete="off" required pattern="RESTORE"></label>
        <div class="actions"><button class="btn danger" type="submit">Restore this backup</button><a class="btn" href="/settings#backups">Cancel</a></div>
      </form>
    </section>`,
  });
}

export const restoringPage = (): string =>
  layout({
    title: 'Restoring',
    body: html`<section class="card narrow">
      <h1>Restoring…</h1>
      <p>The backup has been unpacked and the app is restarting. This takes about 15 seconds.</p>
      <p>Then <a href="/login">sign in</a> with an account from the backup. If the page does not load after a minute, check that the server is running.</p>
    </section>`,
  });

