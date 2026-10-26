// Loads ./.env when present (local development). Real environment variables always win.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file; use the process environment */
}
export {};
