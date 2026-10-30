import { apiRequest, getActiveWorkspaceId, setActiveWorkspaceId } from './lib/api.js';
import { waitForAuthReady, signOut } from './lib/auth.js';
import { renderSalesWorkflow } from './sales-workflows.js';
import { renderActionCentre } from './action-centre.js';

const PREVIEW_MODE = new URLSearchParams(window.location.search).get("preview") === "1";
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
let leads=[],currentView="overview",searchTerm="",toastTimer,workspaceSession=null,actionCentreConversationOpener=null;
const demoDate = days => new Date(Date.now() + days * 86400000).toISOString();
const demoDay = days => demoDate(days).slice(0, 10);
const demo = [
  {id:"demo-001",client_name:"Aarav Mehta",company_name:"Mehta & Co.",client_email:"aarav@example.test",client_phone:"+91 98••• 1201",agent_name:"Riya Travel",agent_email:"partner@example.test",property_name:"The LaLiT New Delhi",inquiry_type:"Corporate stay",check_in:demoDay(18),check_out:demoDay(21),guests:26,estimated_value:480000,source:"Travel agent",status:"Proposal sent",assigned_to:"Priya Sharma",last_contact_at:demoDate(-1),next_follow_up:demoDate(0),notes:"Quarterly leadership offsite; needs meeting room and 26 rooms.",created_at:demoDate(-5),updated_at:demoDate(-1)},
  {id:"demo-002",client_name:"Sana Kapoor",company_name:"Northstar Events",client_email:"sana@example.test",client_phone:"+91 98••• 7782",agent_name:"Northstar Events",agent_email:"events@example.test",property_name:"The LaLiT Mumbai",inquiry_type:"Wedding / social event",check_in:demoDay(34),check_out:demoDay(36),guests:140,estimated_value:1850000,source:"Direct inquiry",status:"Negotiation",assigned_to:"Dev Malhotra",last_contact_at:demoDate(-2),next_follow_up:demoDate(1),notes:"Wedding enquiry with overlapping room-block request.",created_at:demoDate(-6),updated_at:demoDate(-2)},
  {id:"demo-003",client_name:"Sana Kapoor",company_name:"Northstar Events",client_email:"sana.kapoor@example.test",client_phone:"+91 98••• 7782",agent_name:"Northstar Events",agent_email:"events@example.test",property_name:"The LaLiT Mumbai",inquiry_type:"Leisure group",check_in:demoDay(35),check_out:demoDay(37),guests:128,estimated_value:960000,source:"Partner referral",status:"New inquiry",assigned_to:"Priya Sharma",last_contact_at:null,next_follow_up:demoDate(0),notes:"Possible overlap with the event enquiry; review before quoting.",created_at:demoDate(-1),updated_at:demoDate(-1)},
  {id:"demo-004",client_name:"Kabir Singh",company_name:"Atlas Consulting",client_email:"kabir@example.test",client_phone:"+91 98••• 9931",agent_name:"Global Stays",agent_email:"global@example.test",property_name:"The LaLiT Jaipur",inquiry_type:"MICE / conference",check_in:demoDay(12),check_out:demoDay(14),guests:42,estimated_value:720000,source:"Corporate",status:"Contacted",assigned_to:"Dev Malhotra",last_contact_at:demoDate(-1),next_follow_up:demoDate(2),notes:"Annual strategy meeting; proposal requested.",created_at:demoDate(-3),updated_at:demoDate(-1)},
  {id:"demo-005",client_name:"Mira Shah",company_name:"Evergreen Mobility",client_email:"mira@example.test",client_phone:"+91 98••• 3014",agent_name:"—",agent_email:"",property_name:"The LaLiT Ashok Bengaluru",inquiry_type:"Corporate stay",check_in:demoDay(7),check_out:demoDay(10),guests:18,estimated_value:315000,source:"Website",status:"Confirmed",assigned_to:"Priya Sharma",last_contact_at:demoDate(-3),next_follow_up:demoDate(4),notes:"Example confirmed booking.",created_at:demoDate(-9),updated_at:demoDate(-3)}
];
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}function money(v){v=Number(v)||0;return v>=1e7?"₹"+(v/1e7).toFixed(1)+"Cr":v>=1e5?"₹"+(v/1e5).toFixed(v>=1e6?1:0)+"L":v>=1e3?"₹"+(v/1e3).toFixed(0)+"k":"₹"+v.toLocaleString("en-IN");}function dateShort(v){if(!v)return"—";const d=new Date(v);return isNaN(d)?"—":d.toLocaleDateString("en-IN",{day:"numeric",month:"short"});}function dateTime(v){if(!v)return"Not scheduled";const d=new Date(v);return isNaN(d)?"Not scheduled":d.toLocaleString("en-IN",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"});}function statusClass(s){return({"New inquiry":"s-new","Contacted":"s-contacted","Proposal sent":"s-proposal","Negotiation":"s-negotiation","Confirmed":"s-confirmed","Lost":"s-lost"})[s]||"s-new";}function initials(s){return String(s||"?").split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join("").toUpperCase();}
function toast(msg,error=false){const el=$("#toast");el.textContent=msg;el.classList.toggle("error",error);el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),3200);}
function detectDuplicates(list){const norm=v=>String(v||"").toLowerCase().replace(/[^a-z0-9]/g,"");return list.map(a=>({...a,duplicate_candidates:list.filter(b=>b.id!==a.id&&((norm(a.company_name)&&norm(a.company_name)===norm(b.company_name)&&a.check_in&&b.check_in&&a.check_in<=(b.check_out||b.check_in)&&b.check_in<=(a.check_out||a.check_in))||(norm(a.client_name)&&norm(a.client_name)===norm(b.client_name)&&a.property_name===b.property_name))).map(b=>({id:b.id,client_name:b.client_name,company_name:b.company_name,agent_name:b.agent_name,property_name:b.property_name,check_in:b.check_in,check_out:b.check_out,status:b.status,estimated_value:b.estimated_value}))}));}
async function api(path,opts={}) {
  if (PREVIEW_MODE) {
    const err = new Error("Read-only preview: changes are not sent to the API or saved.");
    err.status = 403;
    err.code = "preview_read_only";
    throw err;
  }
  const user = await waitForAuthReady();
  if (!user) {
    const err = new Error("Please sign in to continue.");
    err.status = 401;
    err.code = "unauthenticated";
    throw err;
  }
  const token = await user.getIdToken();
  return apiRequest(path, { ...opts, token });
}
function renderWorkspaceOptions(workspaces, selectedId="") {
  const select=$("#workspace-select");
  if(!select) return;
  select.replaceChildren();
  const placeholder=document.createElement("option");
  placeholder.value="";
  placeholder.textContent=workspaces.length?"Choose hotel workspace":"No workspaces yet";
  select.append(placeholder);
  for(const workspace of workspaces){
    const option=document.createElement("option");
    option.value=workspace.id;
    option.textContent=workspace.name+" · "+(workspace.access_status==="invited"?"Invitation":workspace.role);
    select.append(option);
  }
  select.value=workspaces.some(item=>item.id===selectedId)?selectedId:"";
  $("#workspace-meta").textContent=workspaces.length===1?"1 workspace available":workspaces.length+" workspaces available";
}

function showWorkspaceGate(message) {
  $("#sync-label").textContent="Workspace selection needed";
  $("#page-title").textContent="Choose your hotel workspace";
  $("#page-subtitle").textContent=message;
  ["#metrics",".priority-banner",".dashboard-grid",".leads-panel"].forEach(selector=>$(selector)?.classList.add("hidden"));
  $("#add-btn").disabled=true;
  $("#workspace-select")?.focus();
}

