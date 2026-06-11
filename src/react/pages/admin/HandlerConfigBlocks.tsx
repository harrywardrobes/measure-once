import React, { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

// ── Shared types ───────────────────────────────────────────────────────────────

export interface LeadStatusOption {
  key: string;
  label: string;
}

// ── Shared utilities ────────────────────────────────────────────────────────────

/**
 * Returns true if `key` is a non-empty string that matches a lead-status key
 * in `statuses`.  An empty / absent key is considered valid (not stale).
 */
export function isLeadStatusKeyValid(
  key: string | undefined | null,
  statuses: LeadStatusOption[],
): boolean {
  if (!key) return true;
  return statuses.some(s => s.key === key);
}

/**
 * Canonical list of config fields that store a lead-status or sub-status key.
 * Used by both the dedicated config blocks and the JSON fallback editor to
 * detect stale references uniformly.
 *
 * - `'lead_status'`              → key must exist in lead statuses only
 */
export const KNOWN_STATUS_KEY_FIELDS: ReadonlyArray<{
  field: string;
  label: string;
  type: 'lead_status';
}> = [
  {
    field: 'intermediateLeadStatus',
    label: 'In-progress lead status',
    type: 'lead_status',
  },
  {
    field: 'submittedLeadStatus',
    label: 'Submitted lead status',
    type: 'lead_status',
  },
] as const;

// ── Shared sub-components ──────────────────────────────────────────────────────

function ConfigLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      sx={{ display: 'block', mb: 0.5, fontWeight: 500 }}
    >
      {children}
    </Typography>
  );
}

// ── ScheduleVisitConfig ────────────────────────────────────────────────────────

export type VisitType =
  | 'design'
  | 'survey'
  | 'other';

export interface ScheduleVisitConfigValue {
  visitType: VisitType;
  defaultDurationMin: number | '';
}

export interface ScheduleVisitConfigProps {
  defaultVisitType?: VisitType;
  defaultDurationMin?: number | '';
  onChange?: (value: ScheduleVisitConfigValue) => void;
}

export function ScheduleVisitConfig({
  defaultVisitType = 'design',
  defaultDurationMin: initialDur = 60,
  onChange,
}: ScheduleVisitConfigProps) {
  const [visitType, setVisitType] = useState<VisitType>(defaultVisitType);
  const [dur, setDur]             = useState<number | ''>(initialDur);

  const durNum   = dur === '' ? NaN : Number(dur);
  const durError =
    dur !== '' && (isNaN(durNum) || durNum < 5 || durNum > 1440)
      ? 'Must be between 5 and 1440 minutes.'
      : '';

  const notify = (vt: VisitType, d: number | '') => {
    onChange?.({ visitType: vt, defaultDurationMin: d });
  };

  const VISIT_TYPES: { value: VisitType; label: string }[] = [
    { value: 'design', label: 'Design visit' },
    { value: 'survey', label: 'Survey' },
    { value: 'other',  label: 'Other' },
  ];

  return (
    <Stack spacing={1.5}>
      <Box>
        <ConfigLabel>Visit type</ConfigLabel>
        <Select
          size="small"
          fullWidth
          value={visitType}
          onChange={e => {
            const vt = e.target.value as VisitType;
            setVisitType(vt);
            notify(vt, dur);
          }}
        >
          {VISIT_TYPES.map(t => (
            <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>
          ))}
        </Select>
      </Box>
      <Box>
        <ConfigLabel>
          Default duration (min){' '}
          <span style={{ fontWeight: 400 }}>(optional)</span>
        </ConfigLabel>
        <TextField
          size="small"
          type="number"
          value={dur}
          error={!!durError}
          helperText={durError || undefined}
          slotProps={{ htmlInput: { min: 5, max: 1440, step: 5 } }}
          onChange={e => {
            const d: number | '' = e.target.value === '' ? '' : Number(e.target.value);
            setDur(d);
            notify(visitType, d);
          }}
        />
      </Box>
    </Stack>
  );
}

