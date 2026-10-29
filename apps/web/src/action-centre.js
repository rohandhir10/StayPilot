const previewState = new Map();
let manualPreviewCounter = 0;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const safeDate = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
const dateLabel = value => {
  const date = safeDate(value);
  if (!date) return 'No deadline';
  return date.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};
const isOverdue = task => task.status === 'open' && safeDate(task.due_at)?.getTime() < Date.now();
const categoryLabel = category => ({
  follow_up: 'Follow-up', ownership: 'Owner needed', missing_information: 'Missing details',
  quotation: 'Quotation', availability: 'Availability', callback: 'Call back',
  client_request: 'Client request', other: 'Manual task'
}[category] || 'Action');
const channelLabel = channel => ({
  crm: 'CRM record', whatsapp: 'WhatsApp', email_gmail: 'Gmail',
  email_outlook: 'Outlook', instagram: 'Instagram', facebook: 'Messenger', manual: 'Manual'
}[channel] || channel || 'CRM record');

function buildPreviewTasks(leads) {
  const candidates = [];
  for (const lead of leads) {
    if (['Confirmed', 'Lost'].includes(lead.status)) continue;
    const company = lead.company_name || lead.client_name || 'this inquiry';
    const owner = String(lead.assigned_to || 'Unassigned');
    const followAt = safeDate(lead.next_follow_up);
    if (followAt && followAt.getTime() <= Date.now() + 86400000) {
      candidates.push({
        id: 'preview-follow-' + lead.id, task_key: 'preview-follow-' + lead.id,
        source_type: 'crm_rule', category: 'follow_up',
        title: (followAt.getTime() < Date.now() ? 'Overdue follow-up · ' : 'Follow up · ') + company,
        description: 'A follow-up is scheduled in the sample CRM record. Review the latest conversation and record the outcome.',
        priority: followAt.getTime() < Date.now() ? 'urgent' : 'high', status: 'open',
        assigned_to: owner, due_at: followAt.toISOString(), lead_id: lead.id, company_name: lead.company_name,
        client_name: lead.client_name, property_name: lead.property_name, evidence_channel: 'crm',
        evidence_text: 'Sample CRM next follow-up: ' + followAt.toISOString(), confidence: 'high'
      });
    }
    if (!owner.trim() || owner.toLowerCase() === 'unassigned') {
      candidates.push({
        id: 'preview-owner-' + lead.id, task_key: 'preview-owner-' + lead.id,
        source_type: 'crm_rule', category: 'ownership', title: 'Assign an owner · ' + company,
        description: 'This active sample inquiry has no named owner. Assign one person to own the next step.',
        priority: 'high', status: 'open', assigned_to: 'Unassigned', due_at: null, lead_id: lead.id,
        company_name: lead.company_name, client_name: lead.client_name, property_name: lead.property_name,
        evidence_channel: 'crm', evidence_text: 'Sample CRM assigned_to is empty or Unassigned.', confidence: 'high'
      });
    }
    if (!lead.client_email && !lead.client_phone) {
      candidates.push({
        id: 'preview-contact-' + lead.id, task_key: 'preview-contact-' + lead.id,
        source_type: 'crm_rule', category: 'missing_information', title: 'Add client contact details · ' + company,
        description: 'The sample inquiry has neither an email nor a phone number. Confirm contact details before outreach.',
        priority: 'normal', status: 'open', assigned_to: owner, due_at: null, lead_id: lead.id,
        company_name: lead.company_name, client_name: lead.client_name, property_name: lead.property_name,
        evidence_channel: 'crm', evidence_text: 'Sample CRM contact fields are empty.', confidence: 'high'
      });
    }
    if (!lead.check_in && !lead.check_out) {
      candidates.push({
        id: 'preview-dates-' + lead.id, task_key: 'preview-dates-' + lead.id,
        source_type: 'crm_rule', category: 'missing_information', title: 'Confirm dates · ' + company,
        description: 'No start or end date is recorded. Confirm dates before availability or pricing is discussed.',
        priority: 'normal', status: 'open', assigned_to: owner, due_at: null, lead_id: lead.id,
        company_name: lead.company_name, client_name: lead.client_name, property_name: lead.property_name,
        evidence_channel: 'crm', evidence_text: 'Sample CRM check-in and check-out dates are blank.', confidence: 'high'
      });
    }
  }

  // Clearly labelled synthetic examples let the preview exercise conversation-derived tasks without real inbox access.
  candidates.push({
    id: 'preview-message-quote', task_key: 'preview-message-quote', source_type: 'conversation_rule',
    category: 'quotation', title: 'Review and prepare a quotation · Northstar Events',
    description: 'The sample inbound message appears to request a revised proposal. Check the source and verify rates before responding.',
    priority: 'high', status: 'open', assigned_to: 'Dev Malhotra', due_at: null, lead_id: leads.find(l => /Northstar/i.test(l.company_name || ''))?.id || null,
    company_name: 'Northstar Events', client_name: 'Sana Kapoor', evidence_channel: 'whatsapp',
    evidence_text: 'SAMPLE MESSAGE: “Could you share a revised proposal for our wedding dates?”', confidence: 'medium'
  });
  candidates.push({
    id: 'preview-message-availability', task_key: 'preview-message-availability', source_type: 'conversation_rule',
    category: 'availability', title: 'Verify availability with reservations · Atlas Consulting',
    description: 'The sample inbound message appears to ask about dates. Confirm availability in the reservations system before replying.',
    priority: 'high', status: 'open', assigned_to: 'Dev Malhotra', due_at: null,
    lead_id: leads.find(l => /Atlas/i.test(l.company_name || ''))?.id || null,
    company_name: 'Atlas Consulting', client_name: 'Kabir Singh', evidence_channel: 'whatsapp',
    evidence_text: 'SAMPLE MESSAGE: “Can you confirm whether rooms are available for these dates?”', confidence: 'medium'
  });

  for (const task of candidates) {
    const current = previewState.get(task.task_key);
    if (!current) previewState.set(task.task_key, task);
    else if (current.status === 'open') previewState.set(task.task_key, { ...current, ...task, status: 'open' });
  }
  return [...previewState.values()];
}