async function readWorkspaceDirectory() {
  const data=await api("/workspaces");
  return Array.isArray(data.workspaces)?data.workspaces:[];
}

async function loadLeads(){
  if (PREVIEW_MODE) {
    leads=detectDuplicates(demo.map(row=>({...row})));
    workspaceSession={user:{name:"StayPilot Preview",email:"preview@staypilot.demo"},workspace:{role:"viewer"}};
    $(".profile b").textContent=workspaceSession.user.name;
    $(".profile small").textContent="Read-only preview · sample data";
    $(".profile .avatar").textContent="SP";
    $(".avatar-small").textContent="SP";
    $("#sync-label").textContent="Read-only demo preview";
    $("#page-title").textContent="Good morning, Preview";
    $("#page-subtitle").textContent="You're viewing sample hotel-sales data. Changes are disabled and nothing is saved.";
    $("#add-btn").disabled=true;
    $("#add-btn").title="Disabled in the read-only preview";
    $("#workspace-select").innerHTML='<option value="">Public demo preview</option>';
    $("#workspace-select").disabled=true;
    $("#workspace-create-btn").hidden=true;
    if (!document.querySelector(".staypilot-preview-banner")) {
      const banner=document.createElement("div");
      banner.className="staypilot-preview-banner";
      banner.textContent="Preview mode · Demo records only · Sign-in and data changes are disabled";
      banner.style.cssText="margin:0 0 18px;padding:11px 14px;border:1px solid #e8d8b8;border-radius:9px;background:#fff9ec;color:#7b5d2d;font-size:12px;font-weight:650";
      document.querySelector(".content")?.prepend(banner);
    }
    render();
    return;
  }
  try {
    workspaceSession=await api("/session");
    const workspaceId=workspaceSession.workspace?.id||"";
    if(workspaceId) setActiveWorkspaceId(workspaceId);
    const directory=await readWorkspaceDirectory();
    renderWorkspaceOptions(directory,workspaceId);
    $("#workspace-select").disabled=directory.length<=1;
    $("#workspace-create-btn").hidden=false;

    const name=workspaceSession.user?.name||workspaceSession.user?.email||"Sales teammate";
    $(".profile b").textContent=name;
    $(".profile small").textContent=(workspaceSession.workspace?.role||"team member")+" · "+(directory.find(w=>w.id===workspaceId)?.name||"StayPilot");
    $(".profile .avatar").textContent=initials(name);
    $(".avatar-small").textContent=initials(name);
    if(currentView==="overview")$("#page-title").textContent="Good morning, "+String(name).split(/\s+/)[0];
    const d=await api("/leads/list");
    leads=Array.isArray(d.leads)?d.leads:[];
    $("#sync-label").textContent="Workspace synced";
    if(d.truncated)toast("Showing the most recent "+d.limit+" inquiries. Narrow the search or export data in batches for older records.");
  } catch(e) {
    leads=[];workspaceSession=null;
    if(e.status===401){location.replace("/login?next="+encodeURIComponent(location.pathname+location.search));return;}
    if(e.code==="workspace_selection_required" || e.code==="workspace_membership_required" || e.code==="member_disabled"){
      try{
        const directory=await readWorkspaceDirectory();
        renderWorkspaceOptions(directory,getActiveWorkspaceId());
        $("#workspace-create-btn").hidden=false;
        if(directory.length===1 && directory[0].id!==getActiveWorkspaceId()){
          setActiveWorkspaceId(directory[0].id);
          await loadLeads();
          return;
        }
        if(directory.length>0){
          showWorkspaceGate("Your account has access to more than one hotel workspace. Select the workspace you want to work in; records remain separated.");
        }else{
          $("#workspace-meta").textContent="Create your first workspace";
          showWorkspaceGate("Your account does not have a hotel workspace yet. Create one to start capturing inquiries and inviting your sales team.");
        }
        return;
      }catch{
        $("#sync-label").textContent="Workspace list unavailable";
      }
    }
    if(e.status===403){
      $("#sync-label").textContent="Workspace access required";
      $("#page-title").textContent="Access needs approval";
      $("#page-subtitle").textContent=e.message||"Ask the workspace owner to invite this email.";
      $("#metrics").classList.add("hidden");
      $(".priority-banner").classList.add("hidden");
      $(".dashboard-grid").classList.add("hidden");
      toast("Your account is not yet authorized for this workspace.",true);
    }else{
      $("#sync-label").textContent="Connection issue";
      toast("Could not load the sales workspace. No sample records were substituted.",true);
    }
  }
  leads=detectDuplicates(leads);
  render();
}
function openView(view){if(view!=="inbox")actionCentreConversationOpener=null;currentView=view;$$(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.view===view));const titles={overview:"Overview",inbox:"Unified inbox",channels:"Channels & integrations",leads:"All inquiries",duplicates:"Duplicate intelligence",followups:"Follow-up queue",workflows:"Guided workflows",agents:"Agent network",pipeline:"Sales pipeline",reports:"Reports & insights","action-centre":"Action Centre"};$("#crumb-title").textContent=titles[view]||"Overview";$("#page-title").textContent=({overview:"Good morning, Priya ✳",inbox:"Every conversation. One shared context.",channels:"Connect the channels your team already uses.",leads:"Every inquiry, in one place",duplicates:"Resolve overlap. Protect opportunity.",followups:"Nothing important slips through.",workflows:"Turn hotel enquiries into consistent next steps.",agents:"Your agent network",pipeline:"See every deal move forward",reports:"Sales performance, made visible","action-centre":"Know what needs doing next"})[view]||titles[view];$("#page-subtitle").textContent=({overview:"A clearer picture of every opportunity across your portfolio.",inbox:"Review imported conversations, link inquiries and capture internal notes across connected channels.",channels:"See what each connection needs, what data it should sync, and which integrations are still pending.",leads:"Search, review and manage the full hotel sales pipeline.",duplicates:"Potential overlaps surfaced for your team to review — never auto-merged.",followups:"A focused queue of next actions for the sales team.",workflows:"Prepare hotel-specific follow-ups, validate key details and set the next reminder. Nothing is sent automatically.",agents:"Understand the partners behind your hotel inquiries.",pipeline:"A shared view of deal stages, ownership and estimated value.",reports:"A practical snapshot of lead quality, response and conversion.","action-centre":"Tasks suggested from CRM records and connected conversations, with evidence attached for verification."})[view]||"";const overview=view==="overview";$("#metrics").classList.toggle("hidden",!overview);$(".priority-banner").classList.toggle("hidden",!overview);$(".dashboard-grid").classList.toggle("hidden",!overview);$(".leads-panel").classList.toggle("hidden",!["overview","leads","duplicates","followups","pipeline"].includes(view));$("#extra-view")?.remove();if(view==="agents"||view==="reports"){const box=document.createElement("section");box.id="extra-view";box.className="view-placeholder";box.innerHTML=view==="agents"?'<div style="font-size:28px;color:#c6a36d">♧</div><h2>Agent relationship intelligence</h2><p>Review partner activity and opportunity history. This MVP groups agent activity from inquiry records; commission and attribution rules should be validated before adding them.</p><button class="btn btn-primary">Export agent summary →</button>':'<div style="font-size:28px;color:#c6a36d">▤</div><h2>Insights grounded in your pipeline</h2><p>Explore stage distribution, estimated value, overdue follow-ups and duplicate-review volume. Sample records are illustrative.</p><button class="btn btn-primary">Export report →</button>';$(".leads-panel").before(box);box.querySelector("button").addEventListener("click",exportCsv);}if(view==="inbox"||view==="channels")renderChannelWorkspace(view);if(view==="action-centre"){const box=document.createElement("section");box.id="extra-view";box.className="action-centre-shell";$(".leads-panel").before(box);renderActionCentre(box,{leads,api,workspaceSession,isPreview:PREVIEW_MODE,toast,onOpenLead:id=>openDetail(id),onOpenConversation:async id=>{openView("inbox");if(actionCentreConversationOpener)await actionCentreConversationOpener(id);}});}if(view==="workflows"){const box=document.createElement("section");box.id="extra-view";box.className="sales-workflow-workspace";$(".leads-panel").before(box);renderSalesWorkflow(box,{leads,api,workspaceSession,isPreview:PREVIEW_MODE,toast,onUpdated:async()=>{await loadLeads();openView("workflows");}});}render();window.scrollTo({top:0,behavior:"smooth"});}
const channelCatalog=[
{name:"WhatsApp Business",key:"whatsapp",detail:"Inbound business messages",priority:"P1",setup:"Connect an eligible Meta Business account, approve required permissions and subscribe the verified webhook."},
{name:"Gmail",key:"email_gmail",detail:"Read-only shared mailbox sync",priority:"P1",setup:"Connect a Google OAuth app in the approved provider integration settings. Google may require verification/security review for Gmail restricted scopes."},
{name:"Outlook / Microsoft 365",key:"email_outlook",detail:"Read-only shared mailbox sync",priority:"P1",setup:"Connect a Microsoft Entra app and grant delegated read permission; tenant policy may require admin consent."},
{name:"Phone calls",key:"phone",detail:"Manual call notes and callbacks",priority:"P1",setup:"Manual logging is supported as an internal note. Automatic call ingestion requires an approved telephony provider."},
{name:"Travel agents & corporate",key:"partner",detail:"Partner-submitted inquiries",priority:"P1",setup:"Issue a restricted partner API key and store it only in the partner server secret manager."},
{name:"Hotel website",key:"website",detail:"Protected direct inquiry intake",priority:"P1",setup:"Configure public Turnstile site key and private server-side secret in Setup, then embed /inquiry.html."},
{name:"Instagram messages",key:"instagram",detail:"Inbound professional-account messages",priority:"P2",setup:"Connect an eligible professional account, approve Meta permissions and subscribe to messaging webhooks."},
{name:"Facebook Messenger",key:"facebook",detail:"Inbound Page messages",priority:"P2",setup:"Connect an eligible Page, approve messaging permissions and subscribe to messaging webhooks."},
{name:"Booking.com",key:"booking_com",detail:"Reservation data where partner access permits",priority:"P2",setup:"Use a qualified connectivity partner/channel manager or an already-authorized partner account."},
{name:"Expedia",key:"expedia",detail:"Reservation data where partner access permits",priority:"P2",setup:"Requires approved Expedia partner access and a connected property account."},
{name:"Other OTAs / channel manager",key:"other_otas",detail:"Normalized partner feeds",priority:"P2",setup:"Connect a documented API or signed webhook only after the provider and permitted data scope are confirmed."},
{name:"Spreadsheet import",key:"spreadsheet",detail:"Validated, duplicate-aware import",priority:"P1",setup:"Use preview first, review possible matches, then explicitly confirm an import of up to 25 rows."},
{name:"Other messages",key:"other",detail:"Source-labelled internal context",priority:"P3",setup:"Use internal notes or define a source-specific integration before automating it."}
];
const channelTitles=Object.fromEntries(channelCatalog.map(c=>[c.key,c.name]));
const companyLogoCatalog={
  whatsapp:{alt:"WhatsApp",src:"https://cdn.simpleicons.org/whatsapp/25D366",className:"brand-whatsapp"},
  email_gmail:{alt:"Gmail",src:"https://cdn.simpleicons.org/gmail/EA4335",className:"brand-gmail"},
  email_outlook:{alt:"Microsoft Outlook",src:"https://cdn.simpleicons.org/microsoftoutlook/0078D4",className:"brand-outlook"},
  instagram:{alt:"Instagram",src:"https://cdn.simpleicons.org/instagram/E4405F",className:"brand-instagram"},
  facebook:{alt:"Facebook Messenger",src:"https://cdn.simpleicons.org/messenger/0866FF",className:"brand-messenger"},
  booking_com:{alt:"Booking.com",src:"https://cdn.simpleicons.org/bookingdotcom/003580",className:"brand-booking"},
  expedia:{alt:"Expedia",src:"https://cdn.simpleicons.org/expedia/191E3B",className:"brand-expedia"}
};
function companyLogoMarkup(key){
 const brand=companyLogoCatalog[key];
 if(!brand)return '<span class="integration-generic-icon" aria-hidden="true">'+esc(({phone:"☎",partner:"P",website:"⌂",other_otas:"↗",spreadsheet:"▤",other:"+"})[key]||"•")+'</span>';
 const initial=brand.alt.charAt(0);
 return '<img class="integration-company-logo '+brand.className+'" src="'+brand.src+'" alt="'+brand.alt+' logo" width="28" height="28" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'integration-generic-icon\',textContent:'+JSON.stringify(initial)+'}))">';
}
function timeLabel(value){if(!value)return"—";const d=new Date(value);return Number.isNaN(d.getTime())?"—":d.toLocaleString("en-IN",{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"});}
function parseCsvRows(text){
 if(typeof text!=="string"||text.length>1000000)throw new Error("CSV file must be smaller than 1 MB.");
 const matrix=[];let row=[],field="",quoted=false;
 for(let i=0;i<text.length;i++){
  const ch=text[i];
  if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"'){quoted=false;}else field+=ch;continue;}
  if(ch==='"'&&field.length===0){quoted=true;continue;}
  if(ch===","){row.push(field);field="";continue;}
  if(ch==="\n"||ch==="\r"){if(ch==="\r"&&text[i+1]==="\n")i++;row.push(field);field="";if(row.some(v=>String(v).trim()!==""))matrix.push(row);row=[];continue;}
  field+=ch;
 }
 if(quoted)throw new Error("CSV contains an unclosed quoted field.");
 if(field.length||row.length){row.push(field);if(row.some(v=>String(v).trim()!==""))matrix.push(row);}
 if(matrix.length<2)throw new Error("CSV needs a header row and at least one inquiry row.");
 const norm=v=>String(v||"").replace(/^\uFEFF/,"").trim().toLowerCase().replace(/[^a-z0-9]/g,"");
 const headers=matrix[0].map(norm);
 const aliases={
  client_name:["clientname","name","guestname","contactname","leadname"],
  company_name:["company","companyname","organisation","organization","account","companyorganisation"],
  client_email:["clientemail","contactemail","guestemail","email"],
  client_phone:["clientphone","phone","phonenumber","mobile","contactnumber"],
  agent_name:["agent","agentname","travelagent","partner","agency","partnername"],
  agent_email:["agentemail","partneremail","travelagentemail"],
  property_name:["property","propertyname","hotel","hotelname","hotelproperty"],
  inquiry_type:["inquirytype","type","eventtype","requirementtype"],
  check_in:["checkin","checkindate","startdate","eventstart","arrivaldate"],
  check_out:["checkout","checkoutdate","enddate","eventend","departuredate"],
  guests:["guests","guestcount","rooms","roomcount","pax"],
  estimated_value:["estimatedvalue","value","opportunityvalue","budget","estimatedrevenue"],
  assigned_to:["assignedto","owner","salesowner","assignedowner"],
  next_follow_up:["nextfollowup","followup","followupdate","nextactiondate"],
  notes:["notes","requirements","comments","description","specialrequirements"]
 };
 const mapped=[];
 for(let i=1;i<matrix.length;i++){
  const cells=matrix[i],obj={};
  for(const [key,names] of Object.entries(aliases)){
   const index=headers.findIndex(h=>names.includes(h));
   if(index>=0&&String(cells[index]||"").trim()!=="")obj[key]=String(cells[index]).trim();
  }
  mapped.push(obj);
 }
 if(mapped.length>25)throw new Error("Import batches are limited to 25 rows. Split this CSV into smaller batches and preview each batch.");
 return mapped;
}
async function renderChannelWorkspace(view){
 const box=document.createElement("section");box.id="extra-view";box.className="channel-workspace";
 if(view==="inbox"){
  box.innerHTML='<div class="channel-notice"><span class="notice-mark">i</span><div><b>Unified inbox</b><p>Imported conversations, provider message history, internal notes and inquiry links. Replies to external contacts are not enabled in this release.</p></div><button class="btn btn-secondary btn-sm" data-view="channels">Channels & setup →</button></div><div class="inbox-toolbar"><div class="inbox-tabs" role="group" aria-label="Filter conversations"><button class="inbox-tab active" data-channel-filter="all">All</button>'+channelCatalog.map(c=>'<button class="inbox-tab" data-channel-filter="'+esc(c.key)+'">'+esc(c.name)+'</button>').join("")+'</div><label class="inbox-search">⌕ <input id="inbox-search" placeholder="Search people, companies or messages…" aria-label="Search conversations"></label></div><div class="inbox-layout"><div class="conversation-list" id="conversation-list"><div class="empty-state">Loading conversations…</div></div><article class="conversation-detail" id="conversation-detail" aria-live="polite"><div class="empty-state">Select a conversation to view its timeline.</div></article></div><div class="inbox-footer">Messages are stored in StayPilot after import. Duplicate matching never automatically merges inquiries.</div>';
  $(".leads-panel").before(box);
  let active="all",query="",rows=[],selectedId=null;
  async function showConversation(id){
   selectedId=id;
   const convo=rows.find(item=>item.id===id);
   if(!convo)return;
   const linked=leads.find(l=>l.id===convo.linked_lead_id);
   $("#conversation-detail").innerHTML='<div class="conversation-detail-head"><span class="channel-avatar">'+esc(channelIcons[convo.channel_key]||"•")+'</span><div><h3>'+esc(convo.participant_display||convo.title||"Conversation")+'</h3><p>'+esc(convo.participant_address||"")+' · '+esc(channelTitles[convo.channel_key]||convo.channel_key)+'</p></div><span class="demo-pill">'+esc(convo.status.toUpperCase())+'</span></div><div id="message-timeline" class="message-timeline"><div class="empty-state">Loading message history…</div></div><div class="match-card"><span>LINKED INQUIRY</span><b>'+esc(linked?linked.client_name+" · "+linked.company_name:"Not linked")+'</b><small>Confirm the inquiry context before linking. Similarity is not proof of a duplicate booking.</small><div class="link-lead-row"><label for="conversation-lead-select">Link inquiry</label><select id="conversation-lead-select"><option value="">No linked inquiry</option>'+leads.map(l=>'<option value="'+esc(l.id)+'" '+(l.id===convo.linked_lead_id?"selected":"")+'>'+esc(l.client_name+" · "+l.company_name+" · "+l.property_name)+'</option>').join("")+'</select><button class="btn btn-secondary btn-sm" data-link-conversation="'+esc(convo.id)+'">Save link</button></div></div><form id="note-form" class="note-form" data-conversation-id="'+esc(convo.id)+'"><label for="internal-note">Add an internal note</label><textarea id="internal-note" name="body_text" maxlength="5000" rows="3" required placeholder="Call outcome, decision or next action…"></textarea><button class="btn btn-primary btn-sm" type="submit">Add internal note</button><p class="disabled-reply">Internal note only. This does not send a message to the external contact.</p></form>';
   try{
    const data=await api("/inbox/messages?conversation_id="+encodeURIComponent(id));
    if(selectedId!==id)return;
    const messages=Array.isArray(data.messages)?data.messages:[];
    $("#message-timeline").innerHTML=messages.length?messages.map(m=>'<div class="message-bubble '+(m.direction==="note"?"internal-note":"")+'"><small>'+esc(m.direction==="note"?"Internal note":m.direction==="outbound"?"Outbound":channelTitles[m.channel_key]||m.channel_key)+' · '+esc(timeLabel(m.provider_created_at||m.created_at))+' · '+esc(m.sender_name||m.sender_address||"")+'</small><p>'+esc(m.body_text||m.subject||"(No message preview)")+'</p></div>').join(""):'<div class="empty-state">No messages imported for this conversation.</div>';
    const item=rows.find(r=>r.id===id);if(item)item.unread_count=0;
   }catch(error){if(selectedId===id)$("#message-timeline").innerHTML='<div class="empty-state">Could not load messages: '+esc(error.message)+'</div>';}
  }
  async function reloadConversations(){
   $("#conversation-list").innerHTML='<div class="empty-state">Loading conversations…</div>';
   const params=new URLSearchParams({limit:"100"});
   if(active!=="all")params.set("channel",active);
   if(query.trim())params.set("q",query.trim());
   try{
    const data=await api("/inbox/conversations?"+params.toString());
    rows=Array.isArray(data.conversations)?data.conversations:[];
    $("#conversation-list").innerHTML=rows.length?rows.map(c=>'<button class="conversation-row '+(c.id===selectedId?"selected":"")+'" data-conversation-id="'+esc(c.id)+'"><span class="channel-avatar">'+esc(channelIcons[c.channel_key]||"•")+'</span><span class="conversation-copy"><span class="conversation-meta"><b>'+esc(c.participant_display||c.title||"Conversation")+'</b><time>'+esc(timeLabel(c.last_message_at||c.updated_at))+'</time></span><span class="conversation-org">'+esc(c.participant_address||"")+'</span><span class="conversation-preview">'+esc(c.last_message_preview||"No message preview")+'</span><span class="conversation-source">'+esc(channelTitles[c.channel_key]||c.channel_key)+(Number(c.unread_count)>0?'<i class="unread-dot"></i>':'')+'</span></span></button>').join(""):'<div class="empty-state">No matching conversations yet. Connect a source or create a conversation from an incoming message.</div>';
    if(rows.length){const target=rows.some(c=>c.id===selectedId)?selectedId:rows[0].id;await showConversation(target);}else{$("#conversation-detail").innerHTML='<div class="empty-state">No conversation selected.</div>';selectedId=null;}
   }catch(error){rows=[];$("#conversation-list").innerHTML='<div class="empty-state">Could not load conversations: '+esc(error.message)+'</div>';$("#conversation-detail").innerHTML='<div class="empty-state">Check sign-in, workspace membership and API availability.</div>';}
  }
  actionCentreConversationOpener=async id=>{
   await reloadConversations();
   if(rows.some(item=>item.id===id))await showConversation(id);
   else toast("The source conversation is not in the current inbox results. Check channel filters or reconnect the source.",true);
  };
  box.addEventListener("click",async e=>{
   const f=e.target.closest("[data-channel-filter]"),c=e.target.closest("[data-conversation-id]"),link=e.target.closest("[data-link-conversation]");
   if(f){active=f.dataset.channelFilter;$$(".inbox-tab").forEach(b=>b.classList.toggle("active",b===f));selectedId=null;await reloadConversations();}
   if(c)await showConversation(c.dataset.conversationId);
   if(link){const select=$("#conversation-lead-select");try{await api("/inbox/link",{method:"POST",body:JSON.stringify({conversation_id:link.dataset.linkConversation,lead_id:select.value||null})});toast("Conversation link updated.");await reloadConversations();}catch(error){toast("Could not link conversation: "+error.message,true);}}
  });
  box.addEventListener("submit",async e=>{
   if(e.target.id!=="note-form")return;
   e.preventDefault();
   const field=e.target.querySelector('[name="body_text"]'),body=field.value.trim();if(!body)return;
   const button=e.target.querySelector("button[type=submit]");button.disabled=true;
   try{await api("/inbox/messages",{method:"POST",body:JSON.stringify({conversation_id:e.target.dataset.conversationId,body_text:body})});toast("Internal note saved.");await showConversation(e.target.dataset.conversationId);await reloadConversations();}
   catch(error){toast("Could not save note: "+error.message,true);}
   finally{button.disabled=false;}
  });
  $("#inbox-search").addEventListener("input",e=>{query=e.target.value;void reloadConversations();});
  await reloadConversations();
 }else{
  box.innerHTML='<div class="channel-notice"><span class="notice-mark">↗</span><div><b>Integration control centre</b><p>Connection state is read from the backend. Credentials are never returned to this screen.</p></div><button class="btn btn-secondary btn-sm" data-view="inbox">Open inbox →</button></div><div class="integration-summary"><div><small>CHANNELS IDENTIFIED</small><b id="integration-count">—</b></div><div><small>ACTIVE CONNECTIONS</small><b id="integration-live">—</b></div><div><small>PRIORITY 1 SETUPS</small><b>6</b></div><div><small>LAST SYNC</small><b class="sync-pending" id="integration-synced">—</b></div></div><div class="integration-section-head"><div><h2>Connection status</h2><p>Email sync is read-only. Other connections activate only after provider setup and successful events.</p></div><div class="integration-head-actions"><button class="btn btn-secondary btn-sm" id="refresh-connections">Refresh status</button><button class="btn btn-primary btn-sm" id="sync-mailboxes">Sync connected mailboxes</button></div></div><div class="integration-grid" id="integration-grid"><div class="empty-state">Loading channel status…</div></div><div class="integration-principles"><h3>Credential and data controls</h3><div class="principle-grid"><div><b>Credentials</b><p>Google, Microsoft and Meta API credentials live in the approved provider integration settings. Application tables store only connection state and external identifiers.</p></div><div><b>Sync health</b><p>Provider failures become stable error codes. Correct permission or app setup before retrying.</p></div><div><b>Idempotency</b><p>Provider message IDs and partner idempotency keys prevent duplicate ingestion.</p></div><div><b>Human review</b><p>Duplicate matching proposes overlaps. Linking and merging remain explicit teammate actions.</p></div></div></div>';
  $(".leads-panel").before(box);
  const draw=connections=>{
   const byKey=new Map(connections.map(c=>[c.channel_key,c]));
   $("#integration-count").textContent=String(channelCatalog.length);
   $("#integration-live").textContent=String(connections.filter(c=>c.connected).length);
   const last=connections.map(c=>c.last_synced_at||c.last_webhook_at).filter(Boolean).sort().pop();
   $("#integration-synced").textContent=last?timeLabel(last):"Not yet";
   $("#integration-grid").innerHTML=channelCatalog.map(c=>{
    const state=byKey.get(c.key)||{status:"not_connected",connection_mode:"manual",connected:false,last_error_code:null,last_synced_at:null,last_webhook_at:null};
    const status=state.status==="inbound_active"?"Inbound active":state.status==="connected"?"Connected":state.status==="pending"?"Pending":state.status==="error"?"Needs attention":state.status==="disabled"?"Disabled":"Not connected";
    return '<article class="integration-card"><div class="integration-card-top"><span class="integration-icon '+(companyLogoCatalog[c.key]?.className||"integration-generic")+'">'+companyLogoMarkup(c.key)+'</span><span class="priority-tag '+c.priority.toLowerCase()+'">'+c.priority+'</span></div><h3>'+esc(c.name)+'</h3><p>'+esc(c.detail)+'</p><div class="integration-status"><i></i><span>'+esc(status)+'</span></div><div class="integration-extra"><small>Mode: '+esc(state.connection_mode||"manual")+'</small><small>Last inbound: '+esc(timeLabel(state.last_webhook_at))+'</small><small>Last sync: '+esc(timeLabel(state.last_synced_at))+'</small>'+(state.last_error_code?'<small class="integration-error">Status code: '+esc(state.last_error_code)+'</small>':'')+'</div><details><summary>Setup requirements</summary><p>'+esc(c.setup)+'</p></details></article>';
   }).join("");
  };
  const refresh=async()=>{
   $("#integration-grid").innerHTML='<div class="empty-state">Loading channel status…</div>';
   try{const d=await api("/channels/status");draw(Array.isArray(d.connections)?d.connections:[]);}
   catch(error){$("#integration-grid").innerHTML='<div class="empty-state">Cannot read connection status: '+esc(error.message)+'</div>';}
  };
  $("#refresh-connections").addEventListener("click",()=>void refresh());
  $("#sync-mailboxes").addEventListener("click",async()=>{
   const button=$("#sync-mailboxes");if(!workspaceSession||!["owner","admin","sales"].includes(workspaceSession.workspace?.role)){toast("Your role cannot sync connected mailboxes.",true);return;}
   button.disabled=true;button.textContent="Syncing…";
   try{const d=await api("/integrations/sync",{method:"POST",body:JSON.stringify({})});toast("Mailbox sync finished. Imported "+Number(d.imported_total??d.imported??0)+" new messages."+(d.ok===false?" Some connected mailboxes need attention.":""),d.ok===false);await refresh();}
   catch(error){toast("Mailbox sync failed: "+error.message,true);}
   finally{button.disabled=false;button.textContent="Sync connected mailboxes";}
  });
  await refresh();
  const importPanel=document.createElement("section");
  importPanel.className="csv-import-panel";
  importPanel.innerHTML='<div class="integration-section-head"><div><h2>Import existing inquiries</h2><p>CSV only. Preview validates every row, finds likely overlaps, and does not write anything until you confirm. Excel files must first be exported as CSV.</p></div></div><div class="csv-import-controls"><label for="csv-import-file">Choose CSV file<input id="csv-import-file" type="file" accept=".csv,text/csv"></label><span class="csv-import-limit">Up to 25 rows per batch · 1 MB maximum</span></div><div id="csv-import-summary" class="csv-import-summary" role="status" aria-live="polite">No file selected.</div><div id="csv-import-errors" class="csv-import-errors hidden"></div><label id="csv-confirm-wrap" class="csv-confirm-wrap hidden"><input type="checkbox" id="csv-confirm-duplicates"> I reviewed the possible duplicate matches and still want to import these rows.</label><button id="csv-import-commit" class="btn btn-primary btn-sm" type="button" disabled hidden>Confirm import</button>';
  box.querySelector(".integration-principles").before(importPanel);
  const canImport=["owner","admin","sales"].includes(workspaceSession?.workspace?.role);
  const csvFile=$("#csv-import-file"),csvSummary=$("#csv-import-summary"),csvErrors=$("#csv-import-errors"),csvConfirm=$("#csv-confirm-wrap"),csvCommit=$("#csv-import-commit");
  if(!canImport){csvFile.disabled=true;csvSummary.textContent="Your role can view integrations but cannot import inquiries.";}
  let pendingImportRows=null,previewDuplicateCount=0;
  async function previewCsv(rows){
   pendingImportRows=rows;previewDuplicateCount=0;csvErrors.classList.add("hidden");csvErrors.textContent="";csvConfirm.classList.add("hidden");$("#csv-confirm-duplicates").checked=false;csvCommit.hidden=true;csvCommit.disabled=true;
   csvSummary.textContent="Validating rows and checking potential overlaps…";
   try{
    const d=await api("/leads/import",{method:"POST",body:JSON.stringify({mode:"preview",rows})});
    previewDuplicateCount=Number(d.duplicate_count||0);
    csvSummary.textContent=d.row_count+" rows passed validation. "+previewDuplicateCount+" potential duplicate match(es) found. No records have been written.";
    if(previewDuplicateCount){
     csvConfirm.classList.remove("hidden");
     const list=Array.isArray(d.potential_duplicates)?d.potential_duplicates:[];
     csvErrors.classList.remove("hidden");
     csvErrors.textContent=list.slice(0,40).map(item=>"Row "+item.row+" · "+(item.matches_import_row?"Possible match with CSV row "+item.matches_import_row:item.client_name+" · "+item.company_name+" · "+item.status)).join("\n")+(list.length>40?"\nMore matches omitted from this preview.":"");
    }
    csvCommit.hidden=false;csvCommit.disabled=false;
   }catch(error){
    pendingImportRows=null;
    const errors=Array.isArray(error.data?.errors)?error.data.errors:[];
    csvSummary.textContent=error.message||"CSV preview failed.";
    if(errors.length){csvErrors.classList.remove("hidden");csvErrors.textContent=errors.map(item=>"Row "+item.row+": "+item.error).join("\n");}
   }
  }
  csvFile.addEventListener("change",async()=>{
   const file=csvFile.files&&csvFile.files[0];pendingImportRows=null;csvCommit.hidden=true;csvConfirm.classList.add("hidden");csvErrors.classList.add("hidden");
   if(!file){csvSummary.textContent="No file selected.";return;}
   if(file.size>1000000){csvSummary.textContent="CSV must be smaller than 1 MB.";return;}
   try{const rows=parseCsvRows(await file.text());await previewCsv(rows);}
   catch(error){csvSummary.textContent=error.message||"Could not read CSV.";}
  });
  $("#csv-confirm-duplicates").addEventListener("change",()=>{if(previewDuplicateCount&&$("#csv-confirm-duplicates").checked)csvSummary.textContent="Possible overlaps acknowledged. Confirm import only if each duplicate is intentional.";});
  csvCommit.addEventListener("click",async()=>{
   if(!pendingImportRows){csvSummary.textContent="Choose a CSV and complete preview first.";return;}
   if(previewDuplicateCount&&!$("#csv-confirm-duplicates").checked){csvSummary.textContent="Review matches and check the confirmation box before importing.";return;}
   csvCommit.disabled=true;csvCommit.textContent="Importing…";
   try{
    const d=await api("/leads/import",{method:"POST",body:JSON.stringify({mode:"commit",rows:pendingImportRows,confirm_duplicates:$("#csv-confirm-duplicates").checked})});
    csvSummary.textContent=d.created+" inquiries imported successfully. Each record and its audit/activity entries were committed as one batch.";
    csvFile.value="";pendingImportRows=null;previewDuplicateCount=0;csvConfirm.classList.add("hidden");csvErrors.classList.add("hidden");csvCommit.hidden=true;
    toast(d.created+" inquiries imported.");await loadLeads();
   }catch(error){
    csvSummary.textContent=error.message||"Import failed. No success is assumed.";
    const conflicts=Array.isArray(error.data?.potential_duplicates)?error.data.potential_duplicates:[];
    if(error.status===409&&conflicts.length){previewDuplicateCount=conflicts.length;csvConfirm.classList.remove("hidden");csvCommit.hidden=false;csvErrors.classList.remove("hidden");csvErrors.textContent=conflicts.slice(0,40).map(item=>"Row "+item.row+" · "+(item.matches_import_row?"Possible match with CSV row "+item.matches_import_row:item.client_name+" · "+item.company_name)).join("\n");}
   }finally{csvCommit.disabled=false;csvCommit.textContent="Confirm import";}
  });
  if(["owner","admin"].includes(workspaceSession?.workspace?.role)){
   const keys=document.createElement("section");keys.className="partner-key-panel";
   keys.innerHTML='<div class="integration-section-head"><div><h2>Partner API access</h2><p>Restricted server-to-server keys for approved travel partners. A secret is shown only once.</p></div></div><form id="partner-key-form" class="partner-key-form"><label for="partner-key-name">Key name<input id="partner-key-name" name="name" maxlength="100" required placeholder="e.g. Apex Travel integration"></label><button class="btn btn-primary btn-sm" type="submit">Create partner key</button></form><div id="partner-key-once" class="partner-key-once hidden"></div><div id="partner-key-list" class="partner-key-list">Loading keys…</div>';
   box.appendChild(keys);
   const loadKeys=async()=>{try{const d=await api("/integrations/api-keys");const list=Array.isArray(d.keys)?d.keys:[];$("#partner-key-list").innerHTML=list.length?list.map(k=>'<div class="partner-key-row"><div><b>'+esc(k.name)+'</b><small>'+esc(k.key_prefix)+'… · '+esc((Array.isArray(k.scopes)?k.scopes:[]).join(", "))+' · '+(k.is_active?"Active":"Revoked")+'</small><small>Created '+esc(timeLabel(k.created_at))+' · Last used '+esc(timeLabel(k.last_used_at))+'</small></div>'+(k.is_active?'<button class="btn btn-secondary btn-sm" data-revoke-key="'+esc(k.id)+'">Revoke</button>':'')+'</div>').join(""):'<div class="empty-state">No partner keys yet.</div>';}catch(error){$("#partner-key-list").textContent="Partner key list unavailable: "+error.message;}};
   keys.addEventListener("submit",async e=>{if(e.target.id!=="partner-key-form")return;e.preventDefault();const input=$("#partner-key-name"),button=e.target.querySelector("button");button.disabled=true;try{const d=await api("/integrations/api-keys",{method:"POST",body:JSON.stringify({name:input.value.trim()})});const once=$("#partner-key-once");once.classList.remove("hidden");once.innerHTML='<b>Copy this secret now. It cannot be shown again.</b><input id="new-partner-secret" readonly autocomplete="off" aria-label="New partner API secret"><button id="copy-partner-secret" class="btn btn-secondary btn-sm" type="button">Copy key</button><p>Store it on the partner server. Never place it in a website or browser application.</p>';$("#new-partner-secret").value=d.secret;input.value="";toast("Partner API key created. Copy it now.");await loadKeys();}catch(error){toast("Could not create key: "+error.message,true);}finally{button.disabled=false;}});
   keys.addEventListener("click",async e=>{const copy=e.target.closest("#copy-partner-secret"),revoke=e.target.closest("[data-revoke-key]");if(copy){try{await navigator.clipboard.writeText($("#new-partner-secret").value);toast("Secret copied to clipboard.");}catch(error){const input=$("#new-partner-secret");input.focus();input.select();toast("Select and copy the secret from the field.");}}if(revoke){if(!confirm("Revoke this partner key? Existing integrations using it will stop working."))return;try{await api("/integrations/api-keys",{method:"DELETE",body:JSON.stringify({id:revoke.dataset.revokeKey})});toast("Partner key revoked.");await loadKeys();}catch(error){toast("Could not revoke key: "+error.message,true);}}});
   await loadKeys();
  }
 }
}

function filteredLeads(){let a=[...leads];if(currentView==="duplicates")a=a.filter(l=>(l.duplicate_candidates||[]).length);if(currentView==="followups")a=a.filter(l=>l.next_follow_up&&new Date(l.next_follow_up)<=new Date(Date.now()+864e5)&&!["Confirmed","Lost"].includes(l.status));if(currentView==="pipeline")a=a.filter(l=>!["Confirmed","Lost"].includes(l.status));const sf=$("#status-filter")?.value||"",pf=$("#property-filter")?.value||"",of=$("#owner-filter")?.value||"",df=$("#duplicate-filter")?.checked||false;if(sf)a=a.filter(l=>l.status===sf);if(pf)a=a.filter(l=>l.property_name===pf);if(of)a=a.filter(l=>(l.assigned_to||"Unassigned")===of);if(df)a=a.filter(l=>(l.duplicate_candidates||[]).length);if(searchTerm){const q=searchTerm.toLowerCase();a=a.filter(l=>[l.client_name,l.company_name,l.client_email,l.client_phone,l.agent_name,l.agent_email,l.property_name,l.inquiry_type,l.status,l.assigned_to,l.notes].some(v=>String(v||"").toLowerCase().includes(q)));}return a;}
function render(){const open=leads.filter(l=>!["Confirmed","Lost"].includes(l.status)),dups=leads.filter(l=>(l.duplicate_candidates||[]).length),due=leads.filter(l=>l.next_follow_up&&new Date(l.next_follow_up)<=new Date(Date.now()+864e5)&&!["Confirmed","Lost"].includes(l.status));$("#m-open").textContent=open.length;$("#m-duplicates").textContent=dups.length;$("#m-followups").textContent=due.length;$("#m-value").textContent=money(open.reduce((n,l)=>n+(Number(l.estimated_value)||0),0));$("#nav-count").textContent=leads.length;$("#dup-count").textContent=dups.length;const owner=$("#owner-filter");if(owner){const chosen=owner.value,owners=[...new Set(leads.map(l=>l.assigned_to||"Unassigned"))].sort();owner.innerHTML='<option value="">All owners</option>'+owners.map(o=>'<option>'+esc(o)+'</option>').join("");owner.value=owners.includes(chosen)?chosen:"";}$("#radar-copy").textContent=dups.length+" inquiry record(s) may overlap, and "+due.length+" follow-up(s) are due soon. Review before the next sales call.";renderPipeline();renderAttention(dups,due);renderTable(filteredLeads());}
function renderPipeline(){const stages=["New inquiry","Contacted","Proposal sent","Negotiation","Confirmed","Lost"],counts=stages.map(s=>leads.filter(l=>l.status===s).length),max=Math.max(1,...counts);$("#pipeline-summary").innerHTML='<div class="pipeline-summary-item"><span class="legend-dot"></span><span>Active deals</span><b>'+leads.filter(l=>!["Confirmed","Lost"].includes(l.status)).length+'</b></div><div class="pipeline-summary-item"><span style="color:#a6b6d6">●</span><span>Confirmed</span><b>'+counts[4]+'</b></div>';$("#pipeline-bars").innerHTML=stages.map((s,i)=>'<div class="stage-col"><span class="stage-count">'+counts[i]+'</span><div class="stage-bar" style="height:'+Math.max(7,counts[i]/max*62)+'px"></div><span class="stage-label">'+["New","Contact","Proposal","Negotiate","Won","Lost"][i]+'</span></div>').join("");$("#pipeline-total").textContent=money(leads.filter(l=>!["Confirmed","Lost"].includes(l.status)).reduce((n,l)=>n+(Number(l.estimated_value)||0),0))+" in play";}
function renderAttention(dups,due){let a=[];dups.slice(0,2).forEach(l=>a.push({icon:"⧉",cls:"warn",title:"Possible duplicate · "+l.company_name,desc:"Also linked to "+l.duplicate_candidates.map(x=>x.agent_name||"another source").join(", "),side:"Review",id:l.id}));due.slice(0,3).forEach(l=>a.push({icon:"◷",cls:new Date(l.next_follow_up)<new Date()?"late":"good",title:(new Date(l.next_follow_up)<new Date()?"Overdue · ":"Due soon · ")+l.company_name,desc:l.status+" · "+(l.assigned_to||"Unassigned")+" · "+l.property_name,side:dateShort(l.next_follow_up),id:l.id}));if(!a.length)a.push({icon:"✓",cls:"good",title:"Your queue is clear",desc:"No urgent duplicate reviews or follow-ups in this sample.",side:"All clear"});$("#attention-list").innerHTML=a.slice(0,4).map(x=>'<div class="attention-item" '+(x.id?'data-detail="'+esc(x.id)+'"':'')+'><div class="attention-icon '+x.cls+'">'+x.icon+'</div><div class="attention-main"><b>'+esc(x.title)+'</b><p>'+esc(x.desc)+'</p></div><span class="attention-side">'+esc(x.side)+'</span></div>').join("");}
function renderTable(a){$("#table-caption").textContent="Showing "+a.length+" "+(currentView==="duplicates"?"potential duplicate(s)":currentView==="followups"?"follow-up item(s)":"inquiry record(s)");const summary=$("#results-summary");if(summary)summary.textContent=a.length+" result"+(a.length===1?"":"s");const body=$("#leads-body");if(!a.length){body.innerHTML='<tr><td colspan="6"><div class="empty-state"><b>No matching inquiries</b><p>Try another search or add a new inquiry.</p></div></td></tr>';return;}body.innerHTML=a.map(l=>{const d=(l.duplicate_candidates||[]).length;return '<tr><td><div class="client-cell"><div class="client-avatar">'+esc(initials(l.client_name))+'</div><div class="client-main"><b>'+esc(l.client_name)+'</b><small>'+esc(l.company_name)+(d?' · <span style="color:#b58030">⚠ '+d+' possible overlap</span>':'')+'</small></div></div></td><td><div class="agent-cell"><b>'+esc(l.agent_name||"Direct inquiry")+'</b><small>'+esc(l.source||"Unknown source")+'</small></div></td><td><div class="property-cell"><b>'+esc(String(l.property_name||"").replace("The LaLiT ",""))+'</b><small>'+esc(l.inquiry_type||"Inquiry")+' · '+dateShort(l.check_in)+'</small></div></td><td class="value-cell">'+money(l.estimated_value)+'</td><td><span class="status-badge '+statusClass(l.status)+'">'+esc(l.status)+'</span></td><td><button class="row-menu" data-detail="'+esc(l.id)+'" title="View details">···</button></td></tr>';}).join("");}
function openAdd(){$("#lead-form").reset();$("#modal-backdrop").classList.add("open");setTimeout(()=>$('#lead-form [name="client_name"]').focus(),50);}function closeAdd(){$("#modal-backdrop").classList.remove("open");}
async function saveLead(e){e.preventDefault();const form=$("#lead-form"),btn=$("#save-btn"),p=Object.fromEntries(new FormData(form).entries());p.guests=Number(p.guests)||1;p.estimated_value=Number(p.estimated_value)||0;for(const k of ["check_in","check_out","next_follow_up"])if(!p[k])p[k]=null;if(p.next_follow_up)p.next_follow_up=new Date(p.next_follow_up).toISOString();btn.disabled=true;btn.textContent="Saving…";try{const d=await api("/leads/create",{method:"POST",body:JSON.stringify(p)});leads.unshift(d.lead);leads=detectDuplicates(leads);closeAdd();render();toast("Inquiry saved. Checking for possible overlaps.");if(d.lead.duplicate_candidates?.length)openDetail(d.lead.id);}catch(err){toast("Could not save inquiry: "+err.message,true);}finally{btn.disabled=false;btn.innerHTML='Save inquiry <span>→</span>';}}
function openDetail(id){const l=leads.find(x=>x.id===id);if(!l)return;$("#detail-title").textContent=l.client_name;$("#detail-subtitle").textContent=l.company_name+" · "+(l.property_name||"Property");const dup=l.duplicate_candidates||[];$("#detail-content").innerHTML='<div class="detail-stats"><div class="detail-stat"><small>ESTIMATED VALUE</small><b>'+money(l.estimated_value)+'</b></div><div class="detail-stat"><small>PIPELINE STATUS</small><b><span class="status-badge '+statusClass(l.status)+'">'+esc(l.status)+'</span></b></div><div class="detail-stat"><small>AGENT PARTNER</small><b>'+esc(l.agent_name||"Direct")+'</b></div></div>'+[['Property',l.property_name],['Inquiry type',l.inquiry_type],['Client email',l.client_email||"—"],['Client phone',l.client_phone||"—"],['Agent email',l.agent_email||"—"],['Dates / event',dateShort(l.check_in)+" – "+dateShort(l.check_out)],['Guests / rooms',l.guests],['Assigned to',l.assigned_to||"Unassigned"],['Next follow-up',dateTime(l.next_follow_up)],['Notes',l.notes||"No notes yet"]].map(([a,b])=>'<div class="detail-row"><span>'+esc(a)+'</span><b>'+esc(b??"—")+'</b></div>').join("")+(dup.length?'<div style="margin-top:16px;background:#fff8eb;border:1px solid #f2e1c5;border-radius:8px;padding:13px"><b style="color:#8c6428">⚠ '+dup.length+' possible duplicate match(es)</b><p style="font-size:10px;color:#8e7b5d;line-height:1.6">Similar details are a signal to investigate, not proof of the same booking.</p>'+dup.map(d=>'<div class="detail-row"><span>'+esc(d.agent_name)+' · '+esc(d.company_name)+'</span><b>'+esc(d.status)+' · '+money(d.estimated_value)+'</b></div>').join("")+'</div>':'')+'<div class="detail-actions"><select id="status-select" class="btn btn-secondary" style="height:35px">'+["New inquiry","Contacted","Proposal sent","Negotiation","Confirmed","Lost"].map(s=>'<option '+(l.status===s?"selected":"")+'>'+s+'</option>').join("")+'</select><button class="btn btn-primary" id="status-save">Update status →</button></div><div class="detail-activity"><h3>Activity history</h3><div id="activity-list"><div class="activity-item"><b>Inquiry in pipeline</b><small>Activity history will appear here when available.</small></div></div></div>';$("#detail-backdrop").classList.add("open");$("#status-save").addEventListener("click",()=>updateStatus(l.id,$("#status-select").value));loadActivities(l.id);}
async function loadActivities(id){try{const d=await api("/leads/activities?id="+encodeURIComponent(id));if(d.activities?.length)$("#activity-list").innerHTML=d.activities.map(a=>'<div class="activity-item"><b>'+esc(a.description)+'</b><small>'+dateTime(a.created_at)+' · '+esc(a.actor||"Sales team")+'</small></div>').join("");}catch{}}
async function updateStatus(id,status){try{const d=await api("/leads/update",{method:"POST",body:JSON.stringify({id,status})});leads=detectDuplicates(leads.map(l=>l.id===id?{...l,...d.lead}:l));$("#detail-backdrop").classList.remove("open");render();toast("Inquiry status updated.");}catch(e){toast("Could not update status: "+e.message,true);}}
function exportCsv(){const a=filteredLeads(),cols=["client_name","company_name","client_email","client_phone","agent_name","agent_email","property_name","inquiry_type","check_in","check_out","guests","estimated_value","source","status","assigned_to","next_follow_up","notes"],csv=[cols.join(","),...a.map(l=>cols.map(k=>'"'+String(l[k]??"").replace(/"/g,'""')+'"').join(","))].join("\r\n"),url=URL.createObjectURL(new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8;"})),el=document.createElement("a");el.href=url;el.download="staypilot-inquiries.csv";el.click();URL.revokeObjectURL(url);toast("CSV export prepared.");}
document.addEventListener("click",e=>{const n=e.target.closest("[data-view]"),g=e.target.closest("[data-go]"),d=e.target.closest("[data-detail]");if(n)openView(n.dataset.view);if(g)openView(g.dataset.go);if(d)openDetail(d.dataset.detail);});$("#add-btn").addEventListener("click",openAdd);$("#help-btn").addEventListener("click",()=>toast("Start with inquiry capture, review duplicate candidates, then assign a clear next action."));$("#export-btn").addEventListener("click",exportCsv);$("#search").addEventListener("input",e=>{searchTerm=e.target.value;renderTable(filteredLeads());});["status-filter","property-filter","owner-filter","duplicate-filter"].forEach(id=>$("#"+id)?.addEventListener("change",()=>renderTable(filteredLeads())));$("#clear-filters").addEventListener("click",()=>{$("#search").value="";searchTerm="";$("#status-filter").value="";$("#property-filter").value="";$("#owner-filter").value="";$("#duplicate-filter").checked=false;renderTable(filteredLeads());});$("#lead-form").addEventListener("submit",saveLead);$("#modal-close").addEventListener("click",closeAdd);$("#cancel-btn").addEventListener("click",closeAdd);$("#modal-backdrop").addEventListener("click",e=>{if(e.target.id==="modal-backdrop")closeAdd();});$("#detail-close").addEventListener("click",()=>$("#detail-backdrop").classList.remove("open"));$("#detail-backdrop").addEventListener("click",e=>{if(e.target.id==="detail-backdrop")$("#detail-backdrop").classList.remove("open");});document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeAdd();$("#detail-backdrop").classList.remove("open");}});const signOutButton=$("#signout-btn");
if(signOutButton){
  signOutButton.addEventListener("click",async()=>{
    if(PREVIEW_MODE){toast("Read-only preview: sign-in is disabled.");return;}
    try{await signOut();}finally{location.replace("/login");}
  });
}
const workspaceSelect=$("#workspace-select");
workspaceSelect?.addEventListener("change",()=>{
  if(!workspaceSelect.value) return;
  setActiveWorkspaceId(workspaceSelect.value);
  location.reload();
});
function closeWorkspaceModal(){ $("#workspace-modal-backdrop")?.classList.remove("open"); }
$("#workspace-create-btn")?.addEventListener("click",()=>{
  if(PREVIEW_MODE){toast("Workspace creation is disabled in the public preview.");return;}
  $("#workspace-modal-backdrop")?.classList.add("open");
  $("#workspace-form input[name=name]")?.focus();
});
$("#workspace-modal-close")?.addEventListener("click",closeWorkspaceModal);
$("#workspace-cancel")?.addEventListener("click",closeWorkspaceModal);
$("#workspace-modal-backdrop")?.addEventListener("click",event=>{
  if(event.target?.id==="workspace-modal-backdrop") closeWorkspaceModal();
});
$("#workspace-form")?.addEventListener("submit",async event=>{
  event.preventDefault();
  if(PREVIEW_MODE){toast("Workspace creation is disabled in the public preview.",true);return;}
  const form=event.currentTarget;
  const name=String(new FormData(form).get("name")||"").trim();
  const submit=$("#workspace-submit");
  if(!name){toast("Enter a hotel or portfolio name.",true);return;}
  submit.disabled=true;
  try{
    const result=await api("/workspaces",{method:"POST",body:JSON.stringify({name})});
    const workspaceId=result.workspace?.id;
    if(typeof workspaceId!=="string"||!workspaceId) throw new Error("The workspace was created but its identifier was not returned. Contact support before retrying.");
    setActiveWorkspaceId(workspaceId);
    closeWorkspaceModal();
    location.reload();
  }catch(error){
    toast(error.message||"Could not create the workspace.",true);
  }finally{
    submit.disabled=false;
  }
});
loadLeads();