// ── ShowMessageConfig ──────────────────────────────────────────────────────────

export interface ShowMessageConfigValue {
  title: string;
  message: string;
}

export interface ShowMessageConfigProps {
  defaultTitle?: string;
  defaultMessage?: string;
  onChange?: (value: ShowMessageConfigValue) => void;
}

export function ShowMessageConfig({
  defaultTitle = '',
  defaultMessage = '',
  onChange,
}: ShowMessageConfigProps) {
  const [title,          setTitle]          = useState(defaultTitle);
  const [message,        setMessage]        = useState(defaultMessage);
  const [msgTouched,     setMsgTouched]     = useState(false);

  const messageError =
    msgTouched && message.trim() === '' ? 'Message is required.' : '';

  const notify = (t: string, m: string) => onChange?.({ title: t, message: m });

  return (
    <Stack spacing={1.5}>
      <Box>
        <ConfigLabel>
          Popup title{' '}
          <span style={{ fontWeight: 400 }}>(optional)</span>
        </ConfigLabel>
        <TextField
          size="small"
          fullWidth
          value={title}
          slotProps={{ htmlInput: { maxLength: 120 } }}
          onChange={e => { setTitle(e.target.value); notify(e.target.value, message); }}
        />
      </Box>
      <Box>
        <ConfigLabel>
          Message to display{' '}
          <span style={{ color: 'error.main', fontWeight: 400 }}>*</span>
        </ConfigLabel>
        <TextField
          size="small"
          fullWidth
          multiline
          rows={4}
          placeholder="What should the operator do when they click this label?"
          value={message}
          error={!!messageError}
          helperText={messageError || undefined}
          slotProps={{ htmlInput: { maxLength: 2000 } }}
          onChange={e => {
            setMsgTouched(true);
            setMessage(e.target.value);
            notify(title, e.target.value);
          }}
        />
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          Shown verbatim in a popup. Plain text only; line breaks are preserved.
        </Typography>
      </Box>
    </Stack>
  );
}

// ── StartDesignVisitConfig ─────────────────────────────────────────────────────

export interface StartDesignVisitConfigValue {
  defaultDurationMin: number | '';
  intermediateLeadStatus: string;
  submittedLeadStatus: string;
  termsAndConditions: string;
}

export interface StartDesignVisitConfigProps {
  defaultDurationMin?: number | '';
  intermediateLeadStatus?: string;
  submittedLeadStatus?: string;
  termsAndConditions?: string;
  leadStatuses?: LeadStatusOption[];
  /** True when the stored intermediateLeadStatus key no longer exists in the current lead status list. */
  intermediateLeadStatusInvalid?: boolean;
  /** True when the stored submittedLeadStatus key no longer exists in the current lead status list. */
  submittedLeadStatusInvalid?: boolean;
  onChange?: (value: StartDesignVisitConfigValue) => void;
}

