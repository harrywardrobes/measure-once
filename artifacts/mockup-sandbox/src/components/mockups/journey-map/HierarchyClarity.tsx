/**
 * V1 — Information Hierarchy
 *
 * Tradeoff: ruthless visual weight separation.
 * Stage numbers + labels dominate. Primary statuses are large.
 * Sub-statuses are always visible but visually subordinate (never hidden).
 * Exit paths are pulled to a dedicated sidebar — out of the main flow.
 * You immediately see the shape of the whole journey; detail is accessible
 * without interaction.
 *
 * What you give up: the page is tall — scanning everything takes scrolling.
 */

import React from "react";

type Sub = { key: string; label: string; action?: string };
type Status = { key: string; label: string; hint?: string; subs?: Sub[] };
type ExitStatus = { key: string; label: string; hint: string; reason: string };
type Stage = {
  num: number;
  id: string;
  label: string;
  phase: "crm" | "prod";
  accent: string;
  accentBg: string;
  accentText: string;
  borderClass: string;
  statuses: Status[];
};

const EXIT_PATHS: ExitStatus[] = [
  { key: "NO_RESPONSE", label: "No Response ×3", hint: "3 contact attempts, no reply", reason: "Unresponsive" },
  { key: "UNQUALIFIED", label: "Unqualified", hint: "Lead doesn't meet project criteria", reason: "Not a fit" },
  { key: "NOT_SUITABLE", label: "Not Suitable", hint: "Project outside scope", reason: "Out of scope" },
  { key: "BAD_TIMING", label: "Bad Timing", hint: "Re-engage in ~1 month", reason: "Too early" },
];

