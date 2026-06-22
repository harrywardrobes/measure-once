import { useCallback, useEffect, useRef, useState } from 'react';
import { dispatchCardActionHandler } from '../utils/dispatchCardActionHandler';
import { resolveActionLabel as resolveActionLabelPure } from '../utils/resolveActionLabel.mjs';
import { GLOBAL_NULL_SLOT_KEY } from '../pages/admin/adminConstants';

export interface CardActionHandlerBinding {
  stage_key?: string;
  status_key?: string;
}

export interface CardActionHandlerData {
  id: number;
  type: string;
  config?: {
    action_name?: string;
    [key: string]: unknown;
  };
  bindings?: CardActionHandlerBinding[];
}

interface StageActionLabel {
  stage_key: string;
  status_key: string;
  label: string;
}

type HandlerIndex = Record<string, CardActionHandlerData>;

function buildIndexes(rows: CardActionHandlerData[]): {
  byLabel: HandlerIndex;
  byId: Record<number, CardActionHandlerData>;
} {
  const byLabel: HandlerIndex = {};
  const byId: Record<number, CardActionHandlerData> = {};
  for (const h of rows || []) {
    byId[h.id] = h;
    for (const b of h.bindings || []) {
      if (b.stage_key) {
        const sk = String(b.stage_key || '').toLowerCase();
        const lk = String(b.status_key || '').toLowerCase();
        byLabel[`${sk}|${lk}`] = h;
      }
    }
  }
  return { byLabel, byId };
}

export interface UseCardActionHandlersResult {
  cardActionHandlerFor: (
    stageKey: string,
    leadStatusKey: string | undefined,
  ) => CardActionHandlerData | null;
  resolveActionLabel: (
    stageKey: string,
    leadStatusKey: string | undefined,
    substageId: string | undefined,
  ) => string;
  loading: boolean;
  error: string | null;
}

