export interface TurnstileSiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  cdata?: string;
}

export async function verifyTurnstile(
  secret: string,
  token: string,
  expectedHostnames: readonly string[],
  fetcher: typeof fetch = fetch
): Promise<boolean> {
  if (!secret || !token || !expectedHostnames.length) return false;
  const form = new URLSearchParams({ secret, response: token });
  const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) return false;
  const parsed: unknown = await response.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const result = parsed as TurnstileSiteverifyResponse;
  if (result.success !== true || typeof result.hostname !== 'string') return false;
  const hostname = result.hostname.toLowerCase();
  return expectedHostnames.some(value => value.toLowerCase() === hostname);
}
