/**
 * V2 — Developer Interface
 *
 * Shows the actual function / API call behind every action.
 * All sub-statuses are permanently expanded.
 * Status keys are shown in their internal enum form.
 * HTTP method badges colour-code each operation type.
 */

import React from "react";

// ── Types ──────────────────────────────────────────────────────────────────

type HttpMethod = "POST" | "PATCH" | "DELETE" | "client";

type ActionFn = {
  label: string;        // button label
  fn: string;           // function name
  method: HttpMethod;   // http verb (or client-side)
  endpoint?: string;    // route
};

type Sub = {
  key: string;          // enum key
  label: string;
  action?: ActionFn;
};

type Status = {
  key: string;          // enum key e.g. FORM_SUBMISSION
  label: string;
  hint?: string;
  action?: ActionFn;    // primary action
  subs?: Sub[];
  isExit?: boolean;
  exitIcon?: string;
};

type Stage = {
  id: string;
  num: number;
  label: string;
  phase: "crm" | "prod";
  color: string;
  bg: string;
  headerBg: string;
  border: string;
  statuses: Status[];
};

// ── Colour helpers ─────────────────────────────────────────────────────────

const METHOD_COLORS: Record<HttpMethod, { bg: string; text: string }> = {
  POST:   { bg: "#dcfce7", text: "#15803d" },
  PATCH:  { bg: "#fef3c7", text: "#b45309" },
  DELETE: { bg: "#fee2e2", text: "#b91c1c" },
  client: { bg: "#ede9fe", text: "#6d28d9" },
};

// ── Data ───────────────────────────────────────────────────────────────────

