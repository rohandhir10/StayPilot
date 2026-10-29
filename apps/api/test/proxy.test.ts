import { describe, expect, it } from 'vitest';
import { isValidTrustedProxyCidr, parseTrustedProxyCidrs } from '../src/proxy.js';

describe('trusted proxy allowlist', () => {
  it('parses, trims and deduplicates configured proxy addresses', () => {
    expect(parseTrustedProxyCidrs(' 10.0.0.4, 10.0.0.0/24,10.0.0.4 ,, ')).toEqual([
      '10.0.0.4',
      '10.0.0.0/24'
    ]);
  });

  it('accepts explicit IPv4 and IPv6 addresses or bounded CIDRs', () => {
    expect(isValidTrustedProxyCidr('10.0.0.4')).toBe(true);
    expect(isValidTrustedProxyCidr('10.0.0.0/24')).toBe(true);
    expect(isValidTrustedProxyCidr('2001:db8::1')).toBe(true);
    expect(isValidTrustedProxyCidr('2001:db8::/48')).toBe(true);
  });

  it('rejects malformed entries and universal trust ranges', () => {
    for (const value of ['*', 'proxy.internal', '10.0.0.0/33', '2001:db8::/129', '10.0.0.0/0', '::/0', '10.0.0.1/24/4']) {
      expect(isValidTrustedProxyCidr(value)).toBe(false);
    }
  });
});
