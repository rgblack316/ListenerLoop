import './env.js';
import { hash } from '@node-rs/argon2';
import { ConfigError, loadConfig } from './config.js';
import { openDb } from './db/index.js';
import { parseOriginList, Repo, showOrigins } from './db/repo.js';
import { isValidEmail } from './lib/util.js';

const USAGE = `ListenerLoop admin CLI

Usage:
  create-admin <email> [--force]     Create the admin account, or reset its login with --force.
                                     The password comes from ADMIN_PASSWORD or a prompt (12+ characters).
  add-show --name "My Show" [--origin https://mysite.com]... [--notify-email you@example.com] [--max-seconds 180]
  list-shows                         Show every show with its site key and embed code.
  set-origins <slug> <origin>...     Replace the sites allowed to embed a show.
  rotate-key <slug>                  Issue a new site key. Old embeds stop working.

In Docker: docker compose exec app node dist/cli.js <command>`;

function flags(args: string[]): { positional: string[]; values: Map<string, string[]>; bools: Set<string> } {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, [...(values.get(name) ?? []), next]);
      i++;
    } else bools.add(name);
  }
  return { positional, values, bools };
}

function readHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setEncoding('utf8');
    if (!stdin.isTTY) {
      stdin.once('data', (d) => resolve(String(d).split(/\r?\n/)[0] ?? ''));
      stdin.resume();
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (chunk: string): void => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function getPassword(): Promise<string> {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv) return fromEnv;
  const first = await readHidden('New password: ');
  const second = await readHidden('Repeat password: ');
  if (first !== second) throw new Error('The passwords did not match.');
  return first;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return;
  }

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const db = openDb(config.databasePath);
  const repo = new Repo(db);
  const { positional, values, bools } = flags(rest);

  switch (command) {
    case 'create-admin': {
      const email = (positional[0] ?? '').trim().toLowerCase();
      if (!isValidEmail(email)) throw new Error('Give a valid email address: create-admin you@example.com');
      if (repo.getAdmin() && !bools.has('force')) {
        throw new Error('An admin account already exists. Use --force to replace its email and password.');
      }
      const password = await getPassword();
      if (password.length < 12) throw new Error('Use a password of at least 12 characters.');
      repo.upsertAdmin(email, await hash(password));
      console.log(`Admin account saved for ${email}.`);
      break;
    }
    case 'add-show': {
      const name = values.get('name')?.[0]?.trim();
      if (!name) throw new Error('--name is required.');
      const { origins, invalid } = parseOriginList((values.get('origin') ?? []).join(' '));
      if (invalid.length) throw new Error(`Not valid addresses: ${invalid.join(', ')}`);
      const notify = values.get('notify-email')?.[0];
      if (notify && !isValidEmail(notify)) throw new Error('--notify-email is not a valid address.');
      const maxSeconds = Number.parseInt(values.get('max-seconds')?.[0] ?? String(config.maxSecondsDefault), 10);
      if (!Number.isInteger(maxSeconds) || maxSeconds < 5 || maxSeconds > 600) throw new Error('--max-seconds must be 5 to 600.');
      const show = repo.createShow({ name, allowed_origins: JSON.stringify(origins), notify_email: notify ?? null, max_seconds: maxSeconds });
      console.log(`Created "${show.name}" (${show.slug}).`);
      console.log(`Embed code:\n  <script src="${config.appUrl}/embed.js" data-site-key="${show.site_key}" async></script>`);
      if (origins.length === 0) console.log('No allowed sites yet. Add some with: set-origins ' + show.slug + ' https://yoursite.com');
      break;
    }
    case 'list-shows': {
      const shows = repo.listShows();
      if (shows.length === 0) console.log('No shows yet. Add one with: add-show --name "My Show"');
      for (const s of shows) {
        console.log(`${s.name} (${s.slug})`);
        console.log(`  allowed sites: ${showOrigins(s).join(', ') || 'none'}`);
        console.log(`  <script src="${config.appUrl}/embed.js" data-site-key="${s.site_key}" async></script>`);
      }
      break;
    }
    case 'set-origins': {
      const [slug, ...list] = positional;
      const show = slug ? repo.getShowBySlug(slug) : undefined;
      if (!show) throw new Error('Unknown show slug. See list-shows.');
      const { origins, invalid } = parseOriginList(list.join(' '));
      if (invalid.length) throw new Error(`Not valid addresses: ${invalid.join(', ')}`);
      repo.updateShow(show.id, { allowed_origins: JSON.stringify(origins) });
      console.log(`${show.name} may now be embedded on: ${origins.join(', ') || 'no sites'}`);
      break;
    }
    case 'rotate-key': {
      const show = positional[0] ? repo.getShowBySlug(positional[0]) : undefined;
      if (!show) throw new Error('Unknown show slug. See list-shows.');
      const key = repo.rotateSiteKey(show.id);
      console.log(`New site key for ${show.name}: ${key}\nUpdate the embed code on its site(s).`);
      break;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      process.exitCode = 1;
  }
  db.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