export function useCardActionHandlers(): UseCardActionHandlersResult {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const byLabelRef = useRef<HandlerIndex>({});
  const byIdRef = useRef<Record<number, CardActionHandlerData>>({});
  // `${stage_key}|${status_key}` → label (lowercase keys).
  // null means the row EXISTS in the DB with an empty label (admin explicitly
  // cleared it). undefined (key absent) means no row exists → fall back to the
  // per-stage default `(stage_key, '')` row.
  const stageActionLabelMapRef = useRef<Record<string, string | null>>({});

  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const fetchStageActionLabels = useCallback(async () => {
    try {
      const res = await fetch('/api/stage-action-labels');
      if (!res.ok) {
        console.warn('[useCardActionHandlers] stage-action-labels fetch failed:', res.status);
        return;
      }
      const rows: StageActionLabel[] = await res.json();
      const m: Record<string, string | null> = {};
      for (const r of rows || []) {
        const s = String(r.stage_key || '').toLowerCase();
        const k = String(r.status_key || '').toLowerCase();
        if (!s) continue;
        const label = String(r.label || '').trim();
        // Store every row so the resolver can distinguish:
        //   non-empty string → use this label
        //   null             → row exists, admin explicitly cleared it (suppress strip)
        //   key absent       → no row → fall back to per-stage default
        m[`${s}|${k}`] = label || null;
      }
      stageActionLabelMapRef.current = m;
    } catch (e) {
      console.warn('[useCardActionHandlers] stage-action-labels fetch error:', (e as Error).message);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    try {
      const [handlersRes] = await Promise.all([
        fetch('/api/card-action-handlers'),
        fetchStageActionLabels(),
      ]);

      if (!handlersRes.ok) throw new Error(`handlers ${handlersRes.status}`);

      const handlers: CardActionHandlerData[] = await handlersRes.json();
      const { byLabel, byId } = buildIndexes(handlers);
      byLabelRef.current = byLabel;
      byIdRef.current = byId;

      setError(null);
      setLoading(false);
      bump();
    } catch (e) {
      console.warn('[useCardActionHandlers] fetch failed:', (e as Error).message);
      setError((e as Error).message);
      setLoading(false);
    }
  }, [bump, fetchStageActionLabels]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('card_action_handlers_changed');
    const onMsg = () => fetchAll();
    ch.addEventListener('message', onMsg);
    return () => {
      ch.removeEventListener('message', onMsg);
      ch.close();
    };
  }, [fetchAll]);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const ch = new BroadcastChannel('stage_action_labels_changed');
    const onMsg = () => fetchStageActionLabels().then(bump);
    ch.addEventListener('message', onMsg);
    return () => {
      ch.removeEventListener('message', onMsg);
      ch.close();
    };
  }, [fetchStageActionLabels, bump]);

  const cardActionHandlerFor = useCallback(
    (
      stageKey: string,
      leadStatusKey: string | undefined,
    ): CardActionHandlerData | null => {
      const sKey = String(stageKey || '').toLowerCase();
      const lsKey = String(leadStatusKey || '').toLowerCase();
      const idx = byLabelRef.current;
      return (
        idx[`${sKey}|${lsKey}`] ||
        idx[`${sKey}|`] ||
        idx[GLOBAL_NULL_SLOT_KEY] ||
        null
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [byLabelRef],
  );

  // Resolve the action-strip label for a card without calling any window globals.
  // Priority:
  //   1. Per-LS stage action label (if contact has a lead status)
  //   2. Per-substageId stage action label (legacy fallback, no LS)
  //   3. Per-stage "no lead status" row (stage|'')
  //
  // The pure resolver logic lives in src/react/utils/resolveActionLabel.mjs and
  // is shared with the unit-test suite so tests exercise the same code path.
  const resolveActionLabel = useCallback(
    (
      stageKey: string,
      leadStatusKey: string | undefined,
      substageId: string | undefined,
    ): string =>
      resolveActionLabelPure(
        stageActionLabelMapRef.current,
        stageKey,
        leadStatusKey,
        substageId,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stageActionLabelMapRef],
  );

  // Window shims: expose React-managed handler data and dispatch as window globals
  // so test probes and any remaining vanilla-JS call-sites can reach them.
  //
  // window.cardActionHandlerFor — label lookup used by test probes.
  //
  // window.cardActionHandlerById — id-keyed lookup used by the click-delegation
  // handler (registered below) so it can retrieve the full config (e.g.
  // intermediateLeadStatus) without maintaining its own duplicate index.
  //
  // window.loadCardActionHandlers — async re-fetch trigger.  The test suite calls
  // this to force the in-page index to update after creating new handlers mid-test.
  //
  // window.dispatchCardActionHandler — modal dispatch shim.  The TypeScript
  // implementation lives in src/react/utils/dispatchCardActionHandler.ts; we
  // expose it on window so test probes (start-design-visit, design-visit) can
  // call it directly on the sales page without going through a React onClick.
  //
  // window.cardActionHandlerAttrs — attr-string helper (test probe E.2).
  // Generates data-card-action-handler-* attribute strings for eq-card-action
  // elements.
  //
  // window.enquiryRowHtml — card-strip HTML helper (test probe E.3).
  // Builds the outer .eq-card HTML including the action-strip div.
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    const cleanups: (() => void)[] = [];

    if (typeof w.cardActionHandlerFor !== 'function') {
      w.cardActionHandlerFor = cardActionHandlerFor;
      cleanups.push(() => {
        if (w.cardActionHandlerFor === cardActionHandlerFor) delete w.cardActionHandlerFor;
      });
    }

    if (typeof w.cardActionHandlerById !== 'function') {
      const handlerById = (id: number) => byIdRef.current[id] ?? null;
      w.cardActionHandlerById = handlerById;
      cleanups.push(() => {
        if (w.cardActionHandlerById === handlerById) delete w.cardActionHandlerById;
      });
    }

    if (typeof w.loadCardActionHandlers !== 'function') {
      w.loadCardActionHandlers = fetchAll;
      cleanups.push(() => {
        if (w.loadCardActionHandlers === fetchAll) delete w.loadCardActionHandlers;
      });
    }

    if (typeof w.dispatchCardActionHandler !== 'function') {
      w.dispatchCardActionHandler = dispatchCardActionHandler;
      cleanups.push(() => {
        if (w.dispatchCardActionHandler === dispatchCardActionHandler)
          delete w.dispatchCardActionHandler;
      });
    }

    // cardActionHandlerAttrs — test probe E.2.
    if (typeof w.cardActionHandlerAttrs !== 'function') {
      const safe = (s: unknown) =>
        String(s == null ? '' : s)
          .replace(/&/g, '&amp;')
          .replace(/"/g, '&quot;')
          .replace(/</g, '&lt;');

      const cardActionHandlerAttrs = (
        stageKey: string,
        leadStatusKey: string,
        ctx: { contactId?: string; contactName?: string; contactEmail?: string; contactPhone?: string; contactMobile?: string },
      ) => {
        const h =
          typeof w.cardActionHandlerFor === 'function'
            ? (w.cardActionHandlerFor as typeof cardActionHandlerFor)(
                stageKey,
                leadStatusKey,
              )
            : null;
        if (!h) return '';
        return (
          ` data-card-action-handler-id="${h.id}"` +
          ` data-card-action-handler-type="${safe(h.type)}"` +
          (h.config?.action_name
            ? ` data-card-action-name="${safe(h.config.action_name)}"`
            : '') +
          (ctx?.contactId ? ` data-card-action-contact-id="${safe(ctx.contactId)}"` : '') +
          (ctx?.contactName
            ? ` data-card-action-contact-name="${safe(ctx.contactName)}"`
            : '') +
          (ctx?.contactEmail
            ? ` data-card-action-contact-email="${safe(ctx.contactEmail)}"`
            : '') +
          (ctx?.contactPhone
            ? ` data-card-action-contact-phone="${safe(ctx.contactPhone)}"`
            : '') +
          (ctx?.contactMobile
            ? ` data-card-action-contact-mobile="${safe(ctx.contactMobile)}"`
            : '')
        );
      };

      w.cardActionHandlerAttrs = cardActionHandlerAttrs;
      cleanups.push(() => {
        if (w.cardActionHandlerAttrs === cardActionHandlerAttrs)
          delete w.cardActionHandlerAttrs;
      });

      // enquiryRowHtml — test probe E.3.
      const enquiryRowHtml = (entry: {
        contact?: {
          id?: string;
          properties?: {
            hs_lead_status?: string;
            firstname?: string;
            lastname?: string;
            email?: string;
            phone?: string;
            mobilephone?: string;
          };
        };
        stageKey?: string;
      }) => {
        const contact = (entry && entry.contact) || {};
        const stageKey2 = (entry && entry.stageKey) || 'sales';
        const props = contact.properties || {};
        const leadStatusKey2 = props.hs_lead_status || '';
        const firstName = props.firstname || '';
        const lastName = props.lastname || '';
        const name =
          [firstName, lastName].filter(Boolean).join(' ') || props.email || '';
        const ctx2 = {
          contactId: contact.id || '',
          contactName: name,
          contactEmail: props.email || '',
          contactPhone: props.phone || '',
          contactMobile: props.mobilephone || '',
        };
        const attrsStr = cardActionHandlerAttrs(
          stageKey2,
          leadStatusKey2,
          ctx2,
        );
        const cahMatch = attrsStr.match(/data-card-action-name="([^"]+)"/);
        const cahName = cahMatch
          ? cahMatch[1]
              .replace(/_/g, ' ')
              .replace(/\b\w/g, (c: string) => c.toUpperCase())
          : '';
        const actionLabel = cahName;
        const safeStr = (s: unknown) =>
          String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;');
        const actionStrip = actionLabel
          ? '<div class="eq-card-action"' +
            attrsStr +
            '>' +
            '<span class="eq-card-action-label">' +
            safeStr(actionLabel) +
            '</span>' +
            '</div>'
          : '';
        return '<div class="eq-card">' + actionStrip + '</div>';
      };

      w.enquiryRowHtml = enquiryRowHtml;
      cleanups.push(() => {
        if (w.enquiryRowHtml === enquiryRowHtml) delete w.enquiryRowHtml;
      });
    }

    return () => cleanups.forEach((fn) => fn());
  }, [cardActionHandlerFor, fetchAll, byIdRef]);

  // Click delegation — handles clicks on [data-card-action-handler-id] elements.
  // These are either test-injected strips or vanilla-JS-rendered eq-card-action
  // divs on the sales page.  React-rendered SalesCard action strips use their own
  // React onClick and do NOT carry these attributes, so they are unaffected.
  useEffect(() => {
    function onDocumentClick(e: MouseEvent) {
      const target = e.target as Element | null;
      const el = target?.closest('[data-card-action-handler-id]') as HTMLElement | null;
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const id = parseInt(el.dataset.cardActionHandlerId ?? '', 10);
      const type = el.dataset.cardActionHandlerType ?? '';
      const ctx = {
        contactId: el.dataset.cardActionContactId ?? '',
        contactName: el.dataset.cardActionContactName ?? '',
        contactEmail: el.dataset.cardActionContactEmail ?? '',
        contactPhone: el.dataset.cardActionContactPhone ?? '',
        contactMobile: el.dataset.cardActionContactMobile ?? '',
      };
      const handler =
        (typeof (window as unknown as Record<string, unknown>).cardActionHandlerById === 'function'
          ? (
              (window as unknown as Record<string, unknown>).cardActionHandlerById as (
                id: number,
              ) => CardActionHandlerData | null
            )(id)
          : null) || { id, type, config: {} };
      dispatchCardActionHandler(handler, ctx);
    }

    document.addEventListener('click', onDocumentClick, true);
    return () => document.removeEventListener('click', onDocumentClick, true);
  }, []);

  return { cardActionHandlerFor, resolveActionLabel, loading, error };
}
