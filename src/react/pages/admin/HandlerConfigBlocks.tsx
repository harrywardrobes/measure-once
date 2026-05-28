import React, { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
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

export interface SubstatusOption {
  key: string;
  label: string;
  statusKey: string;
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
 * Returns true if `key` is a non-empty string that matches either a lead-status
 * key in `statuses` OR a sub-status key in `substatuses`.
 * An empty / absent key is considered valid (not stale).
 */
export function isStatusKeyValid(
  key: string | undefined | null,
  statuses: LeadStatusOption[],
  substatuses: SubstatusOption[],
): boolean {
  if (!key) return true;
  return statuses.some(s => s.key === key) || substatuses.some(s => s.key === key);
}

/**
 * Canonical list of config fields that store a lead-status or sub-status key.
 * Used by both the dedicated config blocks and the JSON fallback editor to
 * detect stale references uniformly.
 *
 * - `'lead_status'`              → key must exist in lead statuses only
 * - `'lead_status_or_substatus'` → key must exist in either lead statuses or sub-statuses
 */
export const KNOWN_STATUS_KEY_FIELDS: ReadonlyArray<{
  field: string;
  label: string;
  type: 'lead_status' | 'lead_status_or_substatus';
}> = [
  {
    field: 'intermediateLeadStatus',
    label: 'In-progress lead status',
    type: 'lead_status',
  },
  {
    field: 'submittedLeadStatus',
    label: 'Submitted lead status',
    type: 'lead_status_or_substatus',
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
  | 'survey'
  | 'installation'
  | 'remedial'
  | 'workshop'
  | 'design'
  | 'other';

export interface ScheduleVisitConfigValue {
  visitType: VisitType;
  defaultDurationMin: number | '';
  addToGoogleCalendar: boolean;
}

export interface ScheduleVisitConfigProps {
  defaultVisitType?: VisitType;
  defaultDurationMin?: number | '';
  addToGoogleCalendar?: boolean;
  onChange?: (value: ScheduleVisitConfigValue) => void;
}

export function ScheduleVisitConfig({
  defaultVisitType = 'survey',
  defaultDurationMin: initialDur = 60,
  addToGoogleCalendar: initialGcal = true,
  onChange,
}: ScheduleVisitConfigProps) {
  const [visitType, setVisitType] = useState<VisitType>(defaultVisitType);
  const [dur, setDur]             = useState<number | ''>(initialDur);
  const [gcal, setGcal]           = useState(initialGcal);

  const durNum   = dur === '' ? NaN : Number(dur);
  const durError =
    dur !== '' && (isNaN(durNum) || durNum < 5 || durNum > 1440)
      ? 'Must be between 5 and 1440 minutes.'
      : '';

  const notify = (vt: VisitType, d: number | '', g: boolean) => {
    onChange?.({ visitType: vt, defaultDurationMin: d, addToGoogleCalendar: g });
  };

  const VISIT_TYPES: { value: VisitType; label: string }[] = [
    { value: 'survey',       label: 'Survey' },
    { value: 'installation', label: 'Installation' },
    { value: 'remedial',     label: 'Remedial' },
    { value: 'workshop',     label: 'Workshop' },
    { value: 'design',       label: 'Design visit' },
    { value: 'other',        label: 'Other' },
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
            notify(vt, dur, gcal);
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
            notify(visitType, d, gcal);
          }}
        />
      </Box>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={gcal}
            onChange={e => { setGcal(e.target.checked); notify(visitType, dur, e.target.checked); }}
          />
        }
        label={<Typography variant="body2">Also add to Google Calendar</Typography>}
      />
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
  addToGoogleCalendar: boolean;
}

export interface StartDesignVisitConfigProps {
  defaultDurationMin?: number | '';
  intermediateLeadStatus?: string;
  submittedLeadStatus?: string;
  termsAndConditions?: string;
  addToGoogleCalendar?: boolean;
  leadStatuses?: LeadStatusOption[];
  substatuses?: SubstatusOption[];
  /** True when the stored intermediateLeadStatus key no longer exists in the current lead status list. */
  intermediateLeadStatusInvalid?: boolean;
  /** True when the stored submittedLeadStatus key no longer exists in any current lead status or sub-status list. */
  submittedLeadStatusInvalid?: boolean;
  onChange?: (value: StartDesignVisitConfigValue) => void;
}

export function StartDesignVisitConfig({
  defaultDurationMin: initialDur = 90,
  intermediateLeadStatus: initialIntermediate = '',
  submittedLeadStatus: initialSubmitted = '',
  termsAndConditions: initialTerms = '',
  addToGoogleCalendar: initialGcal = true,
  leadStatuses = [],
  substatuses = [],
  intermediateLeadStatusInvalid = false,
  submittedLeadStatusInvalid = false,
  onChange,
}: StartDesignVisitConfigProps) {
  const [dur,          setDur]          = useState<number | ''>(initialDur);
  const [intermediate, setIntermediate] = useState(initialIntermediate);
  const [submitted,    setSubmitted]    = useState(initialSubmitted);
  const [terms,        setTerms]        = useState(initialTerms);
  const [gcal,         setGcal]         = useState(initialGcal);

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
    g: boolean,
  ) => onChange?.({
    defaultDurationMin:     d,
    intermediateLeadStatus: inter,
    submittedLeadStatus:    sub,
    termsAndConditions:     t,
    addToGoogleCalendar:    g,
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
            notify(d, intermediate, submitted, terms, gcal);
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
            notify(dur, e.target.value, submitted, terms, gcal);
          }}
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
            notify(dur, intermediate, e.target.value, terms, gcal);
          }}
        >
          <MenuItem value=""><em>— none —</em></MenuItem>
          {leadStatuses.length > 0 && (
            [
              <MenuItem key="__ls_header__" disabled sx={{ fontSize: '0.75rem', opacity: 0.6, pointerEvents: 'none' }}>
                Lead statuses
              </MenuItem>,
              ...leadStatuses.map(ls => (
                <MenuItem key={`ls-${ls.key}`} value={ls.key}>{ls.label || ls.key}</MenuItem>
              )),
            ]
          )}
          {substatuses.length > 0 && (
            [
              <MenuItem key="__sub_header__" disabled sx={{ fontSize: '0.75rem', opacity: 0.6, pointerEvents: 'none' }}>
                Lead sub-statuses
              </MenuItem>,
              ...substatuses.map(s => (
                <MenuItem key={`sub-${s.key}`} value={s.key}>
                  {s.label ? `${s.label} (${s.statusKey})` : `${s.key} (${s.statusKey})`}
                </MenuItem>
              )),
            ]
          )}
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
            notify(dur, intermediate, submitted, e.target.value, gcal);
          }}
        />
      </Box>

      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={gcal}
            onChange={e => { setGcal(e.target.checked); notify(dur, intermediate, submitted, terms, e.target.checked); }}
          />
        }
        label={<Typography variant="body2">Also add to Google Calendar</Typography>}
      />
    </Stack>
  );
}

