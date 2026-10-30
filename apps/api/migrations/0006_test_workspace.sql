-- Isolated workspace for the restricted manual dashboard test account.
-- Never copy production customer records into this workspace.
INSERT INTO workspaces (slug, name) VALUES ('test', 'StayPilot Test Workspace')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO leads (workspace_id, client_name, company_name, client_email, client_phone, agent_name, agent_email,
  property_name, inquiry_type, check_in, check_out, guests, estimated_value, source, status, assigned_to, next_follow_up, notes)
SELECT w.id, v.client_name, v.company_name, v.client_email, v.client_phone, v.agent_name, v.agent_email,
  v.property_name, v.inquiry_type, CURRENT_DATE + v.start_days, CURRENT_DATE + v.end_days, v.guests,
  v.estimated_value, v.source, v.status, v.assigned_to, now() + v.followup_hours * interval '1 hour', v.notes
FROM workspaces w
CROSS JOIN (VALUES
 ('Aarav Mehta','Mehta & Co.','aarav@example.test','+91 98000 1201','Riya Travel','partner@example.test','The LaLiT New Delhi','Corporate stay',18,21,26,480000::numeric,'Travel agent','Proposal sent','Priya Sharma',0,'Quarterly leadership offsite; needs meeting room and 26 rooms.'),
 ('Sana Kapoor','Northstar Events','sana@example.test','+91 98000 7782','Northstar Events','events@example.test','The LaLiT Mumbai','Wedding / social event',34,36,140,1850000::numeric,'Direct inquiry','Negotiation','Dev Malhotra',24,'Wedding enquiry with overlapping room-block request.'),
 ('Kabir Singh','Atlas Consulting','kabir@example.test','+91 98000 9931','Global Stays','global@example.test','The LaLiT Jaipur','MICE / conference',12,14,42,720000::numeric,'Corporate','Contacted','Dev Malhotra',48,'Annual strategy meeting; proposal requested.'),
 ('Mira Shah','Evergreen Mobility','mira@example.test','+91 98000 3014','','','The LaLiT Ashok Bengaluru','Corporate stay',7,10,18,315000::numeric,'Website','Confirmed','Priya Sharma',96,'Example confirmed booking.'),
 ('Ishaan Rao','BluePeak Systems','ishaan@example.test','+91 98000 4442','Summit Travel','summit@example.test','The LaLiT New Delhi','Leisure group',25,28,32,560000::numeric,'Partner referral','New inquiry','Priya Sharma',2,'Sample group stay awaiting first response.')
) AS v(client_name,company_name,client_email,client_phone,agent_name,agent_email,property_name,inquiry_type,start_days,end_days,guests,estimated_value,source,status,assigned_to,followup_hours,notes)
WHERE w.slug = 'test'
AND NOT EXISTS (SELECT 1 FROM leads existing WHERE existing.workspace_id = w.id);

INSERT INTO sp_channel_connections (workspace_id, channel_key, provider, display_name, status, connection_mode)
SELECT test.id, source.channel_key, source.provider, source.display_name, 'not_connected', source.connection_mode
FROM workspaces test
JOIN workspaces production ON production.slug = 'default'
JOIN sp_channel_connections source ON source.workspace_id = production.id
WHERE test.slug = 'test'
ON CONFLICT (workspace_id, channel_key) DO NOTHING;
