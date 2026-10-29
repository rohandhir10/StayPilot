import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';

describe('workspace integrity constraints (PostgreSQL integration)', () => {
  let defaultWorkspaceId = '';
  let otherWorkspaceId = '';
  let defaultLeadId = '';
  let otherLeadId = '';
  let defaultConversationId = '';
  let defaultPartnerKeyId = '';

  beforeAll(async () => {
    const defaults = await pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE slug='default' LIMIT 1"
    );
    if (!defaults.rows[0]) throw new Error('Default workspace migration was not applied.');
    defaultWorkspaceId = defaults.rows[0].id;

    const other = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug,name) VALUES ('integrity-test-workspace','Integrity Test Workspace')
       ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id`
    );
    otherWorkspaceId = other.rows[0].id;

    const defaultLead = await pool.query<{ id: string }>(
      `INSERT INTO leads (workspace_id,client_name,property_name,inquiry_type)
       VALUES ($1,'Integrity Test Lead A','Test Hotel A','Test') RETURNING id`,
      [defaultWorkspaceId]
    );
    defaultLeadId = defaultLead.rows[0].id;

    const otherLead = await pool.query<{ id: string }>(
      `INSERT INTO leads (workspace_id,client_name,property_name,inquiry_type)
       VALUES ($1,'Integrity Test Lead B','Test Hotel B','Test') RETURNING id`,
      [otherWorkspaceId]
    );
    otherLeadId = otherLead.rows[0].id;

    const conversation = await pool.query<{ id: string }>(
      `INSERT INTO sp_conversations (workspace_id,channel_key,external_thread_id,title)
       VALUES ($1,'whatsapp','integrity-test-thread','Integrity Test') RETURNING id`,
      [defaultWorkspaceId]
    );
    defaultConversationId = conversation.rows[0].id;

    const key = await pool.query<{ id: string }>(
      `INSERT INTO sp_partner_api_keys
       (workspace_id,name,key_prefix,key_hash,scopes,is_active,created_by_user_id)
       VALUES ($1,'Integrity Test Key','sp_test_integrity','sha256-integrity-test','["inquiries:create"]'::jsonb,true,'user_test_owner')
       RETURNING id`,
      [defaultWorkspaceId]
    );
    defaultPartnerKeyId = key.rows[0].id;
  });

  afterAll(async () => {
    if (defaultPartnerKeyId) await pool.query('DELETE FROM sp_partner_api_keys WHERE id=$1', [defaultPartnerKeyId]);
    if (defaultConversationId) await pool.query('DELETE FROM sp_conversations WHERE id=$1', [defaultConversationId]);
    if (defaultLeadId) await pool.query('DELETE FROM leads WHERE id=$1', [defaultLeadId]);
    if (otherWorkspaceId) await pool.query('DELETE FROM workspaces WHERE id=$1', [otherWorkspaceId]);
  });

  it('rejects a lead activity whose workspace differs from the lead workspace', async () => {
    await expect(pool.query(
      `INSERT INTO lead_activities (workspace_id,lead_id,activity_type,description)
       VALUES ($1,$2,'test','cross workspace')`,
      [otherWorkspaceId,defaultLeadId]
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects linking a conversation to another workspace\'s lead', async () => {
    await expect(pool.query(
      `INSERT INTO sp_conversations (workspace_id,channel_key,external_thread_id,linked_lead_id)
       VALUES ($1,'whatsapp','integrity-cross-workspace-thread',$2)`,
      [otherWorkspaceId,defaultLeadId]
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a channel message attached to another workspace\'s conversation', async () => {
    await expect(pool.query(
      `INSERT INTO sp_channel_messages (workspace_id,conversation_id,channel_key,direction,body_text)
       VALUES ($1,$2,'whatsapp','inbound','cross workspace message')`,
      [otherWorkspaceId,defaultConversationId]
    )).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a partner idempotency record that crosses workspace boundaries', async () => {
    await expect(pool.query(
      `INSERT INTO sp_partner_requests (workspace_id,api_key_id,idempotency_key,request_hash,lead_id)
       VALUES ($1,$2,'integrity-test-idempotency','request-hash',$3)`,
      [defaultWorkspaceId,defaultPartnerKeyId,otherLeadId]
    )).rejects.toMatchObject({ code: '23503' });
  });
});
