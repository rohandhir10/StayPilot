import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireWorkspaceMember: vi.fn() }));
vi.mock('../src/auth.js', () => ({ requireWorkspaceMember: mocks.requireWorkspaceMember }));

import { pool } from '../src/db.js';
import { registerLeadRoutes } from '../src/routes/leads.js';
import { registerInboxRoutes } from '../src/routes/inbox.js';

const app = Fastify();
const fixture = randomUUID().slice(0, 8);
let workspaceId = '';
const leadIds: string[] = [];
const conversationIds: string[] = [];
const messageConversationIds: string[] = [];

describe('cursor pagination and inbox read consistency (PostgreSQL integration)', () => {
  beforeAll(async () => {
    const ws = await pool.query<{ id: string }>("SELECT id FROM workspaces WHERE slug='default' LIMIT 1");
    if (!ws.rows[0]) throw new Error('Default workspace migration was not applied.');
    workspaceId = ws.rows[0].id;
    mocks.requireWorkspaceMember.mockImplementation(async () => ({
      workspace_id: workspaceId, user_id: 'user_pagination_test', email: 'pagination@example.test', display_name: 'Pagination Test', role: 'owner'
    }));
    await registerLeadRoutes(app);
    await registerInboxRoutes(app);
    await app.ready();
    for (let i = 1; i <= 3; i++) {
      const created = await pool.query<{ id: string }>(
        `INSERT INTO leads (workspace_id,client_name,company_name,property_name,inquiry_type,created_at)
         VALUES ($1,$2,$3,'Pagination Test Hotel','Test',$4::timestamptz) RETURNING id`,
        [workspaceId, `pagination-${fixture}-lead-${i}`, `pagination-${fixture}-company-${i}`, `2099-10-2${i}T00:00:00.123456Z`]
      );
      leadIds.push(created.rows[0].id);
    }
    for (let i = 1; i <= 3; i++) {
      const created = await pool.query<{ id: string }>(
        `INSERT INTO sp_conversations (workspace_id,channel_key,external_thread_id,title,last_message_at,updated_at)
         VALUES ($1,'other',$2,$3,$4::timestamptz,$4::timestamptz) RETURNING id`,
        [workspaceId, `pagination-${fixture}-thread-${i}`, `Pagination thread ${i}`, `2099-10-2${i}T00:00:00.123456Z`]
      );
      conversationIds.push(created.rows[0].id);
    }
    const messageConvo = await pool.query<{ id: string }>(
      `INSERT INTO sp_conversations (workspace_id,channel_key,external_thread_id,title,unread_count)
       VALUES ($1,'other',$2,'Pagination message history',3) RETURNING id`,
      [workspaceId, `pagination-${fixture}-messages`]
    );
    messageConversationIds.push(messageConvo.rows[0].id);
    for (let i = 1; i <= 3; i++) {
      await pool.query(
        `INSERT INTO sp_channel_messages (workspace_id,conversation_id,channel_key,direction,body_text,created_at)
         VALUES ($1,$2,'other','inbound',$3,$4::timestamptz)`,
        [workspaceId, messageConversationIds[0], `pagination-message-${i}`, `2099-10-2${i}T00:00:00.123456Z`]
      );
    }
  });
  afterAll(async () => {
    await app.close();
    if (messageConversationIds.length) await pool.query('DELETE FROM sp_conversations WHERE id=ANY($1::uuid[])', [messageConversationIds]);
    if (conversationIds.length) await pool.query('DELETE FROM sp_conversations WHERE id=ANY($1::uuid[])', [conversationIds]);
    if (leadIds.length) await pool.query('DELETE FROM leads WHERE id=ANY($1::uuid[])', [leadIds]);
  });
  it('returns every inquiry exactly once across keyset pages', async () => {
    const firstResponse = await app.inject({ method: 'GET', url: '/api/leads/list?limit=2' });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json();
    expect(first.leads.map((row: { id: string }) => row.id)).toEqual([leadIds[2], leadIds[1]]);
    expect(first.has_more).toBe(true);
    const secondResponse = await app.inject({ method: 'GET', url: `/api/leads/list?limit=2&cursor=${encodeURIComponent(first.next_cursor)}` });
    expect(secondResponse.statusCode).toBe(200);
    const second = secondResponse.json();
    expect(second.leads.map((row: { id: string }) => row.id)).toEqual([leadIds[0]]);
    expect(second.has_more).toBe(false);
    expect(second.next_cursor).toBeNull();
  });
  it('returns every inbox conversation exactly once across keyset pages', async () => {
    const firstResponse = await app.inject({ method: 'GET', url: '/api/inbox/conversations?limit=2' });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json();
    const firstRows = first.conversations.filter((row: { id: string }) => conversationIds.includes(row.id));
    expect(firstRows.map((row: { id: string }) => row.id)).toEqual([conversationIds[2], conversationIds[1]]);
    expect(first.has_more).toBe(true);
    const secondResponse = await app.inject({ method: 'GET', url: `/api/inbox/conversations?limit=2&cursor=${encodeURIComponent(first.next_cursor)}` });
    expect(secondResponse.statusCode).toBe(200);
    const second = secondResponse.json();
    const secondRows = second.conversations.filter((row: { id: string }) => conversationIds.includes(row.id));
    expect(secondRows.map((row: { id: string }) => row.id)).toEqual([conversationIds[0]]);
  });
  it('resets unread atomically on the latest page but not while retrieving older messages', async () => {
    const id = messageConversationIds[0];
    const firstResponse = await app.inject({ method: 'GET', url: `/api/inbox/messages?conversation_id=${id}&limit=2` });
    expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json();
    expect(first.messages.map((row: { body_text: string }) => row.body_text)).toEqual(['pagination-message-2','pagination-message-3']);
    expect(first.has_more).toBe(true);
    let state = await pool.query('SELECT unread_count FROM sp_conversations WHERE id=$1', [id]);
    expect(state.rows[0].unread_count).toBe(0);
    await pool.query('UPDATE sp_conversations SET unread_count=1 WHERE id=$1', [id]);
    const older = await app.inject({ method: 'GET', url: `/api/inbox/messages?conversation_id=${id}&limit=2&cursor=${encodeURIComponent(first.next_cursor)}` });
    expect(older.statusCode).toBe(200);
    expect(older.json().messages.map((row: { body_text: string }) => row.body_text)).toEqual(['pagination-message-1']);
    state = await pool.query('SELECT unread_count FROM sp_conversations WHERE id=$1', [id]);
    expect(state.rows[0].unread_count).toBe(1);
  });
  it('rejects invalid cursors before hitting the database query', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/leads/list?cursor=not-a-cursor' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/inbox/conversations?cursor=not-a-cursor' })).statusCode).toBe(400);
  });
});