function statusPill(task) {
  if (task.status === 'completed') return '<span class="ac-status is-completed">Completed</span>';
  if (task.status === 'dismissed') return '<span class="ac-status">Dismissed</span>';
  if (isOverdue(task)) return '<span class="ac-status is-overdue">Overdue</span>';
  if (task.source_type === 'conversation_rule') return '<span class="ac-status is-suggested">Suggested from message</span>';
  if (task.priority === 'urgent' || task.priority === 'high') return '<span class="ac-status is-priority">Priority</span>';
  return '<span class="ac-status">Open</span>';
}

function renderTask(task, { isPreview, canWrite }) {
  const evidenceText = task.evidence_text || 'No message excerpt was stored for this action.';
  const connectedTo = task.company_name || task.client_name || task.conversation_title || task.participant_display || '';
  const confidence = String(task.confidence || 'medium').toUpperCase();
  return `<article class="ac-task ${task.status !== 'open' ? 'is-resolved' : ''}">
    <div class="ac-task-check"><span class="ac-priority-dot ${escapeHtml(task.priority || 'normal')}"></span></div>
    <div class="ac-task-main">
      <div class="ac-task-kicker"><span>${escapeHtml(categoryLabel(task.category))}</span><span>·</span><span>${escapeHtml(channelLabel(task.evidence_channel || task.conversation_channel || (task.source_type === 'manual' ? 'manual' : 'crm')))}</span></div>
      <h3>${escapeHtml(task.title)}</h3>
      <p class="ac-task-description">${escapeHtml(task.description)}</p>
      <div class="ac-evidence"><div class="ac-evidence-head"><span>WHY THIS IS HERE</span><span class="ac-confidence">${escapeHtml(confidence)} CONFIDENCE</span></div><p>${escapeHtml(evidenceText)}</p></div>
      <div class="ac-task-meta"><span><span aria-hidden="true">◷</span> ${escapeHtml(dateLabel(task.due_at))}</span><span><span aria-hidden="true">♙</span> ${escapeHtml(task.assigned_to || 'Unassigned')}</span>${connectedTo ? '<span>↗ ' + escapeHtml(connectedTo) + '</span>' : ''}</div>
    </div>
    <div class="ac-task-actions">
      ${statusPill(task)}
      ${task.lead_id ? '<button type="button" class="ac-link-btn" data-ac-lead="' + escapeHtml(task.lead_id) + '">Open inquiry ↗</button>' : ''}
      ${task.status === 'open' && canWrite ? '<button type="button" class="btn btn-primary btn-sm" data-ac-action="completed" data-ac-id="' + escapeHtml(task.id) + '">Mark done</button><button type="button" class="ac-dismiss" data-ac-action="dismissed" data-ac-id="' + escapeHtml(task.id) + '">Dismiss suggestion</button>' : ''}
      ${task.status !== 'open' && canWrite ? '<button type="button" class="ac-link-btn" data-ac-action="open" data-ac-id="' + escapeHtml(task.id) + '">Reopen</button>' : ''}
    </div>
  </article>`;
}

