import React, { useState } from "react";

type SubStatus = { key: string; label: string; actionLabel?: string };
type Status = {
  key: string;
  label: string;
  hint?: string;
  subs?: SubStatus[];
  isExit?: boolean;
  exitReason?: string;
};
type Stage = {
  id: string;
  label: string;
  phase: "crm" | "production";
  color: string;
  bgColor: string;
  borderColor: string;
  dotColor: string;
  statuses: Status[];
};

const STAGES: Stage[] = [
  {
    id: "entry",
    label: "New Enquiry",
    phase: "crm",
    color: "text-violet-800",
    bgColor: "bg-violet-50",
    borderColor: "border-violet-300",
    dotColor: "bg-violet-500",
    statuses: [
      {
        key: "__NULL__",
        label: "New Contact",
        hint: "Lead enters system via any channel",
        subs: [
          { key: "NEWC_WEB", label: "Web Form", actionLabel: "New Enquiry" },
          { key: "NEWC_EMAIL", label: "Email", actionLabel: "New Enquiry" },
          { key: "NEWC_WHATSAPP", label: "WhatsApp", actionLabel: "New Enquiry" },
          { key: "NEWC_CALL", label: "Phone Call", actionLabel: "Summarise Call" },
          { key: "NEWC_INSTA", label: "Instagram", actionLabel: "New Enquiry" },
          { key: "NEWC_FACEBOOK", label: "Facebook", actionLabel: "New Enquiry" },
        ],
      },
    ],
  },
  {
    id: "sales",
    label: "Sales",
    phase: "crm",
    color: "text-blue-800",
    bgColor: "bg-blue-50",
    borderColor: "border-blue-300",
    dotColor: "bg-blue-500",
    statuses: [
      {
        key: "FORM_SUBMISSION",
        label: "Form Submission",
        hint: "Email + WhatsApp asking for more information",
      },
      {
        key: "ATTEMPTED_TO_CONTACT",
        label: "Attempted to Contact",
        hint: "If no response in 2 working days, call to discuss",
        subs: [
          { key: "ATCN_EMAIL", label: "Email Sent" },
          { key: "ATCN_WHATSAPP", label: "WhatsApp Sent" },
          { key: "ATCN_CALL", label: "Call Attempted" },
          { key: "ATCN_NO_RESPONSE", label: "No Response" },
        ],
      },
      {
        key: "IN_PROGRESS",
        label: "In Progress",
        hint: "Actively discussing project requirements",
      },
      {
        key: "AWAITING_PHOTOS",
        label: "Awaiting Photos",
        hint: "Customer sending room photos / measurements",
        subs: [
          { key: "AWPH_MORE_INFO", label: "More Info Requested" },
          { key: "AWPH_RECEIVED", label: "Photos Received", actionLabel: "Review Photos" },
        ],
      },
      {
        key: "ROUGH_ESTIMATE",
        label: "Rough Estimate",
        hint: "Estimate shared with customer — awaiting decision",
      },
      {
        key: "BAD_TIMING",
        label: "Bad Timing",
        hint: "Follow up in ~1 month or suggested date",
        isExit: true,
        exitReason: "Too early — revisit",
      },
      {
        key: "UNQUALIFIED",
        label: "Unqualified",
        hint: "Lead doesn't meet project criteria",
        isExit: true,
        exitReason: "Not a fit",
      },
      {
        key: "NOT_SUITABLE",
        label: "Not Suitable",
        hint: "Project outside scope or capability",
        isExit: true,
        exitReason: "Out of scope",
      },
      {
        key: "NO_RESPONSE",
        label: "No Response (3×)",
        hint: "3 contact attempts with no reply",
        isExit: true,
        exitReason: "Unresponsive",
      },
    ],
  },
  {
    id: "designvisit",
    label: "Design Visit",
    phase: "crm",
    color: "text-indigo-800",
    bgColor: "bg-indigo-50",
    borderColor: "border-indigo-300",
    dotColor: "bg-indigo-500",
    statuses: [
      {
        key: "DESIGN_SCHEDULED",
        label: "Design Scheduled",
        hint: "Add date to calendar",
        subs: [
          { key: "DSSC_SUGGESTED", label: "Date Suggested", actionLabel: "Re-Send Invite" },
          { key: "DSSC_AGREED", label: "Date Agreed", actionLabel: "Add to Calendar" },
          { key: "DSSC_CONFIRMED", label: "Date Confirmed", actionLabel: "Start Meeting" },
          { key: "DSSC_CANCELLED", label: "Visit Cancelled" },
        ],
      },
      {
        key: "DESIGN_IN_PROGRESS",
        label: "Design In Progress",
        hint: "Design meeting is underway",
      },
      {
        key: "OPEN_DEAL",
        label: "Open Deal",
        hint: "Estimate sent — awaiting customer acceptance",
        subs: [
          { key: "OPDL_AMENDMENTS", label: "Amendments Needed", actionLabel: "Send New Estimate" },
        ],
      },
      {
        key: "DESIGN_ACCEPTED",
        label: "Design Accepted",
        hint: "Customer has approved the design and estimate",
      },
    ],
  },
  {
    id: "survey",
    label: "Survey",
    phase: "crm",
    color: "text-cyan-800",
    bgColor: "bg-cyan-50",
    borderColor: "border-cyan-300",
    dotColor: "bg-cyan-500",
    statuses: [
      {
        key: "DEPOSIT_INVOICE",
        label: "Awaiting Deposit",
        hint: "Deposit invoice issued — awaiting payment",
        subs: [
          { key: "DPIN_RECEIVED", label: "Deposit Received", actionLabel: "Suggest Survey Dates" },
        ],
      },
      {
        key: "SURVEY_SCHEDULED",
        label: "Survey Scheduled",
        hint: "",
        subs: [
          { key: "SRSC_SUGGESTED", label: "Date Suggested" },
          { key: "SRSC_AGREED", label: "Date Agreed", actionLabel: "Add to Calendar" },
          { key: "SRSC_CONFIRMED", label: "Visit Confirmed", actionLabel: "Start Survey" },
          { key: "SRSC_CANCELLED", label: "Survey Cancelled", actionLabel: "Refund Customer" },
        ],
      },
      {
        key: "SURVEY_IN_PROGRESS",
        label: "Survey In Progress",
        hint: "Check date with customer",
      },
      {
        key: "SURVEY_SENT",
        label: "Survey Sent",
        hint: "Final survey sent to customer for review",
        subs: [
          { key: "SRSN_AMENDMENTS", label: "Amendments Needed", actionLabel: "Send New Survey" },
        ],
      },
      {
        key: "PRODUCTION_READY",
        label: "Ready for Production",
        hint: "Email customer to confirm installation date",
      },
    ],
  },
  {
    id: "order",
    label: "Order",
    phase: "production",
    color: "text-emerald-800",
    bgColor: "bg-emerald-50",
    borderColor: "border-emerald-300",
    dotColor: "bg-emerald-500",
    statuses: [
      { key: "order_doors", label: "Order Doors", hint: "Order in for previous Mon or Tue" },
      { key: "order_sheets", label: "Order Sheets", hint: "Sheet materials for workshop prep" },
      { key: "order_hardware", label: "Order Hardware", hint: "Hinges, handles, fixings" },
    ],
  },
  {
    id: "workshop",
    label: "Workshop",
    phase: "production",
    color: "text-teal-800",
    bgColor: "bg-teal-50",
    borderColor: "border-teal-300",
    dotColor: "bg-teal-500",
    statuses: [
      { key: "print_installer_pack", label: "Print Installer Pack", hint: "Renders, cutlist, installation notes" },
      { key: "print_labels", label: "Print Labels", hint: "Label each component to match cutlist" },
      { key: "notify_customer", label: "Notify Customer", hint: "Let customer know production is underway" },
      { key: "prep_framework", label: "Prep Framework / MDF", hint: "Cut and prep all timber framework" },
      { key: "prep_sheet_materials", label: "Prep Sheet Materials", hint: "Prepare sheets ready for cutting" },
      { key: "cut_sheet_materials", label: "Cut Sheet Materials", hint: "Cut to size per cutlist" },
    ],
  },
  {
    id: "packing",
    label: "Packing",
    phase: "production",
    color: "text-amber-800",
    bgColor: "bg-amber-50",
    borderColor: "border-amber-300",
    dotColor: "bg-amber-500",
    statuses: [
      { key: "pack_in_progress", label: "In Progress", hint: "Wrap and protect all components" },
      { key: "date_agreed", label: "Date / Time Agreed", hint: "Confirm delivery window with customer" },
      { key: "ready_to_load", label: "Ready to Load", hint: "All components checked, wrapped, staged" },
    ],
  },
  {
    id: "delivery",
    label: "Delivery",
    phase: "production",
    color: "text-orange-800",
    bgColor: "bg-orange-50",
    borderColor: "border-orange-300",
    dotColor: "bg-orange-500",
    statuses: [
      { key: "loaded", label: "Loaded into Van", hint: "All components loaded and secured" },
      { key: "delivered", label: "Delivered", hint: "Note date, time, and any comments" },
    ],
  },
  {
    id: "installation",
    label: "Installation",
    phase: "production",
    color: "text-rose-800",
    bgColor: "bg-rose-50",
    borderColor: "border-rose-300",
    dotColor: "bg-rose-500",
    statuses: [
      { key: "inst_scheduled", label: "Scheduled", hint: "Confirm date with customer and installer" },
      { key: "inst_in_progress", label: "In Progress", hint: "Installation underway on site" },
      { key: "inst_complete", label: "Complete", hint: "All fitted and checked with customer" },
      { key: "final_invoice_sent", label: "Final Invoice Sent", hint: "Send invoice once signed off" },
    ],
  },
  {
    id: "aftercare",
    label: "Aftercare",
    phase: "production",
    color: "text-purple-800",
    bgColor: "bg-purple-50",
    borderColor: "border-purple-300",
    dotColor: "bg-purple-500",
    statuses: [
      { key: "final_payment", label: "Final Payment Received", hint: "Mark once payment has cleared" },
      { key: "thank_you", label: "Thank You Sent", hint: "Email thanking customer, request a review" },
    ],
  },
];

