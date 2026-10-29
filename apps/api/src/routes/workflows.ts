import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { inTransaction, pool } from '../db.js';
import { requireWorkspaceMember, type MemberRole } from '../auth.js';
import { auditEvent } from '../domain.js';
import { fail, noStore } from '../http.js';
import {
  workflowEnrollSchema,
  workflowQueueQuerySchema,
  workflowTaskCompleteSchema,
  workflowEnrollmentActionSchema
} from '../validation.js';

type SequenceKey = 'corporate' | 'wedding' | 'mice' | 'general';
type WorkflowStep = { key: string; title: string; instructions: string; waitDays: number };
type WorkflowTemplate = { key: SequenceKey; title: string; purpose: string; steps: WorkflowStep[] };

const writerRoles: MemberRole[] = ['owner', 'admin', 'sales'];
const DAY_MS = 24 * 60 * 60 * 1000;

const templates: Record<SequenceKey, WorkflowTemplate> = {
  corporate: {
    key: 'corporate',
    title: 'Corporate stay',
    purpose: 'Qualify a business stay and prepare an accurate proposal without guessing about availability or rates.',
    steps: [
      { key: 'verify_requirements', title: 'Verify stay requirements', instructions: 'Confirm the requested property, dates, rooms, guests, billing needs and contact details. Ask rather than infer missing information.', waitDays: 0 },
      { key: 'verify_inventory_rate', title: 'Verify inventory and approved rate', instructions: 'Ask the authorised reservations or revenue team to verify exact inventory, applicable rate plan, taxes, terms and any meeting-room requirements. Do not quote an estimate as an approved rate.', waitDays: 0 },
      { key: 'prepare_proposal', title: 'Prepare proposal for approval', instructions: 'Prepare the proposal using the hotel-approved figures and terms. Recheck property, dates, room count, taxes, cancellation terms and totals before an authorised employee sends it.', waitDays: 0 },
      { key: 'proposal_follow_up', title: 'Follow up on the sent proposal', instructions: 'Only complete this after the approved proposal has actually been sent. Confirm receipt, record the customer response and agree on the next action.', waitDays: 2 },
      { key: 'record_outcome', title: 'Record the decision and next action', instructions: 'Record the documented outcome. Mark the enquiry confirmed only after an authorised person verifies the booking; otherwise record the real stage and next step.', waitDays: 3 }
    ]
  },
  wedding: {
    key: 'wedding',
    title: 'Wedding / social event',
    purpose: 'Coordinate the event sales process while requiring human verification of date, capacity, package and price.',
    steps: [
      { key: 'capture_event_brief', title: 'Verify the event brief', instructions: 'Confirm event date(s), event type, guest count, room block, requested spaces, catering, AV, setup and decision timeline.', waitDays: 0 },
      { key: 'verify_venue', title: 'Verify venue availability and capacity', instructions: 'Ask the events team to verify the exact date, space, safe capacity, setup and room inventory. A similar event or an open calendar slot is not proof of availability.', waitDays: 0 },
      { key: 'approve_package', title: 'Prepare package for approval', instructions: 'Use only the property-approved package, inclusions, taxes, cancellation terms and rates. Obtain the required internal approval before the offer is sent.', waitDays: 0 },
      { key: 'event_follow_up', title: 'Follow up on the approved offer', instructions: 'Only complete this after the authorised offer has been sent. Record the response and arrange a site visit only after the hotel confirms the slot.', waitDays: 2 },
      { key: 'record_outcome', title: 'Record the decision and next action', instructions: 'Capture the documented decision and next action. Do not mark a date, venue or booking as confirmed without explicit hotel confirmation.', waitDays: 3 }
    ]
  },
  mice: {
    key: 'mice',
    title: 'MICE / conference',
    purpose: 'Qualify meeting requirements and coordinate verified venue, rooms and commercial terms.',
    steps: [
      { key: 'validate_requirements', title: 'Validate event and room requirements', instructions: 'Confirm event dates, attendees, room block, meeting rooms, AV, catering, breakouts, setup and billing needs.', waitDays: 0 },
      { key: 'verify_capacity', title: 'Verify venue, rooms and capacity', instructions: 'Have the relevant hotel team verify venue capacity, configuration, inventory, AV and the approved rate plan for the requested dates.', waitDays: 0 },
      { key: 'prepare_proposal', title: 'Prepare proposal for approval', instructions: 'Use verified inventory and approved terms only. Recheck quantities, taxes, inclusions, deposits and cancellation clauses before the authorised employee sends the proposal.', waitDays: 0 },
      { key: 'proposal_follow_up', title: 'Follow up on the sent proposal', instructions: 'Only complete after the proposal has actually been sent. Confirm receipt and record the customer response or requested changes.', waitDays: 2 },
      { key: 'record_outcome', title: 'Record the decision and next action', instructions: 'Record a substantiated outcome and the next action. Never infer a confirmed event or room block from a verbal estimate or an unsent proposal.', waitDays: 3 }
    ]
  },
  general: {
    key: 'general',
    title: 'Other / leisure group',
    purpose: 'Clarify the request, route it to the right owner and verify details before making a promise.',
    steps: [
      { key: 'clarify_request', title: 'Clarify the request', instructions: 'Confirm the right property, dates, guest or room count, contact channel and any special requirements. Keep unverified fields marked as unknown.', waitDays: 0 },
      { key: 'assign_and_verify', title: 'Assign an owner and verify options', instructions: 'Make sure one sales owner is accountable. Ask the appropriate hotel team to verify inventory, rates and applicable terms before offering options.', waitDays: 0 },
      { key: 'prepare_response', title: 'Prepare response for approval', instructions: 'Use approved hotel information only. Check dates, property, quantities and terms before an authorised employee sends the response.', waitDays: 0 },
      { key: 'follow_up', title: 'Follow up on the response', instructions: 'Only complete after the response has actually been sent. Record any reply and agree on the next action.', waitDays: 2 },
      { key: 'record_outcome', title: 'Record the decision and next action', instructions: 'Update the pipeline from documented information, not from assumptions. Leave the opportunity open if the outcome is still unknown.', waitDays: 3 }
    ]
  }
};

