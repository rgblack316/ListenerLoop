import path from 'node:path';

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

export interface Config {
  appUrl: string;
  appOrigin: string;
  appHostname: string;
  port: number;
  host: string;
  trustProxy: boolean;
  secureCookies: boolean;
  logLevel: string;
  sessionSecret: string;
  dataDir: string;
  databasePath: string;
  tmpDir: string;
  storageDriver: 'local' | 's3';
  localStoragePath: string;
  s3: {
    endpoint?: string;
    region: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
  };
  turnstile: { siteKey: string; secretKey: string };
  mail: {
    provider: 'smtp' | 'resend' | 'none';
    from: string;
    smtp: { host?: string; port: number; user?: string; pass?: string };
    resendApiKey?: string;
  };
  maxUploadMb: number;
  maxSecondsDefault: number;
  mp3BitrateKbps: number;
  keepOriginals: boolean;
  rateLimitPerHour: number;
  rateLimitPerShowHour: number;
  dailyCapPerShow: number;
  retentionDays: number;
  ffmpegPath: string;
  ffprobePath: string;
  /** 'whisper' turns on local transcription (still opt-in per show); 'off' disables it everywhere. */
  transcription: 'off' | 'whisper';
  whisperBin: string;
  whisperModel: string;
  whisperModelDir: string;
  whisperThreads: number;
  /** 'en' for English-only (.en) models, otherwise automatic detection unless WHISPER_LANGUAGE is set. */
  whisperLanguage: string;
  transcribeTimeoutSec: number;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const str = (name: string, fallback = ''): string => (env[name] ?? '').trim() || fallback;
  const int = (name: string, fallback: number, min = 0): number => {
    const raw = str(name);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      problems.push(`${name} must be an integer >= ${min} (got "${raw}")`);
      return fallback;
    }
    return n;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const raw = str(name).toLowerCase();
    if (!raw) return fallback;
    if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
    if (['0', 'false', 'no', 'off'].includes(raw)) return false;
    problems.push(`${name} must be true or false (got "${raw}")`);
    return fallback;
  };

  let appUrl = str('APP_URL');
  let appOrigin = '';
  let appHostname = '';
  if (!appUrl) {
    problems.push('APP_URL is required (for example https://listenerloop.app)');
  } else {
    try {
      const u = new URL(appUrl);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad protocol');
      appOrigin = u.origin;
      appHostname = u.hostname.toLowerCase();
      appUrl = u.origin;
    } catch {
      problems.push(`APP_URL is not a valid http(s) URL (got "${appUrl}")`);
    }
  }

  const sessionSecret = str('SESSION_SECRET');
  if (sessionSecret.length < 32) {
    problems.push('SESSION_SECRET is required and must be at least 32 characters (try: openssl rand -hex 32)');
  }

  const dataDir = path.resolve(str('DATA_DIR', './data'));
  const databasePath = path.resolve(str('DATABASE_PATH', path.join(dataDir, 'app.db')));
  const localStoragePath = path.resolve(str('LOCAL_STORAGE_PATH', path.join(dataDir, 'audio')));

  const transcriptionRaw = str('TRANSCRIPTION', 'off').toLowerCase();
  if (transcriptionRaw !== 'off' && transcriptionRaw !== 'whisper') problems.push(`TRANSCRIPTION must be "off" or "whisper" (got "${transcriptionRaw}")`);
  const transcriptionMode = transcriptionRaw === 'whisper' ? 'whisper' : 'off';
  const whisperModel = str('WHISPER_MODEL', 'small.en');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(whisperModel)) problems.push(`WHISPER_MODEL "${whisperModel}" is not a valid model name (for example base.en or small.en)`);
  const driver = str('STORAGE_DRIVER', 'local');
  if (driver !== 'local' && driver !== 's3') problems.push(`STORAGE_DRIVER must be "local" or "s3" (got "${driver}")`);
  const s3 = {
    endpoint: str('S3_ENDPOINT') || undefined,
    region: str('S3_REGION', 'auto'),
    bucket: str('S3_BUCKET') || undefined,
    accessKeyId: str('S3_ACCESS_KEY_ID') || undefined,
    secretAccessKey: str('S3_SECRET_ACCESS_KEY') || undefined,
    forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
  };
  if (driver === 's3') {
    for (const [name, value] of [
      ['S3_BUCKET', s3.bucket],
      ['S3_ACCESS_KEY_ID', s3.accessKeyId],
      ['S3_SECRET_ACCESS_KEY', s3.secretAccessKey],
    ] as const) {
      if (!value) problems.push(`${name} is required when STORAGE_DRIVER=s3`);
    }
  }

  const turnstile = { siteKey: str('TURNSTILE_SITE_KEY'), secretKey: str('TURNSTILE_SECRET_KEY') };
  if (!turnstile.siteKey) problems.push('TURNSTILE_SITE_KEY is required');
  if (!turnstile.secretKey) problems.push('TURNSTILE_SECRET_KEY is required');

  const mailProvider = str('MAIL_PROVIDER', 'smtp');
  if (!['smtp', 'resend', 'none'].includes(mailProvider)) {
    problems.push(`MAIL_PROVIDER must be "smtp", "resend" or "none" (got "${mailProvider}")`);
  }
  const mail = {
    provider: (['smtp', 'resend', 'none'].includes(mailProvider) ? mailProvider : 'none') as 'smtp' | 'resend' | 'none',
    from: str('MAIL_FROM'),
    smtp: {
      host: str('SMTP_HOST') || undefined,
      port: int('SMTP_PORT', 587, 1),
      user: str('SMTP_USER') || undefined,
      pass: str('SMTP_PASS') || undefined,
    },
    resendApiKey: str('RESEND_API_KEY') || undefined,
  };

  const config: Config = {
    appUrl,
    appOrigin,
    appHostname,
    port: int('PORT', 3000, 1),
    host: str('HOST', '0.0.0.0'),
    trustProxy: bool('TRUST_PROXY', true),
    secureCookies: appOrigin.startsWith('https://'),
    logLevel: str('LOG_LEVEL', 'info'),
    sessionSecret,
    dataDir,
    databasePath,
    tmpDir: path.join(dataDir, 'tmp'),
    storageDriver: driver === 's3' ? 's3' : 'local',
    localStoragePath,
    s3,
    turnstile,
    mail,
    maxUploadMb: int('MAX_UPLOAD_MB', 15, 1),
    maxSecondsDefault: int('MAX_SECONDS_DEFAULT', 180, 5),
    mp3BitrateKbps: int('MP3_BITRATE_KBPS', 64, 16),
    keepOriginals: bool('KEEP_ORIGINALS', false),
    rateLimitPerHour: int('RATE_LIMIT_PER_HOUR', 5, 1),
    rateLimitPerShowHour: int('RATE_LIMIT_PER_SHOW_HOUR', 60, 1),
    dailyCapPerShow: int('DAILY_CAP_PER_SHOW', 300, 1),
    retentionDays: int('RETENTION_DAYS', 0, 0),
    ffmpegPath: str('FFMPEG_PATH', 'ffmpeg'),
    ffprobePath: str('FFPROBE_PATH', 'ffprobe'),
    transcription: transcriptionMode,
    whisperBin: str('WHISPER_BIN', 'whisper-cli'),
    whisperModel,
    whisperModelDir: path.resolve(str('WHISPER_MODEL_DIR', path.join(dataDir, 'models'))),
    whisperThreads: int('WHISPER_THREADS', 2, 1),
    whisperLanguage: str('WHISPER_LANGUAGE', whisperModel.endsWith('.en') ? 'en' : 'auto'),
    transcribeTimeoutSec: int('TRANSCRIBE_TIMEOUT_SEC', 1800, 30),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
