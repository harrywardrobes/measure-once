import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMAIL_TEMPLATE_DRAFT_PREFIX as DRAFT_PREFIX, ADMIN_DEEP_LINK_KEY } from '../../constants/localStorageKeys';

import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  GlobalStyles,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';

import { GET, PATCH, POST } from '../../utils/api';
import { useToast } from '../../contexts/ToastContext';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { DiscardConfirmDialog } from '../../components/modals/DiscardConfirmDialog';
import { usePageTitle } from '../../hooks/usePageTitle';
import { HANDLER_EMAIL_TEMPLATES, HANDLER_TYPE_LABELS } from '../../utils/handlerMeta';
import {
  analyzeTemplateTokens,
  MALFORMED_REASON_ORDER,
  MALFORMED_REASON_TEXT,
  TokenHighlightField,
  type MalformedReason,
  type MalformedReasonText,
  type TokenHighlightFieldHandle,
} from '../../components/TokenHighlightField';

/** Body text colour for the iframe email preview. Not a React style prop — lives inside a raw HTML string. */
const IFRAME_BODY_COLOR = '#111';

// ── Types ─────────────────────────────────────────────────────────────────────

interface EmailTemplate {
  key: string;
  label: string;
  description: string;
  variables: string[];
  subject: string;
  body_text: string;
  body_html: string;
  footer_text: string;
  updated_at: string | null;
  updated_by: string | null;
}

interface DraftFields {
  subject: string;
  body_text: string;
  body_html: string;
  footer_text: string;
}

interface PreviewResult {
  subject: string;
  text: string;
  html: string;
}

function draftKey(key: string): string {
  return DRAFT_PREFIX + key;
}

