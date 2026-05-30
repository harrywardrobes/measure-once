/**
 * V2 — Affordance Visibility
 *
 * Tradeoff: every interactive element looks exactly like what it does.
 * All sub-statuses are pre-expanded — no hidden state.
 * Action buttons look like real buttons with explicit call-to-action text.
 * The pipeline is a swimlane with thick directional arrows.
 * Active/complete state indicators show progress at a glance.
 *
 * What you give up: density — the expanded layout is wider/taller,
 * and the page requires more scrolling to see everything.
 */

import React from "react";

type Sub = { key: string; label: string; action?: string };
type Status = { key: string; label: string; hint?: string; subs?: Sub[]; isExit?: boolean };

const STAGES = [
  {
    id: "entry", num: 0, label: "New Enquiry", phase: "crm" as const,
    color: "#7c3aed", bg: "#f5f3ff", border: "#c4b5fd",
    statuses: [
      { key: "new", label: "New Contact", hint: "Lead enters system",
        subs: [
          { key: "web", label: "Web Form", action: "New Enquiry" },
          { key: "email", label: "Email", action: "New Enquiry" },
          { key: "wa", label: "WhatsApp", action: "New Enquiry" },
          { key: "call", label: "Phone Call", action: "Summarise Call" },
          { key: "insta", label: "Instagram", action: "New Enquiry" },
          { key: "fb", label: "Facebook", action: "New Enquiry" },
        ],
      },
    ],
  },
  {
    id: "sales", num: 1, label: "Sales", phase: "crm" as const,
    color: "#2563eb", bg: "#eff6ff", border: "#93c5fd",
    statuses: [
      { key: "form_sub", label: "Form Submission", hint: "Email + WhatsApp customer asking for more information" },
      { key: "atc", label: "Attempted to Contact", hint: "No response → call within 2 working days",
        subs: [
          { key: "email", label: "Email Sent" },
          { key: "wa", label: "WhatsApp Sent" },
          { key: "call", label: "Call Attempted" },
          { key: "nr", label: "No Response" },
        ],
      },
      { key: "ip", label: "In Progress", hint: "Actively discussing requirements" },
      { key: "photos", label: "Awaiting Photos", hint: "Customer sending room photos / measurements",
        subs: [
          { key: "more_info", label: "More Info Requested" },
          { key: "received", label: "Photos Received", action: "Review Customer Photos" },
        ],
      },
      { key: "est", label: "Rough Estimate", hint: "Estimate shared — awaiting customer decision" },
      { key: "no_response", label: "No Response ×3", isExit: true },
      { key: "unqualified", label: "Unqualified", isExit: true },
      { key: "not_suitable", label: "Not Suitable", isExit: true },
      { key: "bad_timing", label: "Bad Timing", isExit: true },
    ],
  },
  {
    id: "dv", num: 2, label: "Design Visit", phase: "crm" as const,
    color: "#4338ca", bg: "#eef2ff", border: "#a5b4fc",
    statuses: [
      { key: "sched", label: "Design Scheduled", hint: "Add date to calendar",
        subs: [
          { key: "sug", label: "Date Suggested", action: "Re-Send Invite" },
          { key: "agr", label: "Date Agreed", action: "Add Design Visit to Calendar" },
          { key: "con", label: "Date Confirmed", action: "Start Design Meeting" },
          { key: "can", label: "Visit Cancelled" },
        ],
      },
      { key: "dip", label: "Design In Progress", hint: "Design meeting underway" },
      { key: "od", label: "Open Deal", hint: "Estimate sent — awaiting acceptance",
        subs: [{ key: "amd", label: "Amendments Needed", action: "Send New Estimate" }],
      },
      { key: "da", label: "Design Accepted", hint: "Customer approved design & estimate" },
    ],
  },
  {
    id: "survey", num: 3, label: "Survey", phase: "crm" as const,
    color: "#0891b2", bg: "#ecfeff", border: "#67e8f9",
    statuses: [
      { key: "dep", label: "Awaiting Deposit Invoice", hint: "Invoice issued — awaiting payment",
        subs: [{ key: "rcv", label: "Deposit Invoice Received", action: "Suggest Survey Dates" }],
      },
      { key: "ss", label: "Survey Scheduled",
        subs: [
          { key: "sug", label: "Survey Date Suggested" },
          { key: "agr", label: "Survey Date Agreed", action: "Add Survey Visit to Calendar" },
          { key: "con", label: "Survey Visit Confirmed", action: "Start Survey Meeting" },
          { key: "can", label: "Survey Cancelled", action: "Refund Customer" },
        ],
      },
      { key: "sip", label: "Survey In Progress", hint: "Check date with customer" },
      { key: "sent", label: "Survey Sent", hint: "Final survey sent to customer",
        subs: [{ key: "amd", label: "Amendments Needed", action: "Send New Survey" }],
      },
      { key: "rfp", label: "Ready for Production", hint: "Email customer — confirm installation date" },
    ],
  },
];

