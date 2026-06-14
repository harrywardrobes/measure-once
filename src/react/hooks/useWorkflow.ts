import { useEffect, useState } from 'react';
import { WorkflowDef, fetchWorkflowCached } from '../lib/workflowConfig';

/**
 * Read the runtime workflow definition without a WorkflowDataProvider.
 *
 * Admin tabs mount as independent React roots (and never unmount on tab switch),
 * so they cannot share the board pages' WorkflowDataContext. This hook reads the
 * shared module-level cache in `workflowConfig`, so the whole page — board pages
 * via the context and every admin tab via this hook — performs a single
 * `/api/workflow` request per load.
 *
 * `workflow` is `null` while loading and stays `null` if the request fails;
 * callers should fall back to `DEFAULT_WORKFLOW`.
 */
export function useWorkflow(): { workflow: WorkflowDef | null; loading: boolean } {
  const [workflow, setWorkflow] = useState<WorkflowDef | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchWorkflowCached()
      .then(wf => {
        if (cancelled) return;
        setWorkflow(wf);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { workflow, loading };
}
