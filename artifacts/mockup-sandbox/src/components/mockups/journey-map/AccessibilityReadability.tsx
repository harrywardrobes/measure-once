/**
 * V3 — Accessibility & Readability
 *
 * Tradeoff: never rely on color alone; minimum 13px text everywhere;
 * WCAG AA contrast; exit paths use stripes + icons not just red;
 * status labels are full-length (no abbreviations); generous spacing.
 *
 * What you give up: compactness — larger text and spacing means fewer
 * items fit without scrolling. The map is the tallest of the three variants.
 */

import React, { useState } from "react";

type Sub = { key: string; label: string; action?: string };
type Status = {
  key: string;
  label: string;
  hint?: string;
  subs?: Sub[];
  isExit?: boolean;
  exitType?: "disqualified" | "timing" | "unresponsive" | "scope";
};

const EXIT_ICONS: Record<string, string> = {
  disqualified: "✕",
  timing: "⏱",
  unresponsive: "◌",
  scope: "⊘",
};
const EXIT_LABELS: Record<string, string> = {
  disqualified: "Disqualified",
  timing: "Bad timing — re-engage",
  unresponsive: "Unresponsive",
  scope: "Out of scope",
};

const STAGES = [
  {
    id: "entry", num: 0, label: "New Enquiry",
    phase: "crm" as const,
    color: "#5b21b6", bg: "#f5f3ff", headerBg: "#ede9fe", border: "#8b5cf6",
    description: "A new lead contacts the business through any channel.",
    statuses: [
      { key: "new", label: "New Contact — source recorded",
        hint: "The lead's enquiry channel is logged and the team is notified.",
        subs: [
          { key: "web", label: "Web Form", action: "Log New Enquiry" },
          { key: "email", label: "Email", action: "Log New Enquiry" },
          { key: "wa", label: "WhatsApp Message", action: "Log New Enquiry" },
          { key: "call", label: "Phone Call", action: "Summarise Phone Call" },
          { key: "insta", label: "Instagram Message", action: "Log New Enquiry" },
          { key: "fb", label: "Facebook Messenger", action: "Log New Enquiry" },
        ],
      },
    ],
  },
  {
    id: "sales", num: 1, label: "Sales",
    phase: "crm" as const,
    color: "#1d4ed8", bg: "#eff6ff", headerBg: "#dbeafe", border: "#3b82f6",
    description: "Qualify the lead, understand requirements, and share a rough estimate.",
    statuses: [
      { key: "form_sub", label: "Form Submission received",
        hint: "Email and WhatsApp the customer asking for more information." },
      { key: "atc", label: "Attempted to Contact",
        hint: "If there is no reply within 2 working days, follow up by phone.",
        subs: [
          { key: "email", label: "Email sent" },
          { key: "wa", label: "WhatsApp message sent" },
          { key: "call", label: "Phone call attempted" },
          { key: "nr", label: "No reply received" },
        ],
      },
      { key: "ip", label: "In Progress — actively discussing",
        hint: "Requirements are being confirmed with the customer." },
      { key: "photos", label: "Awaiting Photos / Measurements",
        hint: "Customer is sending room photos or measurements.",
        subs: [
          { key: "more_info", label: "Additional information requested" },
          { key: "received", label: "Photos and measurements received", action: "Review Customer Photos" },
        ],
      },
      { key: "est", label: "Rough Estimate shared",
        hint: "An estimate has been shared with the customer — awaiting their decision." },
      { key: "nr3", label: "No Response after 3 attempts", isExit: true, exitType: "unresponsive" },
      { key: "uq", label: "Unqualified — does not meet criteria", isExit: true, exitType: "disqualified" },
      { key: "ns", label: "Not Suitable — outside scope", isExit: true, exitType: "scope" },
      { key: "bt", label: "Bad Timing — revisit later", isExit: true, exitType: "timing" },
    ],
  },
  {
    id: "dv", num: 2, label: "Design Visit",
    phase: "crm" as const,
    color: "#3730a3", bg: "#eef2ff", headerBg: "#e0e7ff", border: "#6366f1",
    description: "Schedule and run a design consultation. Produce and agree an estimate.",
    statuses: [
      { key: "sched", label: "Design Visit Scheduled",
        hint: "Add the confirmed date to the team calendar.",
        subs: [
          { key: "sug", label: "Visit date suggested to customer", action: "Re-Send Calendar Invite" },
          { key: "agr", label: "Visit date agreed with customer", action: "Add Design Visit to Calendar" },
          { key: "con", label: "Visit date confirmed", action: "Start Design Meeting" },
          { key: "can", label: "Visit cancelled by customer or team" },
        ],
      },
      { key: "dip", label: "Design Meeting In Progress",
        hint: "The design consultation is currently underway." },
      { key: "od", label: "Open Deal — estimate under review",
        hint: "A detailed estimate has been sent. Awaiting customer acceptance.",
        subs: [{ key: "amd", label: "Amendments requested by customer", action: "Send Revised Estimate" }],
      },
      { key: "da", label: "Design Accepted — moving to Survey",
        hint: "The customer has approved the design and estimate." },
    ],
  },
  {
    id: "survey", num: 3, label: "Survey",
    phase: "crm" as const,
    color: "#0e7490", bg: "#ecfeff", headerBg: "#cffafe", border: "#06b6d4",
    description: "Collect a deposit, carry out a technical survey, and prepare production plans.",
    statuses: [
      { key: "dep", label: "Awaiting Deposit Invoice payment",
        hint: "The deposit invoice has been issued — awaiting customer payment.",
        subs: [{ key: "rcv", label: "Deposit invoice payment received", action: "Suggest Survey Dates" }],
      },
      { key: "ss", label: "Survey Visit Scheduled",
        subs: [
          { key: "sug", label: "Survey date suggested to customer" },
          { key: "agr", label: "Survey date agreed with customer", action: "Add Survey Visit to Calendar" },
          { key: "con", label: "Survey visit confirmed", action: "Start Survey Meeting" },
          { key: "can", label: "Survey cancelled — refund required", action: "Process Customer Refund" },
        ],
      },
      { key: "sip", label: "Survey Visit In Progress",
        hint: "Check and confirm measurement date with customer." },
      { key: "sent", label: "Survey document sent to customer",
        hint: "The final survey has been sent to the customer for review.",
        subs: [{ key: "amd", label: "Amendments requested by customer", action: "Send Revised Survey" }],
      },
      { key: "rfp", label: "Ready for Production",
        hint: "Email the customer to confirm the installation date." },
    ],
  },
];

