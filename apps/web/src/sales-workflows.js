const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));

const playbooks = [
  {
    id: "corporate",
    title: "Corporate stay",
    match: "Corporate stay",
    purpose: "Qualify the stay and gather the details needed for a verified proposal.",
    steps: [
      "Verify requested dates, room count, guest count and the correct property.",
      "Confirm meeting-room, billing, rate-plan and special requirements with the client.",
      "Ask the hotel team to verify live inventory and approved pricing before a proposal is sent.",
      "Set one accountable owner and a dated next action."
    ],
    subject: "Following up on your corporate stay enquiry",
    body: lead => `Hello ${lead.client_name || "[verify contact name]"},

Thank you for contacting ${lead.property_name || "[verify property]"} about ${lead.company_name || "[verify organisation]"}'s corporate stay.

To help us prepare an accurate proposal, could you confirm the requested dates, number of rooms, approximate guest count, any meeting-room requirements, and billing or rate-plan needs?

Our team will verify availability, facilities and approved pricing before making a proposal. This message does not confirm inventory or a rate.

Regards,
[Your name]
Hotel Sales Team`
  },
  {
    id: "wedding",
    title: "Wedding / social event",
    match: "Wedding / social event",
    purpose: "Capture event requirements and coordinate a venue review without promising capacity or availability.",
    steps: [
      "Verify event date(s), event format, guest count and the property requested.",
      "Confirm which spaces, room block, food and beverage, AV and setup are required.",
      "Ask the events team to verify availability, capacity, package terms and pricing.",
      "Arrange a site visit only after the relevant team confirms a suitable slot."
    ],
    subject: "Next steps for your event enquiry",
    body: lead => `Hello ${lead.client_name || "[verify contact name]"},

Thank you for considering ${lead.property_name || "[verify property]"} for ${lead.company_name || "your event"}.

To coordinate the right options, could you confirm the event date, event format, expected guest count, room-block needs, preferred function spaces, and any food, beverage or AV requirements?

Our events team will verify the relevant spaces, availability, capacity and approved package terms before sharing options. No date, space or price is reserved by this email.

Regards,
[Your name]
Hotel Events Sales Team`
  },
  {
    id: "mice",
    title: "MICE / conference",
    match: "MICE / conference",
    purpose: "Gather the requirements that affect conference setup and a reliable commercial proposal.",
    steps: [
      "Verify event dates, attendee count, room block and required meeting spaces.",
      "Confirm AV, catering, breakout rooms, setup and billing requirements.",
      "Have the hotel team validate inventory, venue capacity and approved commercial terms.",
      "Set a next action and owner for the proposal review."
    ],
    subject: "Details needed for your meeting or conference enquiry",
    body: lead => `Hello ${lead.client_name || "[verify contact name]"},

Thank you for your enquiry to ${lead.property_name || "[verify property]"} regarding ${lead.company_name || "your meeting or conference"}.

To help our team prepare a suitable proposal, please confirm the event dates, attendee count, room-block requirements, meeting-room setup, AV, catering, breakout-room needs and billing requirements.

Our team will verify venue availability, capacity, room inventory and approved pricing before we make an offer. This email is not a booking or availability confirmation.

Regards,
[Your name]
Hotel Sales Team`
  },
  {
    id: "general",
    title: "Other / leisure group",
    match: "Other",
    purpose: "Clarify what the guest or organiser needs before making a promise.",
    steps: [
      "Confirm the correct property, dates, guest count and contact channel.",
      "Ask for any specific accommodation, event or accessibility requirements.",
      "Verify inventory, applicable terms and pricing with the authorised hotel team.",
      "Assign an owner and a dated follow-up."
    ],
    subject: "Following up on your hotel enquiry",
    body: lead => `Hello ${lead.client_name || "[verify contact name]"},

Thank you for your enquiry to ${lead.property_name || "[verify property]"}.

Could you confirm your requested dates, guest or room count, and any specific requirements? This will help our team review the correct options.

Availability and pricing will be checked by the hotel team before a proposal is shared. No reservation, rate or inventory is confirmed by this message.

Regards,
[Your name]
Hotel Sales Team`
  }
];

function choosePlaybook(lead) {
  const type = String(lead?.inquiry_type || "").toLowerCase();
  if (type.includes("wedding") || type.includes("social")) return "wedding";
  if (type.includes("mice") || type.includes("conference") || type.includes("meeting")) return "mice";
  if (type.includes("corporate")) return "corporate";
  return "general";
}

