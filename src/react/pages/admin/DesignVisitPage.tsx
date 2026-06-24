import React, { useCallback, useEffect, useState } from 'react';
import { useConnectionCheck, useConnectionToast } from '../../context/ConnectionToastContext';
import {
  Box, Button, Card, CardContent, Divider, Stack, Typography,
} from '@mui/material';
import { GET, POST } from '../../utils/api';
import { usePageTitle } from '../../hooks/usePageTitle';
import { TabBar } from '../../components/TabBar';
import { QuestionnaireBuilder } from './QuestionnaireBuilder';
import { ADMIN_VISITS_SUBTAB_KEY } from '../../constants/localStorageKeys';
import {
  DvHandle, DvFurniture, DvDoorStyle, DvTerms, AnyItem,
  CatalogueTable, DvItemEditorDialog, useCatalogueData,
  SuppliersTab,
  showToast,
} from './visitCatalogueShared';

type VisitsSubtab = 'catalogues' | 'questionnaire' | 'terms' | 'suppliers';
const VISITS_SUBTABS: { key: VisitsSubtab; label: string }[] = [
  { key: 'catalogues',    label: 'Catalogues' },
  { key: 'questionnaire', label: 'Questionnaire' },
  { key: 'terms',         label: 'Terms' },
  { key: 'suppliers',     label: 'Suppliers' },
];

// ── Module-level refs ──────────────────────────────────────────────────────────

const W = window as unknown as Record<string, unknown>;
const _reloadRef:      { fn: (() => Promise<void>) | null }                          = { fn: null };
const _openEditorRef:  { fn: ((type: string, existingId?: number) => void) | null }  = { fn: null };
const _deleteItemRef:  { fn: ((type: string, id: number) => Promise<void>) | null }  = { fn: null };

// ── TermsDisplay component ─────────────────────────────────────────────────────