const STAGES: Stage[] = [
  {
    id: "entry", num: 0, label: "New Enquiry", phase: "crm",
    color: "#7c3aed", bg: "#f5f3ff", headerBg: "#1e1b4b", border: "#c4b5fd",
    statuses: [
      {
        key: "NEW_CONTACT",
        label: "New Contact",
        hint: "Lead enters system via any channel",
        subs: [
          { key: "WEB_FORM",   label: "Web Form",       action: { label: "New Enquiry",    fn: "createContact()",      method: "POST",   endpoint: "POST /api/contacts" } },
          { key: "EMAIL",      label: "Email",           action: { label: "New Enquiry",    fn: "createContact()",      method: "POST",   endpoint: "POST /api/contacts" } },
          { key: "WHATSAPP",   label: "WhatsApp",        action: { label: "New Enquiry",    fn: "createContact()",      method: "POST",   endpoint: "POST /api/contacts" } },
          { key: "PHONE_CALL", label: "Phone Call",      action: { label: "Summarise Call", fn: "addCallSummaryNote()", method: "POST",   endpoint: "POST /api/contacts/:id/notes" } },
          { key: "INSTAGRAM",  label: "Instagram",       action: { label: "New Enquiry",    fn: "createContact()",      method: "POST",   endpoint: "POST /api/contacts" } },
          { key: "FACEBOOK",   label: "Facebook",        action: { label: "New Enquiry",    fn: "createContact()",      method: "POST",   endpoint: "POST /api/contacts" } },
        ],
      },
    ],
  },
  {
    id: "sales", num: 1, label: "Sales", phase: "crm",
    color: "#1d4ed8", bg: "#eff6ff", headerBg: "#1e3a8a", border: "#93c5fd",
    statuses: [
      {
        key: "FORM_SUBMISSION",
        label: "Form Submission",
        hint: "Email + WhatsApp asking for more information",
        action: { label: "Send Intro", fn: "sendIntroMessage()", method: "PATCH", endpoint: "PATCH /api/contacts/:id" },
      },
      {
        key: "ATTEMPTED_TO_CONTACT",
        label: "Attempted to Contact",
        hint: "No reply within 2 working days → call",
        subs: [
          { key: "ATC_EMAIL",  label: "Email Sent",       action: { label: "Send Email",    fn: "sendEmail()",          method: "POST",   endpoint: "POST /api/contacts/:id/email" } },
          { key: "ATC_WA",     label: "WhatsApp Sent",    action: { label: "Send WhatsApp", fn: "sendWhatsApp()",       method: "POST",   endpoint: "POST /api/whatsapp/send" } },
          { key: "ATC_CALL",   label: "Call Attempted",   action: { label: "Log Call",      fn: "addCallSummaryNote()", method: "POST",   endpoint: "POST /api/contacts/:id/notes" } },
          { key: "ATC_NR",     label: "No Response" },
        ],
      },
      {
        key: "IN_PROGRESS",
        label: "In Progress",
        hint: "Actively discussing requirements",
        action: { label: "Update Stage", fn: "setLeadStatus()", method: "PATCH", endpoint: "PATCH /api/contacts/:id" },
      },
      {
        key: "AWAITING_PHOTOS",
        label: "Awaiting Photos",
        hint: "Customer sending room photos / measurements",
        subs: [
          { key: "MORE_INFO",     label: "More Info Requested", action: { label: "Request Info",   fn: "sendInfoRequest()",    method: "POST",   endpoint: "POST /api/contacts/:id/notes" } },
          { key: "PHOTOS_RCVD",  label: "Photos Received",     action: { label: "Review Photos",  fn: "openPhotosModal()",    method: "client" } },
        ],
      },
      {
        key: "ROUGH_ESTIMATE",
        label: "Rough Estimate",
        hint: "Estimate shared — awaiting decision",
        action: { label: "Send Estimate", fn: "createQBEstimate()", method: "POST", endpoint: "POST /api/qb/estimates" },
      },
      { key: "NO_RESPONSE_X3", label: "No Response ×3", isExit: true, exitIcon: "◌" },
      { key: "UNQUALIFIED",    label: "Unqualified",    isExit: true, exitIcon: "✕" },
      { key: "NOT_SUITABLE",   label: "Not Suitable",   isExit: true, exitIcon: "⊘" },
      { key: "BAD_TIMING",     label: "Bad Timing",     isExit: true, exitIcon: "⏱" },
    ],
  },
  {
    id: "dv", num: 2, label: "Design Visit", phase: "crm",
    color: "#3730a3", bg: "#eef2ff", headerBg: "#312e81", border: "#a5b4fc",
    statuses: [
      {
        key: "DESIGN_SCHEDULED",
        label: "Design Scheduled",
        hint: "Add confirmed date to calendar",
        subs: [
          { key: "DV_DATE_SUG",  label: "Date Suggested",  action: { label: "Re-Send Invite",         fn: "resendCalendarInvite()", method: "POST",   endpoint: "POST /api/calendar/invite" } },
          { key: "DV_DATE_AGR",  label: "Date Agreed",     action: { label: "Add to Calendar",        fn: "createCalendarEvent()",  method: "POST",   endpoint: "POST /api/calendar/events" } },
          { key: "DV_DATE_CON",  label: "Date Confirmed",  action: { label: "Start Design Meeting",   fn: "startDesignVisit()",     method: "PATCH",  endpoint: "PATCH /api/design-visits/:id" } },
          { key: "DV_CANCELLED", label: "Visit Cancelled", action: { label: "Cancel Visit",           fn: "cancelDesignVisit()",    method: "PATCH",  endpoint: "PATCH /api/design-visits/:id" } },
        ],
      },
      {
        key: "DESIGN_IN_PROGRESS",
        label: "Design In Progress",
        hint: "Design consultation underway",
        action: { label: "Complete Meeting", fn: "completeDesignVisit()", method: "PATCH", endpoint: "PATCH /api/design-visits/:id" },
      },
      {
        key: "OPEN_DEAL",
        label: "Open Deal",
        hint: "Estimate sent — awaiting acceptance",
        subs: [
          { key: "AMENDMENTS", label: "Amendments Needed", action: { label: "Send Revised Estimate", fn: "updateQBEstimate()", method: "PATCH", endpoint: "PATCH /api/qb/estimates/:id" } },
        ],
        action: { label: "Accept Deal", fn: "setLeadStatus()", method: "PATCH", endpoint: "PATCH /api/contacts/:id" },
      },
      {
        key: "DESIGN_ACCEPTED",
        label: "Design Accepted",
        hint: "Customer approved design & estimate",
        action: { label: "Move to Survey", fn: "setLeadStatus()", method: "PATCH", endpoint: "PATCH /api/contacts/:id" },
      },
    ],
  },
  {
    id: "survey", num: 3, label: "Survey", phase: "crm",
    color: "#0e7490", bg: "#ecfeff", headerBg: "#164e63", border: "#67e8f9",
    statuses: [
      {
        key: "AWAITING_DEPOSIT",
        label: "Awaiting Deposit",
        hint: "Invoice issued — awaiting payment",
        subs: [
          { key: "DEP_RCVD", label: "Deposit Received", action: { label: "Suggest Survey Dates", fn: "suggestSurveyDates()", method: "POST", endpoint: "POST /api/contacts/:id/notes" } },
        ],
        action: { label: "Send Invoice", fn: "createQBInvoice()", method: "POST", endpoint: "POST /api/qb/invoices" },
      },
      {
        key: "SURVEY_SCHEDULED",
        label: "Survey Scheduled",
        hint: "",
        subs: [
          { key: "SV_DATE_SUG",  label: "Date Suggested",   action: { label: "Re-Send Invite",            fn: "resendCalendarInvite()", method: "POST",   endpoint: "POST /api/calendar/invite" } },
          { key: "SV_DATE_AGR",  label: "Date Agreed",      action: { label: "Add Survey to Calendar",    fn: "createCalendarEvent()",  method: "POST",   endpoint: "POST /api/calendar/events" } },
          { key: "SV_DATE_CON",  label: "Visit Confirmed",  action: { label: "Start Survey Meeting",      fn: "startVisit()",           method: "PATCH",  endpoint: "PATCH /api/visits/:id" } },
          { key: "SV_CANCELLED", label: "Visit Cancelled",  action: { label: "Process Refund",            fn: "voidQBInvoice()",        method: "PATCH",  endpoint: "PATCH /api/qb/invoices/:id/void" } },
        ],
      },
      {
        key: "SURVEY_IN_PROGRESS",
        label: "Survey In Progress",
        hint: "Check confirmation date with customer",
        action: { label: "Complete Survey", fn: "completeVisit()", method: "PATCH", endpoint: "PATCH /api/visits/:id" },
      },
      {
        key: "SURVEY_SENT",
        label: "Survey Sent",
        hint: "Final survey sent for customer review",
        subs: [
          { key: "SV_AMD", label: "Amendments Needed", action: { label: "Send Revised Survey", fn: "addSurveyNote()", method: "POST", endpoint: "POST /api/contacts/:id/notes" } },
        ],
        action: { label: "Send Survey", fn: "sendSurveyDocument()", method: "POST", endpoint: "POST /api/contacts/:id/notes" },
      },
      {
        key: "READY_FOR_PRODUCTION",
        label: "Ready for Production",
        hint: "Email customer to confirm installation date",
        action: { label: "Confirm Install Date", fn: "setLeadStatus()", method: "PATCH", endpoint: "PATCH /api/contacts/:id" },
      },
    ],
  },
];

