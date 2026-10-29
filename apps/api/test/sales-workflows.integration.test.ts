import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn()
}));

vi.mock('../src/auth.js', () => ({
  requireWorkspaceMember: mocks.requireWorkspaceMember
}));

import { pool, inTransaction } from '../src/db.js';
import { upsertExternalMessageWithClient } from '../src/domain.js';
import { registerLeadRoutes } from '../src/routes/leads.js';
import { registerWorkflowRoutes } from '../src/routes/workflows.js';

const app = Fastify();
const fixture = randomUUID().replaceAll('-', '').slice(0, 12);
let workspaceId = '';
const leadIds: string[] = [];
const conversationIds: string[] = [];
const actorEmail = `sales-workflow-${fixture}@example.test`;
const member = {
  workspace_id: '',
  user_id: `sales-workflow-test-${fixture}`,
  email: actorEmail,
  display_name: 'Sales Workflow Integration Test',
  role: 'sales' as const
};

function leadPayload(key: string, overrides: Record<string, unknown> = {}) {
  return {
    client_name: `Workflow Contact ${fixture} ${key}`,
    company_name: `Workflow Organisation ${fixture} ${key}`,
    client_email: `workflow-${fixture}-${key}@example.test`,
    client_phone: '',
    property_name: 'Workflow Test Hotel',
    inquiry_type: 'Corporate stay',
    check_in: '2026-12-10',
    check_out: '2026-12-12',
    guests: 4,
    estimated_value: 45000,
    source: 'Travel agent',
    status: 'New inquiry',
    assigned_to: 'Sales Workflow Integration Test',
    notes: 'Automated workflow integration fixture',
    ...overrides
  };
}

async function createLead(key: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/leads/create',
    payload: leadPayload(key, overrides)
  });
  expect(response.statusCode).toBe(201);
  const id = response.json().lead.id as string;
  leadIds.push(id);
  return id;
}

async function startSequence(leadId: string, key: 'corporate' | 'wedding' | 'mice' | 'general' = 'corporate', confirm = false) {
  return await app.inject({
    method: 'POST',
    url: '/api/workflows/enroll',
    payload: { lead_id: leadId, sequence_key: key, confirm_duplicate_review: confirm }
  });
}

