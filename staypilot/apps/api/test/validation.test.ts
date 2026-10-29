import { describe, expect, it } from 'vitest';
import { leadSchema, publicLeadSchema, leadUpdateSchema } from '../src/validation.js';

const baseLead = {
  client_name: 'Aarav Mehta', company_name: 'Orion Technologies',
  client_email: 'sales@example.com', client_phone: '+91 99999 88888',
  agent_name: 'Apex Travel', agent_email: 'agent@example.com',
  property_name: 'Hotel New Delhi', inquiry_type: 'Corporate stay',
  check_in: '2026-12-12', check_out: '2026-12-15', guests: 20,
  estimated_value: 450000, source: 'Travel agent', status: 'New inquiry',
  assigned_to: 'Sales team', next_follow_up: '2026-10-29T10:00:00.000Z', notes: 'Needs a room block'
};

describe('request schemas', () => {
  it('accepts a valid inquiry and defaults absent optional fields safely', () => {
    const result = leadSchema.safeParse(baseLead);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.source).toBe('Travel agent');
  });

  it('rejects impossible calendar dates and normalizes surrounding email whitespace', () => {
    expect(leadSchema.safeParse({ ...baseLead, check_in: '2026-02-31' }).success).toBe(false);
    const parsed = leadSchema.safeParse({ ...baseLead, client_email: ' sales@example.com ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.client_email).toBe('sales@example.com');
  });

  it('rejects reversed stay dates and overlarge notes', () => {
    expect(leadSchema.safeParse({ ...baseLead, check_in: '2026-12-16', check_out: '2026-12-15' }).success).toBe(false);
    expect(leadSchema.safeParse({ ...baseLead, notes: 'x'.repeat(5001) }).success).toBe(false);
  });

  it('rejects a public inquiry without affirmative privacy consent or CAPTCHA token', () => {
    const input = { ...baseLead, company_name: '', privacy_consent: true, turnstile_token: 'token', form_started_at: Date.now(), website: '' };
    const parsed = publicLeadSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toBe('Website');
      expect('turnstile_token' in parsed.data).toBe(false);
      expect('privacy_consent' in parsed.data).toBe(false);
    }
    expect(publicLeadSchema.safeParse({ ...input, privacy_consent: false }).success).toBe(false);
    expect(publicLeadSchema.safeParse({ ...input, turnstile_token: '' }).success).toBe(false);
  });

  it('rejects empty update operations', () => {
    expect(leadUpdateSchema.safeParse({ id: '70b9fb11-8458-4a2d-945b-6e7f5f7d310c' }).success).toBe(false);
    expect(leadUpdateSchema.safeParse({ id: '70b9fb11-8458-4a2d-945b-6e7f5f7d310c', status: 'Confirmed' }).success).toBe(true);
  });
});