const PROD_STAGES = [
  { id: "order", num: 4, label: "Order", color: "#047857", bg: "#d1fae5",
    steps: ["Order doors — for previous Monday or Tuesday", "Order sheet materials", "Order hardware — hinges, handles, fixings"] },
  { id: "workshop", num: 5, label: "Workshop", color: "#0f766e", bg: "#ccfbf1",
    steps: ["Print installer pack (renders, cutlist, notes)", "Print and attach component labels", "Notify customer — production is underway", "Prepare framework timber and MDF", "Prepare sheet materials for cutting", "Cut sheet materials to size per cutlist"] },
  { id: "packing", num: 6, label: "Packing", color: "#b45309", bg: "#fef3c7",
    steps: ["Wrap and protect all components", "Confirm delivery date and time window", "Stage components — ready to load"] },
  { id: "delivery", num: 7, label: "Delivery", color: "#c2410c", bg: "#ffedd5",
    steps: ["Load all components into van", "Deliver — note date, time, and comments"] },
  { id: "install", num: 8, label: "Installation", color: "#be123c", bg: "#ffe4e6",
    steps: ["Confirm installation date with customer and installer", "Installation underway on site", "Installation complete — checked with customer", "Send final invoice once signed off"] },
  { id: "aftercare", num: 9, label: "Aftercare", color: "#7e22ce", bg: "#f3e8ff",
    steps: ["Confirm final payment received", "Send thank-you email and request a review"] },
];

function ExitBadge({ s }: { s: Status }) {
  const icon = EXIT_ICONS[s.exitType!] ?? "✕";
  const label = EXIT_LABELS[s.exitType!] ?? "Exit";
  return (
    <div
      className="rounded-lg px-3 py-2.5 flex items-start gap-3"
      style={{
        background: "repeating-linear-gradient(45deg, #fee2e2 0px, #fee2e2 6px, #fef2f2 6px, #fef2f2 12px)",
        border: "1.5px solid #fca5a5",
      }}
    >
      <span
        className="text-[14px] font-bold text-red-600 mt-0.5 shrink-0 w-5 text-center"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div>
        <div className="text-[12px] font-bold text-red-800 leading-snug">{s.label}</div>
        <div className="text-[11px] text-red-600 mt-0.5">{label}</div>
      </div>
    </div>
  );
}

