export type ConversationActionCategory = 'quotation' | 'availability' | 'callback' | 'client_request';
export type ConversationActionSignal = {
  category: ConversationActionCategory;
  title: string;
  description: string;
  priority: 'normal' | 'high';
  confidence: 'low' | 'medium';
};

// Conservative phrase rules: a signal only creates a suggestion, never a claimed fact or external action.
export function classifyInboundMessage(body: string, subject = ''): ConversationActionSignal | null {
  const text = (subject + ' ' + body).slice(0, 20000);
  if (/\b(quote|quotation|proposal|rate card|pricing|price estimate|estimate|cost breakdown)\b/i.test(text)) {
    return { category: 'quotation', title: 'Review and prepare a quotation', description: 'The latest inbound message appears to request pricing or a proposal. Verify rates and terms against the hotel source of truth before responding.', priority: 'high', confidence: 'medium' };
  }
  if (/\b(availability|available|room block|rooms? for|check (the )?dates|do you have rooms|confirm (the )?dates)\b/i.test(text)) {
    return { category: 'availability', title: 'Verify availability with reservations', description: 'The latest inbound message appears to ask about dates or room availability. Check the reservations system before making any commitment.', priority: 'high', confidence: 'medium' };
  }
  if (/\b(call me|please call|give me a call|call back|callback|phone me)\b/i.test(text)) {
    return { category: 'callback', title: 'Return the client’s call', description: 'The latest inbound message appears to request a call. Confirm the right contact and log the outcome after speaking.', priority: 'normal', confidence: 'medium' };
  }
  if (/\b(please confirm|follow[ -]?up|let me know|revert (back )?to me|send (me )?(the )?(details|information)|share (the )?details|waiting for (an )?update|update me|respond|response)\b/i.test(text)) {
    return { category: 'client_request', title: 'Review and respond to the client request', description: 'The latest inbound message appears to ask for a response or update. Open the source conversation to verify the request and next step.', priority: 'normal', confidence: 'low' };
  }
  return null;
}