function TermsDisplay({ terms }: { terms: DvTerms[] }) {
  const sorted  = [...terms].sort((a, b) => b.version - a.version);
  const current = sorted[0];
  const older   = sorted.slice(1);

  if (!current) {
    return <p className="admin-msg admin-msg--muted">No terms published yet.</p>;
  }

  const fmt = (d: string) =>
    new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <>
      <div className="adm-terms-current-wrap">
        <div className="adm-terms-version-row">
          <span className="adm-terms-version-badge">v{current.version}</span>
          <span className="adm-terms-version-date">{fmt(current.published_at)}</span>
          {current.published_by && (
            <span className="adm-terms-version-by">by {current.published_by}</span>
          )}
        </div>
        <pre className="adm-terms-preview">{current.text}</pre>
      </div>
      {older.length > 0 && (
        <details className="adm-terms-history" style={{ marginTop: 10 }}>
          <summary className="adm-terms-history-toggle">
            Show {older.length} older version{older.length !== 1 ? 's' : ''}
          </summary>
          <div className="adm-terms-history-list">
            {older.map(t => (
              <div key={t.id} className="adm-terms-history-item">
                <div className="adm-terms-version-row">
                  <span className="adm-terms-version-badge adm-terms-version-badge--old">v{t.version}</span>
                  <span className="adm-terms-version-date">{fmt(t.published_at)}</span>
                </div>
                <pre className="adm-terms-preview adm-terms-preview--old">{t.text}</pre>
              </div>
            ))}
          </div>
        </details>
      )}
    </>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function DesignVisitPage() {
  usePageTitle('Visits · Measure Once');
  useConnectionCheck();
  const { notifyApiError } = useConnectionToast();
  const [subtab, setSubtab] = useState<VisitsSubtab>(() => {
    try {
      const saved = localStorage.getItem(ADMIN_VISITS_SUBTAB_KEY) as VisitsSubtab | null;
      if (saved && VISITS_SUBTABS.some((t) => t.key === saved)) return saved;
    } catch { /* ignore */ }
    return 'catalogues';
  });
  const handleSubtab = useCallback((key: string) => {
    setSubtab(key as VisitsSubtab);
    try { localStorage.setItem(ADMIN_VISITS_SUBTAB_KEY, key); } catch { /* ignore */ }
  }, []);

  const {
    handles, furniture, doorStyles,
    dialogState, fetchAll: fetchCatalogue,
    openEditor, closeDialog,
    moveItem, reorderItems, deleteItem,
  } = useCatalogueData();

  const [terms,           setTerms]           = useState<DvTerms[]>([]);
  const [termsEditorOpen, setTermsEditorOpen] = useState(false);
  const [termsNewText,    setTermsNewText]    = useState('');
  const [termsErr,        setTermsErr]        = useState('');

  const fetchAll = useCallback(async () => {
    await fetchCatalogue();
    try {
      const t = await GET('/api/admin/design-visit-terms');
      setTerms(Array.isArray(t) ? t as DvTerms[] : []);
    } catch (e) {
      notifyApiError('database', e);
    }
  }, [fetchCatalogue, notifyApiError]);

  useEffect(() => {
    _reloadRef.fn     = fetchAll;
    _openEditorRef.fn = openEditor;
    _deleteItemRef.fn = deleteItem;
    fetchAll();

    W.loadDvCatalogue       = fetchAll;
    W.openDvHandleEditor    = (id?: number) => _openEditorRef.fn?.('handle', id);
    W.openDvFurnitureEditor = (id?: number) => _openEditorRef.fn?.('furniture', id);
    W.openDvDoorStyleEditor = (id?: number) => _openEditorRef.fn?.('door-style', id);
    W.deleteDvItem          = (type: string, id: number) => _deleteItemRef.fn?.(type, id);

    return () => {
      _reloadRef.fn     = null;
      _openEditorRef.fn = null;
      _deleteItemRef.fn = null;
      ['loadDvCatalogue', 'openDvHandleEditor', 'openDvFurnitureEditor', 'openDvDoorStyleEditor', 'deleteDvItem']
        .forEach(k => delete W[k]);
    };
  }, [fetchAll, openEditor, deleteItem]);

  const publishTerms = useCallback(async () => {
    const text = termsNewText.trim();
    if (!text) { setTermsErr('Terms text cannot be empty.'); return; }
    try {
      await POST('/api/admin/design-visit-terms', { text });
      setTermsEditorOpen(false);
      setTermsNewText('');
      setTermsErr('');
      showToast('Terms published.');
      try { new BroadcastChannel('design_visit_terms_changed').postMessage({ ts: Date.now() }); } catch { /* ignore */ }
      await fetchAll();
    } catch (e) {
      notifyApiError('database', e);
      setTermsErr((e as Error).message || 'Publish failed.');
    }
  }, [termsNewText, fetchAll, notifyApiError]);

  const handleCols:    Array<{ field: keyof DvHandle;    label: string }> = [{ field: 'name', label: 'Name' }, { field: 'style', label: 'Style' }];
  const furnitureCols: Array<{ field: keyof DvFurniture; label: string }> = [{ field: 'name', label: 'Name' }, { field: 'description', label: 'Description' }];
  const doorStyleCols: Array<{ field: keyof DvDoorStyle; label: string }> = [{ field: 'name', label: 'Name' }, { field: 'image_url', label: 'Image URL' }];

  return (
    <>
      <TabBar
        tabs={VISITS_SUBTABS.map((t) => ({ key: t.key, label: t.label }))}
        activeKey={subtab}
        onSelect={handleSubtab}
      />

      {subtab === 'catalogues' && (
      <Stack spacing={2} sx={{ mt: 2 }}>
        <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
          <CardContent sx={{ py: '10px !important' }}>
            <Typography variant="body2" color="text.secondary">
              Catalogue (door styles, handles, ranges) is shared with survey visits.
            </Typography>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
              <Box>
                <Typography variant="h6">Design Visit — Handles</Typography>
                <Typography variant="body2" color="text.secondary">
                  Handle options displayed in the design visit wizard for the customer to choose from.
                </Typography>
              </Box>
              <Button variant="contained" onClick={() => openEditor('handle')} sx={{ flexShrink: 0 }}>
                + Add handle
              </Button>
            </Box>
            <div id="dv-handles-wrap">
              <CatalogueTable
                type="handle"
                items={handles}
                columns={handleCols}
                showImage
                onMove={moveItem}
                onReorder={reorderItems}
                onEdit={openEditor}
                onDelete={deleteItem}
              />
            </div>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
              <Box>
                <Typography variant="h6">Design Visit — Furniture Ranges</Typography>
                <Typography variant="body2" color="text.secondary">
                  Furniture ranges displayed in the design visit wizard.
                </Typography>
              </Box>
              <Button variant="contained" onClick={() => openEditor('furniture')} sx={{ flexShrink: 0 }}>
                + Add range
              </Button>
            </Box>
            <div id="dv-furniture-wrap">
              <CatalogueTable
                type="furniture"
                items={furniture}
                columns={furnitureCols}
                onMove={moveItem}
                onReorder={reorderItems}
                onEdit={openEditor}
                onDelete={deleteItem}
              />
            </div>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
              <Box>
                <Typography variant="h6">Design Visit — Door Styles</Typography>
                <Typography variant="body2" color="text.secondary">
                  Door styles the designer can select per room in the wizard.
                </Typography>
              </Box>
              <Button variant="contained" onClick={() => openEditor('door-style')} sx={{ flexShrink: 0 }}>
                + Add style
              </Button>
            </Box>
            <div id="dv-door-styles-wrap">
              <CatalogueTable
                type="door-style"
                items={doorStyles}
                columns={doorStyleCols}
                onMove={moveItem}
                onReorder={reorderItems}
                onEdit={openEditor}
                onDelete={deleteItem}
              />
            </div>
          </CardContent>
        </Card>
      </Stack>
      )}

      {subtab === 'questionnaire' && (
        <Box sx={{ mt: 2 }}>
          <Card variant="outlined" sx={{ bgcolor: 'action.hover', mb: 2 }}>
            <CardContent sx={{ py: '10px !important' }}>
              <Typography variant="body2" color="text.secondary">
                Survey questions are the ones tagged with &lsquo;survey&rsquo; in <em>Applies to</em>.
              </Typography>
            </CardContent>
          </Card>
          <QuestionnaireBuilder />
        </Box>
      )}

      {subtab === 'terms' && (
      <Stack spacing={2} sx={{ mt: 2 }}>
        <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
          <CardContent sx={{ py: '10px !important' }}>
            <Typography variant="body2" color="text.secondary">
              The same versioned terms are reused for survey visits.
            </Typography>
          </CardContent>
        </Card>

        <Card variant="outlined" id="dv-terms-card">
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 2 }}>
              <Box>
                <Typography variant="h6">Design Visit — Terms &amp; Conditions</Typography>
                <Typography variant="body2" color="text.secondary">
                  Each published revision is versioned and stamped on the visit at submission time.
                  Customers always see the version that was active when their visit was submitted.
                </Typography>
              </Box>
              {!termsEditorOpen && (
                <Button variant="contained" onClick={() => { setTermsEditorOpen(true); setTermsNewText(''); setTermsErr(''); }} sx={{ flexShrink: 0 }}>
                  Publish new version
                </Button>
              )}
            </Box>

            <div id="dv-terms-current">
              <TermsDisplay terms={terms} />
            </div>

            {termsEditorOpen && (
              <>
                <Divider sx={{ my: 2 }} />
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  New terms text (will become the active version)
                </Typography>
                <textarea
                  className="field adm-terms-textarea"
                  rows={8}
                  maxLength={4000}
                  placeholder="Enter the full terms and conditions text…"
                  value={termsNewText}
                  onChange={e => setTermsNewText(e.target.value)}
                  style={{ width: '100%', marginBottom: 4 }}
                />
                {termsErr && (
                  <Typography variant="caption" color="error" sx={{ display: 'block', mb: 1 }}>
                    {termsErr}
                  </Typography>
                )}
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
                  <Button variant="text" onClick={() => { setTermsEditorOpen(false); setTermsErr(''); }}>Cancel</Button>
                  <Button variant="contained" onClick={publishTerms}>Publish</Button>
                </Box>
              </>
            )}
          </CardContent>
        </Card>
      </Stack>
      )}

      {subtab === 'suppliers' && <SuppliersTab />}

      <DvItemEditorDialog
        open={dialogState.open}
        type={dialogState.type}
        existingId={dialogState.existingId}
        onClose={closeDialog}
        onSaved={fetchCatalogue}
      />
    </>
  );
}

export default DesignVisitPage;
