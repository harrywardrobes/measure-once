// ── Workflow stage config ──────────────────────────────────────────────────────
// Typed TypeScript equivalents of the constants that used to live in
// public/workflow-core.js. Imported by WorkflowDataContext and any React
// component that needs stage metadata without reading window globals.

export interface WorkflowStage {
  label?: string;
  statuses?: Array<{ id: string; label: string; hint?: string }>;
  tasks?: string[];
}

export interface WorkflowDef {
  stages?: Record<string, WorkflowStage>;
}

// Cold-start fallback. The runtime workflow is fetched from /api/workflow;
// this object is used only when that fetch returns null.
export const DEFAULT_WORKFLOW: WorkflowDef = {
  stages: {
    sales:        { label: 'Sales' },
    designvisit:  { label: 'Design Visit' },
    survey:       { label: 'Survey' },
    order:        { label: 'Order' },
    workshop:     { label: 'Workshop' },
    packing:      { label: 'Packing' },
    delivery:     { label: 'Delivery' },
    installation: { label: 'Installation' },
    aftercare:       { label: 'Aftercare' },
    customerservice: { label: 'Customer Service' },
  },
};

export const STAGE_KEYS: string[] = Object.keys(DEFAULT_WORKFLOW.stages!);