describe('persistent hotel-sales workflows (PostgreSQL integration)', () => {
  beforeAll(async () => {
    const workspace = await pool.query("SELECT id FROM workspaces WHERE slug='default' LIMIT 1");
    if (!workspace.rows[0]) throw new Error('Default workspace is missing. CI migrations must run first.');
    workspaceId = workspace.rows[0].id;
    member.workspace_id = workspaceId;
    mocks.requireWorkspaceMember.mockImplementation(async () => member);
    await registerLeadRoutes(app);
    await registerWorkflowRoutes(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (conversationIds.length) await pool.query('DELETE FROM sp_conversations WHERE id = ANY($1::uuid[])', [conversationIds]);
    if (leadIds.length) {
      await pool.query('DELETE FROM sp_audit_events WHERE workspace_id=$1 AND actor_email=$2', [workspaceId, actorEmail]);
      await pool.query('DELETE FROM leads WHERE workspace_id=$1 AND id = ANY($2::uuid[])', [workspaceId, leadIds]);
    }
  });

  it('persists a sequence, advances a task, and stops pending work when the lead closes', async () => {
    const leadId = await createLead('advance');
    const start = await startSequence(leadId);
    expect(start.statusCode).toBe(201);
    expect(start.json().enrollment.status).toBe('active');
    expect(start.json().task.title).toBe('Verify stay requirements');

    const queue = await app.inject({ method: 'GET', url: '/api/workflows/queue?limit=100' });
    expect(queue.statusCode).toBe(200);
    const queued = queue.json().enrollments.find((row: { lead_id: string }) => row.lead_id === leadId);
    expect(queued).toBeTruthy();
    expect(queued.task_id).toBe(start.json().task.id);

    const completed = await app.inject({
      method: 'POST',
      url: '/api/workflows/tasks/complete',
      payload: { task_id: start.json().task.id, note: 'Requirements verified with the customer.' }
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json().completed).toBe(true);
    expect(completed.json().next_task.title).toBe('Verify inventory and approved rate');

    const tasksBeforeClose = await pool.query(
      'SELECT status FROM sp_sales_workflow_tasks WHERE workspace_id=$1 AND lead_id=$2 ORDER BY step_number',
      [workspaceId, leadId]
    );
    expect(tasksBeforeClose.rows.map((row: { status: string }) => row.status)).toEqual(['completed', 'scheduled']);

    const closeLead = await app.inject({
      method: 'POST',
      url: '/api/leads/update',
      payload: { id: leadId, status: 'Confirmed' }
    });
    expect(closeLead.statusCode).toBe(200);
    expect(closeLead.json().lead.next_follow_up).toBeNull();

    const state = await pool.query(
      `SELECT e.status AS enrollment_status, e.stop_reason, t.status AS task_status
       FROM sp_sales_workflow_enrollments e
       JOIN sp_sales_workflow_tasks t ON t.workspace_id=e.workspace_id AND t.enrollment_id=e.id
       WHERE e.workspace_id=$1 AND e.lead_id=$2 ORDER BY t.step_number`,
      [workspaceId, leadId]
    );
    expect(state.rows.map((row: { enrollment_status: string; stop_reason: string; task_status: string }) =>
      [row.enrollment_status, row.stop_reason, row.task_status]
    )).toEqual([
      ['stopped', 'lead_confirmed', 'completed'],
      ['stopped', 'lead_confirmed', 'cancelled']
    ]);
  });

  it('requires review of possible duplicate enquiries before starting a sequence', async () => {
    const sharedEmail = `workflow-duplicate-${fixture}@example.test`;
    const originalId = await createLead('duplicate-original', { client_email: sharedEmail });
    await createLead('duplicate-copy', { client_email: sharedEmail });

    const blocked = await startSequence(originalId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('possible_duplicate_requires_review');
    expect(blocked.json().potential_duplicates).toHaveLength(1);

    const confirmedReview = await startSequence(originalId, 'wedding', true);
    expect(confirmedReview.statusCode).toBe(201);
    expect(confirmedReview.json().enrollment.sequence_key).toBe('wedding');
  });

  it('pauses a live sequence when a new inbound message arrives on a linked conversation', async () => {
    const leadId = await createLead('reply-pause');
    const start = await startSequence(leadId);
    expect(start.statusCode).toBe(201);

    const conversation = await pool.query(
      `INSERT INTO sp_conversations
        (workspace_id, channel_key, external_thread_id, title, participant_display, participant_address, linked_lead_id)
       VALUES ($1,'email_gmail',$2,'Customer reply test',$3,$4,$5)
       RETURNING id`,
      [workspaceId, `workflow-thread-${fixture}`, 'Customer ' + fixture, `customer-${fixture}@example.test`, leadId]
    );
    const conversationId = conversation.rows[0].id as string;
    conversationIds.push(conversationId);

    await inTransaction(client => upsertExternalMessageWithClient(client, {
      workspaceId,
      channelKey: 'email_gmail',
      externalThreadId: `workflow-thread-${fixture}`,
      title: 'Customer reply test',
      participantDisplay: 'Customer ' + fixture,
      participantAddress: `customer-${fixture}@example.test`,
      providerMessageId: `workflow-message-${fixture}`,
      senderName: 'Customer ' + fixture,
      senderAddress: `customer-${fixture}@example.test`,
      recipientAddress: 'hotel-sales@example.test',
      subject: 'Re: Hotel enquiry',
      bodyText: 'Thank you, could you clarify the package?',
      providerCreatedAt: new Date(Date.now() - 86400000).toISOString(),
      metadata: {}
    }));

    const status = await pool.query(
      `SELECT e.status, e.pause_reason, l.next_follow_up
       FROM sp_sales_workflow_enrollments e
       JOIN leads l ON l.workspace_id=e.workspace_id AND l.id=e.lead_id
       WHERE e.workspace_id=$1 AND e.lead_id=$2`,
      [workspaceId, leadId]
    );
    expect(status.rows[0].status).toBe('paused');
    expect(status.rows[0].pause_reason).toBe('customer_reply');
    expect(status.rows[0].next_follow_up).toBeNull();
  });
});
