import { describe, expect, it } from 'vitest';
import { decodePageCursor, encodePageCursor } from '../src/pagination.js';

describe('keyset pagination cursors', () => {
  it('round-trips PostgreSQL timestamps without millisecond precision loss', () => {
    const value = { sortAt: '2026-10-29 19:30:01.123456+05:30', id: '70b9fb11-8458-4a2d-945b-6e7f5f7d310c' };
    expect(decodePageCursor(encodePageCursor(value))).toEqual(value);
  });
  it('round-trips composite inbox sort keys', () => {
    const value = { sortAt: '2026-10-29 19:30:01.123456+05:30', secondaryAt: '2026-10-29 19:30:01.123456+05:30', id: '70b9fb11-8458-4a2d-945b-6e7f5f7d310c' };
    expect(decodePageCursor(encodePageCursor(value))).toEqual(value);
  });
  it.each([undefined, '', 'not-base64', 'eyJ2IjoyfQ', 'e30'])('rejects malformed cursor input (%s)', value => {
    expect(decodePageCursor(value)).toBeNull();
  });
});
