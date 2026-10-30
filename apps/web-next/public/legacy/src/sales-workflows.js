export function renderSalesWorkflow(container, { leads = [], isPreview = false }) {
  const items = [
    ["Confirm the request", "Check dates, room or guest count, property and contact details."],
    ["Review potential overlaps", "Compare similar names, companies and date ranges before quoting."],
    ["Assign an owner", "Make sure one team member is responsible for the next action."],
    ["Record the next follow-up", "Set a clear date and capture the latest client context."],
  ];
  const leadCount = leads.length;
  container.innerHTML = `
    <div class="workflow-card">
      <div class="workflow-eyebrow">STAYPILOT PLAYBOOK</div>
      <h2>From inquiry to confident next step</h2>
      <p>Use the same review sequence for every hotel inquiry. These prompts do not send messages, confirm bookings or change records.</p>
      <div class="workflow-context">${leadCount} inquiry record${leadCount === 1 ? "" : "s"} currently available${isPreview ? " in read-only preview" : ""}.</div>
      <ol class="workflow-steps">
        ${items.map(([title, detail]) => `<li><span class="workflow-step-mark">✓</span><div><strong>${title}</strong><p>${detail}</p></div></li>`).join("")}
      </ol>
      <p class="workflow-footnote">Always verify availability, pricing and booking terms in the hotel's source of truth before making a commitment.</p>
    </div>`;
}