function activeLeads(leads) {
  return [...leads].filter(lead => !["Confirmed", "Lost"].includes(lead.status)).sort((a, b) => {
    const at = a.next_follow_up ? new Date(a.next_follow_up).getTime() : Number.POSITIVE_INFINITY;
    const bt = b.next_follow_up ? new Date(b.next_follow_up).getTime() : Number.POSITIVE_INFINITY;
    const aDue = Number.isFinite(at) && at <= Date.now();
    const bDue = Number.isFinite(bt) && bt <= Date.now();
    if (aDue !== bDue) return aDue ? -1 : 1;
    return String(a.created_at || "").localeCompare(String(b.created_at || ""));
  });
}

function localDefaultFollowUp() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(10, 0, 0, 0);
  const pad = n => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function dueLabel(lead) {
  if (!lead.next_follow_up) return "No follow-up set";
  const time = new Date(lead.next_follow_up).getTime();
  if (!Number.isFinite(time)) return "Follow-up date needs review";
  if (time < Date.now()) return "Overdue · " + new Date(lead.next_follow_up).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  if (time < Date.now() + 86400000) return "Due soon · " + new Date(lead.next_follow_up).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return "Next action · " + new Date(lead.next_follow_up).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

function dataChecks(lead) {
  const missing = [];
  if (!lead.client_email && !lead.client_phone) missing.push("No client email or phone is recorded.");
  if (!lead.property_name) missing.push("Property is missing.");
  if (!lead.check_in) missing.push("Requested start / arrival date is missing.");
  if (!lead.check_out) missing.push("Requested end / departure date is missing.");
  if (!Number(lead.guests)) missing.push("Guest or room count is missing.");
  if (!lead.assigned_to || lead.assigned_to === "Unassigned") missing.push("No sales owner is assigned.");
  if (Array.isArray(lead.duplicate_candidates) && lead.duplicate_candidates.length) missing.push("Possible overlapping inquiry: review it before quoting or treating this as a separate booking.");
  if (lead.status === "Confirmed") missing.push("This inquiry is already marked confirmed. Do not send a sales follow-up.");
  return missing;
}

export function renderSalesWorkflow(box, { leads, api, workspaceSession, isPreview, toast, onUpdated }) {
  let selectedId = activeLeads(leads)[0]?.id || leads[0]?.id || "";
  let selectedPlaybook = selectedId ? choosePlaybook(leads.find(lead => lead.id === selectedId)) : "general";
  let reviewed = false;
  let draftOverride = false;
  let currentDraft = "";
  const canWrite = !isPreview && ["owner", "admin", "sales"].includes(workspaceSession?.workspace?.role);

  function render() {
    const work = activeLeads(leads);
    const lead = leads.find(item => item.id === selectedId) || work[0] || leads[0] || null;
    if (lead && lead.id !== selectedId) {
      selectedId = lead.id;
      selectedPlaybook = choosePlaybook(lead);
    }
    const playbook = playbooks.find(item => item.id === selectedPlaybook) || playbooks[3];
    const checks = lead ? dataChecks(lead) : [];
    const draft = lead ? playbook.body(lead) : "";
    currentDraft = draft;
    reviewed = false;
    draftOverride = false;

    const queueHtml = work.length ? work.map(item => {
      const due = item.next_follow_up && new Date(item.next_follow_up).getTime() <= Date.now();
      const duplicates = Array.isArray(item.duplicate_candidates) ? item.duplicate_candidates.length : 0;
      return '<button type="button" class="wf-queue-item ' + (item.id === lead?.id ? "active" : "") + '" data-wf-lead="' + esc(item.id) + '">' +
        '<div class="wf-queue-top"><b>' + esc(item.client_name || "Unnamed contact") + '</b><span class="wf-stage">' + esc(item.status || "New inquiry") + '</span></div>' +
        '<div class="wf-queue-company">' + esc(item.company_name || "Company not recorded") + ' · ' + esc(item.inquiry_type || "Type unknown") + '</div>' +
        '<div class="wf-queue-bottom"><span class="' + (due ? "wf-overdue" : "wf-muted") + '">' + esc(dueLabel(item)) + '</span>' +
        (duplicates ? '<span class="wf-warning-chip">Review overlap</span>' : '') + '</div></button>';
    }).join("") : '<div class="empty-state"><b>No open inquiries</b><p>There are no active leads in this workspace.</p></div>';

    box.innerHTML = '<div class="wf-banner"><div class="wf-banner-icon">✓</div><div><b>Workflow desk · prepare once, verify before acting</b><p>StayPilot organises the next action, drafts a response from approved text and schedules a reminder. It does not send messages, promise a rate, check live inventory or confirm a booking.</p></div></div>' +
      '<div class="wf-summary"><div><small>OPEN ENQUIRIES</small><b>' + work.length + '</b></div><div><small>FOLLOW-UP OVERDUE</small><b>' + work.filter(item => item.next_follow_up && new Date(item.next_follow_up).getTime() < Date.now()).length + '</b></div><div><small>NEED DATA / OVERLAP REVIEW</small><b>' + work.filter(item => dataChecks(item).length).length + '</b></div></div>' +
      '<div class="wf-layout"><aside class="wf-queue"><div class="wf-section-head"><div><h2>Work queue</h2><p>Sorted by overdue follow-up first.</p></div></div><div class="wf-queue-list">' + queueHtml + '</div></aside>' +
      '<section class="wf-workarea">' + (lead ? (
        '<div class="wf-record-head"><div><div class="wf-eyebrow">SELECTED INQUIRY</div><h2>' + esc(lead.client_name || "Unnamed contact") + '</h2><p>' + esc(lead.company_name || "Company not recorded") + ' · ' + esc(lead.property_name || "Property not recorded") + '</p></div><span class="wf-stage">' + esc(lead.status || "New inquiry") + '</span></div>' +
        '<div class="wf-fact-grid"><div><small>TYPE</small><b>' + esc(lead.inquiry_type || "Not recorded") + '</b></div><div><small>DATES</small><b>' + esc(lead.check_in || "Start date missing") + ' → ' + esc(lead.check_out || "End date missing") + '</b></div><div><small>GUESTS / ROOMS</small><b>' + esc(Number(lead.guests) ? String(lead.guests) : "Not recorded") + '</b></div><div><small>OWNER</small><b>' + esc(lead.assigned_to || "Unassigned") + '</b></div></div>' +
        '<div class="wf-section-head"><div><h3>1. Pick a playbook</h3><p>Hotel-specific steps; no invented rates or availability.</p></div><select id="wf-playbook" aria-label="Choose sales playbook">' + playbooks.map(item => '<option value="' + item.id + '" ' + (item.id === playbook.id ? "selected" : "") + '>' + esc(item.title) + '</option>').join("") + '</select></div>' +
        '<div class="wf-playbook-intro"><b>' + esc(playbook.purpose) + '</b><ol>' + playbook.steps.map(step => '<li>' + esc(step) + '</li>').join("") + '</ol></div>' +
        '<div class="wf-section-head"><div><h3>2. Check the record</h3><p>Missing information and possible overlaps are warnings, not assumptions.</p></div></div>' +
        '<div class="wf-checks">' + (checks.length ? checks.map(item => '<div class="wf-check"><span>!</span><p>' + esc(item) + '</p></div>').join("") : '<div class="wf-clear"><span>✓</span><p>No missing fields detected by basic checks. This is not proof that the information is correct.</p></div>') + '</div>' +
        '<div class="wf-section-head"><div><h3>3. Review a message draft</h3><p>Only uses the contact and property names on this record.</p></div><span class="wf-review-tag">Approval required</span></div>' +
        '<label class="wf-field-label" for="wf-subject">Email subject</label><input id="wf-subject" class="wf-subject" maxlength="200" value="' + esc(playbook.subject) + '">' +
        '<label class="wf-field-label" for="wf-draft">Draft body</label><textarea id="wf-draft" class="wf-draft" rows="12" maxlength="10000">' + esc(draft) + '</textarea>' +
        '<label class="wf-review-check"><input type="checkbox" id="wf-reviewed"><span>I have verified the recipient, property, dates / guest count and duplicate warnings, and checked that this draft makes no unapproved commitment.</span></label>' +
        '<div class="wf-actions"><button type="button" class="btn btn-secondary" data-wf-action="copy-draft">Copy reviewed draft</button><div class="wf-reminder"><label for="wf-reminder-date">Next follow-up</label><input id="wf-reminder-date" type="datetime-local" value="' + localDefaultFollowUp() + '"><button type="button" class="btn btn-primary" data-wf-action="save-reminder" ' + (canWrite ? "" : "disabled") + '>Save reminder</button></div></div>' +
        '<p class="wf-footnote">' + (isPreview ? 'Preview mode: reminders are not saved. You can still inspect and copy sample drafts.' : canWrite ? 'Saving a reminder updates the inquiry’s next-follow-up field only. It does not create a multi-step timer or send a message.' : 'Your role can review drafts but cannot save reminders.') + '</p>'
      ) : '<div class="empty-state"><b>Select an inquiry to start</b><p>Open an active inquiry to prepare its next action.</p></div>') + '</section></div>';

    const playbookSelect = $("#wf-playbook", box);
    if (playbookSelect) playbookSelect.addEventListener("change", () => {
      selectedPlaybook = playbookSelect.value;
      reviewed = false;
      render();
    });
    const reviewCheck = $("#wf-reviewed", box);
    if (reviewCheck) reviewCheck.addEventListener("change", () => { reviewed = reviewCheck.checked; });
    const draftEl = $("#wf-draft", box);
    if (draftEl) draftEl.addEventListener("input", () => { currentDraft = draftEl.value; draftOverride = true; if ($("#wf-reviewed", box)) $("#wf-reviewed", box).checked = false; reviewed = false; });
    const subjectEl = $("#wf-subject", box);
    if (subjectEl) subjectEl.addEventListener("input", () => { draftOverride = true; if ($("#wf-reviewed", box)) $("#wf-reviewed", box).checked = false; reviewed = false; });
  }

  box.addEventListener("click", async event => {
    const leadButton = event.target.closest("[data-wf-lead]");
    const action = event.target.closest("[data-wf-action]");
    if (leadButton) {
      selectedId = leadButton.dataset.wfLead;
      const chosenLead = leads.find(item => item.id === selectedId);
      selectedPlaybook = choosePlaybook(chosenLead);
      render();
      return;
    }
    if (!action) return;
    const lead = leads.find(item => item.id === selectedId);
    if (!lead) return;
    if (action.dataset.wfAction === "copy-draft") {
      if (["Confirmed", "Lost"].includes(lead.status)) {
        toast("This inquiry is marked closed; no sales follow-up draft can be copied.", true);
        return;
      }
      const checkbox = $("#wf-reviewed", box);
      if (!checkbox?.checked) {
        toast("Review the contact, property, dates / guest count and warnings, then tick the approval checkbox.", true);
        return;
      }
      const subject = $("#wf-subject", box)?.value.trim() || "";
      const body = $("#wf-draft", box)?.value.trim() || "";
      if (!subject || !body) {
        toast("Subject and draft body are required.", true);
        return;
      }
      try {
        await navigator.clipboard.writeText("Subject: " + subject + "\n\n" + body);
        toast("Reviewed draft copied. Nothing was sent.");
      } catch {
        toast("Clipboard access was blocked. Select the draft and copy it manually.", true);
      }
      return;
    }
    if (action.dataset.wfAction === "save-reminder") {
      if (!canWrite) {
        toast(isPreview ? "Preview mode: reminders are not saved." : "Your role cannot save reminders.", true);
        return;
      }
      const input = $("#wf-reminder-date", box);
      const picked = input?.value ? new Date(input.value) : null;
      if (!picked || Number.isNaN(picked.getTime()) || picked.getTime() <= Date.now()) {
        toast("Choose a valid future follow-up time.", true);
        return;
      }
      if (["Confirmed", "Lost"].includes(lead.status)) {
        toast("Closed opportunities cannot be scheduled for a sales follow-up.", true);
        return;
      }
      action.disabled = true;
      action.textContent = "Saving…";
      try {
        const result = await api("/leads/update", {
          method: "POST",
          body: JSON.stringify({ id: lead.id, next_follow_up: picked.toISOString() })
        });
        const updated = result.lead;
        const index = leads.findIndex(item => item.id === lead.id);
        if (index >= 0) leads[index] = { ...leads[index], ...updated };
        toast("Follow-up reminder saved. No message was sent.");
        if (onUpdated) await onUpdated();
        else render();
      } catch (error) {
        toast("Reminder was not saved: " + (error?.message || "request failed"), true);
      } finally {
        if (action.isConnected) action.disabled = false;
      }
    }
  });

  render();
}
