/**
 * EmailComposer — shared inline email editor with Edit/Preview mode.
 *
 * Shows editable subject and body fields. When `fetchPreviewHtml` is supplied
 * the component renders an Edit/Preview toggle; switching to Preview calls the
 * callback to get the rendered HTML and displays it in a sandboxed iframe.
 * While in Preview mode, changes to subject or body trigger a debounced
 * refresh (600 ms) so the iframe stays in sync.
 *
 * Does NOT render Send/Cancel buttons — those belong in the parent's footer.
 */
import React, { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import AttachFileIcon from '@mui/icons-material/AttachFile';

function bodyTextToHtml(text: string): string {
  return text
    .split('\n')
    .map(l => {
      if (l.trim() === '') return '';
      return `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</p>`;
    })
    .join('');
}

export interface EmailComposerProps {
  subject: string;
  onSubjectChange: (s: string) => void;
  body: string;
  onBodyChange: (b: string) => void;
  /** When provided, enables the Edit/Preview toggle and calls this to fetch rendered HTML. */
  fetchPreviewHtml?: (subject: string, body: string) => Promise<string>;
  disabled?: boolean;
  recipientName?: string;
  recipientEmail?: string;
  bodyMinRows?: number;
  bodyMaxLength?: number;
  subjectMaxLength?: number;
  /** External error message shown below the composer (e.g. send failure). */
  sendError?: string;
  /** Files attached to this email. */
  attachments?: File[];
  /** Called when the attachment list changes (add or remove). */
  onAttachmentsChange?: (files: File[]) => void;
}

export function EmailComposer({
  subject,
  onSubjectChange,
  body,
  onBodyChange,
  fetchPreviewHtml,
  disabled,
  recipientName,
  recipientEmail,
  bodyMinRows = 4,
  bodyMaxLength,
  subjectMaxLength,
  sendError,
  attachments = [],
  onAttachmentsChange,
}: EmailComposerProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (!onAttachmentsChange) return;
    const incoming = Array.from(e.target.files || []);
    if (!incoming.length) return;
    const merged = [...attachments, ...incoming];
    onAttachmentsChange(merged);
    // Reset so re-selecting the same file triggers onChange again.
    e.target.value = '';
  }

  function removeAttachment(index: number) {
    if (!onAttachmentsChange) return;
    onAttachmentsChange(attachments.filter((_, i) => i !== index));
  }

  const totalBytes = attachments.reduce((s, f) => s + f.size, 0);
  const oversized = totalBytes > 20 * 1024 * 1024;
  const [viewMode, setViewMode] = useState<'edit' | 'preview'>('edit');
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetchedSubjectRef = useRef('');
  const fetchedBodyRef = useRef('');

  async function doFetchPreview(s: string, b: string) {
    if (!fetchPreviewHtml) return;
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const html = await fetchPreviewHtml(s, b);
      setPreviewHtml(html);
      fetchedSubjectRef.current = s;
      fetchedBodyRef.current = b;
    } catch {
      setPreviewError('Could not load email preview.');
    } finally {
      setPreviewLoading(false);
    }
  }

  // Debounced auto-refresh while in Preview mode.
  useEffect(() => {
    if (viewMode !== 'preview' || previewLoading || !fetchPreviewHtml) return;
    const bodyDirty    = body.trim()    !== fetchedBodyRef.current.trim();
    const subjectDirty = subject.trim() !== fetchedSubjectRef.current.trim();
    if (!bodyDirty && !subjectDirty) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void doFetchPreview(subject.trim(), body.trim());
    }, 600);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, subject, viewMode, previewLoading]);

  // Clear debounce on unmount.
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  function handleToggleViewMode(_: React.MouseEvent, next: 'edit' | 'preview' | null) {
    if (!next) return;
    setViewMode(next);
    if (next === 'preview' && fetchPreviewHtml) {
      const bodyDirty    = body.trim()    !== fetchedBodyRef.current.trim();
      const subjectDirty = subject.trim() !== fetchedSubjectRef.current.trim();
      if (bodyDirty || subjectDirty) {
        if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
        void doFetchPreview(subject.trim(), body.trim());
      }
    }
  }

  const recipientLine = recipientName
    ? `${recipientName}${recipientEmail ? ` <${recipientEmail}>` : ''}`
    : recipientEmail || null;

  const fallbackHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;font-size:14px;color:#111;padding:12px 16px;margin:0;}p{margin:0 0 0.6em;}</style></head><body>${bodyTextToHtml(body)}</body></html>`;

  return (
    <Stack spacing={1.5}>
      {/* To: + toggle row */}
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 1 }}>
        {recipientLine ? (
          <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
            To: <strong>{recipientLine}</strong>
          </Typography>
        ) : <span />}
        {fetchPreviewHtml && (
          <ToggleButtonGroup
            size="small"
            exclusive
            value={viewMode}
            onChange={handleToggleViewMode}
            disabled={disabled}
          >
            <ToggleButton value="edit" sx={{ px: 1.25, py: 0.25, fontSize: '0.7rem' }}>
              Edit
            </ToggleButton>
            <ToggleButton value="preview" sx={{ px: 1.25, py: 0.25, fontSize: '0.7rem' }}>
              Preview
            </ToggleButton>
          </ToggleButtonGroup>
        )}
      </Box>

      {viewMode === 'edit' ? (
        <>
          <TextField
            label="Subject"
            size="small"
            fullWidth
            value={subject}
            onChange={e => onSubjectChange(e.target.value)}
            disabled={disabled}
            slotProps={{ htmlInput: subjectMaxLength ? { maxLength: subjectMaxLength } : {} }}
          />
          <TextField
            label="Body"
            size="small"
            multiline
            minRows={bodyMinRows}
            fullWidth
            value={body}
            onChange={e => onBodyChange(e.target.value)}
            disabled={disabled}
            slotProps={{ htmlInput: bodyMaxLength ? { maxLength: bodyMaxLength } : {} }}
          />
          {onAttachmentsChange && (
            <Box>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileInputChange}
              />
              <Button
                size="small"
                variant="outlined"
                startIcon={<AttachFileIcon />}
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled}
                sx={{ mb: attachments.length ? 1 : 0 }}
              >
                Attach file
              </Button>
              {attachments.length > 0 && (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                  {attachments.map((file, i) => (
                    <Chip
                      key={i}
                      label={file.name}
                      size="small"
                      variant="outlined"
                      onDelete={disabled ? undefined : () => removeAttachment(i)}
                    />
                  ))}
                </Box>
              )}
              {oversized && (
                <Alert severity="warning" sx={{ mt: 0.75, py: 0 }}>
                  Total attachment size exceeds 20 MB — the email may be rejected by the recipient's server.
                </Alert>
              )}
            </Box>
          )}
        </>
      ) : (
        /* Preview mode */
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
            Subject
          </Typography>
          <Box sx={{
            px: 1.5, py: 0.75,
            border: '1px solid', borderColor: 'divider',
            borderRadius: 1, bgcolor: 'background.paper', mb: 1,
          }}>
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {subject.trim() || <em style={{ opacity: 0.5 }}>empty subject</em>}
            </Typography>
          </Box>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>
            Body
          </Typography>
          <Box sx={{
            border: '1px solid', borderColor: 'divider',
            borderRadius: 1, overflow: 'hidden',
            bgcolor: 'common.white', position: 'relative',
          }}>
            {previewLoading && (
              <Box sx={{
                position: 'absolute', inset: 0,
                display: 'flex', alignItems: 'center', gap: 1,
                px: 2, py: 1.5, bgcolor: 'rgba(255,255,255,0.75)', zIndex: 1,
              }}>
                <CircularProgress size={16} />
                <Typography variant="caption" color="text.secondary">Refreshing preview…</Typography>
              </Box>
            )}
            <iframe
              title="Email preview"
              sandbox="allow-same-origin"
              srcDoc={previewHtml || fallbackHtml}
              style={{ width: '100%', minHeight: 120, border: 'none', display: 'block' }}
              onLoad={e => {
                const iframe = e.currentTarget;
                try {
                  const h = iframe.contentDocument?.body?.scrollHeight;
                  if (h && h > 0) iframe.style.height = `${h + 24}px`;
                } catch { /* cross-origin guard */ }
              }}
            />
          </Box>
        </Box>
      )}

      {previewError && (
        <Alert severity="error" sx={{ py: 0 }}>{previewError}</Alert>
      )}
      {sendError && (
        <Alert severity="error" sx={{ py: 0 }}>{sendError}</Alert>
      )}
    </Stack>
  );
}
