const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PageCursor = { sortAt: string; secondaryAt?: string; id: string };

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

export function encodePageCursor(cursor: PageCursor): string {
  if (!validTimestamp(cursor.sortAt) || !UUID_PATTERN.test(cursor.id) ||
      (cursor.secondaryAt !== undefined && !validTimestamp(cursor.secondaryAt))) {
    throw new Error('invalid_page_cursor_position');
  }
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url');
}

export function decodePageCursor(raw: unknown): PageCursor | null {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.toString('base64url') !== raw) return null;
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (candidate.v !== 1 || !validTimestamp(candidate.sortAt) || !UUID_PATTERN.test(String(candidate.id || ''))) return null;
    if (candidate.secondaryAt !== undefined && !validTimestamp(candidate.secondaryAt)) return null;
    return {
      sortAt: candidate.sortAt,
      ...(candidate.secondaryAt === undefined ? {} : { secondaryAt: candidate.secondaryAt }),
      id: String(candidate.id)
    };
  } catch {
    return null;
  }
}
