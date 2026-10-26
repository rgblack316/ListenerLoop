export interface TurnstileResult {
  success: boolean;
  hostname?: string;
  errorCodes: string[];
}

export type TurnstileVerifier = (args: { secret: string; token: string; remoteIp?: string }) => Promise<TurnstileResult>;

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const verifyWithCloudflare: TurnstileVerifier = async ({ secret, token, remoteIp }) => {
  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { success: false, errorCodes: [`http-${res.status}`] };
    const json = (await res.json()) as { success?: boolean; hostname?: string; 'error-codes'?: string[] };
    return { success: json.success === true, hostname: json.hostname, errorCodes: json['error-codes'] ?? [] };
  } catch {
    return { success: false, errorCodes: ['network-error'] };
  }
};

/** Cloudflare's published dummy secrets (1x/2x/3x...) never return the real hostname. */
export function isTestSecret(secret: string): boolean {
  return /^[123]x0{20,}[A-Za-z0-9]*$/.test(secret);
}