const PROD_STAGES = [
  { id: "order", num: 4, label: "Order", color: "#059669", bg: "#ecfdf5",
    steps: ["Order Doors", "Order Sheets", "Order Hardware"] },
  { id: "workshop", num: 5, label: "Workshop", color: "#0d9488", bg: "#f0fdfa",
    steps: ["Print Installer Pack", "Print Labels", "Notify Customer", "Prep Framework / MDF", "Prep Sheet Materials", "Cut Sheet Materials"] },
  { id: "packing", num: 6, label: "Packing", color: "#d97706", bg: "#fffbeb",
    steps: ["Packing In Progress", "Date / Time Agreed", "Ready to Load"] },
  { id: "delivery", num: 7, label: "Delivery", color: "#ea580c", bg: "#fff7ed",
    steps: ["Loaded into Van", "Delivered"] },
  { id: "install", num: 8, label: "Installation", color: "#e11d48", bg: "#fff1f2",
    steps: ["Scheduled", "In Progress", "Complete", "Final Invoice Sent"] },
  { id: "aftercare", num: 9, label: "Aftercare", color: "#9333ea", bg: "#faf5ff",
    steps: ["Final Payment Received", "Thank You Sent"] },
];

function ActionButton({ label, color }: { label: string; color: string }) {
  return (
    <button
      className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold text-white cursor-default select-none"
      style={{ background: color }}
    >
      <span>▶</span>
      {label}
    </button>
  );
}