function sequenceKey(value: string): value is SequenceKey {
  return Object.hasOwn(templates, value);
}

function isClosedLead(status: unknown): status is 'Confirmed' | 'Lost' {
  return status === 'Confirmed' || status === 'Lost';
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : undefined;
}

function taskFor(enrollmentId: string, workspaceId: string, leadId: string, step: WorkflowStep, stepNumber: number, scheduledAt: Date) {
  return { enrollmentId, workspaceId, leadId, step, stepNumber, scheduledAt };
}

async function insertTask(client: pg.PoolClient, input: ReturnType<typeof taskFor>) {
  const result = await client.query(
    `INSERT INTO sp_sales_workflow_tasks
       (workspace_id, enrollment_id, lead_id, step_number, step_key, title, instructions, scheduled_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, workspace_id, enrollment_id, lead_id, step_number, step_key, title, instructions, status, scheduled_at`,
    [input.workspaceId, input.enrollmentId, input.leadId, input.stepNumber, input.step.key, input.step.title, input.step.instructions, input.scheduledAt]
  );
  return result.rows[0];
}

export async function registerWorkflowRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/workflows/templates', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    noStore(reply);
    return reply.send({
      templates: Object.values(templates).map(template => ({
        key: template.key,
        title: template.title,
        purpose: template.purpose,
        steps: template.steps.map((step, index) => ({
          number: index + 1,
          key: step.key,
          title: step.title,
          instructions: step.instructions,
          wait_days_after_previous_step: step.waitDays
        }))
      }))
    });
  });

  app.get('/api/workflows/queue', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply);
    if (!member) return;
    const parsed = workflowQueueQuerySchema.safeParse(request.query);
    if (!parsed.success) return fail(reply, 400, 'Workflow queue filters are invalid.', 'invalid_workflow_query');
    try {
      const result = await pool.query(
        `SELECT
           e.id AS enrollment_id, e.workspace_id, e.lead_id, e.sequence_key, e.status AS enrollment_status,
           e.current_step, e.next_action_at, e.pause_reason, e.stop_reason, e.started_at, e.updated_at AS enrollment_updated_at,
           l.client_name, l.company_name, l.property_name, l.inquiry_type, l.status AS lead_status,
           l.check_in, l.check_out, l.guests, l.assigned_to,
           t.id AS task_id, t.step_number AS task_step_number, t.step_key AS task_step_key,
           t.title AS task_title, t.instructions AS task_instructions, t.status AS task_status,
           t.scheduled_at AS task_scheduled_at
         FROM sp_sales_workflow_enrollments e
         JOIN leads l ON l.workspace_id=e.workspace_id AND l.id=e.lead_id
         LEFT JOIN sp_sales_workflow_tasks t
           ON t.workspace_id=e.workspace_id AND t.enrollment_id=e.id
          AND t.step_number=e.current_step AND t.status='scheduled'
         WHERE e.workspace_id=$1 AND e.status IN ('active','paused')
         ORDER BY CASE WHEN e.status='active' THEN 0 ELSE 1 END,
                  e.next_action_at ASC NULLS LAST, e.started_at DESC
         LIMIT $2`,
        [member.workspace_id, parsed.data.limit]
      );
      noStore(reply);
      return reply.send({ enrollments: result.rows });
    } catch {
      return fail(reply, 500, 'Could not load the workflow queue.', 'workflow_queue_failed');
    }
  });

  app.post('/api/workflows/enroll', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writerRoles);
    if (!member) return;
    const parsed = workflowEnrollSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Workflow details are invalid.', 'invalid_workflow_enrollment');
    const input = parsed.data;
    if (!sequenceKey(input.sequence_key)) return fail(reply, 400, 'Choose a supported hotel-sales workflow.', 'invalid_sequence_key');

    try {
      const outcome = await inTransaction(async client => {
        const leadResult = await client.query(
          `SELECT id, client_name, company_name, client_email, client_phone, property_name, inquiry_type,
                  check_in::text AS check_in, check_out::text AS check_out, status, next_follow_up
           FROM leads WHERE id=$1 AND workspace_id=$2 FOR UPDATE`,
          [input.lead_id, member.workspace_id]
        );
        const lead = leadResult.rows[0];
        if (!lead) return { kind: 'lead_missing' as const };
        if (isClosedLead(lead.status)) return { kind: 'lead_closed' as const };

        const duplicates = await client.query(
          `SELECT id, client_name, company_name, property_name, check_in::text AS check_in, check_out::text AS check_out, status
           FROM leads other
           WHERE other.workspace_id=$1 AND other.id<>$2 AND (
             (NULLIF(lower(trim($3::text)), '') IS NOT NULL AND lower(trim(other.client_email))=lower(trim($3::text))) OR
             (length(regexp_replace(COALESCE($4::text,''), '[^0-9]', '', 'g')) >= 8 AND
              regexp_replace(COALESCE(other.client_phone,''), '[^0-9]', '', 'g')=regexp_replace(COALESCE($4::text,''), '[^0-9]', '', 'g')) OR
             (NULLIF(regexp_replace(lower(COALESCE($5::text,'')), '[^a-z0-9]', '', 'g'), '') IS NOT NULL AND
              regexp_replace(lower(other.client_name), '[^a-z0-9]', '', 'g')=regexp_replace(lower($5::text), '[^a-z0-9]', '', 'g') AND
              lower(other.property_name)=lower($6::text)) OR
             (NULLIF(regexp_replace(lower(COALESCE($7::text,'')), '[^a-z0-9]', '', 'g'), '') IS NOT NULL AND
              regexp_replace(lower(other.company_name), '[^a-z0-9]', '', 'g')=regexp_replace(lower($7::text), '[^a-z0-9]', '', 'g') AND
              $8::date IS NOT NULL AND other.check_in IS NOT NULL AND
              $8::date <= COALESCE(other.check_out, other.check_in) AND
              other.check_in <= COALESCE($9::date, $8::date))
           )
           ORDER BY other.updated_at DESC LIMIT 10`,
          [member.workspace_id, lead.id, lead.client_email, lead.client_phone, lead.client_name, lead.property_name, lead.company_name, lead.check_in, lead.check_out]
        );
        if (duplicates.rows.length && !input.confirm_duplicate_review) {
          return { kind: 'duplicate_review_required' as const, potential_duplicates: duplicates.rows };
        }

        const active = await client.query(
          `SELECT id FROM sp_sales_workflow_enrollments
           WHERE workspace_id=$1 AND lead_id=$2 AND status IN ('active','paused') LIMIT 1`,
          [member.workspace_id, lead.id]
        );
        if (active.rows.length) return { kind: 'already_active' as const };

        const template = templates[input.sequence_key];
        const firstStep = template.steps[0]!;
        const now = new Date();
        const enrollmentResult = await client.query(
          `INSERT INTO sp_sales_workflow_enrollments
             (workspace_id, lead_id, sequence_key, status, current_step, next_action_at,
              created_by_user_id, created_by_email)
           VALUES ($1,$2,$3,'active',1,$4,$5,$6)
           RETURNING id, workspace_id, lead_id, sequence_key, status, current_step, next_action_at, pause_reason, started_at`,
          [member.workspace_id, lead.id, input.sequence_key, now, member.user_id, member.email]
        );
        const enrollment = enrollmentResult.rows[0];
        const task = await insertTask(client, taskFor(enrollment.id, member.workspace_id, lead.id, firstStep, 1, now));
        await client.query('UPDATE leads SET next_follow_up=$1, updated_at=now() WHERE id=$2 AND workspace_id=$3', [now, lead.id, member.workspace_id]);
        await client.query(
          `INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, actor_user_id, actor_email, actor)
           VALUES ($1,$2,'workflow_started',$3,$4,$5,$6)`,
          [member.workspace_id, lead.id, `Started the ${template.title} workflow${duplicates.rows.length ? ' after reviewing possible overlaps' : ''}.`.slice(0, 500), member.user_id, member.email, member.display_name]
        );
        await auditEvent(client, {
          workspaceId: member.workspace_id, actor: member, action: 'workflow.started',
          entityType: 'workflow_enrollment', entityId: enrollment.id,
          metadata: { lead_id: lead.id, sequence_key: input.sequence_key, duplicate_review_confirmed: Boolean(input.confirm_duplicate_review) }
        });
        return { kind: 'created' as const, enrollment, task };
      });

      if (outcome.kind === 'lead_missing') return fail(reply, 404, 'Inquiry not found in this workspace.', 'lead_not_found');
      if (outcome.kind === 'lead_closed') return fail(reply, 409, 'Closed enquiries cannot start a new sales workflow.', 'lead_closed');
      if (outcome.kind === 'already_active') return fail(reply, 409, 'This enquiry already has an active or paused workflow.', 'workflow_already_active');
      if (outcome.kind === 'duplicate_review_required') {
        noStore(reply);
        return reply.code(409).send({
          error: 'Possible overlapping enquiries were found. Review the matches before starting this workflow.',
          code: 'possible_duplicate_requires_review',
          potential_duplicates: outcome.potential_duplicates
        });
      }
      noStore(reply);
      return reply.code(201).send({ enrollment: outcome.enrollment, task: outcome.task });
    } catch (error) {
      if (errorCode(error) === '23505') return fail(reply, 409, 'Another workflow was started for this enquiry. Refresh the queue before retrying.', 'workflow_already_active');
      return fail(reply, 500, 'Could not start the sales workflow.', 'workflow_start_failed');
    }
  });

  app.post('/api/workflows/tasks/complete', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writerRoles);
    if (!member) return;
    const parsed = workflowTaskCompleteSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Task details are invalid.', 'invalid_workflow_task');
    try {
      const outcome = await inTransaction(async client => {
        const result = await client.query(
          `SELECT t.id AS task_id, t.workspace_id, t.enrollment_id, t.lead_id, t.step_number, t.status AS task_status,
                  e.sequence_key, e.status AS enrollment_status, e.current_step,
                  l.status AS lead_status
           FROM sp_sales_workflow_tasks t
           JOIN sp_sales_workflow_enrollments e ON e.workspace_id=t.workspace_id AND e.id=t.enrollment_id
           JOIN leads l ON l.workspace_id=t.workspace_id AND l.id=t.lead_id
           WHERE t.id=$1 AND t.workspace_id=$2
           FOR UPDATE OF t,e,l`,
          [parsed.data.task_id, member.workspace_id]
        );
        const row = result.rows[0];
        if (!row) return { kind: 'task_missing' as const };
        if (row.enrollment_status !== 'active') return { kind: 'workflow_not_active' as const };
        if (row.task_status !== 'scheduled' || Number(row.step_number) !== Number(row.current_step)) {
          return { kind: 'task_not_current' as const };
        }
        if (isClosedLead(row.lead_status)) {
          const closedReason = row.lead_status === 'Confirmed' ? 'lead_confirmed' : 'lead_lost';
          await client.query(
            `UPDATE sp_sales_workflow_enrollments
             SET status='stopped', stop_reason=$1, next_action_at=NULL, stopped_at=now(), updated_at=now()
             WHERE workspace_id=$2 AND id=$3 AND status IN ('active','paused')`,
            [closedReason, member.workspace_id, row.enrollment_id]
          );
          await client.query(
            `UPDATE sp_sales_workflow_tasks SET status='cancelled', updated_at=now()
             WHERE workspace_id=$1 AND enrollment_id=$2 AND status='scheduled'`,
            [member.workspace_id, row.enrollment_id]
          );
          await client.query('UPDATE leads SET next_follow_up=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2', [member.workspace_id, row.lead_id]);
          return { kind: 'lead_closed' as const };
        }

        const template = templates[row.sequence_key as SequenceKey];
        if (!template || !template.steps[row.current_step - 1]) return { kind: 'bad_template' as const };
        await client.query(
          `UPDATE sp_sales_workflow_tasks SET status='completed', completed_at=now(), completed_by_user_id=$1,
             completion_note=$2, updated_at=now()
           WHERE workspace_id=$3 AND id=$4 AND status='scheduled'`,
          [member.user_id, parsed.data.note || '', member.workspace_id, row.task_id]
        );

        const nextStepNumber = Number(row.current_step) + 1;
        const nextStep = template.steps[nextStepNumber - 1];
        if (!nextStep) {
          await client.query(
            `UPDATE sp_sales_workflow_enrollments
             SET status='completed', current_step=$1, next_action_at=NULL, completed_at=now(), updated_at=now()
             WHERE workspace_id=$2 AND id=$3`,
            [Number(row.current_step), member.workspace_id, row.enrollment_id]
          );
          await client.query('UPDATE leads SET next_follow_up=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2', [member.workspace_id, row.lead_id]);
          await client.query(
            `INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, actor_user_id, actor_email, actor)
             VALUES ($1,$2,'workflow_completed','Completed the sales workflow. No message was sent by StayPilot.',$3,$4,$5)`,
            [member.workspace_id, row.lead_id, member.user_id, member.email, member.display_name]
          );
          await auditEvent(client, { workspaceId: member.workspace_id, actor: member, action: 'workflow.completed', entityType: 'workflow_enrollment', entityId: row.enrollment_id });
          return { kind: 'completed' as const };
        }

        const nextAt = new Date(Date.now() + nextStep.waitDays * DAY_MS);
        const task = await insertTask(client, taskFor(row.enrollment_id, member.workspace_id, row.lead_id, nextStep, nextStepNumber, nextAt));
        const enrollmentResult = await client.query(
          `UPDATE sp_sales_workflow_enrollments SET current_step=$1, next_action_at=$2, updated_at=now()
           WHERE workspace_id=$3 AND id=$4
           RETURNING id, workspace_id, lead_id, sequence_key, status, current_step, next_action_at, pause_reason, started_at`,
          [nextStepNumber, nextAt, member.workspace_id, row.enrollment_id]
        );
        await client.query('UPDATE leads SET next_follow_up=$1, updated_at=now() WHERE workspace_id=$2 AND id=$3', [nextAt, member.workspace_id, row.lead_id]);
        await client.query(
          `INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, actor_user_id, actor_email, actor)
           VALUES ($1,$2,'workflow_step_completed',$3,$4,$5,$6)`,
          [member.workspace_id, row.lead_id, `Completed workflow step ${row.current_step}; next action scheduled for ${nextAt.toISOString()}.`.slice(0, 500), member.user_id, member.email, member.display_name]
        );
        await auditEvent(client, {
          workspaceId: member.workspace_id, actor: member, action: 'workflow.step_completed',
          entityType: 'workflow_task', entityId: row.task_id,
          metadata: { enrollment_id: row.enrollment_id, completed_step: row.current_step, next_step: nextStepNumber }
        });
        return { kind: 'advanced' as const, enrollment: enrollmentResult.rows[0], task };
      });

      if (outcome.kind === 'task_missing') return fail(reply, 404, 'Workflow task not found.', 'workflow_task_not_found');
      if (outcome.kind === 'workflow_not_active') return fail(reply, 409, 'This workflow is paused or closed. Review its state before continuing.', 'workflow_not_active');
      if (outcome.kind === 'task_not_current') return fail(reply, 409, 'This task is already completed or is not the current step.', 'workflow_task_not_current');
      if (outcome.kind === 'lead_closed') return fail(reply, 409, 'The enquiry is closed. StayPilot stopped the remaining workflow tasks.', 'lead_closed_workflow_stopped');
      if (outcome.kind === 'bad_template') return fail(reply, 500, 'Workflow template is not available.', 'workflow_template_missing');
      noStore(reply);
      return reply.send(outcome.kind === 'completed' ? { completed: true, next_task: null } : { completed: true, enrollment: outcome.enrollment, next_task: outcome.task });
    } catch {
      return fail(reply, 500, 'Could not complete this workflow task.', 'workflow_task_complete_failed');
    }
  });

  app.post('/api/workflows/enrollments/action', async (request, reply) => {
    const member = await requireWorkspaceMember(request, reply, writerRoles);
    if (!member) return;
    const parsed = workflowEnrollmentActionSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 400, parsed.error.issues[0]?.message || 'Workflow action is invalid.', 'invalid_workflow_action');
    try {
      const outcome = await inTransaction(async client => {
        const result = await client.query(
          `SELECT e.id, e.lead_id, e.sequence_key, e.status, e.current_step, e.pause_reason, l.status AS lead_status
           FROM sp_sales_workflow_enrollments e
           JOIN leads l ON l.workspace_id=e.workspace_id AND l.id=e.lead_id
           WHERE e.id=$1 AND e.workspace_id=$2 FOR UPDATE OF e,l`,
          [parsed.data.enrollment_id, member.workspace_id]
        );
        const row = result.rows[0];
        if (!row) return { kind: 'missing' as const };
        const { action } = parsed.data;
        if (action === 'pause') {
          if (row.status !== 'active') return { kind: 'invalid_state' as const };
          await client.query(
            `UPDATE sp_sales_workflow_enrollments SET status='paused', pause_reason='manual',
             next_action_at=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2`,
            [member.workspace_id, row.id]
          );
          await client.query('UPDATE leads SET next_follow_up=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2', [member.workspace_id, row.lead_id]);
        } else if (action === 'resume') {
          if (row.status !== 'paused') return { kind: 'invalid_state' as const };
          if (isClosedLead(row.lead_status)) {
            const closedReason = row.lead_status === 'Confirmed' ? 'lead_confirmed' : 'lead_lost';
            await client.query(
              `UPDATE sp_sales_workflow_enrollments SET status='stopped', stop_reason=$1,
               next_action_at=NULL, stopped_at=now(), updated_at=now() WHERE workspace_id=$2 AND id=$3`,
              [closedReason, member.workspace_id, row.id]
            );
            await client.query(
              `UPDATE sp_sales_workflow_tasks SET status='cancelled', updated_at=now()
               WHERE workspace_id=$1 AND enrollment_id=$2 AND status='scheduled'`,
              [member.workspace_id, row.id]
            );
            await client.query('UPDATE leads SET next_follow_up=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2', [member.workspace_id, row.lead_id]);
            return { kind: 'lead_closed' as const };
          }
          const now = new Date();
          const task = await client.query(
            `UPDATE sp_sales_workflow_tasks SET scheduled_at=$1, updated_at=now()
             WHERE workspace_id=$2 AND enrollment_id=$3 AND step_number=$4 AND status='scheduled'
             RETURNING id`,
            [now, member.workspace_id, row.id, row.current_step]
          );
          if (!task.rows.length) return { kind: 'no_current_task' as const };
          await client.query(
            `UPDATE sp_sales_workflow_enrollments SET status='active', pause_reason=NULL,
             next_action_at=$1, updated_at=now() WHERE workspace_id=$2 AND id=$3`,
            [now, member.workspace_id, row.id]
          );
          await client.query('UPDATE leads SET next_follow_up=$1, updated_at=now() WHERE workspace_id=$2 AND id=$3', [now, member.workspace_id, row.lead_id]);
        } else {
          if (!['active', 'paused'].includes(row.status)) return { kind: 'invalid_state' as const };
          await client.query(
            `UPDATE sp_sales_workflow_enrollments SET status='cancelled', pause_reason=NULL,
             stop_reason='manual_cancel', next_action_at=NULL, stopped_at=now(), updated_at=now()
             WHERE workspace_id=$1 AND id=$2`,
            [member.workspace_id, row.id]
          );
          await client.query(
            `UPDATE sp_sales_workflow_tasks SET status='cancelled', updated_at=now()
             WHERE workspace_id=$1 AND enrollment_id=$2 AND status='scheduled'`,
            [member.workspace_id, row.id]
          );
          await client.query('UPDATE leads SET next_follow_up=NULL, updated_at=now() WHERE workspace_id=$1 AND id=$2', [member.workspace_id, row.lead_id]);
        }
        await client.query(
          `INSERT INTO lead_activities (workspace_id, lead_id, activity_type, description, actor_user_id, actor_email, actor)
           VALUES ($1,$2,'workflow_action',$3,$4,$5,$6)`,
          [member.workspace_id, row.lead_id, `Workflow ${action} by ${member.display_name}.`, member.user_id, member.email, member.display_name]
        );
        await auditEvent(client, {
          workspaceId: member.workspace_id, actor: member, action: `workflow.${action}`,
          entityType: 'workflow_enrollment', entityId: row.id, metadata: { lead_id: row.lead_id }
        });
        return { kind: 'ok' as const, action };
      });

      if (outcome.kind === 'missing') return fail(reply, 404, 'Workflow not found.', 'workflow_not_found');
      if (outcome.kind === 'invalid_state') return fail(reply, 409, 'This workflow cannot take that action in its current state.', 'workflow_state_conflict');
      if (outcome.kind === 'no_current_task') return fail(reply, 409, 'No current task was found. Refresh the workflow queue.', 'workflow_task_not_found');
      if (outcome.kind === 'lead_closed') return fail(reply, 409, 'The enquiry is closed. StayPilot stopped the remaining workflow tasks.', 'lead_closed_workflow_stopped');
      noStore(reply);
      return reply.send({ ok: true, action: outcome.action });
    } catch {
      return fail(reply, 500, 'Could not update this workflow.', 'workflow_action_failed');
    }
  });
}
