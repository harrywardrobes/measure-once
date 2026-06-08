import React, { useCallback, useEffect, useState } from 'react';

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
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';

import { GET, PATCH } from '../../utils/api';
import { useToast } from '../../contexts/ToastContext';
import { usePageTitle } from '../../hooks/usePageTitle';

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

const DRAFT_PREFIX = 'emailTemplateDraft:';

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

// ── Edit dialog ───────────────────────────────────────────────────────────────

interface EditDialogProps {
  template: EmailTemplate;
  onClose: () => void;
  onSaved: (updated: EmailTemplate) => void;
}

function EditTemplateDialog({ template, onClose, onSaved }: EditDialogProps) {
  const showToast = useToast();
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

  // Persist the in-progress edit so a refresh / navigation does not lose work.
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

  const handleSave = useCallback(async () => {
    if (!fields.subject.trim()) {
      showToast('Subject is required.', true);
      return;
    }
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

  return (
    <Dialog open onClose={handleCancel} maxWidth="md" fullWidth>
      <DialogTitle>Edit: {template.label}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5} sx={{ mt: 0.5 }}>
          {template.description && (
            <Typography variant="body2" color="text.secondary">
              {template.description}
            </Typography>
          )}

          {template.variables.length > 0 && (
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
                Available variables (insert with double curly braces, e.g. {'{{firstName}}'}):
              </Typography>
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
                {template.variables.map((v) => (
                  <Chip key={v} label={`{{${v}}}`} size="small" variant="outlined" />
                ))}
              </Stack>
            </Box>
          )}

          {hadDraft && (
            <Alert severity="info">
              Restored an unsaved draft from your last edit. Save to apply, or cancel to discard it.
            </Alert>
          )}

          <TextField
            label="Subject"
            value={fields.subject}
            onChange={set('subject')}
            fullWidth
            required
          />
          <TextField
            label="Body (plain text)"
            value={fields.body_text}
            onChange={set('body_text')}
            fullWidth
            multiline
            minRows={6}
            helperText="Sent as the plain-text part of the email."
          />
          <TextField
            label="Body (HTML)"
            value={fields.body_html}
            onChange={set('body_html')}
            fullWidth
            multiline
            minRows={6}
            helperText="Optional. Leave blank to auto-generate HTML from the plain-text body."
          />
          <TextField
            label="Footer"
            value={fields.footer_text}
            onChange={set('footer_text')}
            fullWidth
            multiline
            minRows={2}
            helperText="Appended to the end of every send of this template."
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleCancel} disabled={saving}>Cancel</Button>
        <Button onClick={handleSave} variant="contained" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
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

  const handleSaved = useCallback((updated: EmailTemplate) => {
    setTemplates((prev) => prev.map((t) => (t.key === updated.key ? updated : t)));
    setEditing(null);
  }, []);

  return (
    <Box sx={{ py: 1 }}>
      <Typography variant="h6" sx={{ mb: 0.5 }}>Email templates</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Edit the subject, body and footer of the emails this app sends. Changes
        take effect immediately. Templates left unedited use the built-in
        defaults.
      </Typography>

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
              {templates.map((t) => (
                <TableRow key={t.key} hover>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>{t.label}</Typography>
                    <Typography variant="caption" color="text.secondary">{t.key}</Typography>
                  </TableCell>
                  <TableCell>{t.subject}</TableCell>
                  <TableCell>
                    <Typography variant="caption" color="text.secondary">{formatUpdated(t)}</Typography>
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" onClick={() => setEditing(t)}>Edit</Button>
                  </TableCell>
                </TableRow>
              ))}
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