const PROD_STAGES = [
  { id: "order",    num: 4, label: "Order",        color: "#047857", bg: "#d1fae5", headerBg: "#064e3b",
    steps: [
      { key: "ORDER_DOORS",    label: "Order Doors",    note: "For prev Mon/Tue" },
      { key: "ORDER_SHEETS",   label: "Order Sheets",   note: "Sheet materials" },
      { key: "ORDER_HARDWARE", label: "Order Hardware", note: "Hinges, handles, fixings" },
    ]},
  { id: "workshop", num: 5, label: "Workshop",     color: "#0f766e", bg: "#ccfbf1", headerBg: "#134e4a",
    steps: [
      { key: "PRINT_INSTALLER_PACK", label: "Print Installer Pack", note: "Renders, cutlist, notes" },
      { key: "PRINT_LABELS",         label: "Print Labels",         note: "Label each component" },
      { key: "NOTIFY_CUSTOMER",      label: "Notify Customer",      note: "Production underway" },
      { key: "PREP_FRAMEWORK",       label: "Prep Framework / MDF", note: "Cut timber" },
      { key: "PREP_SHEETS",          label: "Prep Sheet Materials", note: "" },
      { key: "CUT_SHEETS",           label: "Cut Sheet Materials",  note: "Per cutlist" },
    ]},
  { id: "packing",  num: 6, label: "Packing",      color: "#b45309", bg: "#fef3c7", headerBg: "#78350f",
    steps: [
      { key: "PACKING_IN_PROGRESS", label: "Packing In Progress",  note: "Wrap components" },
      { key: "DATE_TIME_AGREED",    label: "Date / Time Agreed",   note: "Confirm window" },
      { key: "READY_TO_LOAD",       label: "Ready to Load",        note: "Checked, staged" },
    ]},
  { id: "delivery", num: 7, label: "Delivery",     color: "#c2410c", bg: "#ffedd5", headerBg: "#7c2d12",
    steps: [
      { key: "LOADED",    label: "Loaded into Van", note: "Secured" },
      { key: "DELIVERED", label: "Delivered",       note: "Note date + comments" },
    ]},
  { id: "install",  num: 8, label: "Installation", color: "#be123c", bg: "#ffe4e6", headerBg: "#881337",
    steps: [
      { key: "INSTALL_SCHEDULED",   label: "Scheduled",            note: "Confirm with installer" },
      { key: "INSTALL_IN_PROGRESS", label: "In Progress",          note: "On site" },
      { key: "INSTALL_COMPLETE",    label: "Complete",             note: "Checked with customer" },
      { key: "FINAL_INVOICE_SENT",  label: "Final Invoice Sent",   note: "Once signed off" },
    ]},
  { id: "aftercare",num: 9, label: "Aftercare",    color: "#7e22ce", bg: "#f3e8ff", headerBg: "#581c87",
    steps: [
      { key: "FINAL_PAYMENT", label: "Final Payment Received", note: "Mark when cleared" },
      { key: "THANK_YOU",     label: "Thank You Sent",         note: "Request a review" },
    ]},
];

