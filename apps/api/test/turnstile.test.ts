import { describe, expect, it } from 'vitest';
import { verifyTurnstile } from '../src/turnstile.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Turnstile server-side verification', () => {
  it('accepts a successful response only for an explicitly approved hostname', async () => {
    const fetcher = async () => response({ success: true, hostname: 'sales.example.com' });
    await expect(verifyTurnstile('secret', 'token', ['sales.example.com'], fetcher)).resolves.toBe(true);
    await expect(verifyTurnstile('secret', 'token', ['other.example.com'], fetcher)).resolves.toBe(false);
  });
  it('rejects missing hostnames, provider rejection, and HTTP errors', async () => {
    await expect(verifyTurnstile('secret', 'token', ['sales.example.com'], async () => response({ success: true }))).resolves.toBe(false);
    await expect(verifyTurnstile('secret', 'token', ['sales.example.com'], async () => response({ success: false, hostname: 'sales.example.com' }))).resolves.toBe(false);
    await expect(verifyTurnstile('secret', 'token', ['sales.example.com'], async () => response({ success: true, hostname: 'sales.example.com' }, 502))).resolves.toBe(false);
  });
  it('fails closed without an expected hostname or credential', async () => {
    let called = false;
    const fetcher = async () => { called = true; return response({ success: true, hostname: 'sales.example.com' }); };
    await expect(verifyTurnstile('', 'token', ['sales.example.com'], fetcher)).resolves.toBe(false);
    await expect(verifyTurnstile('secret', 'token', [], fetcher)).resolves.toBe(false);
    expect(called).toBe(false);
  });
  it('propagates network errors so the route fails closed', async () => {
    const fetcher = async (): Promise<Response> => { throw new Error('network unavailable'); };
    await expect(verifyTurnstile('secret', 'token', ['sales.example.com'], fetcher)).rejects.toThrow('network unavailable');
  });
});