export function StartDesignVisitConfig({
  defaultDurationMin: initialDur = 90,
  intermediateLeadStatus: initialIntermediate = '',
  submittedLeadStatus: initialSubmitted = '',
  termsAndConditions: initialTerms = '',
  leadStatuses = [],
  intermediateLeadStatusInvalid = false,
  submittedLeadStatusInvalid = false,
  onChange,
}: StartDesignVisitConfigProps) {
  const [dur,          setDur]          = useState<number | ''>(initialDur);
  const [intermediate, setIntermediate] = useState(initialIntermediate);
  const [submitted,    setSubmitted]    = useState(initialSubmitted);
  const [terms,        setTerms]        = useState(initialTerms);

  const durNum   = dur === '' ? NaN : Number(dur);
  const durError =
    dur !== '' && (isNaN(durNum) || durNum < 5 || durNum > 1440)
      ? 'Must be between 5 and 1440 minutes.'
      : '';

  const notify = (
    d: number | '',
    inter: string,
    sub: string,
    t: string,
  ) => onChange?.({
    defaultDurationMin:     d,
    intermediateLeadStatus: inter,
    submittedLeadStatus:    sub,
    termsAndConditions:     t,
  });

  return (
    <Stack spacing={1.5}>
      <Box>
        <ConfigLabel>Default duration (min)</ConfigLabel>
        <TextField
          size="small"
          type="number"
          value={dur}
          error={!!durError}
          helperText={durError || undefined}
          slotProps={{ htmlInput: { min: 5, max: 1440, step: 5 } }}
          onChange={e => {
            const d: number | '' = e.target.value === '' ? '' : Number(e.target.value);
            setDur(d);
            notify(d, intermediate, submitted, terms);
          }}
        />
      </Box>

      <Box>
        <ConfigLabel>
          In-progress lead status{' '}
          <span style={{ fontWeight: 400 }}>(optional — set when wizard opens)</span>
        </ConfigLabel>
        <Select
          size="small"
          fullWidth
          displayEmpty
          value={intermediate}
          error={intermediateLeadStatusInvalid}
          onChange={e => {
            setIntermediate(e.target.value);
            notify(dur, e.target.value, submitted, terms);
          }}
          SelectDisplayProps={{ 'data-testid': 'intermediate-ls-select-trigger' } as React.HTMLAttributes<HTMLDivElement>}
        >
          <MenuItem value=""><em>— none —</em></MenuItem>
          {leadStatuses.map(ls => (
            <MenuItem key={ls.key} value={ls.key}>{ls.label || ls.key}</MenuItem>
          ))}
        </Select>
        {intermediateLeadStatusInvalid && (
          <Alert severity="warning" sx={{ mt: 0.75 }}>
            This lead status no longer exists. Select a valid option or clear it before saving.
          </Alert>
        )}
      </Box>

      <Box
        sx={{
          bgcolor: 'info.lighter',
          border: '1px solid',
          borderColor: 'info.light',
          borderRadius: 1,
          p: 1.25,
        }}
      >
        <Typography variant="caption" color="info.dark">
          <strong>Two-phase status flow:</strong> Opening the wizard sets the in-progress
          status. Submitting the form sets the submitted status.
        </Typography>
      </Box>

      <Box>
        <ConfigLabel>
          Submitted lead status{' '}
          <span style={{ fontWeight: 400 }}>(optional — set on submit)</span>
        </ConfigLabel>
        <Select
          size="small"
          fullWidth
          displayEmpty
          value={submitted}
          error={submittedLeadStatusInvalid}
          onChange={e => {
            setSubmitted(e.target.value);
            notify(dur, intermediate, e.target.value, terms);
          }}
          SelectDisplayProps={{ 'data-testid': 'submitted-ls-select-trigger' } as React.HTMLAttributes<HTMLDivElement>}
        >
          <MenuItem value=""><em>— none —</em></MenuItem>
          {leadStatuses.map(ls => (
            <MenuItem key={ls.key} value={ls.key}>{ls.label || ls.key}</MenuItem>
          ))}

        </Select>
        {submittedLeadStatusInvalid && (
          <Alert severity="warning" sx={{ mt: 0.75 }}>
            This lead status no longer exists. Select a valid option or clear it before saving.
          </Alert>
        )}
      </Box>

      <Box>
        <ConfigLabel>
          Terms &amp; Conditions{' '}
          <span style={{ fontWeight: 400 }}>(optional, ≤4000 chars)</span>
        </ConfigLabel>
        <TextField
          size="small"
          fullWidth
          multiline
          rows={4}
          placeholder="Your terms and conditions text…"
          value={terms}
          slotProps={{ htmlInput: { maxLength: 4000 } }}
          onChange={e => {
            setTerms(e.target.value);
            notify(dur, intermediate, submitted, e.target.value);
          }}
        />
      </Box>
    </Stack>
  );
}