const STAGES: Stage[] = [
  {
    num: 0, id: "entry", label: "New Enquiry", phase: "crm",
    accent: "#7c3aed", accentBg: "#f5f3ff", accentText: "#4c1d95",
    borderClass: "border-violet-300",
    statuses: [
      { key: "new", label: "New Contact", hint: "Lead enters via any channel",
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
    num: 1, id: "sales", label: "Sales", phase: "crm",
    accent: "#2563eb", accentBg: "#eff6ff", accentText: "#1e3a8a",
    borderClass: "border-blue-300",
    statuses: [
      { key: "form_sub", label: "Form Submission", hint: "Email + WhatsApp asking for more information" },
      { key: "atc", label: "Attempted to Contact", hint: "If no response in 2 working days, call to discuss",
        subs: [
          { key: "atcn_email", label: "Email Sent" },
          { key: "atcn_wa", label: "WhatsApp Sent" },
          { key: "atcn_call", label: "Call Attempted" },
          { key: "atcn_nr", label: "No Response" },
        ],
      },
      { key: "in_progress", label: "In Progress", hint: "Actively discussing requirements" },
      { key: "awaiting_photos", label: "Awaiting Photos", hint: "Customer sending room photos / measurements",
        subs: [
          { key: "more_info", label: "More Info Requested" },
          { key: "received", label: "Photos Received", action: "Review Photos" },
        ],
      },
      { key: "rough_est", label: "Rough Estimate", hint: "Estimate shared — awaiting decision" },
    ],
  },
  {
    num: 2, id: "dv", label: "Design Visit", phase: "crm",
    accent: "#4338ca", accentBg: "#eef2ff", accentText: "#312e81",
    borderClass: "border-indigo-300",
    statuses: [
      { key: "ds", label: "Design Scheduled", hint: "Add date to calendar",
        subs: [
          { key: "sug", label: "Date Suggested", action: "Re-Send Invite" },
          { key: "agr", label: "Date Agreed", action: "Add to Calendar" },
          { key: "con", label: "Date Confirmed", action: "Start Meeting" },
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
    num: 3, id: "survey", label: "Survey", phase: "crm",
    accent: "#0891b2", accentBg: "#ecfeff", accentText: "#164e63",
    borderClass: "border-cyan-300",
    statuses: [
      { key: "dep", label: "Awaiting Deposit", hint: "Invoice issued — awaiting payment",
        subs: [{ key: "dep_rcv", label: "Deposit Received", action: "Suggest Survey Dates" }],
      },
      { key: "ss", label: "Survey Scheduled", hint: "",
        subs: [
          { key: "ss_sug", label: "Date Suggested" },
          { key: "ss_agr", label: "Date Agreed", action: "Add to Calendar" },
          { key: "ss_con", label: "Visit Confirmed", action: "Start Survey" },
          { key: "ss_can", label: "Survey Cancelled", action: "Refund Customer" },
        ],
      },
      { key: "sip", label: "Survey In Progress", hint: "Check date with customer" },
      { key: "sent", label: "Survey Sent", hint: "Final survey sent for review",
        subs: [{ key: "amd", label: "Amendments Needed", action: "Send New Survey" }],
      },
      { key: "rfp", label: "Ready for Production", hint: "Email customer to confirm installation date" },
    ],
  },
  {
    num: 4, id: "order", label: "Order", phase: "prod",
    accent: "#059669", accentBg: "#ecfdf5", accentText: "#064e3b",
    borderClass: "border-emerald-300",
    statuses: [
      { key: "doors", label: "Order Doors", hint: "For previous Mon or Tue" },
      { key: "sheets", label: "Order Sheets", hint: "Sheet materials for workshop prep" },
      { key: "hardware", label: "Order Hardware", hint: "Hinges, handles, fixings" },
    ],
  },
  {
    num: 5, id: "workshop", label: "Workshop", phase: "prod",
    accent: "#0d9488", accentBg: "#f0fdfa", accentText: "#134e4a",
    borderClass: "border-teal-300",
    statuses: [
      { key: "pack", label: "Print Installer Pack", hint: "Renders, cutlist, installation notes" },
      { key: "labels", label: "Print Labels", hint: "Label each component" },
      { key: "notify", label: "Notify Customer", hint: "Let customer know production is underway" },
      { key: "framework", label: "Prep Framework / MDF", hint: "Cut all timber components" },
      { key: "sheets", label: "Prep Sheet Materials" },
      { key: "cut", label: "Cut Sheet Materials", hint: "Cut to size per cutlist" },
    ],
  },
  {
    num: 6, id: "packing", label: "Packing", phase: "prod",
    accent: "#d97706", accentBg: "#fffbeb", accentText: "#78350f",
    borderClass: "border-amber-300",
    statuses: [
      { key: "pack", label: "In Progress", hint: "Wrap and protect all components" },
      { key: "date", label: "Date / Time Agreed", hint: "Confirm delivery window with customer" },
      { key: "load", label: "Ready to Load", hint: "All checked, wrapped, staged" },
    ],
  },
  {
    num: 7, id: "delivery", label: "Delivery", phase: "prod",
    accent: "#ea580c", accentBg: "#fff7ed", accentText: "#7c2d12",
    borderClass: "border-orange-300",
    statuses: [
      { key: "loaded", label: "Loaded into Van", hint: "All secured in van" },
      { key: "delivered", label: "Delivered", hint: "Note date, time, any comments" },
    ],
  },
  {
    num: 8, id: "install", label: "Installation", phase: "prod",
    accent: "#e11d48", accentBg: "#fff1f2", accentText: "#881337",
    borderClass: "border-rose-300",
    statuses: [
      { key: "sched", label: "Scheduled", hint: "Confirm with customer and installer" },
      { key: "ip", label: "In Progress", hint: "Installation underway on site" },
      { key: "done", label: "Complete", hint: "All fitted and checked with customer" },
      { key: "inv", label: "Final Invoice Sent", hint: "Send once installation signed off" },
    ],
  },
  {
    num: 9, id: "aftercare", label: "Aftercare", phase: "prod",
    accent: "#9333ea", accentBg: "#faf5ff", accentText: "#581c87",
    borderClass: "border-purple-300",
    statuses: [
      { key: "payment", label: "Final Payment Received", hint: "Mark once payment clears" },
      { key: "thanks", label: "Thank You Sent", hint: "Email thanks, request a review" },
    ],
  },
];

function StageCard({ stage }: { stage: Stage }) {
  const isProd = stage.phase === "prod";
  return (
    <div
      className="rounded-xl border-2 overflow-hidden"
      style={{ borderColor: stage.accent, minWidth: 220 }}
    >
      {/* Header */}
      <div className="px-4 pt-3 pb-2" style={{ background: stage.accentBg }}>
        <div className="flex items-center gap-2 mb-1">
          <div
            className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
            style={{ background: stage.accent }}
          >
            {stage.num}
          </div>
          <span
            className="text-[9px] font-bold uppercase tracking-widest"
            style={{ color: stage.accent }}
          >
            {isProd ? "Workflow" : "CRM"}
          </span>
        </div>
        <h3 className="text-base font-bold" style={{ color: stage.accentText }}>
          {stage.label}
        </h3>
      </div>

      {/* Statuses */}
      <div className="bg-white px-4 py-3 space-y-3">
        {stage.statuses.map((s, i) => (
          <div key={s.key}>
            {/* Primary status */}
            <div className="flex items-start gap-2">
              <div
                className="w-2.5 h-2.5 rounded-full mt-1 shrink-0"
                style={{ background: stage.accent }}
              />
              <div className="flex-1">
                <div className="text-[13px] font-semibold text-slate-800 leading-snug">
                  {s.label}
                </div>
                {s.hint && (
                  <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">{s.hint}</div>
                )}
                {/* Sub-statuses always visible — visually subordinate */}
                {s.subs && (
                  <div className="mt-1.5 ml-1 space-y-1">
                    {s.subs.map((sub) => (
                      <div
                        key={sub.key}
                        className="flex items-center gap-1.5 text-[10px] text-slate-500"
                      >
                        <div
                          className="w-1 h-1 rounded-full shrink-0"
                          style={{ background: stage.accent, opacity: 0.5 }}
                        />
                        <span>{sub.label}</span>
                        {sub.action && (
                          <span
                            className="ml-auto text-[9px] px-1.5 py-px rounded font-medium"
                            style={{ background: stage.accentBg, color: stage.accent }}
                          >
                            {sub.action}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            {/* Connector */}
            {i < stage.statuses.length - 1 && (
              <div className="ml-[5px] mt-1 w-px h-3" style={{ background: stage.accent, opacity: 0.2 }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PhaseArrow({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center shrink-0 gap-1" style={{ paddingTop: 52 }}>
      {label && (
        <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 whitespace-nowrap">
          {label}
        </span>
      )}
      <svg width="28" height="16" viewBox="0 0 28 16" fill="none">
        <path d="M0 8H20M14 2L22 8L14 14" stroke="#cbd5e1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function HierarchyClarity() {
  const crmStages = STAGES.filter((s) => s.phase === "crm");
  const prodStages = STAGES.filter((s) => s.phase === "prod");

  return (
    <div className="min-h-screen bg-slate-100 p-6 overflow-auto">
      {/* Title + tradeoff note */}
      <div className="mb-5 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-lg font-bold text-slate-900">Customer Journey Map</h1>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Stages numbered 0–9 · Sub-statuses always visible · Exit paths isolated to sidebar
          </p>
        </div>
        <div className="text-[10px] text-slate-500 bg-white border border-slate-200 rounded-lg px-3 py-2 max-w-xs shrink-0">
          <span className="font-bold text-slate-700 block mb-0.5">V1 — Information Hierarchy</span>
          Tradeoff: all detail is always visible; stage numbers create clear sequence.
          You give up: vertical compactness — the map is tall.
        </div>
      </div>

      <div className="flex gap-5">
        {/* Main flow */}
        <div className="flex-1 min-w-0 space-y-6">
          {/* Phase 1 */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-blue-600 mb-3 flex items-center gap-2">
              <div className="h-px flex-1 bg-blue-200" />
              Phase 1 — CRM Sales Pipeline
              <div className="h-px flex-1 bg-blue-200" />
            </div>
            <div className="flex items-start gap-3 overflow-x-auto pb-2">
              {crmStages.map((stage, i) => (
                <React.Fragment key={stage.id}>
                  <StageCard stage={stage} />
                  {i < crmStages.length - 1 && <PhaseArrow />}
                </React.Fragment>
              ))}
              <PhaseArrow label="↓ next phase" />
            </div>
          </div>

          {/* Phase 2 */}
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-600 mb-3 flex items-center gap-2">
              <div className="h-px flex-1 bg-emerald-200" />
              Phase 2 — Production Workflow
              <div className="h-px flex-1 bg-emerald-200" />
            </div>
            <div className="flex items-start gap-3 overflow-x-auto pb-2">
              {prodStages.map((stage, i) => (
                <React.Fragment key={stage.id}>
                  <StageCard stage={stage} />
                  {i < prodStages.length - 1 && <PhaseArrow />}
                </React.Fragment>
              ))}
              <div className="flex items-center shrink-0" style={{ paddingTop: 52 }}>
                <div className="ml-2 px-3 py-2 rounded-full bg-green-600 text-white text-xs font-bold shadow">
                  🎉 Complete
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Exit paths sidebar */}
        <div className="w-44 shrink-0">
          <div className="sticky top-0">
            <div className="text-[10px] font-bold uppercase tracking-widest text-red-500 mb-3 flex items-center gap-1">
              <span>⬡</span> Exit Paths
            </div>
            <div className="space-y-3">
              {EXIT_PATHS.map((e) => (
                <div
                  key={e.key}
                  className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5"
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <div className="w-2 h-2 rotate-45 bg-red-400 shrink-0" />
                    <span className="text-[11px] font-bold text-red-800">{e.label}</span>
                  </div>
                  <div className="text-[10px] text-red-600 font-medium mb-0.5">{e.reason}</div>
                  <div className="text-[10px] text-red-400 italic leading-snug">{e.hint}</div>
                </div>
              ))}
            </div>

            {/* Decision key */}
            <div className="mt-5 rounded-lg border border-slate-200 bg-white px-3 py-3">
              <div className="text-[10px] font-bold text-slate-600 uppercase tracking-wider mb-2">
                Key decisions in Sales
              </div>
              <ul className="space-y-1.5 text-[10px] text-slate-500">
                <li>→ 3 no-replies → <span className="text-red-600 font-medium">exit</span></li>
                <li>→ No budget / fit → <span className="text-red-600 font-medium">exit</span></li>
                <li>→ Out of scope → <span className="text-red-600 font-medium">exit</span></li>
                <li>→ Bad timing → <span className="text-red-600 font-medium">exit (re-engage)</span></li>
                <li>→ Est. accepted → <span className="text-indigo-600 font-medium">Design Visit</span></li>
                <li>→ Visit cancelled → return to Sales</li>
                <li>→ Amendments needed → new estimate</li>
                <li>→ Survey cancelled → refund &amp; review</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