// ── Sub-components ─────────────────────────────────────────────────────────

function MethodBadge({ method }: { method: HttpMethod }) {
  const c = METHOD_COLORS[method];
  const label = method === "client" ? "client" : method;
  return (
    <span
      className="inline-flex items-center px-1.5 py-px rounded text-[9px] font-bold font-mono shrink-0"
      style={{ background: c.bg, color: c.text }}
    >
      {label}
    </span>
  );
}

function FnCall({ a, color }: { a: ActionFn; color: string }) {
  return (
    <div
      className="mt-1.5 rounded-md border px-2 py-1.5 flex flex-col gap-1"
      style={{ borderColor: color + "44", background: color + "08" }}
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        <MethodBadge method={a.method} />
        <span className="font-mono text-[11px] font-semibold" style={{ color }}>
          {a.fn}
        </span>
      </div>
      {a.endpoint && (
        <span className="font-mono text-[9px] text-slate-400 truncate">{a.endpoint}</span>
      )}
    </div>
  );
}

function StatusBlock({ s, color }: { s: Status; color: string }) {
  if (s.isExit) {
    return (
      <div
        className="rounded-md px-2.5 py-2 flex items-center gap-2 border border-dashed border-red-300"
        style={{
          background: "repeating-linear-gradient(135deg, #fee2e2 0px, #fee2e2 4px, #fef2f2 4px, #fef2f2 10px)",
        }}
      >
        <span className="font-mono text-[12px] text-red-500 shrink-0">{s.exitIcon}</span>
        <div>
          <div className="font-mono text-[10px] text-red-400">EXIT</div>
          <div className="text-[11px] font-semibold text-red-700">{s.label}</div>
          <div className="font-mono text-[9px] text-red-400">{s.key}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-white overflow-hidden" style={{ borderColor: color + "33" }}>
      {/* Status header row */}
      <div className="px-2.5 pt-2 pb-1.5 border-b" style={{ borderColor: color + "22", background: color + "05" }}>
        <div className="flex items-start gap-2">
          <div className="w-2.5 h-2.5 rounded-full mt-0.5 shrink-0" style={{ background: color }} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[12px] font-semibold text-slate-800">{s.label}</span>
            </div>
            <div className="font-mono text-[9px] text-slate-400 mt-px">{s.key}</div>
          </div>
        </div>
        {s.hint && <div className="text-[10px] text-slate-500 mt-1 ml-4">{s.hint}</div>}
        {s.action && (
          <div className="ml-4">
            <FnCall a={s.action} color={color} />
          </div>
        )}
      </div>

      {/* Sub-statuses — always expanded */}
      {s.subs && (
        <div className="px-2.5 py-2 space-y-2" style={{ background: color + "03" }}>
          {s.subs.map((sub) => (
            <div key={sub.key} className="pl-2 border-l-2" style={{ borderColor: color + "44" }}>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, opacity: 0.5 }} />
                <span className="text-[11px] font-semibold text-slate-700">{sub.label}</span>
              </div>
              <div className="font-mono text-[9px] text-slate-400 mt-px ml-3">{sub.key}</div>
              {sub.action && (
                <div className="mt-1 ml-3">
                  <FnCall a={sub.action} color={color} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StageCard({ stage }: { stage: Stage }) {
  return (
    <div className="rounded-xl overflow-hidden border shrink-0" style={{ borderColor: stage.border, minWidth: 232, maxWidth: 248 }}>
      {/* Dark header */}
      <div className="px-3 py-2.5" style={{ background: stage.headerBg }}>
        <div className="flex items-center gap-2 mb-1">
          <div
            className="w-5 h-5 rounded flex items-center justify-center text-white text-[10px] font-bold font-mono shrink-0"
            style={{ background: stage.color }}
          >
            {stage.num}
          </div>
          <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-slate-400">
            {stage.phase === "crm" ? "crm" : "workflow"}
          </span>
        </div>
        <div className="text-[14px] font-bold text-white">{stage.label}</div>
        <div className="font-mono text-[9px] text-slate-400 mt-0.5 uppercase tracking-wider">
          stage.{stage.id}
        </div>
      </div>

      {/* Status list */}
      <div className="p-2.5 space-y-2" style={{ background: stage.bg }}>
        {stage.statuses.map((s) => (
          <StatusBlock key={s.key} s={s} color={stage.color} />
        ))}
      </div>
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-start shrink-0" style={{ paddingTop: 56 }}>
      <svg width="24" height="18" viewBox="0 0 24 18" fill="none">
        <path d="M1 9H19M14 3L21 9L14 15" stroke="#64748b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

// ── Root ───────────────────────────────────────────────────────────────────

export function AffordanceVisibility() {
  return (
    <div className="min-h-screen bg-slate-100 p-4 overflow-auto" style={{ fontFamily: "system-ui, sans-serif" }}>
      {/* Header */}
      <div className="mb-4 flex items-start gap-4">
        <div>
          <h1 className="text-[16px] font-bold text-slate-900 font-mono">
            CustomerJourneyMap
            <span className="text-slate-400 font-normal">.tsx</span>
          </h1>
          <p className="text-[11px] text-slate-500 mt-0.5 font-mono">
            // all statuses · functions surfaced · sub-statuses expanded
          </p>
        </div>
        {/* Legend */}
        <div className="ml-auto flex items-center gap-3 text-[10px] font-mono flex-wrap shrink-0">
          {(Object.entries(METHOD_COLORS) as [HttpMethod, {bg:string,text:string}][]).map(([m, c]) => (
            <span key={m} className="flex items-center gap-1">
              <span className="px-1.5 py-px rounded font-bold" style={{ background: c.bg, color: c.text }}>{m}</span>
            </span>
          ))}
          <span className="flex items-center gap-1 text-slate-400">
            <span className="px-1.5 py-px rounded border border-dashed border-red-300 text-red-500">EXIT</span>
          </span>
        </div>
      </div>

      {/* CRM phase */}
      <section className="mb-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="h-px flex-1 bg-blue-300" />
          <span className="font-mono text-[10px] font-bold text-blue-600 uppercase tracking-widest">
            // PHASE_1: CRM_SALES_PIPELINE — stages 0–3
          </span>
          <div className="h-px flex-1 bg-blue-300" />
        </div>
        <div className="flex items-start gap-2 overflow-x-auto pb-3">
          {STAGES.map((stage, i) => (
            <React.Fragment key={stage.id}>
              <StageCard stage={stage} />
              {i < STAGES.length - 1 && <Arrow />}
            </React.Fragment>
          ))}
          <Arrow />
          <div className="flex items-start shrink-0" style={{ paddingTop: 52 }}>
            <div
              className="rounded-lg px-3 py-2 font-mono text-[11px] font-bold text-white text-center"
              style={{ background: "#334155" }}
            >
              READY_FOR_<br />PRODUCTION
            </div>
          </div>
        </div>
      </section>

      {/* Production phase */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <div className="h-px flex-1 bg-emerald-300" />
          <span className="font-mono text-[10px] font-bold text-emerald-600 uppercase tracking-widest">
            // PHASE_2: PRODUCTION_WORKFLOW — stages 4–9 (internal checklist)
          </span>
          <div className="h-px flex-1 bg-emerald-300" />
        </div>
        <div className="flex items-start gap-2 overflow-x-auto pb-3">
          {PROD_STAGES.map((stage, si) => (
            <React.Fragment key={stage.id}>
              <div className="rounded-xl overflow-hidden border shrink-0" style={{ borderColor: stage.color + "66", minWidth: 175 }}>
                <div className="px-3 py-2.5" style={{ background: stage.headerBg }}>
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className="w-5 h-5 rounded flex items-center justify-center text-white text-[10px] font-bold font-mono"
                      style={{ background: stage.color }}
                    >
                      {stage.num}
                    </div>
                    <span className="font-mono text-[9px] text-slate-400 uppercase tracking-wider">workflow</span>
                  </div>
                  <div className="text-[13px] font-bold text-white">{stage.label}</div>
                  <div className="font-mono text-[9px] text-slate-400 mt-0.5">stage.{stage.id}</div>
                </div>
                <div className="p-2.5 space-y-1.5" style={{ background: stage.bg }}>
                  {stage.steps.map((step) => (
                    <div
                      key={step.key}
                      className="rounded-md bg-white border px-2 py-1.5"
                      style={{ borderColor: stage.color + "33" }}
                    >
                      <div className="flex items-start gap-1.5">
                        <div
                          className="w-3.5 h-3.5 rounded border-2 shrink-0 mt-px flex items-center justify-center"
                          style={{ borderColor: stage.color }}
                        >
                          <span className="text-[7px]" style={{ color: stage.color }}>✓</span>
                        </div>
                        <div>
                          <div className="text-[11px] font-semibold text-slate-800 leading-snug">{step.label}</div>
                          {step.note && <div className="font-mono text-[9px] text-slate-400 mt-px">{step.note}</div>}
                          <div className="font-mono text-[9px] text-slate-300 mt-px">{step.key}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              {si < PROD_STAGES.length - 1 && <Arrow />}
            </React.Fragment>
          ))}
          <div className="flex items-center shrink-0 ml-2">
            <div
              className="font-mono text-[11px] font-bold text-white px-3 py-2 rounded-lg shadow-md text-center"
              style={{ background: "#16a34a" }}
            >
              STATUS.<br />COMPLETE 🎉
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
