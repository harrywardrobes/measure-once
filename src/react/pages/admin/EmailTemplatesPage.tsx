import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EMAIL_TEMPLATE_DRAFT_PREFIX as DRAFT_PREFIX, ADMIN_DEEP_LINK_KEY, ADMIN_ACTIVE_GROUP_KEY, ADMIN_ACTIVE_TAB_KEY } from '../../constants/localStorageKeys';

import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
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
  Tabs,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import MailOutlineIcon from '@mui/icons-material/EmailOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';

import { GET, PATCH, POST } from '../../utils/api';
import { useToast } from '../../contexts/ToastContext';
import { useDiscardGuard } from '../../hooks/useDiscardGuard';
import { DiscardConfirmDialog } from '../../components/modals/DiscardConfirmDialog';
import { usePageTitle } from '../../hooks/usePageTitle';
import {
  HANDLER_OUTCOMES,
  HANDLER_TYPE_LABELS,
  ACTION_LEVEL_EMAIL_TEMPLATES,
  SYSTEM_EMAIL_TEMPLATES,
  isHandlerType,
} from '../../utils/handlerMeta';
import {
  templateRefKey,
  templateRefIsSystem,
  templateRefSentFrom,
  templateRefTrigger,
} from '../../../../shared/handler-outcomes';
import PersonOutlineIcon from '@mui/icons-material/PersonOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import type { HandlerType } from '../../components/CardActionModalsHost';
import {
  analyzeTemplateTokens,
  MALFORMED_REASON_ORDER,
  MALFORMED_REASON_TEXT,
  TokenHighlightField,
  type MalformedReason,
  type MalformedReasonText,
  type TokenHighlightFieldHandle,
} from '../../components/TokenHighlightField';

function navigateToWorkflow(handlerType: string) {
  try { localStorage.setItem(ADMIN_DEEP_LINK_KEY, handlerType); } catch { /* ignore */ }
  const W = window as unknown as Record<string, unknown>;
  if (typeof W.adminSwitchToTab === 'function') {
    (W.adminSwitchToTab as (id: string) => void)('workflow');
  } else {
    try {
      localStorage.setItem(ADMIN_ACTIVE_GROUP_KEY, 'configuration');
      localStorage.setItem(ADMIN_ACTIVE_TAB_KEY, 'workflow');
    } catch { /* ignore */ }
    location.href = '/admin';
  }
}

/** Body text colour for the iframe email preview. Not a React style prop — lives inside a raw HTML string. */
const IFRAME_BODY_COLOR = '#111';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TemplateAudience = 'customer' | 'team';

/** Display metadata for each recipient audience. Keyed by audience, not by
 *  template key — sourced from the per-template `audience` field on the API. */
const AUDIENCE_META: Record<TemplateAudience, { label: string; tooltip: string }> = {
  customer: {
    label: 'Customer',
    tooltip: 'Sent to the customer (external recipient).',
  },
  team: {
    label: 'Internal team',
    tooltip: 'Sent to internal staff / the team — not to the customer.',
  },
};

export interface EmailTemplate {
  key: string;
  label: string;
  description: string;
  /** Recipient audience — 'customer' or 'team' (internal). Null if unspecified. */
  audience: TemplateAudience | null;
  variables: string[];
  variableDescriptions?: Record<string, string>;
  defaultVariablesUsed?: string[];
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
                    // reflow-ok: fires once per iframe load (not a hot path); sizes the iframe to its content height.
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
  /** Plain-language description of what fires this email — passed through from the row's trigger prop. */
  trigger?: string;
  onClose: () => void;
  onSaved: (updated: EmailTemplate) => void;
}