// ── DeliveryWindowConfig ───────────────────────────────────────────────────────

export interface DeliveryWindowConfigValue {
  defaultTitle: string;
  addToGoogleCalendar: boolean;
}

export interface DeliveryWindowConfigProps {
  defaultTitle?: string;
  addToGoogleCalendar?: boolean;
  onChange?: (value: DeliveryWindowConfigValue) => void;
}

export function DeliveryWindowConfig({
  defaultTitle: initialTitle = '',
  addToGoogleCalendar: initialGcal = true,
  onChange,
}: DeliveryWindowConfigProps) {
  const [title, setTitle] = useState(initialTitle);
  const [gcal,  setGcal]  = useState(initialGcal);

  const notify = (t: string, g: boolean) => onChange?.({ defaultTitle: t, addToGoogleCalendar: g });

  return (
    <Stack spacing={1.5}>
      <Box>
        <ConfigLabel>
          Default title{' '}
          <span style={{ fontWeight: 400 }}>(optional, ≤120 chars)</span>
        </ConfigLabel>
        <TextField
          size="small"
          fullWidth
          placeholder="e.g. Delivery window"
          value={title}
          slotProps={{ htmlInput: { maxLength: 120 } }}
          onChange={e => { setTitle(e.target.value); notify(e.target.value, gcal); }}
        />
      </Box>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={gcal}
            onChange={e => { setGcal(e.target.checked); notify(title, e.target.checked); }}
          />
        }
        label={<Typography variant="body2">Also add to Google Calendar</Typography>}
      />
    </Stack>
  );
}

// ── InstallationSlotConfig ─────────────────────────────────────────────────────

export interface InstallationSlotConfigValue {
  defaultDurationMin: number | '';
  defaultTitle: string;
  addToGoogleCalendar: boolean;
}

export interface InstallationSlotConfigProps {
  defaultDurationMin?: number | '';
  defaultTitle?: string;
  addToGoogleCalendar?: boolean;
  onChange?: (value: InstallationSlotConfigValue) => void;
}

export function InstallationSlotConfig({
  defaultDurationMin: initialDur = 240,
  defaultTitle: initialTitle = '',
  addToGoogleCalendar: initialGcal = true,
  onChange,
}: InstallationSlotConfigProps) {
  const [dur,   setDur]   = useState<number | ''>(initialDur);
  const [title, setTitle] = useState(initialTitle);
  const [gcal,  setGcal]  = useState(initialGcal);

  const durNum   = dur === '' ? NaN : Number(dur);
  const durError =
    dur !== '' && (isNaN(durNum) || durNum < 5 || durNum > 1440)
      ? 'Must be between 5 and 1440 minutes.'
      : '';

  const notify = (d: number | '', t: string, g: boolean) =>
    onChange?.({ defaultDurationMin: d, defaultTitle: t, addToGoogleCalendar: g });

  return (
    <Stack spacing={1.5}>
      <Box>
        <ConfigLabel>
          Default duration (min){' '}
          <span style={{ fontWeight: 400 }}>(optional, 5–1440)</span>
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
            notify(d, title, gcal);
          }}
        />
      </Box>
      <Box>
        <ConfigLabel>
          Default title{' '}
          <span style={{ fontWeight: 400 }}>(optional, ≤120 chars)</span>
        </ConfigLabel>
        <TextField
          size="small"
          fullWidth
          placeholder="e.g. Installation"
          value={title}
          slotProps={{ htmlInput: { maxLength: 120 } }}
          onChange={e => { setTitle(e.target.value); notify(dur, e.target.value, gcal); }}
        />
      </Box>
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={gcal}
            onChange={e => { setGcal(e.target.checked); notify(dur, title, e.target.checked); }}
          />
        }
        label={<Typography variant="body2">Also add to Google Calendar</Typography>}
      />
    </Stack>
  );
}