function StatusRow({ s, color }: { s: Status; color: string }) {
  if (s.isExit) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-red-50 border border-red-200">
        <div className="w-2.5 h-2.5 rotate-45 bg-red-400 shrink-0" />
        <span className="text-[11px] font-semibold text-red-700">{s.label}</span>
        <span className="ml-auto text-[9px] text-red-400 uppercase tracking-wider font-medium">Exit</span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-100 bg-white shadow-sm overflow-hidden">
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <div className="w-3 h-3 rounded-full mt-0.5 shrink-0" style={{ background: color }} />
        <div className="flex-1">
          <div className="text-[12px] font-semibold text-slate-800">{s.label}</div>
          {s.hint && <div className="text-[10px] text-slate-500 mt-0.5">{s.hint}</div>}
        </div>
      </div>
      {s.subs && (
        <div className="border-t border-slate-100 px-3 py-2 space-y-1.5" style={{ background: `${color}08` }}>
          {s.subs.map((sub) => (
            <div key={sub.key} className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, opacity: 0.5 }} />
              <span className="text-[11px] text-slate-600 flex-1">{sub.label}</span>
              {sub.action && <ActionButton label={sub.action} color={color} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BigArrow() {
  return (
    <div className="flex items-start shrink-0" style={{ paddingTop: 16 }}>
      <svg width="36" height="24" viewBox="0 0 36 24" fill="none">
        <path d="M2 12H28M22 5L32 12L22 19" stroke="#94a3b8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function AffordanceVisibility() {
  return (
    <div className="min-h-screen bg-slate-50 p-5 overflow-auto">
      {/* Header */}
      <div className="mb-5 flex items-start gap-6">
        <div>
          <h1 className="text-lg font-bold text-slate-900">Customer Journey Map</h1>
          <p className="text-[11px] text-slate-500 mt-0.5">All sub-statuses expanded · Action buttons visible at a glance</p>
        </div>
        <div className="text-[10px] text-slate-500 bg-white border border-slate-200 rounded-lg px-3 py-2 max-w-xs ml-auto shrink-0">
          <span className="font-bold text-slate-700 block mb-0.5">V2 — Affordance Visibility</span>
          Tradeoff: all sub-statuses shown, buttons look actionable. You give up: density — layout is wider.
        </div>
      </div>

      {/* CRM Swimlane */}
      <div className="mb-2">
        <div className="text-[10px] font-bold uppercase tracking-widest text-blue-600 mb-3 flex items-center gap-2">
          <div className="h-0.5 flex-1 bg-blue-200" />
          Phase 1 — CRM Sales Pipeline
          <div className="h-0.5 flex-1 bg-blue-200" />
        </div>
        <div className="flex items-start gap-2 overflow-x-auto pb-3">
          {STAGES.map((stage, si) => (
            <React.Fragment key={stage.id}>
              <div
                className="rounded-xl border-2 overflow-hidden shrink-0"
                style={{ borderColor: stage.border, minWidth: 220, maxWidth: 240 }}
              >
                {/* Stage header */}
                <div className="px-3 py-2.5" style={{ background: stage.bg }}>
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                      style={{ background: stage.color }}
                    >
                      {stage.num}
                    </div>
                    <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: stage.color }}>
                      CRM
                    </span>
                  </div>
                  <div className="text-[14px] font-bold" style={{ color: stage.color }}>
                    {stage.label}
                  </div>
                </div>
                {/* Statuses */}
                <div className="p-3 space-y-2 bg-white">
                  {stage.statuses.map((s) => (
                    <StatusRow key={s.key} s={s} color={stage.color} />
                  ))}
                </div>
              </div>
              {si < STAGES.length - 1 && <BigArrow />}
            </React.Fragment>
          ))}
          <BigArrow />
          <div className="flex items-start shrink-0 pt-2">
            <div className="px-3 py-2 rounded-lg bg-slate-700 text-white text-xs font-bold text-center">
              Ready for<br />Production
            </div>
          </div>
        </div>
      </div>

      {/* Production Swimlane */}
      <div>
        <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-600 mb-3 flex items-center gap-2">
          <div className="h-0.5 flex-1 bg-emerald-200" />
          Phase 2 — Production Workflow (Checklist)
          <div className="h-0.5 flex-1 bg-emerald-200" />
        </div>
        <div className="flex items-start gap-2 overflow-x-auto pb-3">
          {PROD_STAGES.map((stage, si) => (
            <React.Fragment key={stage.id}>
              <div
                className="rounded-xl border-2 overflow-hidden shrink-0"
                style={{ borderColor: stage.color + "66", minWidth: 180 }}
              >
                <div className="px-3 py-2" style={{ background: stage.bg }}>
                  <div className="flex items-center gap-2 mb-0.5">
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold shrink-0"
                      style={{ background: stage.color }}
                    >
                      {stage.num}
                    </div>
                    <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: stage.color }}>
                      Workflow
                    </span>
                  </div>
                  <div className="text-[13px] font-bold" style={{ color: stage.color }}>
                    {stage.label}
                  </div>
                </div>
                <div className="px-3 py-2 bg-white space-y-1.5">
                  {stage.steps.map((step, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div
                        className="w-4 h-4 rounded border-2 shrink-0 flex items-center justify-center"
                        style={{ borderColor: stage.color + "66" }}
                      >
                        <span className="text-[8px]" style={{ color: stage.color }}>✓</span>
                      </div>
                      <span className="text-[11px] text-slate-600">{step}</span>
                    </div>
                  ))}
                </div>
              </div>
              {si < PROD_STAGES.length - 1 && <BigArrow />}
            </React.Fragment>
          ))}
          <div className="flex items-center shrink-0 ml-1">
            <div className="px-3 py-2.5 rounded-full bg-green-600 text-white text-xs font-bold shadow-md">
              🎉 Complete
            </div>
          </div>
        </div>
      </div>

      {/* Decision table */}
      <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 max-w-2xl">
        <h4 className="text-[12px] font-bold text-amber-800 mb-2">If / Then decisions in Sales</h4>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
          {[
            ["3 contact attempts, no reply", "→ No Response (exit)"],
            ["No budget / doesn't fit criteria", "→ Unqualified (exit)"],
            ["Project out of scope", "→ Not Suitable (exit)"],
            ["Right fit, wrong timing", "→ Bad Timing (re-engage ~1 month)"],
            ["Rough estimate accepted", "→ Proceed to Design Visit"],
            ["Design visit cancelled", "→ Return to Sales or close"],
            ["Open deal — amendments", "→ Revised estimate, stay in DV"],
            ["Survey cancelled", "→ Refund customer, review case"],
          ].map(([cond, result], i) => (
            <React.Fragment key={i}>
              <div className="text-amber-700 font-medium">{cond}</div>
              <div className="text-amber-900 font-semibold">{result}</div>
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