function SubStatusBadge({ sub }: { sub: SubStatus }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-white border border-current/20 text-[10px] leading-tight">
      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 shrink-0" />
      <span className="font-medium opacity-80">{sub.label}</span>
      {sub.actionLabel && (
        <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded text-[9px] bg-current/10 font-semibold opacity-70">
          {sub.actionLabel}
        </span>
      )}
    </div>
  );
}

function StatusNode({
  status,
  dotColor,
  stageColor,
}: {
  status: Status;
  dotColor: string;
  stageColor: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasSubs = status.subs && status.subs.length > 0;

  if (status.isExit) {
    return (
      <div className="flex items-start gap-2 pl-1">
        <div className="flex flex-col items-center mt-1">
          <div className="w-2.5 h-2.5 rounded-sm rotate-45 bg-red-400 shrink-0" />
        </div>
        <div>
          <div className="text-[11px] font-semibold text-red-700 leading-tight">{status.label}</div>
          {status.exitReason && (
            <div className="text-[10px] text-red-500 mt-0.5">{status.exitReason}</div>
          )}
          {status.hint && (
            <div className="text-[10px] text-red-400 mt-0.5 italic">{status.hint}</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        onClick={() => hasSubs && setExpanded((e) => !e)}
        className={`w-full flex items-start gap-2 text-left group ${hasSubs ? "cursor-pointer" : "cursor-default"}`}
      >
        <div className="flex flex-col items-center mt-1 shrink-0">
          <div className={`w-2.5 h-2.5 rounded-full ${dotColor} shrink-0`} />
          {hasSubs && (
            <div className="w-px h-full bg-current/20 mt-0.5" style={{ minHeight: 8 }} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-[11px] font-semibold leading-tight ${stageColor}`}>
            {status.label}
            {hasSubs && (
              <span className="ml-1 text-[9px] opacity-50 font-normal">
                ({status.subs!.length}) {expanded ? "▲" : "▼"}
              </span>
            )}
          </div>
          {status.hint && (
            <div className="text-[10px] text-neutral-500 mt-0.5 leading-snug">{status.hint}</div>
          )}
        </div>
      </button>

      {hasSubs && expanded && (
        <div className={`ml-4 space-y-1 ${stageColor}`}>
          {status.subs!.map((sub) => (
            <SubStatusBadge key={sub.key} sub={sub} />
          ))}
        </div>
      )}
    </div>
  );
}

function StageCard({ stage }: { stage: Stage }) {
  const mainStatuses = stage.statuses.filter((s) => !s.isExit);
  const exitStatuses = stage.statuses.filter((s) => s.isExit);

  return (
    <div className="flex flex-col gap-2 min-w-[200px] max-w-[220px]">
      {/* Header */}
      <div
        className={`rounded-lg border-2 ${stage.borderColor} ${stage.bgColor} px-3 py-2`}
      >
        <div className="flex items-center gap-2 mb-1">
          <div className={`w-2 h-2 rounded-full ${stage.dotColor}`} />
          <span className={`text-[11px] font-bold uppercase tracking-wider ${stage.color}`}>
            {stage.phase === "crm" ? "CRM" : "WORKFLOW"}
          </span>
        </div>
        <h3 className={`text-sm font-bold ${stage.color}`}>{stage.label}</h3>
      </div>

      {/* Main statuses */}
      <div
        className={`rounded-lg border ${stage.borderColor} bg-white px-3 py-3 space-y-3 flex-1 ${stage.color}`}
      >
        {mainStatuses.map((status, i) => (
          <React.Fragment key={status.key}>
            <StatusNode status={status} dotColor={stage.dotColor} stageColor={stage.color} />
            {i < mainStatuses.length - 1 && (
              <div className="flex items-center gap-1 pl-1">
                <div className={`w-px h-3 ${stage.dotColor} opacity-30 ml-1`} />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>

      {/* Exit statuses */}
      {exitStatuses.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-3 space-y-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-red-500 mb-2 flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-sm rotate-45 bg-red-400" />
            Exit paths
          </div>
          {exitStatuses.map((status) => (
            <StatusNode
              key={status.key}
              status={status}
              dotColor="bg-red-400"
              stageColor="text-red-700"
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-start pt-[3.5rem] shrink-0">
      <svg width="32" height="20" viewBox="0 0 32 20" fill="none">
        <path
          d="M0 10 H24 M18 4 L28 10 L18 16"
          stroke="#94a3b8"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function PhaseLabel({ label, color }: { label: string; color: string }) {
  return (
    <div className={`text-[10px] font-bold uppercase tracking-widest ${color} px-2 py-1 rounded`}>
      {label}
    </div>
  );
}

export function CustomerJourneyMap() {
  const crmStages = STAGES.filter((s) => s.phase === "crm");
  const prodStages = STAGES.filter((s) => s.phase === "production");

  return (
    <div className="min-h-screen bg-slate-50 p-6 overflow-auto">
      {/* Title */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-800">Customer Journey Map</h1>
        <p className="text-sm text-slate-500 mt-1">
          Stages · Lead Statuses · Sub-statuses · Exit paths — click any status with sub-statuses to expand
        </p>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 mb-6 text-[11px] text-slate-600">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-blue-500" />
          <span>Lead status</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm rotate-45 bg-red-400" />
          <span>Exit path</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-slate-200 border border-slate-300" />
          <span>Sub-status</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded bg-slate-300 text-center leading-3 text-[9px]">▼</div>
          <span>Click to expand sub-statuses</span>
        </div>
      </div>

      {/* Phase 1 — CRM */}
      <div className="mb-3">
        <PhaseLabel label="Phase 1 — CRM (Sales pipeline)" color="text-blue-700" />
      </div>
      <div className="flex items-start gap-0 mb-8 overflow-x-auto pb-2">
        {crmStages.map((stage, i) => (
          <React.Fragment key={stage.id}>
            <StageCard stage={stage} />
            {i < crmStages.length - 1 && <Arrow />}
          </React.Fragment>
        ))}

        {/* Bridge to production */}
        <Arrow />
        <div className="flex flex-col items-center justify-start pt-[3.5rem] shrink-0">
          <div className="px-3 py-2 rounded-lg bg-slate-700 text-white text-[11px] font-bold text-center leading-tight">
            Ready for<br />Production
          </div>
        </div>
        <Arrow />
      </div>

      {/* Phase 2 — Production */}
      <div className="mb-3">
        <PhaseLabel label="Phase 2 — Production workflow" color="text-emerald-700" />
      </div>
      <div className="flex items-start gap-0 overflow-x-auto pb-4">
        {prodStages.map((stage, i) => (
          <React.Fragment key={stage.id}>
            <StageCard stage={stage} />
            {i < prodStages.length - 1 && <Arrow />}
          </React.Fragment>
        ))}

        {/* End state */}
        <Arrow />
        <div className="flex flex-col items-center justify-start pt-[3.5rem] shrink-0">
          <div className="px-3 py-2 rounded-full bg-green-600 text-white text-[11px] font-bold text-center leading-tight shadow">
            🎉 Complete
          </div>
        </div>
      </div>

      {/* Decision note */}
      <div className="mt-6 p-4 rounded-lg border border-amber-200 bg-amber-50 max-w-2xl">
        <h4 className="text-sm font-semibold text-amber-800 mb-2">Key if / then decisions in Sales</h4>
        <ul className="text-[12px] text-amber-700 space-y-1 list-none">
          <li>→ <strong>No contact after 3 attempts</strong> → No Response (exit)</li>
          <li>→ <strong>Customer unresponsive / no budget</strong> → Unqualified or No Response (exit)</li>
          <li>→ <strong>Project out of scope</strong> → Not Suitable (exit)</li>
          <li>→ <strong>Right fit but wrong time</strong> → Bad Timing (exit — re-engage in ~1 month)</li>
          <li>→ <strong>Rough estimate accepted</strong> → Design Visit scheduled</li>
          <li>→ <strong>Design visit cancelled</strong> → return to Sales or close</li>
          <li>→ <strong>Open deal — amendments needed</strong> → revised estimate sent, stays in Design Visit</li>
          <li>→ <strong>Survey cancelled</strong> → Refund customer, case reviewed</li>
          <li>→ <strong>Survey sent — amendments</strong> → revised survey, stays in Survey stage</li>
        </ul>
      </div>
    </div>
  );
}
