import { z } from 'zod';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Enter a real calendar date in YYYY-MM-DD format.');
const nullableDate = z.union([z.null(), z.literal(''), dateOnly]).optional().transform(v => v || null);
const nullableDateTime = z.union([z.null(), z.literal(''), z.string().datetime({ offset: true }), z.string().datetime()]).optional().transform(v => v || null);
const optionalEmail = z.union([z.literal(''), z.string().trim().email().max(254)]).optional().transform(v => (v || '').trim().toLowerCase());
const phone = z.union([z.literal(''), z.string().regex(/^[+()0-9.\s-]{6,32}$/)]).optional().transform(v => (v || '').trim());

const leadBaseSchema = z.object({
  client_name: z.string().trim().min(1).max(120),
  company_name: z.string().trim().max(160).optional().default(''),
  client_email: optionalEmail,
  client_phone: phone,
  agent_name: z.string().trim().max(160).optional().default(''),
  agent_email: optionalEmail,
  property_name: z.string().trim().min(1).max(160).default('Hotel property'),
  inquiry_type: z.string().trim().min(1).max(100).default('General inquiry'),
  check_in: nullableDate,
  check_out: nullableDate,
  guests: z.coerce.number().int().min(1).max(10000).default(1),
  estimated_value: z.coerce.number().finite().min(0).max(1_000_000_000).default(0),
  source: z.enum(['Travel agent', 'Email', 'Phone', 'Website', 'WhatsApp', 'Instagram', 'Facebook', 'Booking.com', 'Expedia', 'Spreadsheet', 'Partner API', 'Other']).default('Other'),
  status: z.enum(['New inquiry', 'Contacted', 'Proposal sent', 'Negotiation', 'Confirmed', 'Lost']).default('New inquiry'),
  assigned_to: z.string().trim().max(160).default('Unassigned'),
  next_follow_up: nullableDateTime,
  notes: z.string().trim().max(5000).default('')
});

function enforceStayDateOrder(value: { check_in: string | null; check_out: string | null }, context: z.RefinementCtx): void {
  if (value.check_in && value.check_out && value.check_out < value.check_in) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['check_out'], message: 'End date cannot be before start date.' });
  }
}

export const leadSchema = leadBaseSchema.superRefine(enforceStayDateOrder);

const publicLeadFieldsSchema = leadBaseSchema.pick({
  client_name: true,
  company_name: true,
  client_email: true,
  client_phone: true,
  agent_name: true,
  agent_email: true,
  property_name: true,
  inquiry_type: true,
  check_in: true,
  check_out: true,
  guests: true,
  notes: true
});

export const publicLeadSchema = publicLeadFieldsSchema.extend({
  privacy_consent: z.literal(true),
  turnstile_token: z.string().min(1).max(4096),
  form_started_at: z.coerce.number().int().positive(),
  website: z.string().max(500).optional().default('')
}).strict().superRefine(enforceStayDateOrder).transform(
  ({ privacy_consent: _consent, turnstile_token: _token, form_started_at: _start, website: _website, ...lead }) => ({
    ...lead,
    source: 'Website' as const,
    status: 'New inquiry' as const,
    assigned_to: 'Unassigned',
    estimated_value: 0,
    next_follow_up: null
  })
);

export const leadUpdateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['New inquiry', 'Contacted', 'Proposal sent', 'Negotiation', 'Confirmed', 'Lost']).optional(),
  assigned_to: z.string().trim().max(160).optional(),
  next_follow_up: nullableDateTime.optional(),
  notes: z.string().trim().max(5000).optional()
}).refine(value => ['status', 'assigned_to', 'next_follow_up', 'notes'].some(key => Object.hasOwn(value, key)), { message: 'No supported fields to update.' });

export const inviteSchema = z.object({
  email: z.string().trim().email().max(254).transform(v => v.toLowerCase()),
  role: z.enum(['admin', 'sales', 'viewer'])
});

export const conversationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  channel: z.string().max(64).optional(),
  status: z.enum(['open', 'pending', 'closed']).optional(),
  q: z.string().trim().max(120).optional()
});

export const noteSchema = z.object({
  conversation_id: z.string().uuid(),
  body_text: z.string().trim().min(1).max(5000)
});

export const linkSchema = z.object({ conversation_id: z.string().uuid(), lead_id: z.string().uuid().nullable() });
