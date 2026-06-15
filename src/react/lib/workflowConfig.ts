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

export { STAGE_KEYS } from '../utils/stageKeys';

// ── Shared workflow fetch ──────────────────────────────────────────────────────
// The runtime workflow definition (/api/workflow) is identical for every page and
// rarely changes. Multiple islands need it (the board pages via WorkflowDataContext
// and several admin tabs), so we fetch it once per page load and share the result.
// Admin tabs each mount as an independent React root, so a React context cannot be
// shared across them — this module-level cache is the single dedup point instead.

/** Normalise a saved workflow: legacy `tasks` arrays become `statuses`. */
export function normalizeWorkflow(saved: WorkflowDef | null): WorkflowDef {
  const wf: WorkflowDef = saved || DEFAULT_WORKFLOW;
  if (wf.stages) {
    for (const stage of Object.values(wf.stages)) {
      if (stage.tasks && !stage.statuses) {
        stage.statuses = stage.tasks.map((t, i) => ({ id: `task_${i}`, label: t, hint: '' }));
      }
    }
  }
  return wf;
}

let _workflowPromise: Promise<WorkflowDef | null> | null = null;

/**
 * Fetch /api/workflow at most once per page load and cache the result.
 * Resolves to the normalised workflow (DEFAULT_WORKFLOW when the server stores
 * none) or `null` when the request fails — failures are not cached so a later
 * caller can retry.
 */
export function fetchWorkflowCached(): Promise<WorkflowDef | null> {
  if (_workflowPromise) return _workflowPromise;
  _workflowPromise = (async () => {
    try {
      const r = await fetch('/api/workflow');
      if (!r.ok) { _workflowPromise = null; return null; }
      const saved = await r.json().catch(() => null) as WorkflowDef | null;
      return normalizeWorkflow(saved);
    } catch {
      _workflowPromise = null;
      return null;
    }
  })();
  return _workflowPromise;
}