function EditTemplateDialog({ template, trigger, onClose, onSaved }: EditDialogProps) {
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

  const defaultUsedSet = useMemo(
    () => new Set(template.defaultVariablesUsed ?? []),
    [template.defaultVariablesUsed],
  );

  const missingDefaultVars = useMemo(
    () => unusedVariables.filter((v) => defaultUsedSet.has(v)),
    [unusedVariables, defaultUsedSet],
  );

  const otherUnusedVars = useMemo(
    () => unusedVariables.filter((v) => !defaultUsedSet.has(v)),
    [unusedVariables, defaultUsedSet],
  );

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

  const audience = template.audience ?? null;
  const audienceMeta = audience ? AUDIENCE_META[audience] : null;
  const chipSx = { height: 20, fontSize: '0.7rem', '.MuiChip-label': { px: 0.75 } } as const;

  return (
    <Dialog open onClose={handleRequestClose} maxWidth="md" fullWidth>
      <DialogTitle>Edit: {template.label}</DialogTitle>

      {(audienceMeta || trigger) && (
        <Box sx={{ px: 3, pb: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
          {audienceMeta && (
            <Tooltip title={audienceMeta.tooltip} arrow>
              <Chip
                icon={audience === 'team' ? <GroupsOutlinedIcon /> : <PersonOutlineIcon />}
                label={audienceMeta.label}
                size="small"
                variant="outlined"
                color={audience === 'team' ? 'secondary' : 'success'}
                sx={{ ...chipSx, '.MuiChip-icon': { fontSize: '0.85rem', ml: 0.5 } }}
              />
            </Tooltip>
          )}
          {trigger && (
            <Typography variant="caption" color="text.secondary">
              <Box component="span" sx={{ fontWeight: 600 }}>Triggered:</Box> {trigger}
            </Typography>
          )}
        </Box>
      )}

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
                  {template.variables.map((v) => {
                    const desc = template.variableDescriptions?.[v];
                    return (
                      <Tooltip
                        key={v}
                        title={desc ? <>{desc}<br /><em>Click to insert</em></> : `Insert {{${v}}} into the field you're editing`}
                        arrow
                      >
                        <Chip
                          label={`{{${v}}}`}
                          size="small"
                          variant="outlined"
                          clickable
                          onClick={() => handleInsertVariable(v)}
                        />
                      </Tooltip>
                    );
                  })}
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

            {missingDefaultVars.length > 0 && (
              <Alert severity="warning">
                <strong>
                  Variable{missingDefaultVars.length > 1 ? 's' : ''} from the default template not included:
                </strong>{' '}
                {missingDefaultVars.map((v) => `{{${v}}}`).join(', ')}
                {' '}— {missingDefaultVars.length > 1 ? 'these are' : 'this is'} used in the
                built-in default but absent from your custom version.
                If the value{missingDefaultVars.length > 1 ? 's are' : ' is'} available when the
                email is sent, {missingDefaultVars.length > 1 ? 'they' : 'it'} won't appear in
                the email.
              </Alert>
            )}

            {otherUnusedVars.length > 0 && (
              <Alert severity="info" icon={false}
                sx={{ color: 'text.secondary', bgcolor: 'transparent', px: 0, py: 0.5 }}
              >
                <Typography variant="caption">
                  Not used:{' '}
                  {otherUnusedVars.map((v) => (
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

// ── Template row ───────────────────────────────────────────────────────────────

interface TemplateRowProps {
  templateKey: string;
  template: EmailTemplate | undefined;
  shared: boolean;
  system: boolean;
  /** For system / system-in-flow emails: the module that actually sends it. */
  sentFrom?: string;
  /** Plain-language description of the exact condition that fires this email. */
  trigger?: string;
  onEdit: (t: EmailTemplate, trigger?: string) => void;
}

/** A single email-template row used inside every accordion (handler / system /
 *  unassigned). Carries the `data-template-key` attribute the deep-link flash
 *  targets. */
export function TemplateRow({ templateKey, template, shared, system, sentFrom, trigger, onEdit }: TemplateRowProps) {
  const chipSx = { height: 18, fontSize: '0.65rem', '.MuiChip-label': { px: 0.6 } } as const;
  const systemTooltip = system
    ? sentFrom
      ? `System / in-flow email — sent by ${sentFrom}`
      : 'System / lifecycle email — not tied to a workflow handler'
    : '';
  const audience = template?.audience ?? null;
  const audienceMeta = audience ? AUDIENCE_META[audience] : null;
  return (
    <Box
      data-template-key={templateKey}
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        py: 1,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
      }}
    >
      <Box sx={{ flex: '1 1 280px', minWidth: 0 }}>
        <Stack direction="row" sx={{ alignItems: 'center', flexWrap: 'wrap', gap: 0.5 }}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {template?.label || templateKey}
          </Typography>
          {shared && (
            <Tooltip title="Sent by more than one outcome or handler" arrow>
              <Chip label="Shared" size="small" color="info" variant="outlined" sx={chipSx} />
            </Tooltip>
          )}
          {system && (
            <Tooltip title={systemTooltip} arrow>
              <Chip label="System" size="small" variant="outlined" sx={chipSx} />
            </Tooltip>
          )}
          {audienceMeta && (
            <Tooltip title={audienceMeta.tooltip} arrow>
              <Chip
                icon={audience === 'team' ? <GroupsOutlinedIcon /> : <PersonOutlineIcon />}
                label={audienceMeta.label}
                size="small"
                variant="outlined"
                color={audience === 'team' ? 'secondary' : 'success'}
                sx={{ ...chipSx, '.MuiChip-icon': { fontSize: '0.8rem', ml: 0.4 } }}
              />
            </Tooltip>
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {templateKey}
        </Typography>
        {trigger && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
            <Box component="span" sx={{ fontWeight: 600 }}>Triggered:</Box> {trigger}
          </Typography>
        )}
        {sentFrom && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25, fontStyle: 'italic' }}>
            Sent from {sentFrom}
          </Typography>
        )}
        {template && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }} noWrap>
            {template.subject}
          </Typography>
        )}
      </Box>
      <Box sx={{ flex: '0 0 auto', textAlign: 'right', ml: 'auto' }}>
        {template ? (
          <>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              {formatUpdated(template)}
            </Typography>
            <Button size="small" variant="outlined" onClick={() => onEdit(template!, trigger)}>Edit</Button>
          </>
        ) : (
          <Typography variant="caption" color="error">Template not found</Typography>
        )}
      </Box>
    </Box>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function EmailTemplatesPage() {
  usePageTitle('Email templates · Measure Once');
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ template: EmailTemplate; trigger?: string } | null>(null);
  const handleEdit = useCallback((t: EmailTemplate, trigger?: string) => setEditing({ template: t, trigger }), []);

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

  // ── Derive the accordion structure from the outcome registry ──────────────

  const templatesByKey = useMemo(() => {
    const m = new Map<string, EmailTemplate>();
    for (const t of templates) m.set(t.key, t);
    return m;
  }, [templates]);

  // How many handler outcomes / action-level slots reference each template key.
  // A count > 1 marks the template as "shared" across outcomes/handlers.
  const usageCount = useMemo(() => {
    const m = new Map<string, number>();
    const bump = (k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const type of Object.keys(HANDLER_OUTCOMES)) {
      for (const o of HANDLER_OUTCOMES[type as HandlerType] ?? []) {
        for (const ref of o.sendsEmailTemplates ?? []) bump(templateRefKey(ref));
      }
      for (const ref of ACTION_LEVEL_EMAIL_TEMPLATES[type as HandlerType] ?? []) bump(templateRefKey(ref));
    }
    return m;
  }, []);

  const systemKeys = useMemo(
    () => new Set(SYSTEM_EMAIL_TEMPLATES.map((s) => s.key)),
    [],
  );

  // One accordion per handler that sends ≥1 email. Each has outcome sub-groups
  // plus a "During action" group for action-level templates. Iteration order
  // follows HANDLER_TYPE_LABELS (the canonical display order) rather than the
  // outcome-registry key order, so handlers always render in the same sequence
  // they appear elsewhere in the admin UI.
  const handlerAccordions = useMemo(() => {
    type Ref = { key: string; system: boolean; sentFrom?: string; trigger?: string };
    const toRef = (r: Parameters<typeof templateRefKey>[0]): Ref => ({
      key: templateRefKey(r),
      system: templateRefIsSystem(r),
      sentFrom: templateRefSentFrom(r),
      trigger: templateRefTrigger(r),
    });
    return Object.keys(HANDLER_TYPE_LABELS)
      .filter(isHandlerType)
      .map((type) => {
        const handlerLabel = HANDLER_TYPE_LABELS[type];
        const groups: { label: string; trigger?: string; refs: Ref[] }[] = [];
        for (const o of HANDLER_OUTCOMES[type] ?? []) {
          if (o.sendsEmailTemplates && o.sendsEmailTemplates.length > 0) {
            // Plain-language trigger derived from the outcome: which staff
            // selection on which handler fires this email.
            const groupTrigger = `Sent when "${o.label}" is selected on the ${handlerLabel} action.`;
            groups.push({ label: o.label, trigger: groupTrigger, refs: o.sendsEmailTemplates.map(toRef) });
          }
        }
        const actionLevel = ACTION_LEVEL_EMAIL_TEMPLATES[type] ?? [];
        if (actionLevel.length > 0) {
          // Action-level emails carry their own per-ref trigger (no staff
          // outcome to derive from), so the group has no shared trigger.
          groups.push({ label: 'During action', refs: actionLevel.map(toRef) });
        }
        const keys = groups.flatMap((g) => g.refs.map((r) => r.key));
        return { id: `handler:${type}`, type, label: handlerLabel, groups, keys };
      })
      .filter((a) => a.groups.length > 0);
  }, []);

  // Templates the registry doesn't reference (no handler outcome / action-level
  // slot, not in the system list) — surfaced in a warning accordion.
  const coveredKeys = useMemo(() => {
    const s = new Set<string>();
    for (const a of handlerAccordions) for (const k of a.keys) s.add(k);
    for (const k of systemKeys) s.add(k);
    return s;
  }, [handlerAccordions, systemKeys]);

  const unassignedTemplates = useMemo(
    () => templates.filter((t) => !coveredKeys.has(t.key)),
    [templates, coveredKeys],
  );

  // Map each template key → the set of accordion ids that reveal it, so the
  // deep-link flash can expand EVERY panel containing the row before scrolling.
  // A system-in-flow template can live under both a handler accordion and the
  // System accordion, so a single id is not enough.
  const keyToAccordionIds = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (k: string, id: string) => {
      const s = m.get(k) ?? new Set<string>();
      s.add(id);
      m.set(k, s);
    };
    for (const a of handlerAccordions) for (const k of a.keys) add(k, a.id);
    for (const k of systemKeys) add(k, 'system');
    for (const t of unassignedTemplates) add(t.key, 'unassigned');
    return m;
  }, [handlerAccordions, systemKeys, unassignedTemplates]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Expand the Unassigned panel by default whenever it has entries so the
  // warning is never hidden behind a collapsed accordion.
  useEffect(() => {
    if (unassignedTemplates.length === 0) return;
    setExpanded((prev) => (prev.has('unassigned') ? prev : new Set(prev).add('unassigned')));
  }, [unassignedTemplates.length]);

  const toggleAccordion = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // ── Deep-link: expand the parent accordion, then scroll + flash the row ────

  useEffect(() => {
    if (loading) return;
    try {
      const key = localStorage.getItem(ADMIN_DEEP_LINK_KEY);
      if (!key) return;
      localStorage.removeItem(ADMIN_DEEP_LINK_KEY);
      const accIds = keyToAccordionIds.get(key);
      if (accIds && accIds.size > 0) {
        setExpanded((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const id of accIds) if (!next.has(id)) { next.add(id); changed = true; }
          return changed ? next : prev;
        });
      }
      // Let the accordion expansion render before scrolling / flashing.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-template-key="${CSS.escape(key)}"]`);
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.style.animation = 'none';
        el.getBoundingClientRect(); // reflow-ok: intentional one-shot CSS animation restart trick (forces style recalc to clear animation state)
        el.style.animation = 'adm-deep-link-flash 1.8s ease-out forwards';
      }));
    } catch { /* ignore */ }
  }, [loading, keyToAccordionIds]);

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
        Templates left unedited use the built-in defaults. Templates are grouped by the action handler that
        sends them, by outcome. <strong>System emails</strong> are lifecycle messages sent outside the workflow.
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

      {!loading && !error && templates.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          No email templates found.
        </Typography>
      )}

      {!loading && !error && templates.length > 0 && (
        <Stack spacing={1}>
          {/* Handler accordions — one per handler that sends email, in registry order */}
          {handlerAccordions.map((a) => (
            <Accordion
              key={a.id}
              expanded={expanded.has(a.id)}
              onChange={() => toggleAccordion(a.id)}
              disableGutters
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                sx={{ '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1, my: 1, pr: 1 } }}
              >
                <MailOutlineIcon fontSize="small" color="action" />
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>{a.label}</Typography>
                <Chip label={`${a.keys.length} template${a.keys.length === 1 ? '' : 's'}`} size="small" sx={{ height: 20 }} />
                <Tooltip title="View this handler in the Workflow tab" arrow>
                  <Button
                    size="small"
                    startIcon={<OpenInNewIcon />}
                    onClick={(e) => { e.stopPropagation(); navigateToWorkflow(a.type); }}
                    sx={{ ml: 'auto', textTransform: 'none' }}
                  >
                    Workflow
                  </Button>
                </Tooltip>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                <Stack spacing={2}>
                  {a.groups.map((g) => (
                    <Box key={g.label}>
                      <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                        {g.label}
                      </Typography>
                      <Stack spacing={1}>
                        {g.refs.map((r) => (
                          <TemplateRow
                            key={r.key}
                            templateKey={r.key}
                            template={templatesByKey.get(r.key)}
                            shared={(usageCount.get(r.key) ?? 0) > 1}
                            system={r.system}
                            sentFrom={r.sentFrom}
                            trigger={r.trigger ?? g.trigger}
                            onEdit={handleEdit}
                          />
                        ))}
                      </Stack>
                    </Box>
                  ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          ))}

          {/* System emails — lifecycle messages sent outside the workflow */}
          <Accordion
            expanded={expanded.has('system')}
            onChange={() => toggleAccordion('system')}
            disableGutters
          >
            <AccordionSummary
              expandIcon={<ExpandMoreIcon />}
              sx={{ '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1, my: 1, pr: 1 } }}
            >
              <MailOutlineIcon fontSize="small" color="action" />
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>System emails</Typography>
              <Chip label={`${SYSTEM_EMAIL_TEMPLATES.length} template${SYSTEM_EMAIL_TEMPLATES.length === 1 ? '' : 's'}`} size="small" sx={{ height: 20 }} />
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0 }}>
              <Alert severity="info" sx={{ mb: 1.5 }}>
                Lifecycle emails sent by the sign-in and onboarding flow — not triggered by a workflow handler.
              </Alert>
              <Stack spacing={1}>
                {SYSTEM_EMAIL_TEMPLATES.map((s) => (
                  <TemplateRow
                    key={s.key}
                    templateKey={s.key}
                    template={templatesByKey.get(s.key)}
                    shared={false}
                    system
                    sentFrom={s.sentFrom}
                    trigger={s.description}
                    onEdit={handleEdit}
                  />
                ))}
              </Stack>
            </AccordionDetails>
          </Accordion>

          {/* Unassigned — templates not referenced by the registry (warning) */}
          {unassignedTemplates.length > 0 && (
            <Accordion
              expanded={expanded.has('unassigned')}
              onChange={() => toggleAccordion('unassigned')}
              disableGutters
              sx={{ border: '1px solid', borderColor: 'warning.main' }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                sx={{ '& .MuiAccordionSummary-content': { alignItems: 'center', gap: 1, my: 1, pr: 1 } }}
              >
                <WarningAmberIcon fontSize="small" color="warning" />
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Unassigned</Typography>
                <Chip label={`${unassignedTemplates.length} template${unassignedTemplates.length === 1 ? '' : 's'}`} size="small" color="warning" sx={{ height: 20 }} />
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                <Alert severity="warning" sx={{ mb: 1.5 }}>
                  These templates aren&apos;t linked to any handler outcome, action-level slot, or the system
                  email list. Add them to the outcome registry (<code>shared/handler-outcomes.ts</code>) so the
                  grouping stays accurate.
                </Alert>
                <Stack spacing={1}>
                  {unassignedTemplates.map((t) => (
                    <TemplateRow
                      key={t.key}
                      templateKey={t.key}
                      template={t}
                      shared={false}
                      system={false}
                      onEdit={handleEdit}
                    />
                  ))}
                </Stack>
              </AccordionDetails>
            </Accordion>
          )}
        </Stack>
      )}

      {editing && (
        <EditTemplateDialog
          template={editing.template}
          trigger={editing.trigger}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </Box>
  );
}