export function renderActionCentre(container, { leads = [], api, workspaceSession = null, isPreview = false, toast = () => {}, onOpenLead = () => {} }) {
  const role = workspaceSession?.workspace?.role || 'viewer';
  const canWrite = isPreview || ['owner', 'admin', 'sales'].includes(role);
  let tasks = [];
  let channelStates = [
    { channel_key: 'whatsapp', display_name: 'WhatsApp Business', status: 'not_connected' },
    { channel_key: 'email_gmail', display_name: 'Gmail', status: 'not_connected' },
    { channel_key: 'email_outlook', display_name: 'Outlook / Microsoft 365', status: 'not_connected' }
  ];
  let activeFilter = 'open';
  let search = '';
  let loading = true;

  container.innerHTML = `
    <section class="ac-workspace">
      <div class="ac-hero">
        <div><div class="ac-overline">STAYPILOT ACTION CENTRE</div><h2>Know what needs doing next.</h2><p>Tasks from your CRM and connected conversations, with evidence attached so the team can verify before acting.</p></div>
        <div class="ac-hero-actions"><span class="ac-mode ${isPreview ? 'ac-mode-preview' : 'ac-mode-live'}">${isPreview ? 'TEST / SAMPLE DATA' : 'WORKSPACE RECORDS'}</span><button class="btn btn-secondary" id="ac-refresh">↻ Scan records</button><button class="btn btn-primary" id="ac-add-toggle">＋ Add task</button></div>
      </div>
      ${isPreview ? '<div class="ac-test-note"><b>Testing mode:</b> sample CRM records and clearly labelled example messages only. Changes stay in this preview session and no inbox is accessed.</div>' : ''}
      <div class="ac-metrics"><div><span>Open actions</span><b id="ac-open-count">—</b></div><div><span>Overdue</span><b id="ac-overdue-count">—</b></div><div><span>Conversation suggestions</span><b id="ac-conversation-count">—</b></div><div><span>Unassigned</span><b id="ac-unassigned-count">—</b></div></div>
      <section class="ac-add-panel hidden" id="ac-add-panel"><form id="ac-add-form"><label>Task title<input name="title" required minlength="3" maxlength="180" placeholder="e.g. Confirm revised room block"></label><label>Owner<input name="assigned_to" maxlength="120" placeholder="Unassigned"></label><label>Due date<input name="due_at" type="datetime-local"></label><label class="ac-add-wide">Notes / context<textarea name="description" maxlength="1000" rows="2" placeholder="What needs to happen, and any context…"></textarea></label><label>Link to inquiry<select name="lead_id"><option value="">No linked inquiry</option>${leads.filter(lead => !['Confirmed','Lost'].includes(lead.status)).map(lead => '<option value="' + escapeHtml(lead.id) + '">' + escapeHtml((lead.company_name || lead.client_name) + ' · ' + lead.property_name) + '</option>').join('')}</select></label><div class="ac-add-actions"><button type="button" class="btn btn-secondary" id="ac-add-cancel">Cancel</button><button type="submit" class="btn btn-primary" id="ac-add-save">Save task</button></div></form></section>
      <div class="ac-source-grid" id="ac-source-grid"><div class="ac-source-title"><div><b>Conversation sources</b><p>Only connected sources can contribute message-derived suggestions.</p></div><span class="ac-muted">STATUS IS VERIFIED BY THE API</span></div><div class="ac-source-cards" id="ac-source-cards"></div></div>
      <section class="ac-queue">
        <div class="ac-queue-head"><div><h2>Action queue</h2><p id="ac-queue-caption">Loading saved tasks and suggestions…</p></div><div class="ac-search"><span>⌕</span><input id="ac-search" placeholder="Search tasks or evidence" aria-label="Search Action Centre tasks"></div></div>
        <div class="ac-filter-row"><button class="ac-filter is-active" data-ac-filter="open">Open</button><button class="ac-filter" data-ac-filter="overdue">Overdue</button><button class="ac-filter" data-ac-filter="conversation">From conversations</button><button class="ac-filter" data-ac-filter="completed">Completed</button><button class="ac-filter" data-ac-filter="dismissed">Dismissed</button></div>
        <div id="ac-task-list" class="ac-task-list"><div class="ac-empty">Loading actions…</div></div>
        <div class="ac-footnote">A suggestion is not proof that a client requested something or that a hotel action occurred. Open its evidence, verify dates / rates / inventory with the system of record, and only mark an action complete when the outcome is confirmed.</div>
      </section>
    </section>`;

  const getTaskList = () => {
    let filtered = [...tasks];
    if (activeFilter === 'open') filtered = filtered.filter(task => task.status === 'open');
    if (activeFilter === 'overdue') filtered = filtered.filter(task => task.status === 'open' && isOverdue(task));
    if (activeFilter === 'conversation') filtered = filtered.filter(task => task.status === 'open' && task.source_type === 'conversation_rule');
    if (activeFilter === 'completed') filtered = filtered.filter(task => task.status === 'completed');
    if (activeFilter === 'dismissed') filtered = filtered.filter(task => task.status === 'dismissed');
    if (search) {
      const term = search.toLowerCase();
      filtered = filtered.filter(task => [task.title, task.description, task.assigned_to, task.evidence_text, task.company_name, task.client_name, task.property_name]
        .some(value => String(value || '').toLowerCase().includes(term)));
    }
    return filtered;
  };

  const paintSources = () => {
    const names = {
      whatsapp: { label: 'WhatsApp Business', note: 'Meta webhook events' },
      email_gmail: { label: 'Gmail', note: 'Mailbox sync / OAuth' },
      email_outlook: { label: 'Outlook / Microsoft 365', note: 'Mailbox sync / OAuth' }
    };
    const holder = container.querySelector('#ac-source-cards');
    if (!holder) return;
    holder.innerHTML = channelStates.map(channel => {
      const info = names[channel.channel_key] || { label: channel.display_name || channel.channel_key, note: '' };
      const status = channel.status || 'not_connected';
      const live = status === 'inbound_active' || status === 'connected';
      const label = live ? 'Connected' : status === 'error' ? 'Needs attention' : status === 'pending' ? 'Setup in progress' : 'Not connected';
      const note = status === 'error' ? (channel.last_error_code || 'Check provider configuration') :
        channel.last_synced_at ? 'Last sync ' + dateLabel(channel.last_synced_at) :
        channel.last_webhook_at ? 'Last inbound event ' + dateLabel(channel.last_webhook_at) : info.note;
      return '<article class="ac-source-card"><div class="ac-source-name"><span class="ac-source-icon ' + escapeHtml(channel.channel_key) + '">' +
        escapeHtml(channel.channel_key === 'whatsapp' ? 'W' : channel.channel_key === 'email_gmail' ? 'G' : 'O') +
        '</span><div><b>' + escapeHtml(info.label) + '</b><small>' + escapeHtml(note) + '</small></div></div><span class="ac-connection-state ' +
        (live ? 'connected' : status === 'error' ? 'error' : '') + '">' + escapeHtml(label) + '</span></article>';
    }).join('');
  };

  const paint = () => {
    const open = tasks.filter(task => task.status === 'open');
    container.querySelector('#ac-open-count').textContent = String(open.length);
    container.querySelector('#ac-overdue-count').textContent = String(open.filter(isOverdue).length);
    container.querySelector('#ac-conversation-count').textContent = String(open.filter(task => task.source_type === 'conversation_rule').length);
    container.querySelector('#ac-unassigned-count').textContent = String(open.filter(task => !task.assigned_to || task.assigned_to.toLowerCase() === 'unassigned').length);
    container.querySelector('#ac-queue-caption').textContent = loading ? 'Refreshing suggestions…' : getTaskList().length + ' task(s) in this view · ' + tasks.length + ' loaded';
    const taskList = container.querySelector('#ac-task-list');
    const list = getTaskList();
    taskList.innerHTML = list.length ? list.map(task => renderTask(task, { isPreview, canWrite })).join('') :
      '<div class="ac-empty"><b>' + (activeFilter === 'open' ? 'Nothing in this queue' : 'No matching tasks') + '</b><p>Scan connected records or change the filter. Tasks are suggestions until someone verifies them.</p></div>';
    container.querySelectorAll('[data-ac-filter]').forEach(button => button.classList.toggle('is-active', button.dataset.acFilter === activeFilter));
    paintSources();
  };

  const loadTasks = async ({ scan = false } = {}) => {
    loading = true; paint();
    if (isPreview) {
      tasks = buildPreviewTasks(leads);
      channelStates = [
        { channel_key: 'whatsapp', display_name: 'WhatsApp Business', status: 'not_connected', last_error_code: 'Sample messages only' },
        { channel_key: 'email_gmail', display_name: 'Gmail', status: 'not_connected', last_error_code: 'Not connected in testing preview' },
        { channel_key: 'email_outlook', display_name: 'Outlook / Microsoft 365', status: 'not_connected', last_error_code: 'Not connected in testing preview' }
      ];
      loading = false; paint(); return;
    }
    try {
      if (scan && canWrite) await api('/action-centre/refresh', { method: 'POST', body: JSON.stringify({}) });
      const response = await api('/action-centre/tasks?status=all');
      tasks = Array.isArray(response.tasks) ? response.tasks : [];
      channelStates = Array.isArray(response.channels) ? response.channels : channelStates;
    } catch (error) {
      toast('Action Centre could not load: ' + (error.message || 'request failed'), true);
      tasks = [];
    } finally { loading = false; paint(); }
  };

  container.querySelector('#ac-refresh').addEventListener('click', () => {
    if (isPreview) { toast('Testing preview refreshed from sample data. No live inbox was accessed.'); void loadTasks(); return; }
    if (!canWrite) { toast('Your workspace role can view actions but cannot run a scan.', true); return; }
    void loadTasks({ scan: true });
  });
  container.querySelector('#ac-add-toggle').addEventListener('click', () => {
    const panel = container.querySelector('#ac-add-panel');
    panel.classList.toggle('hidden');
    if (!panel.classList.contains('hidden')) panel.querySelector('[name="title"]').focus();
  });
  container.querySelector('#ac-add-cancel').addEventListener('click', () => container.querySelector('#ac-add-panel').classList.add('hidden'));
  container.querySelector('#ac-add-form').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const input = {
      title: String(formData.get('title') || '').trim(),
      description: String(formData.get('description') || '').trim(),
      assigned_to: String(formData.get('assigned_to') || '').trim() || 'Unassigned',
      lead_id: String(formData.get('lead_id') || '') || null,
      due_at: formData.get('due_at') ? new Date(String(formData.get('due_at'))).toISOString() : null
    };
    const button = container.querySelector('#ac-add-save');
    button.disabled = true;
    try {
      if (isPreview) {
        const id = 'preview-manual-' + (++manualPreviewCounter);
        previewState.set(id, { id, task_key: id, source_type: 'manual', category: 'other', priority: 'normal', status: 'open',
          evidence_channel: 'manual', evidence_text: 'Temporary task created in the sample testing session.', confidence: 'high', due_at: input.due_at,
          lead_id: input.lead_id, assigned_to: input.assigned_to, title: input.title, description: input.description });
      } else {
        await api('/action-centre/tasks', { method: 'POST', body: JSON.stringify(input) });
      }
      form.reset(); container.querySelector('#ac-add-panel').classList.add('hidden');
      toast(isPreview ? 'Temporary testing task added to this preview session.' : 'Task saved to the workspace.');
      await loadTasks();
    } catch (error) {
      toast('Could not save task: ' + error.message, true);
    } finally { button.disabled = false; }
  });
  container.querySelector('#ac-search').addEventListener('input', event => { search = event.target.value || ''; paint(); });
  container.querySelectorAll('[data-ac-filter]').forEach(button => button.addEventListener('click', () => { activeFilter = button.dataset.acFilter; paint(); }));
  container.addEventListener('click', async event => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionButton = target.closest('[data-ac-action]');
    const leadButton = target.closest('[data-ac-lead]');
    if (leadButton) { onOpenLead(leadButton.dataset.acLead); return; }
    if (!actionButton) return;
    const id = actionButton.dataset.acId;
    const status = actionButton.dataset.acAction;
    if (!id || !status) return;
    actionButton.setAttribute('disabled', 'disabled');
    try {
      if (isPreview) {
        const entry = [...previewState.entries()].find(([, value]) => value.id === id);
        if (entry) previewState.set(entry[0], { ...entry[1], status });
      } else {
        await api('/action-centre/tasks/' + encodeURIComponent(id) + '/status', { method: 'POST', body: JSON.stringify({ status }) });
      }
      await loadTasks();
      toast(status === 'completed' ? 'Task marked complete. Confirm the outcome is recorded.' : status === 'dismissed' ? 'Suggestion dismissed.' : 'Task reopened.');
    } catch (error) {
      toast('Could not update task: ' + error.message, true);
      actionButton.removeAttribute('disabled');
    }
  });

  paint();
  void loadTasks({ scan: !isPreview && canWrite });
}
