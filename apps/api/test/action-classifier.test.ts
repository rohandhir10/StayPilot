import { describe, expect, it } from 'vitest';
import { classifyInboundMessage } from '../src/action-classifier.js';

describe('Action Centre inbound-message classifier', () => {
  it('suggests a quotation task when a client asks for a proposal or pricing', () => {
    const result = classifyInboundMessage('Could you share a revised proposal with the new room rates?');
    expect(result?.category).toBe('quotation');
    expect(result?.priority).toBe('high');
    expect(result?.confidence).toBe('medium');
    expect(result?.description).toContain('Verify rates');
  });

  it('suggests availability verification without claiming inventory is available', () => {
    const result = classifyInboundMessage('Can you confirm whether rooms are available for these dates?');
    expect(result?.category).toBe('availability');
    expect(result?.description).toContain('reservations system');
    expect(result?.description).not.toContain('availability is confirmed');
  });

  it('detects a callback request and a generic follow-up request', () => {
    expect(classifyInboundMessage('Please call me back this afternoon')?.category).toBe('callback');
    expect(classifyInboundMessage('Please send me the details and let me know')?.category).toBe('client_request');
  });

  it('ignores messages that do not contain a supported action signal', () => {
    expect(classifyInboundMessage('Thank you, we enjoyed the event last week.')).toBeNull();
  });

  it('can use the subject line as context for a quotation request', () => {
    expect(classifyInboundMessage('Any update?', 'Re: Wedding quotation')?.category).toBe('quotation');
  });
});
