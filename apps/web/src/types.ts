export type LeadStatus = 'New inquiry' | 'Contacted' | 'Proposal sent' | 'Negotiation' | 'Confirmed' | 'Lost';
export type ConversationStatus = 'open' | 'pending' | 'closed';

export interface Lead {
  id: string;
  client_name: string;
  company_name: string | null;
  client_email: string | null;
  client_phone: string | null;
  agent_name: string | null;
  agent_email: string | null;
  property_name: string;
  inquiry_type: string;
  check_in: string | null;
  check_out: string | null;
  guests: number;
  estimated_value: number | string | null;
  source: string;
  status: LeadStatus;
  assigned_to: string | null;
  next_follow_up: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  duplicate_candidates?: Array<Pick<Lead, 'id' | 'client_name' | 'company_name' | 'property_name' | 'check_in' | 'check_out' | 'status'>>;
}

export interface Conversation {
  id: string;
  channel_key: string;
  external_account_id: string | null;
  title: string | null;
  participant_display: string | null;
  participant_address: string | null;
  linked_lead_id: string | null;
  status: ConversationStatus;
  unread_count: number;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_message_direction: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboxMessage {
  id: string;
  channel_key: string;
  direction: string;
  sender_name: string | null;
  sender_address: string | null;
  recipient_address?: string | null;
  subject?: string | null;
  body_text: string;
  provider_created_at: string | null;
  delivery_status: string | null;
  created_by_user_id?: string | null;
  created_at: string;
}

export interface ChannelConnection {
  channel_key: string;
  provider: string;
  display_name: string;
  status: string;
  connection_mode: string | null;
  account_label: string | null;
  external_account_id: string | null;
  last_synced_at: string | null;
  last_webhook_at: string | null;
  last_error_code: string | null;
  connected: boolean;
  liveDataConfirmed: boolean;
  credentialsReturned: false;
}

export interface Session {
  user: { id: string; email: string; name: string | null };
  workspace: { id: string; role: 'owner' | 'admin' | 'sales' | 'viewer' };
  permissions: {
    canManageTeam: boolean;
    canManageIntegrations: boolean;
    canWriteInquiries: boolean;
  };
}

export interface Invite {
  id: string;
  email: string;
  role: 'admin' | 'sales' | 'viewer';
  expires_at: string;
  accepted_at: string | null;
  accepted: boolean;
  revoked_at: string | null;
  created_at: string;
}
