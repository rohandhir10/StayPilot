import { describe, expect, it } from 'vitest';
import {
  workflowEnrollSchema,
  workflowQueueQuerySchema,
  workflowTaskCompleteSchema,
  workflowEnrollmentActionSchema
} from '../src/validation.js';
import { isWorkflowTaskDue } from '../src/routes/workflows.js';

const leadId = '70b9fb11-8458-4a2d-945b-6e7f5f7d310c';
const taskId = '80b9fb11-8458-4a2d-945b-6e7f5f7d310c';
const enrollmentId = '90b9fb11-8458-4a2d-945b-6e7f5f7d310c';

describe('persistent sales workflow inputs', () => {
  it('accepts supported hotel-sales sequence keys and defaults duplicate review to false', () => {
    const parsed = workflowEnrollSchema.safeParse({ lead_id: leadId, sequence_key: 'wedding' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.confirm_duplicate_review).toBe(false);
  });

  it('rejects unsupported sequence keys and unexpected fields', () => {
    expect(workflowEnrollSchema.safeParse({ lead_id: leadId, sequence_key: 'hotel-room-pricing' }).success).toBe(false);
    expect(workflowEnrollSchema.safeParse({ lead_id: leadId, sequence_key: 'corporate', bypass_review: true }).success).toBe(false);
  });

  it('bounds workflow queue requests', () => {
    expect(workflowQueueQuerySchema.safeParse({ limit: 50 }).success).toBe(true);
    expect(workflowQueueQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(workflowQueueQuerySchema.safeParse({ limit: -1 }).success).toBe(false);
  });

  it('validates task completion and explicit sequence actions', () => {
    expect(workflowTaskCompleteSchema.safeParse({ task_id: taskId, note: 'Verified with sales' }).success).toBe(true);
    expect(workflowTaskCompleteSchema.safeParse({ task_id: 'not-a-uuid' }).success).toBe(false);
    expect(workflowEnrollmentActionSchema.safeParse({ enrollment_id: enrollmentId, action: 'pause' }).success).toBe(true);
    expect(workflowEnrollmentActionSchema.safeParse({ enrollment_id: enrollmentId, action: 'send-quote' }).success).toBe(false);
  });
});

describe('workflow task scheduling guard', () => {
  const dueAt = Date.parse('2026-10-30T10:00:00.000Z');

  it('allows a task at or before its scheduled time', () => {
    expect(isWorkflowTaskDue('2026-10-30T10:00:00.000Z', dueAt)).toBe(true);
    expect(isWorkflowTaskDue('2026-10-30T09:59:59.000Z', dueAt)).toBe(true);
  });

  it('blocks tasks scheduled in the future', () => {
    expect(isWorkflowTaskDue('2026-10-30T10:00:01.000Z', dueAt)).toBe(false);
    expect(isWorkflowTaskDue(new Date(dueAt + 60_000), dueAt)).toBe(false);
  });

  it('fails closed for invalid schedule timestamps', () => {
    expect(isWorkflowTaskDue('not-a-date', dueAt)).toBe(false);
  });
});
