import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path: string[] }> };
const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

async function proxy(request: NextRequest, context: Context) {
  if (!allowedMethods.has(request.method)) return NextResponse.json({ error: 'Method not allowed.' }, { status: 405 });
  const originValue = process.env.API_BASE_URL;
  if (!originValue) return NextResponse.json({ error: 'API service is not configured.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  let origin: URL;
  try {
    origin = new URL(originValue);
    if (origin.pathname !== '/' || origin.search || origin.hash || (process.env.NODE_ENV === 'production' && origin.protocol !== 'https:')) throw new Error();
  } catch {
    return NextResponse.json({ error: 'API service configuration is invalid.' }, { status: 503 });
  }
  const { path } = await context.params;
  if (!path?.length || path.some(part => !part || part === '.' || part === '..' || part.includes('/'))) {
    return NextResponse.json({ error: 'Invalid API path.' }, { status: 400 });
  }
  const target = new URL('/' + path.map(encodeURIComponent).join('/'), origin);
  target.search = request.nextUrl.search;
  const headers = new Headers();
  for (const key of ['accept', 'authorization', 'content-type', 'idempotency-key', 'x-hub-signature-256']) {
    const value = request.headers.get(key);
    if (value) headers.set(key, value);
  }
  const init: RequestInit = { method: request.method, headers, cache: 'no-store', redirect: 'manual' };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 1_048_576) return NextResponse.json({ error: 'Request body is too large.' }, { status: 413 });
    init.body = bytes;
  }
  try {
    const upstream = await fetch(target, init);
    const responseHeaders = new Headers();
    for (const key of ['content-type', 'cache-control', 'retry-after', 'x-request-id']) {
      const value = upstream.headers.get(key);
      if (value) responseHeaders.set(key, value);
    }
    responseHeaders.set('Cache-Control', 'no-store, private');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ error: 'The StayPilot API is temporarily unavailable.', code: 'upstream_unavailable' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