function loadDraft(key: string): DraftFields | null {
  try {
    const raw = localStorage.getItem(draftKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as DraftFields;
  } catch (_) { /* ignore */ }
  return null;
}

function clearDraft(key: string): void {
  try { localStorage.removeItem(draftKey(key)); } catch (_) { /* ignore */ }
}

function formatUpdated(t: EmailTemplate): string {
  if (!t.updated_at) return 'Default (never edited)';
  let when = t.updated_at;
  try { when = new Date(t.updated_at).toLocaleString(); } catch (_) { /* keep raw */ }
  return t.updated_by ? `${when} by ${t.updated_by}` : when;
}

// ── Preview panel ─────────────────────────────────────────────────────────────

interface PreviewPanelProps {
  templateKey: string;
  fields: DraftFields;
}

function PreviewPanel({ templateKey, fields }: PreviewPanelProps) {
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'html' | 'text'>('html');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchPreview = useCallback(async (f: DraftFields, key: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await POST<PreviewResult>(
        `/api/admin/email-templates/${encodeURIComponent(key)}/preview`,
        {
          subject: f.subject,
          body_text: f.body_text,
          body_html: f.body_html,
          footer_text: f.footer_text,
        },
      );
      setPreview(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchPreview(fields, templateKey);
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [fields, templateKey, fetchPreview]);

  const hasHtml = Boolean(preview?.html?.trim());

  return (
    <Stack spacing={2}>
      <Alert severity="info" sx={{ py: 0.5 }}>
        Variables are filled with sample values so you can see how the email
        will look. Unsaved edits are reflected here in real time.
      </Alert>

      {loading && !preview && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={24} />
        </Box>
      )}

      {error && (
        <Alert severity="error">Could not render preview: {error}</Alert>
      )}

      {preview && (
        <Stack spacing={1.5}>
          {/* Subject */}
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
              Subject
            </Typography>
            <Box sx={{
              px: 1.5, py: 1,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: 'background.paper',
            }}>
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {preview.subject || <em style={{ opacity: 0.5 }}>empty subject</em>}
              </Typography>
            </Box>
          </Box>

          {/* Body view-mode toggle */}
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary">Body</Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={hasHtml ? viewMode : 'text'}
              onChange={(_, v) => { if (v) setViewMode(v); }}
            >
              <Tooltip title={hasHtml ? 'HTML email body' : 'No HTML body — showing plain text'}>
                <span>
                  <ToggleButton value="html" disabled={!hasHtml} sx={{ px: 1.5, py: 0.25, fontSize: '0.7rem' }}>
                    HTML
                  </ToggleButton>
                </span>
              </Tooltip>
              <ToggleButton value="text" sx={{ px: 1.5, py: 0.25, fontSize: '0.7rem' }}>
                Plain text
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>

          {/* Body content */}
          {(hasHtml && viewMode === 'html') ? (
            <Box sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              overflow: 'hidden',
              bgcolor: 'common.white',
            }}>
              <iframe
                title="Email HTML preview"
                sandbox="allow-same-origin"
                srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;font-size:14px;color:${IFRAME_BODY_COLOR};padding:16px;margin:0;}</style></head><body>${preview.html}</body></html>`}
                style={{ width: '100%', minHeight: 240, border: 'none', display: 'block' }}
                onLoad={(e) => {
                  const iframe = e.currentTarget;
                  try {
                    const h = iframe.contentDocument?.body?.scrollHeight;
                    if (h && h > 0) iframe.style.height = `${h + 32}px`;
                  } catch (_) { /* cross-origin guard */ }
                }}
              />
            </Box>
          ) : (
            <Box sx={{
              px: 1.5, py: 1,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              bgcolor: 'background.paper',
              fontFamily: 'monospace',
              fontSize: '0.8rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 320,
              overflowY: 'auto',
            }}>
              {preview.text || <em style={{ opacity: 0.5 }}>empty body</em>}
            </Box>
          )}

          {loading && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary' }}>
              <CircularProgress size={12} />
              <Typography variant="caption">Updating preview…</Typography>
            </Box>
          )}
        </Stack>
      )}
    </Stack>
  );
}

// ── Malformed-placeholder messaging ───────────────────────────────────────────
// The per-reason wording (MALFORMED_REASON_TEXT / MALFORMED_REASON_ORDER) and
// the MalformedReasonText shape now live alongside the token classifier in
// TokenHighlightField, so the inline hover hint and this save-guard banner /
// confirm dialog share one source of truth.

interface MalformedGroup extends MalformedReasonText {
  reason: MalformedReason;
  tokens: string[];
}

// ── Edit dialog ───────────────────────────────────────────────────────────────

interface EditDialogProps {
  template: EmailTemplate;
  onClose: () => void;
  onSaved: (updated: EmailTemplate) => void;
}

function EditTemplateDialog({ template, onClose, onSaved }: EditDialogProps) {
  const showToast = useToast();
  const [activeTab, setActiveTab] = useState(0);
  const [fields, setFields] = useState<DraftFields>(() => {
    const draft = loadDraft(template.key);
    return draft || {
      subject: template.subject,
      body_text: template.body_text,
      body_html: template.body_html,
      footer_text: template.footer_text,
    };
  });
  const [hadDraft] = useState<boolean>(() => loadDraft(template.key) !== null);
  const [saving, setSaving] = useState(false);
  const [confirmUnknownOpen, setConfirmUnknownOpen] = useState(false);

  const hasUnsavedChanges =
    fields.subject    !== template.subject    ||
    fields.body_text  !== template.body_text  ||
    fields.body_html  !== template.body_html  ||
    fields.footer_text !== template.footer_text;

  // ── Click-to-insert variable chips ─────────────────────────────────────────
  // Track the most recently focused field so a chip click inserts the token at
  // its caret. Falls back to appending to the plain-text body if none focused.
  const fieldRefs = useRef<Record<keyof DraftFields, React.RefObject<TokenHighlightFieldHandle>>>({
    subject: React.createRef(),
    body_text: React.createRef(),
    body_html: React.createRef(),
    footer_text: React.createRef(),
  });
  const lastFocusedRef = useRef<keyof DraftFields | null>(null);

  const handleInsertVariable = useCallback((name: string) => {
    const target = lastFocusedRef.current;
    if (target) {
      fieldRefs.current[target].current?.insertAtCaret(`{{${name}}}`);
    } else {
      fieldRefs.current.body_text.current?.insertAtCaret(`{{${name}}}`, { append: true });
    }
  }, []);

  // ── Token analysis ────────────────────────────────────────────────────────
  // Reuse buildSegments (via analyzeTemplateTokens) so the inline field
  // highlighting and this save-guard banner always agree on what counts as a
  // malformed placeholder — including `{{` openers with no closing braces.
  // Each field is analysed independently so an unclosed opener typed at the end
  // of one field is treated as still-being-typed, not as "followed by" the next
  // field's text.
  const { unknownTokens, unusedVariables, malformedTokens } = useMemo(() => {
    const knownSet = new Set(template.variables);
    const { usedNames, unknownNames, malformedTokens } = analyzeTemplateTokens(
      [fields.subject, fields.body_text, fields.body_html, fields.footer_text],
      knownSet,
    );
    const usedSet = new Set(usedNames);
    return {
      unknownTokens: unknownNames,
      unusedVariables: template.variables.filter((v) => !usedSet.has(v)),
      malformedTokens,
    };
  }, [fields, template.variables]);

  // Group malformed placeholders by their cause so the save-guard banner and
  // confirm dialog can give each cause its own precise explanation.
  const malformedGroups = useMemo<MalformedGroup[]>(
    () =>
      MALFORMED_REASON_ORDER.map((reason) => ({
        reason,
        ...MALFORMED_REASON_TEXT[reason],
        tokens: malformedTokens
          .filter((m) => m.reason === reason)
          .map((m) => m.text),
      })).filter((g) => g.tokens.length > 0),
    [malformedTokens],
  );

  useEffect(() => {
    try {
      localStorage.setItem(draftKey(template.key), JSON.stringify(fields));
    } catch (_) { /* ignore */ }
  }, [template.key, fields]);

  const set = useCallback(
    (name: keyof DraftFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value;
      setFields((f) => ({ ...f, [name]: value }));
    },
    [],
  );

  const handleCancel = useCallback(() => {
    clearDraft(template.key);
    onClose();
  }, [template.key, onClose]);

  const { confirmOpen: confirmDiscardOpen, handleRequestClose, handleKeepEditing } = useDiscardGuard(
    hasUnsavedChanges,
    handleCancel,
  );

  const handleConfirmedSave = useCallback(async () => {
    if (!fields.subject.trim()) {
      showToast('Subject is required.', true);
      setConfirmUnknownOpen(false);
      return;
    }
    setConfirmUnknownOpen(false);
    setSaving(true);
    try {
      const updated = await PATCH<EmailTemplate>(
        `/api/admin/email-templates/${encodeURIComponent(template.key)}`,
        {
          subject: fields.subject,
          body_text: fields.body_text,
          body_html: fields.body_html,
          footer_text: fields.footer_text,
        },
      );
      clearDraft(template.key);
      showToast('Email template saved.');
      onSaved(updated);
    } catch (e) {
      showToast('Save failed: ' + (e as Error).message, true);
    } finally {
      setSaving(false);
    }
  }, [fields, template.key, showToast, onSaved]);

  const handleSave = useCallback(() => {
    if (!fields.subject.trim()) {
      showToast('Subject is required.', true);
      return;
    }
    if (unknownTokens.length > 0 || malformedTokens.length > 0) {
      setConfirmUnknownOpen(true);
      return;
    }
    handleConfirmedSave();
  }, [fields.subject, unknownTokens, malformedTokens, showToast, handleConfirmedSave]);

  return (
    <Dialog open onClose={handleRequestClose} maxWidth="md" fullWidth>
      <DialogTitle>Edit: {template.label}</DialogTitle>

      <Box sx={{ borderBottom: 1, borderColor: 'divider', px: 3 }}>
        <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)}>
          <Tab label="Edit" />
          <Tab label="Preview" />
        </Tabs>
      </Box>

      <DialogContent dividers>
        {/* Edit panel — always mounted so draft state is preserved; hidden when on Preview tab */}
        <Box sx={{ display: activeTab === 0 ? 'block' : 'none' }}>
          <Stack spacing={2.5} sx={{ mt: 0.5 }}>
            {template.description && (
              <Typography variant="body2" color="text.secondary">
                {template.description}
              </Typography>
            )}

            {template.variables.length > 0 && (
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
                  Available variables — click one to insert it at your cursor:
                </Typography>
                <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
                  {template.variables.map((v) => (
                    <Tooltip key={v} title={`Insert {{${v}}} into the field you're editing`}>
                      <Chip
                        label={`{{${v}}}`}
                        size="small"
                        variant="outlined"
                        clickable
                        onClick={() => handleInsertVariable(v)}
                      />
                    </Tooltip>
                  ))}
                </Stack>
              </Box>
            )}

            {hadDraft && (
              <Alert severity="info">
                Restored an unsaved draft from your last edit. Save to apply, or cancel to discard it.
              </Alert>
            )}

            {malformedGroups.map((g) => (
              <Alert key={g.reason} severity="warning">
                <strong>{g.heading}:</strong>{' '}
                {g.tokens.join(', ')}
                {' '}— {g.explanation}. As written{' '}
                {g.tokens.length > 1 ? 'these render' : 'this renders'} as literal
                text.
              </Alert>
            ))}

            {unknownTokens.length > 0 && (
              <Alert severity="warning">
                <strong>
                  Unknown variable{unknownTokens.length > 1 ? 's' : ''}:
                </strong>{' '}
                {unknownTokens.map((t) => `{{${t}}}`).join(', ')}
                {' '}— these will render as literal text in the sent email. Check for typos.
              </Alert>
            )}

            {unusedVariables.length > 0 && (
              <Alert severity="info" icon={false}
                sx={{ color: 'text.secondary', bgcolor: 'transparent', px: 0, py: 0.5 }}
              >
                <Typography variant="caption">
                  Not used:{' '}
                  {unusedVariables.map((v) => (
                    <Box
                      key={v}
                      component="span"
                      sx={{
                        fontFamily: 'monospace',
                        fontSize: '0.78rem',
                        bgcolor: 'action.hover',
                        borderRadius: 0.5,
                        px: 0.5,
                        mr: 0.5,
                      }}
                    >{`{{${v}}}`}</Box>
                  ))}
                </Typography>
              </Alert>
            )}

            <TokenHighlightField
              ref={fieldRefs.current.subject}
              label="Subject"
              value={fields.subject}
              onChange={set('subject')}
              onFocus={() => { lastFocusedRef.current = 'subject'; }}
              knownVariables={template.variables}
              required
              data-testid="template-field-subject"
            />
            <TokenHighlightField
              ref={fieldRefs.current.body_text}
              label="Body (plain text)"
              value={fields.body_text}
              onChange={set('body_text')}
              onFocus={() => { lastFocusedRef.current = 'body_text'; }}
              knownVariables={template.variables}
              multiline
              minRows={6}
              helperText="Sent as the plain-text part of the email."
              data-testid="template-field-body-text"
            />
            <TokenHighlightField
              ref={fieldRefs.current.body_html}
              label="Body (HTML)"
              value={fields.body_html}
              onChange={set('body_html')}
              onFocus={() => { lastFocusedRef.current = 'body_html'; }}
              knownVariables={template.variables}
              multiline
              minRows={6}
              helperText="Optional. Leave blank to auto-generate HTML from the plain-text body."
              data-testid="template-field-body-html"
            />
            <TokenHighlightField
              ref={fieldRefs.current.footer_text}
              label="Footer"
              value={fields.footer_text}
              onChange={set('footer_text')}
              onFocus={() => { lastFocusedRef.current = 'footer_text'; }}
              knownVariables={template.variables}
              multiline
              minRows={2}
              helperText="Appended to the end of every send of this template."
              data-testid="template-field-footer"
            />
          </Stack>
        </Box>

        {/* Preview panel — always mounted so it fetches updates while admin types on Edit tab */}
        <Box sx={{ display: activeTab === 1 ? 'block' : 'none', mt: 0.5 }}>
          <PreviewPanel templateKey={template.key} fields={fields} />
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={handleRequestClose} disabled={saving}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>

      {/* Discard-changes confirmation */}
      <DiscardConfirmDialog
        open={confirmDiscardOpen}
        onKeepEditing={handleKeepEditing}
        onDiscard={handleCancel}
      />

      {/* Confirmation dialog when unknown or malformed tokens are present */}
      <Dialog open={confirmUnknownOpen} onClose={() => setConfirmUnknownOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>
          {unknownTokens.length > 0 && malformedTokens.length > 0
            ? 'Variable problems in template'
            : malformedTokens.length > 0
              ? 'Malformed placeholders in template'
              : 'Unknown variables in template'}
        </DialogTitle>
        <DialogContent>
          {malformedGroups.map((g) => (
            <React.Fragment key={g.reason}>
              <Typography variant="body2" sx={{ mb: 1 }}>
                <strong>{g.heading}</strong> — {g.explanation}:
              </Typography>
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
                {g.tokens.map((t) => (
                  <Chip key={t} label={t} size="small" color="warning" />
                ))}
              </Stack>
            </React.Fragment>
          ))}
          {unknownTokens.length > 0 && (
            <>
              <Typography variant="body2" sx={{ mb: 1.5 }}>
                This template contains variable{unknownTokens.length > 1 ? 's' : ''} that won't be replaced when the email is sent:
              </Typography>
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75, mb: 1.5 }}>
                {unknownTokens.map((t) => (
                  <Chip key={t} label={`{{${t}}}`} size="small" color="warning" />
                ))}
              </Stack>
            </>
          )}
          <Typography variant="body2" color="text.secondary">
            These will appear as literal text in the sent email. Check for typos or remove them before saving.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmUnknownOpen(false)} disabled={saving}>Go back</Button>
          <Button onClick={handleConfirmedSave} variant="contained" color="warning" disabled={saving}>
            Save anyway
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function EmailTemplatesPage() {
  usePageTitle('Email templates · Measure Once');
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EmailTemplate | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await GET<EmailTemplate[]>('/api/admin/email-templates');
      setTemplates(rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Deep-link: scroll + flash the requested template row ──────────────────

  useEffect(() => {
    if (loading) return;
    try {
      const key = localStorage.getItem(ADMIN_DEEP_LINK_KEY);
      if (!key) return;
      localStorage.removeItem(ADMIN_DEEP_LINK_KEY);
      const el = document.querySelector<HTMLElement>(`[data-template-key="${CSS.escape(key)}"]`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.style.animation = 'none';
      el.getBoundingClientRect();
      el.style.animation = 'adm-deep-link-flash 1.8s ease-out forwards';
    } catch { /* ignore */ }
  }, [loading]);

  const handleSaved = useCallback((updated: EmailTemplate) => {
    setTemplates((prev) => prev.map((t) => (t.key === updated.key ? updated : t)));
    setEditing(null);
  }, []);

  return (
    <Box sx={{ py: 1 }}>
      <GlobalStyles styles={`
        @keyframes adm-deep-link-flash {
          0%   { outline: 2px solid transparent; outline-offset: 0px; }
          10%  { outline: 2px solid #8B2BFF;     outline-offset: 2px; }
          80%  { outline: 2px solid #8B2BFF;     outline-offset: 2px; }
          100% { outline: 2px solid transparent; outline-offset: 0px; }
        }
      `} />
      <Typography variant="h6" sx={{ mb: 1 }}>Email templates</Typography>
      <Alert severity="info" sx={{ mb: 2 }}>
        Edit the subject, body and footer of the emails this app sends. Changes take effect immediately.
        Templates left unedited use the built-in defaults. The <strong>Used by</strong> column shows which action handlers send each template.
      </Alert>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      )}

      {error && !loading && (
        <Alert severity="error" sx={{ mb: 2 }} action={
          <Button color="inherit" size="small" onClick={fetchAll}>Retry</Button>
        }>
          Could not load email templates: {error}
        </Alert>
      )}

      {!loading && !error && (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Template</TableCell>
                <TableCell>Subject</TableCell>
                <TableCell>Last updated</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {templates.map((t) => {
                const usedByHandlers = Object.entries(HANDLER_EMAIL_TEMPLATES)
                  .filter(([, keys]) => keys.includes(t.key))
                  .map(([type]) => ({ type, label: HANDLER_TYPE_LABELS[type] || type }));
                return (
                  <TableRow key={t.key} hover data-template-key={t.key}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{t.label}</Typography>
                      <Typography variant="caption" color="text.secondary">{t.key}</Typography>
                      {usedByHandlers.length > 0 && (
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                          {usedByHandlers.map(h => (
                            <Chip
                              key={h.type}
                              label={h.label}
                              size="small"
                              sx={{
                                fontSize: '0.7rem',
                                height: 20,
                                bgcolor: 'rgba(124,58,237,0.08)',
                                color: 'rgb(109,40,217)',
                                '.MuiChip-label': { px: 0.75 },
                              }}
                            />
                          ))}
                        </Box>
                      )}
                    </TableCell>
                    <TableCell>{t.subject}</TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary">{formatUpdated(t)}</Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Button size="small" onClick={() => setEditing(t)}>Edit</Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {templates.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                      No email templates found.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      {editing && (
        <EditTemplateDialog
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </Box>
  );
}