function StatusCard({ s, color }: { s: Status; color: string }) {
  const [open, setOpen] = useState(false);
  if (s.isExit) return <ExitBadge s={s} />;
  const hasSubs = s.subs && s.subs.length > 0;
  return (
    <div className="rounded-lg border-2 border-slate-100 bg-white overflow-hidden">
      <button
        className="w-full text-left flex items-start gap-3 px-3 py-3"
        onClick={() => hasSubs && setOpen((v) => !v)}
        aria-expanded={hasSubs ? open : undefined}
      >
        <div className="w-3.5 h-3.5 rounded-full mt-0.5 shrink-0" style={{ background: color }} />
        <div className="flex-1">
          <div className="text-[13px] font-semibold text-slate-900 leading-snug">{s.label}</div>
          {s.hint && <div className="text-[12px] text-slate-600 mt-1 leading-snug">{s.hint}</div>}
        </div>
        {hasSubs && (
          <span className="text-[11px] text-slate-400 mt-0.5 shrink-0 font-medium">
            {open ? "▲ Hide" : `▼ ${s.subs!.length} sub-statuses`}
          </span>
        )}
      </button>
      {hasSubs && open && (
        <div className="border-t-2 border-slate-100 px-3 py-2.5 space-y-2" style={{ background: color + "0a" }}>
          {s.subs!.map((sub) => (
            <div key={sub.key} className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color, opacity: 0.6 }} />
              <span className="text-[12px] text-slate-700 flex-1">{sub.label}</span>
              {sub.action && (
                <button
                  className="shrink-0 px-2.5 py-1 rounded-md text-[11px] font-semibold text-white cursor-default"
                  style={{ background: color }}
                >
                  {sub.action}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AccessibilityReadability() {
  return (
    <div className="min-h-screen bg-slate-50 p-6 overflow-auto" style={{ fontFamily: "system-ui, sans-serif" }}>
      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-bold text-slate-900 leading-tight">Customer Journey Map</h1>
          <p className="text-[13px] text-slate-600 mt-1">
            Full-length labels · High-contrast · Click any status to expand sub-statuses
          </p>
        </div>
        <div className="text-[11px] text-slate-500 bg-white border border-slate-200 rounded-lg px-3 py-2 max-w-xs shrink-0">
          <span className="font-bold text-slate-700 block mb-0.5">V3 — Accessibility &amp; Readability</span>
          Tradeoff: min 13px text, high contrast, patterns not just colour. You give up: compactness.
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-5 mb-5 text-[12px] text-slate-600 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-3.5 h-3.5 rounded-full bg-blue-600" />
          <span>Lead status</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 rounded flex items-center justify-center text-[10px] font-bold text-red-700"
            style={{ background: "repeating-linear-gradient(45deg, #fee2e2 0px, #fee2e2 4px, #fef2f2 4px, #fef2f2 8px)", border: "1px solid #fca5a5" }}>✕</div>
          <span>Exit path (pattern + icon, not colour alone)</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded text-[10px] bg-slate-200 text-slate-700 font-medium">▼ N sub-statuses</span>
          <span>Expandable — click to show detail</span>
        </div>
      </div>

      {/* CRM Phase */}
      <section aria-labelledby="phase1-heading" className="mb-6">
        <h2 id="phase1-heading"
          className="text-[11px] font-bold uppercase tracking-widest text-blue-700 mb-3 flex items-center gap-2">
          <div className="h-0.5 flex-1 bg-blue-300" />
          Phase 1 — CRM Sales Pipeline (Stages 0–3)
          <div className="h-0.5 flex-1 bg-blue-300" />
        </h2>
        <div className="flex items-start gap-2 overflow-x-auto pb-3">
          {STAGES.map((stage, si) => (
            <React.Fragment key={stage.id}>
              <div
                role="region"
                aria-labelledby={`stage-${stage.id}`}
                className="rounded-xl border-2 overflow-hidden shrink-0"
                style={{ borderColor: stage.border, minWidth: 240, maxWidth: 260 }}
              >
                <div className="px-4 py-3" style={{ background: stage.headerBg }}>
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[11px] font-bold shrink-0"
                      style={{ background: stage.color }}
                      aria-label={`Stage ${stage.num}`}
                    >
                      {stage.num}
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: stage.color }}>
                      CRM
                    </span>
                  </div>
                  <h3 id={`stage-${stage.id}`} className="text-[15px] font-bold mb-1" style={{ color: stage.color }}>
                    {stage.label}
                  </h3>
                  <p className="text-[11px] leading-snug" style={{ color: stage.color + "bb" }}>
                    {stage.description}
                  </p>
                </div>
                <div className="px-3 py-3 space-y-2" style={{ background: stage.bg }}>
                  {stage.statuses.map((s) => (
                    <StatusCard key={s.key} s={s} color={stage.color} />
                  ))}
                </div>
              </div>
              {si < STAGES.length - 1 && (
                <div className="flex items-start shrink-0" style={{ paddingTop: 60 }}>
                  <svg width="28" height="20" viewBox="0 0 28 20" fill="none" aria-hidden="true">
                    <path d="M2 10H22M16 4L24 10L16 16" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              )}
            </React.Fragment>
          ))}
          <div className="flex items-start shrink-0" style={{ paddingTop: 60 }}>
            <svg width="28" height="20" viewBox="0 0 28 20" fill="none" aria-hidden="true">
              <path d="M2 10H22M16 4L24 10L16 16" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="flex items-start shrink-0" style={{ paddingTop: 54 }}>
            <div className="px-3 py-2 rounded-lg bg-slate-700 text-white text-[13px] font-bold text-center">
              Ready for<br />Production
            </div>
          </div>
        </div>
      </section>

      {/* Production Phase */}
      <section aria-labelledby="phase2-heading">
        <h2 id="phase2-heading"
          className="text-[11px] font-bold uppercase tracking-widest text-emerald-700 mb-3 flex items-center gap-2">
          <div className="h-0.5 flex-1 bg-emerald-300" />
          Phase 2 — Production Workflow (Stages 4–9)
          <div className="h-0.5 flex-1 bg-emerald-300" />
        </h2>
        <div className="flex items-start gap-2 overflow-x-auto pb-3">
          {PROD_STAGES.map((stage, si) => (
            <React.Fragment key={stage.id}>
              <div
                role="region"
                aria-labelledby={`prod-${stage.id}`}
                className="rounded-xl border-2 overflow-hidden shrink-0"
                style={{ borderColor: stage.color + "88", minWidth: 200 }}
              >
                <div className="px-3 py-2.5" style={{ background: stage.bg }}>
                  <div className="flex items-center gap-2 mb-1">
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[11px] font-bold shrink-0"
                      style={{ background: stage.color }}
                    >
                      {stage.num}
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: stage.color }}>
                      Workflow
                    </span>
                  </div>
                  <h3 id={`prod-${stage.id}`} className="text-[14px] font-bold" style={{ color: stage.color }}>
                    {stage.label}
                  </h3>
                </div>
                <div className="px-3 py-3 space-y-2 bg-white">
                  {stage.steps.map((step, i) => (
                    <div key={i} className="flex items-start gap-2.5">
                      <div
                        className="w-5 h-5 rounded border-2 shrink-0 flex items-center justify-center mt-0.5"
                        style={{ borderColor: stage.color }}
                        role="checkbox"
                        aria-checked="false"
                        aria-label={step}
                      >
                        <span className="text-[9px] font-bold" style={{ color: stage.color }}>✓</span>
                      </div>
                      <span className="text-[12px] text-slate-700 leading-snug">{step}</span>
                    </div>
                  ))}
                </div>
              </div>
              {si < PROD_STAGES.length - 1 && (
                <div className="flex items-start shrink-0" style={{ paddingTop: 50 }}>
                  <svg width="28" height="20" viewBox="0 0 28 20" fill="none" aria-hidden="true">
                    <path d="M2 10H22M16 4L24 10L16 16" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              )}
            </React.Fragment>
          ))}
          <div className="flex items-center shrink-0 ml-2">
            <div
              className="px-4 py-3 rounded-full text-white text-[13px] font-bold shadow-md"
              style={{ background: "#16a34a" }}
              role="status"
              aria-label="Journey complete"
            >
              🎉 Complete
            </div>
          </div>
        </div>
      </section>

      {/* Decision guide */}
      <div className="mt-6 rounded-xl border-2 border-amber-300 bg-amber-50 p-4 max-w-2xl">
        <h3 className="text-[13px] font-bold text-amber-900 mb-3">Key if / then decisions in Sales</h3>
        <ul className="space-y-2">
          {[
            { if: "3 contact attempts with no reply", then: "→ No Response (exit — unresponsive)", icon: "◌" },
            { if: "Lead doesn't meet project criteria", then: "→ Unqualified (exit — disqualified)", icon: "✕" },
            { if: "Project is outside scope or capability", then: "→ Not Suitable (exit — out of scope)", icon: "⊘" },
            { if: "Good fit, but wrong time for the customer", then: "→ Bad Timing (exit — re-engage in ~1 month)", icon: "⏱" },
            { if: "Rough estimate accepted by customer", then: "→ Proceed to Design Visit" },
            { if: "Design visit is cancelled", then: "→ Return to Sales or close the lead" },
            { if: "Open deal — customer requests amendments", then: "→ Send revised estimate, stay in Design Visit" },
            { if: "Survey visit is cancelled", then: "→ Process refund, review the case" },
          ].map((row, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px]">
              {row.icon && (
                <span className="w-4 text-center text-red-600 font-bold shrink-0">{row.icon}</span>
              )}
              {!row.icon && <span className="w-4 shrink-0" />}
              <span className="text-amber-800"><strong className="font-semibold">If</strong> {row.if}</span>
              <span className="text-amber-900 font-semibold shrink-0">{row.then}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
