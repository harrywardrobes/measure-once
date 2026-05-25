import React from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Popover,
  Radio,
  RadioGroup,
  Select,
  Skeleton,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import EmailIcon from '@mui/icons-material/Email';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LanguageIcon from '@mui/icons-material/Language';
import PhoneIcon from '@mui/icons-material/Phone';
import PlaceIcon from '@mui/icons-material/Place';
import RefreshIcon from '@mui/icons-material/Refresh';
import ScheduleIcon from '@mui/icons-material/Schedule';
import SearchIcon from '@mui/icons-material/Search';
import { usePrivilege } from '../hooks/usePrivilege';

// ── Types ──────────────────────────────────────────────────────────────────────

type TradeContact = {
  name?: string;
  role?: string;
  phone?: string;
  email?: string;
  preferred_contact?: string;
};

type Trade = {
  id: number;
  company_name?: string;
  trade_type?: string;
  areas_served?: string[];
  timescale?: string;
  notes?: string;
  website?: string;
  company_phone?: string;
  contacts?: TradeContact[];
  created_at?: string;
  created_by_name?: string;
  updated_at?: string;
  updated_by_name?: string;
};

type PhoneDirectoryEntry = {
  phone?: string;
  label?: string;
  email?: string;
  field?: string;
  contactId?: string | number;
};

type PhoneDirectory = {
  team: PhoneDirectoryEntry[];
  trades: PhoneDirectoryEntry[];
  customers: PhoneDirectoryEntry[];
};

type PhoneConflict =
  | { surface: 'trade'; company: Trade; kind: 'company' }
  | { surface: 'trade'; company: Trade; kind: 'contact'; contactName: string }
  | { surface: 'team'; entry: PhoneDirectoryEntry }
  | { surface: 'customer'; contactId: string | number; label: string; field: string };

type EmailConflict = { company: Trade; contactName: string };

type ContactSlot = Required<TradeContact>;

type FormValues = {
  company_name: string;
  trade_type: string;
  areas_served: string[];
  website: string;
  company_phone: string;
  timescale: string;
  notes: string;
  contacts: ContactSlot[];
};

type AuditEntry = {
  action: string;
  actor_name?: string;
  changed_at: string;
};

// ── Constants ──────────────────────────────────────────────────────────────────

const TRADE_CATEGORIES = [
  'Carpentry / Roofing',
  'Carpet Fitting',
  'Electrical',
  'Handyman Services',
  'Internal Joinery',
  'Landscaping / Outdoors',
  'Painting + Decorating',
  'Plasterer',
  'Plumbing',
];

const TRADE_AREAS = [
  'Anglesey',
  'Chester Only',
  'Cheshire',
  'Greater Manchester',
  'Liverpool',
  'North Wales',
  'Wirral',
  'Wrexham',
];

const TRADE_TYPE_COLORS: Record<string, string> = {
  'Electrical':             '#f59e0b',
  'Plumbing':               '#3b82f6',
  'Carpentry / Roofing':    '#f97316',
  'Carpet Fitting':         '#ec4899',
  'Handyman Services':      '#14b8a6',
  'Internal Joinery':       '#92400e',
  'Landscaping / Outdoors': '#22c55e',
  'Painting + Decorating':  '#8b5cf6',
  'Plasterer':              '#94a3b8',
};

const MAX_CONTACTS = 3;

// ── Utility ────────────────────────────────────────────────────────────────────

function tradeTypeColor(type: string): string {
  return TRADE_TYPE_COLORS[type] || '#9ca3af';
}

function phoneKey(s: string | undefined | null): string {
  const digits = String(s || '').replace(/\D+/g, '');
  if (digits.length < 7) return '';
  return digits.length > 9 ? digits.slice(-9) : digits;
}

function normalizeEmail(s: string): string {
  return (s || '').trim().toLowerCase();
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol === 'http:' || u.protocol === 'https:') return raw;
    return null;
  } catch {
    return null;
  }
}

function initials(name: string): string {
  return (name || '').trim().split(/\s+/).map(n => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function blankContact(): ContactSlot {
  return { name: '', role: '', phone: '', email: '', preferred_contact: '' };
}

// ── API helpers ────────────────────────────────────────────────────────────────

async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  if (r.status === 401) { location.href = '/login'; throw new Error('Unauthorized'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((data as { error?: string }).error || `HTTP ${r.status}`);
    (err as { code?: string }).code = (data as { code?: string }).code;
    throw err;
  }
  return data as T;
}

// ── Conflict helpers ───────────────────────────────────────────────────────────

function findPhoneConflict(
  phone: string,
  trades: Trade[],
  directory: PhoneDirectory,
  editingId: number | null,
): PhoneConflict | null {
  const needle = phoneKey(phone);
  if (!needle) return null;
  for (const co of trades) {
    if (editingId !== null && co.id === editingId) continue;
    if (phoneKey(co.company_phone) === needle)
      return { surface: 'trade', company: co, kind: 'company' };
    for (const c of co.contacts || [])
      if (phoneKey(c.phone) === needle)
        return { surface: 'trade', company: co, kind: 'contact', contactName: c.name || '' };
  }
  for (const t of directory.team)
    if (phoneKey(t.phone) === needle) return { surface: 'team', entry: t };
  for (const c of directory.customers)
    if (phoneKey(c.phone) === needle)
      return {
        surface: 'customer',
        contactId: c.contactId!,
        label: c.label || 'a customer',
        field: c.field || 'phone',
      };
  return null;
}

function findEmailConflict(
  email: string,
  trades: Trade[],
  editingId: number | null,
): EmailConflict | null {
  const needle = normalizeEmail(email);
  if (!needle) return null;
  for (const co of trades) {
    if (editingId !== null && co.id === editingId) continue;
    for (const c of co.contacts || [])
      if (normalizeEmail(c.email || '') === needle)
        return { company: co, contactName: c.name || '' };
  }
  return null;
}

// ── PhoneConflict notice ───────────────────────────────────────────────────────

function PhoneConflictNotice({
  conflict,
  onJump,
}: {
  conflict: PhoneConflict;
  onJump?: (id: number) => void;
}) {
  if (conflict.surface === 'trade') {
    const who =
      conflict.kind === 'contact' && conflict.contactName
        ? `${conflict.contactName} at `
        : '';
    const fieldLabel = conflict.kind === 'company' ? 'company phone of ' : '';
    return (
      <Alert severity="warning" sx={{ py: 0.5, fontSize: 12 }}>
        <strong>This phone number is already in use</strong>
        {' '}as the {fieldLabel}{who}
        <Box
          component="a"
          href="#"
          onClick={(e) => { e.preventDefault(); onJump?.(conflict.company.id); }}
          sx={{ color: 'inherit', fontWeight: 700 }}
        >
          {conflict.company.company_name || 'this company'}
        </Box>
        . Pick a different number or open the existing record.
      </Alert>
    );
  }
  if (conflict.surface === 'team') {
    const where = conflict.entry.field === 'ec_phone' ? 'emergency contact phone' : 'mobile number';
    const who = conflict.entry.label || conflict.entry.email || 'a team member';
    return (
      <Alert severity="warning" sx={{ py: 0.5, fontSize: 12 }}>
        <strong>This phone number is already in use</strong>
        {' '}as the {where} of team member{' '}
        <Box component="a" href="/admin" sx={{ color: 'inherit', fontWeight: 700 }}>{who}</Box>
        . Pick a different number.
      </Alert>
    );
  }
  if (conflict.surface === 'customer') {
    const where = conflict.field === 'mobilephone' ? 'mobile' : 'phone';
    const href = `/customers/${encodeURIComponent(String(conflict.contactId))}`;
    return (
      <Alert severity="warning" sx={{ py: 0.5, fontSize: 12 }}>
        <strong>This phone number is already in use</strong>
        {' '}as the {where} of customer{' '}
        <Box component="a" href={href} sx={{ color: 'inherit', fontWeight: 700 }}>{conflict.label}</Box>
        . Pick a different number.
      </Alert>
    );
  }
  return null;
}

function EmailConflictNotice({
  conflict,
  onJump,
}: {
  conflict: EmailConflict;
  onJump?: (id: number) => void;
}) {
  const who = conflict.contactName ? `${conflict.contactName} at ` : '';
  return (
    <Alert severity="warning" sx={{ py: 0.5, fontSize: 12 }}>
      <strong>This email is already in use</strong>
      {' '}by {who}
      <Box
        component="a"
        href="#"
        onClick={(e) => { e.preventDefault(); onJump?.(conflict.company.id); }}
        sx={{ color: 'inherit', fontWeight: 700 }}
      >
        {conflict.company.company_name || 'this company'}
      </Box>
      . Pick a different address or open the existing record.
    </Alert>
  );
}

// ── ContactChip ────────────────────────────────────────────────────────────────

function ContactChip({ contact }: { contact: TradeContact }) {
  const [anchorEl, setAnchorEl] = React.useState<HTMLElement | null>(null);
  const name = contact.name || '';
  const role = contact.role || '';
  const phone = contact.phone || '';
  const email = contact.email || '';
  const pref = (contact.preferred_contact || '').toLowerCase();
  const prefPhone = pref.includes('phone') || pref.includes('call') || pref.includes('whatsapp');
  const prefEmail = pref.includes('email');
  const ini = initials(name);

  return (
    <>
      <Chip
        onClick={(e) => { e.stopPropagation(); setAnchorEl(e.currentTarget); }}
        avatar={
          <Box
            component="span"
            sx={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: '50%',
              bgcolor: 'primary.light', color: 'primary.dark',
              fontSize: 10, fontWeight: 700, flexShrink: 0, ml: '4px !important',
            }}
          >
            {ini}
          </Box>
        }
        label={
          <Box sx={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2, py: 0.25 }}>
            <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.primary', lineHeight: 1.2 }}>
              {name}
            </Typography>
            {role && (
              <Typography sx={{ fontSize: 10, color: 'text.secondary', lineHeight: 1.2 }}>
                {role}
              </Typography>
            )}
          </Box>
        }
        variant="outlined"
        sx={{ height: 'auto', py: 0.5, cursor: 'pointer' }}
        aria-haspopup="true"
      />
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={() => setAnchorEl(null)}
        onClick={(e) => e.stopPropagation()}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { width: 260, borderRadius: 2 } } }}
      >
        <Box sx={{ p: 1.5, borderBottom: 1, borderColor: 'divider', display: 'flex', gap: 1.5, alignItems: 'center' }}>
          <Box sx={{
            width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
            bgcolor: 'primary.light', color: 'primary.dark',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 13, fontWeight: 700,
          }}>
            {ini}
          </Box>
          <Box>
            <Typography variant="subtitle2">{name}</Typography>
            {role && <Typography variant="caption" color="text.secondary">{role}</Typography>}
          </Box>
        </Box>
        <Box sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
          {phone && (
            <Box
              component="a"
              href={`tel:${phone}`}
              sx={{
                display: 'flex', alignItems: 'center', gap: 1, p: 1, borderRadius: 1,
                textDecoration: 'none', color: 'text.primary',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <PhoneIcon fontSize="small" sx={{ color: prefPhone ? 'primary.main' : 'text.disabled' }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="caption" noWrap sx={{ display: 'block' }}>{phone}</Typography>
                {prefPhone && <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Preferred</Typography>}
              </Box>
            </Box>
          )}
          {email && (
            <Box
              component="a"
              href={`mailto:${email}`}
              sx={{
                display: 'flex', alignItems: 'center', gap: 1, p: 1, borderRadius: 1,
                textDecoration: 'none', color: 'text.primary',
                '&:hover': { bgcolor: 'action.hover' },
              }}
            >
              <EmailIcon fontSize="small" sx={{ color: prefEmail ? 'primary.main' : 'text.disabled' }} />
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="caption" noWrap sx={{ display: 'block' }}>{email}</Typography>
                {prefEmail && <Typography variant="caption" sx={{ color: 'primary.main', fontWeight: 700, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>Preferred</Typography>}
              </Box>
            </Box>
          )}
          {!phone && !email && (
            <Typography variant="caption" color="text.secondary" sx={{ px: 1, py: 0.5 }}>
              No contact details
            </Typography>
          )}
        </Box>
      </Popover>
    </>
  );
}

// ── Trade card skeleton ────────────────────────────────────────────────────────

function TradeCardSkeleton() {
  return (
    <Card variant="outlined" sx={{ mb: 1 }}>
      <CardContent sx={{ pb: '12px !important' }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Box sx={{ flex: '0 0 26%', minWidth: 0 }}>
            <Skeleton variant="text" width="70%" height={20} />
            <Skeleton variant="rounded" width={80} height={20} sx={{ mt: 0.5, borderRadius: 999 }} />
            <Skeleton variant="text" width="60%" height={14} sx={{ mt: 0.5 }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
              <Skeleton variant="rounded" width={110} height={32} sx={{ borderRadius: 999 }} />
              <Skeleton variant="rounded" width={90} height={32} sx={{ borderRadius: 999 }} />
            </Stack>
            <Skeleton variant="text" width="80%" height={14} sx={{ mt: 1 }} />
          </Box>
          <Box sx={{ flex: '0 0 auto', textAlign: 'right' }}>
            <Skeleton variant="rounded" width={70} height={22} sx={{ borderRadius: 999 }} />
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

// ── Trade card ─────────────────────────────────────────────────────────────────

function TradeCard({
  trade,
  isPriv,
  onEdit,
  onDelete,
}: {
  trade: Trade;
  isPriv: boolean;
  onEdit: (t: Trade) => void;
  onDelete: (id: number) => void;
}) {
  const color = tradeTypeColor(trade.trade_type || '');
  const badgeBg = color + '18';
  const areasDisplay = (trade.areas_served || []).join(', ');
  const webUrl = trade.website ? safeUrl(trade.website) : null;
  const websiteDisplay = webUrl ? webUrl.replace(/^https?:\/\//, '') : '';

  const auditParts: string[] = [];
  if (trade.created_by_name)
    auditParts.push(`Added by ${trade.created_by_name}${trade.created_at ? ` · ${fmtDate(trade.created_at)}` : ''}`);
  else if (trade.created_at)
    auditParts.push(`Added ${fmtDate(trade.created_at)}`);
  if (trade.updated_by_name)
    auditParts.push(`Edited by ${trade.updated_by_name}${trade.updated_at ? ` · ${fmtDate(trade.updated_at)}` : ''}`);

  return (
    <Card
      variant="outlined"
      sx={{
        mb: 1,
        '&:hover .trade-actions': { opacity: 1, pointerEvents: 'auto' },
      }}
    >
      <CardContent sx={{ pb: '10px !important' }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          {/* Left column */}
          <Box sx={{ flex: { xs: '0 0 100%', sm: '0 0 26%' }, minWidth: 0 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'text.primary' }}>
              {trade.company_name}
            </Typography>
            {trade.trade_type && (
              <Chip
                label={trade.trade_type}
                size="small"
                sx={{
                  mt: 0.5,
                  bgcolor: badgeBg,
                  color: color,
                  border: `1px solid ${color}33`,
                  fontWeight: 700,
                  fontSize: 11,
                  height: 20,
                }}
              />
            )}
            {areasDisplay && (
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start', mt: 0.5 }}>
                <PlaceIcon sx={{ fontSize: 13, color: 'text.disabled', mt: '1px', flexShrink: 0 }} />
                <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.4 }}>
                  {areasDisplay}
                </Typography>
              </Stack>
            )}
          </Box>

          {/* Middle column */}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {(trade.contacts || []).length > 0 && (
              <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', mb: 0.75, gap: '6px 6px' }}>
                {(trade.contacts || []).map((c, i) => (
                  <ContactChip key={i} contact={c} />
                ))}
              </Stack>
            )}
            {trade.notes && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontStyle: 'italic' }}
              >
                "{trade.notes}"
              </Typography>
            )}
            {webUrl && (
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 0.5 }}>
                <LanguageIcon sx={{ fontSize: 13, color: 'text.disabled', flexShrink: 0 }} />
                <Typography
                  component="a"
                  href={webUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  variant="caption"
                  sx={{ color: 'primary.main', textDecoration: 'none', wordBreak: 'break-all', '&:hover': { textDecoration: 'underline' } }}
                >
                  {websiteDisplay}
                </Typography>
              </Stack>
            )}
            {trade.company_phone && (
              <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 0.5 }}>
                <PhoneIcon sx={{ fontSize: 13, color: 'text.disabled', flexShrink: 0 }} />
                <Typography
                  component="a"
                  href={`tel:${trade.company_phone}`}
                  variant="caption"
                  sx={{ color: 'text.secondary', textDecoration: 'none', '&:hover': { color: 'text.primary' } }}
                >
                  {trade.company_phone}
                </Typography>
              </Stack>
            )}
          </Box>

          {/* Right column */}
          <Box sx={{ flex: '0 0 auto', display: 'flex', flexDirection: { xs: 'row', sm: 'column' }, alignItems: { xs: 'center', sm: 'flex-end' }, gap: 1 }}>
            {trade.timescale && (
              <Chip
                icon={<ScheduleIcon sx={{ fontSize: '13px !important' }} />}
                label={`Lead: ${trade.timescale}`}
                size="small"
                variant="outlined"
                sx={{ fontSize: 11, height: 22, color: 'text.secondary' }}
              />
            )}
            {isPriv && (
              <Stack
                direction="row"
                spacing={0.5}
                className="trade-actions"
                sx={{ opacity: { xs: 1, sm: 0 }, pointerEvents: { xs: 'auto', sm: 'none' }, transition: 'opacity 0.15s' }}
              >
                <Tooltip title="Edit">
                  <IconButton size="small" onClick={() => onEdit(trade)} aria-label="Edit company">
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title="Delete">
                  <IconButton size="small" color="error" onClick={() => onDelete(trade.id)} aria-label="Delete company">
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            )}
          </Box>
        </Stack>

        {auditParts.length > 0 && (
          <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1, pt: 1, borderTop: 1, borderColor: 'divider' }}>
            {auditParts.join(' · ')}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

// ── Rendered contact slot component ───────────────────────────────────────────

function RenderedContactSlot({
  index,
  slot,
  isFirst,
  trades,
  editingId,
  directory,
  onConflictChange,
  onEditingIdJump,
  onChange,
  onRemove,
}: {
  index: number;
  slot: ContactSlot;
  isFirst: boolean;
  trades: Trade[];
  editingId: number | null;
  directory: PhoneDirectory;
  onConflictChange: (index: number, phone: PhoneConflict | null, email: EmailConflict | null) => void;
  onEditingIdJump: (id: number) => void;
  onChange: (index: number, field: keyof ContactSlot, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const phoneDebounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const emailDebounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phoneConflict, setPhoneConflict] = React.useState<PhoneConflict | null>(null);
  const [emailConflict, setEmailConflict] = React.useState<EmailConflict | null>(null);
  // Refs keep the latest conflict values so each debounced effect always
  // passes the current sibling value to onConflictChange, avoiding stale closures.
  const phoneConflictRef = React.useRef<PhoneConflict | null>(null);
  const emailConflictRef = React.useRef<EmailConflict | null>(null);

  React.useEffect(() => {
    if (phoneDebounce.current) clearTimeout(phoneDebounce.current);
    phoneDebounce.current = setTimeout(() => {
      const c = findPhoneConflict(slot.phone, trades, directory, editingId);
      setPhoneConflict(c);
      phoneConflictRef.current = c;
      onConflictChange(index, c, emailConflictRef.current);
    }, 300);
    return () => { if (phoneDebounce.current) clearTimeout(phoneDebounce.current); };
  }, [slot.phone, trades, directory, editingId]);

  React.useEffect(() => {
    if (emailDebounce.current) clearTimeout(emailDebounce.current);
    emailDebounce.current = setTimeout(() => {
      const c = findEmailConflict(slot.email, trades, editingId);
      setEmailConflict(c);
      emailConflictRef.current = c;
      onConflictChange(index, phoneConflictRef.current, c);
    }, 300);
    return () => { if (emailDebounce.current) clearTimeout(emailDebounce.current); };
  }, [slot.email, trades, editingId]);

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.5, mb: 1.5 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1.25 }}>
        <Typography variant="overline" color="text.secondary">
          Contact {index + 1}
        </Typography>
        {!isFirst && (
          <Tooltip title="Remove contact">
            <IconButton size="small" onClick={() => onRemove(index)} aria-label={`Remove contact ${index + 1}`}>
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 1.5 }}>
        <TextField
          label={isFirst ? 'Full name *' : 'Full name'}
          value={slot.name}
          onChange={(e) => onChange(index, 'name', e.target.value)}
          placeholder="e.g. John Smith"
          required={isFirst}
          fullWidth
          size="small"
        />
        <TextField
          label="Role / job title"
          value={slot.role}
          onChange={(e) => onChange(index, 'role', e.target.value)}
          placeholder="e.g. Director"
          fullWidth
          size="small"
        />
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 1 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <TextField
            label="Phone number"
            value={slot.phone}
            onChange={(e) => onChange(index, 'phone', e.target.value)}
            placeholder="e.g. 07700 900123"
            fullWidth
            size="small"
            type="tel"
          />
          {phoneConflict && (
            <Box sx={{ mt: 0.75 }}>
              <PhoneConflictNotice conflict={phoneConflict} onJump={onEditingIdJump} />
            </Box>
          )}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <TextField
            label="Email address"
            value={slot.email}
            onChange={(e) => onChange(index, 'email', e.target.value)}
            placeholder="e.g. john@example.com"
            fullWidth
            size="small"
            type="email"
          />
          {emailConflict && (
            <Box sx={{ mt: 0.75 }}>
              <EmailConflictNotice conflict={emailConflict} onJump={onEditingIdJump} />
            </Box>
          )}
        </Box>
      </Stack>

      <Box>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
          Preferred contact method
        </Typography>
        <RadioGroup
          row
          value={slot.preferred_contact}
          onChange={(e) => onChange(index, 'preferred_contact', e.target.value)}
        >
          {['Phone call', 'WhatsApp', 'Email'].map((opt) => (
            <FormControlLabel
              key={opt}
              value={opt}
              control={<Radio size="small" />}
              label={<Typography variant="caption">{opt}</Typography>}
            />
          ))}
        </RadioGroup>
      </Box>
    </Box>
  );
}

// ── TradeFormDialog ────────────────────────────────────────────────────────────

function TradeFormDialog({
  open,
  editingTrade,
  trades,
  directory,
  isAdmin,
  isManager,
  onClose,
  onSaved,
  onJumpToTrade,
}: {
  open: boolean;
  editingTrade: Trade | null;
  trades: Trade[];
  directory: PhoneDirectory;
  isAdmin: boolean;
  isManager: boolean;
  onClose: () => void;
  onSaved: (trade: Trade, isNew: boolean) => void;
  onJumpToTrade: (id: number) => void;
}) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const isEdit = editingTrade !== null;
  const editingId = editingTrade?.id ?? null;

  const blankForm = (): FormValues => ({
    company_name: '',
    trade_type: '',
    areas_served: [],
    website: '',
    company_phone: '',
    timescale: '',
    notes: '',
    contacts: [blankContact()],
  });

  const [form, setForm] = React.useState<FormValues>(blankForm);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [slotConflicts, setSlotConflicts] = React.useState<Record<number, { phone: PhoneConflict | null; email: EmailConflict | null }>>({});

  const companyPhoneDebounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [companyPhoneConflict, setCompanyPhoneConflict] = React.useState<PhoneConflict | null>(null);

  const [auditLoading, setAuditLoading] = React.useState(false);
  const [auditEntries, setAuditEntries] = React.useState<AuditEntry[]>([]);
  const [auditError, setAuditError] = React.useState(false);
  const [auditExpanded, setAuditExpanded] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    if (editingTrade) {
      setForm({
        company_name: editingTrade.company_name || '',
        trade_type: editingTrade.trade_type || '',
        areas_served: Array.isArray(editingTrade.areas_served) ? editingTrade.areas_served : [],
        website: editingTrade.website || '',
        company_phone: editingTrade.company_phone || '',
        timescale: editingTrade.timescale || '',
        notes: editingTrade.notes || '',
        contacts: editingTrade.contacts?.length
          ? editingTrade.contacts.map(c => ({
              name: c.name || '',
              role: c.role || '',
              phone: c.phone || '',
              email: c.email || '',
              preferred_contact: c.preferred_contact || '',
            }))
          : [blankContact()],
      });
    } else {
      setForm(blankForm());
    }
    setSaving(false);
    setError('');
    setSlotConflicts({});
    setCompanyPhoneConflict(null);
    setAuditEntries([]);
    setAuditError(false);
    setAuditExpanded(false);
  }, [open, editingTrade]);

  React.useEffect(() => {
    if (companyPhoneDebounce.current) clearTimeout(companyPhoneDebounce.current);
    companyPhoneDebounce.current = setTimeout(() => {
      setCompanyPhoneConflict(findPhoneConflict(form.company_phone, trades, directory, editingId));
    }, 300);
    return () => { if (companyPhoneDebounce.current) clearTimeout(companyPhoneDebounce.current); };
  }, [form.company_phone, trades, directory, editingId]);

  const handleAuditToggle = async (_: React.SyntheticEvent, expanded: boolean) => {
    setAuditExpanded(expanded);
    if (expanded && editingTrade && auditEntries.length === 0 && !auditError) {
      setAuditLoading(true);
      try {
        const entries = await apiFetch<AuditEntry[]>('GET', `/api/trades/${editingTrade.id}/audit`);
        setAuditEntries(Array.isArray(entries) ? entries : []);
      } catch {
        setAuditError(true);
      } finally {
        setAuditLoading(false);
      }
    }
  };

  const hasAnyConflict =
    !!companyPhoneConflict ||
    Object.values(slotConflicts).some(c => c.phone || c.email);

  const handleContactChange = (index: number, field: keyof ContactSlot, value: string) => {
    setForm(prev => {
      const contacts = [...prev.contacts];
      contacts[index] = { ...contacts[index], [field]: value };
      return { ...prev, contacts };
    });
  };

  const handleContactRemove = (index: number) => {
    setForm(prev => ({
      ...prev,
      contacts: prev.contacts.filter((_, i) => i !== index),
    }));
    setSlotConflicts(prev => {
      const next: typeof prev = {};
      Object.keys(prev).forEach(k => {
        const ki = parseInt(k);
        if (ki < index) next[ki] = prev[ki];
        else if (ki > index) next[ki - 1] = prev[ki];
      });
      return next;
    });
  };

  const handleSlotConflictChange = (
    index: number,
    phone: PhoneConflict | null,
    email: EmailConflict | null,
  ) => {
    setSlotConflicts(prev => ({ ...prev, [index]: { phone, email } }));
  };

  const handleAreaToggle = (area: string) => {
    setForm(prev => ({
      ...prev,
      areas_served: prev.areas_served.includes(area)
        ? prev.areas_served.filter(a => a !== area)
        : [...prev.areas_served, area],
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const contacts = form.contacts.filter(c => c.name.trim());
    if (!contacts.length) {
      setError('At least one contact with a name is required');
      return;
    }
    if (!form.trade_type.trim()) {
      setError('Please select a category');
      return;
    }
    if (hasAnyConflict) {
      setError('One or more phone numbers or emails are already in use — please update them before saving');
      return;
    }

    setSaving(true);
    setError('');

    const body = {
      company_name: form.company_name.trim(),
      trade_type: form.trade_type.trim(),
      areas_served: form.areas_served,
      timescale: form.timescale.trim(),
      notes: form.notes.trim(),
      website: form.website.trim(),
      company_phone: form.company_phone.trim(),
      contacts,
    };

    try {
      if (isEdit && editingTrade) {
        const updated = await apiFetch<Trade>('PUT', `/api/trades/${editingTrade.id}`, body);
        onSaved(updated, false);
      } else if (isAdmin) {
        const created = await apiFetch<Trade>('POST', '/api/trades', body);
        onSaved(created, true);
      } else {
        await apiFetch('POST', '/api/trades/submissions', body);
        onSaved({} as Trade, false);
      }
    } catch (err) {
      const e = err as { code?: string; message?: string };
      setError(
        e.code === 'DB_ERROR'
          ? "Couldn't save — a database error occurred. Please try again."
          : e.message || 'Failed to save company',
      );
      setSaving(false);
    }
  };

  const auditParts: string[] = [];
  if (editingTrade?.created_by_name)
    auditParts.push(`Added by ${editingTrade.created_by_name}${editingTrade.created_at ? ` · ${fmtDate(editingTrade.created_at)}` : ''}`);
  else if (editingTrade?.created_at)
    auditParts.push(`Added ${fmtDate(editingTrade.created_at)}`);
  if (editingTrade?.updated_by_name)
    auditParts.push(`Edited by ${editingTrade.updated_by_name}${editingTrade.updated_at ? ` · ${fmtDate(editingTrade.updated_at)}` : ''}`);

  const submitLabel = isEdit
    ? (saving ? 'Saving…' : 'Save Changes')
    : isAdmin
      ? (saving ? 'Adding…' : 'Add Company')
      : (saving ? 'Submitting…' : 'Submit for Approval');

  const dialogTitle = isEdit ? 'Edit Company' : (isAdmin ? 'Add Company' : 'Submit Company');

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      fullScreen={fullScreen}
      fullWidth
      maxWidth="sm"
      scroll="paper"
    >
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', pb: 1 }}>
        <span>{dialogTitle}</span>
        <IconButton onClick={onClose} disabled={saving} aria-label="Close" size="small">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        <Box component="form" id="trade-form" onSubmit={handleSubmit} noValidate>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 1.5 }}>
            <TextField
              label="Company name *"
              value={form.company_name}
              onChange={(e) => setForm(prev => ({ ...prev, company_name: e.target.value }))}
              placeholder="e.g. Cheshire Electrical"
              required
              fullWidth
              size="small"
            />
            <Box sx={{ flex: 1 }}>
              <Select
                value={form.trade_type}
                onChange={(e) => setForm(prev => ({ ...prev, trade_type: e.target.value }))}
                displayEmpty
                fullWidth
                size="small"
                required
              >
                <MenuItem value="" disabled>Select a category…</MenuItem>
                {TRADE_CATEGORIES.map(cat => (
                  <MenuItem key={cat} value={cat}>{cat}</MenuItem>
                ))}
              </Select>
            </Box>
          </Stack>

          <Box sx={{ mb: 1.5 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.75 }}>
              Areas served
            </Typography>
            <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', gap: '8px 8px' }}>
              {TRADE_AREAS.map(area => (
                <Chip
                  key={area}
                  label={area}
                  size="small"
                  onClick={() => handleAreaToggle(area)}
                  color={form.areas_served.includes(area) ? 'primary' : 'default'}
                  variant={form.areas_served.includes(area) ? 'filled' : 'outlined'}
                  sx={{ cursor: 'pointer' }}
                />
              ))}
            </Stack>
          </Box>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 1.5 }}>
            <TextField
              label="Website"
              value={form.website}
              onChange={(e) => setForm(prev => ({ ...prev, website: e.target.value }))}
              placeholder="e.g. https://example.com"
              fullWidth
              size="small"
              type="url"
            />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <TextField
                label="Company phone"
                value={form.company_phone}
                onChange={(e) => setForm(prev => ({ ...prev, company_phone: e.target.value }))}
                placeholder="e.g. 01244 123456"
                fullWidth
                size="small"
                type="tel"
              />
              {companyPhoneConflict && (
                <Box sx={{ mt: 0.75 }}>
                  <PhoneConflictNotice conflict={companyPhoneConflict} onJump={onJumpToTrade} />
                </Box>
              )}
            </Box>
          </Stack>

          <TextField
            label="Typical lead time"
            value={form.timescale}
            onChange={(e) => setForm(prev => ({ ...prev, timescale: e.target.value }))}
            placeholder="e.g. 1–2 weeks"
            fullWidth
            size="small"
            sx={{ mb: 1.5 }}
          />

          <TextField
            label="Notes"
            value={form.notes}
            onChange={(e) => setForm(prev => ({ ...prev, notes: e.target.value }))}
            placeholder="Any extra details…"
            fullWidth
            multiline
            rows={3}
            size="small"
            sx={{ mb: 1.5 }}
          />

          <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1.5, mt: 0.5, mb: 1.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', mb: 1.5 }}>
              <Typography variant="subtitle2">Points of Contact</Typography>
              <Typography variant="caption" color="text.secondary">At least one required</Typography>
            </Stack>
            {form.contacts.map((slot, i) => (
              <RenderedContactSlot
                key={i}
                index={i}
                slot={slot}
                isFirst={i === 0}
                trades={trades}
                editingId={editingId}
                directory={directory}
                onConflictChange={handleSlotConflictChange}
                onEditingIdJump={onJumpToTrade}
                onChange={handleContactChange}
                onRemove={handleContactRemove}
              />
            ))}
            {form.contacts.length < MAX_CONTACTS && (
              <Button
                variant="outlined"
                size="small"
                startIcon={<AddIcon />}
                fullWidth
                onClick={() => setForm(prev => ({ ...prev, contacts: [...prev.contacts, blankContact()] }))}
                sx={{ borderStyle: 'dashed' }}
              >
                Add another contact
              </Button>
            )}
          </Box>

          {auditParts.length > 0 && (
            <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mt: 1, pt: 1, borderTop: 1, borderColor: 'divider' }}>
              {auditParts.join(' · ')}
            </Typography>
          )}

          {isEdit && (
            <Accordion
              expanded={auditExpanded}
              onChange={handleAuditToggle}
              elevation={0}
              sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '6px !important', mt: 1.5, '&:before': { display: 'none' } }}
            >
              <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ minHeight: 40, '& .MuiAccordionSummary-content': { my: 0.75 } }}>
                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                  Change history
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0 }}>
                {auditLoading && (
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <CircularProgress size={12} />
                    <Typography variant="caption" color="text.secondary">Loading…</Typography>
                  </Stack>
                )}
                {auditError && (
                  <Typography variant="caption" color="text.secondary">Could not load history.</Typography>
                )}
                {!auditLoading && !auditError && auditEntries.length === 0 && (
                  <Typography variant="caption" color="text.secondary">No history recorded yet.</Typography>
                )}
                {auditEntries.map((entry, i) => (
                  <Stack key={i} direction="row" spacing={1}
                    sx={{ justifyContent: 'space-between', alignItems: 'baseline', py: 0.5, px: 1, borderRadius: 0.75, bgcolor: 'action.hover', mb: 0.5 }}>
                    <Typography variant="caption" color="text.secondary">{entry.action}</Typography>
                    <Typography variant="caption" color="text.disabled" sx={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {entry.actor_name && <strong>{entry.actor_name} · </strong>}
                      {fmtDate(entry.changed_at)}
                    </Typography>
                  </Stack>
                ))}
              </AccordionDetails>
            </Accordion>
          )}

          {error && (
            <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>
          )}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 2, py: 1.5 }}>
        <Button onClick={onClose} disabled={saving} variant="outlined">
          Cancel
        </Button>
        <Button
          type="submit"
          form="trade-form"
          variant="contained"
          disabled={saving || hasAnyConflict}
          title={hasAnyConflict ? 'One or more phone numbers or emails are already in use' : undefined}
        >
          {submitLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── DeleteConfirmDialog ────────────────────────────────────────────────────────

function DeleteConfirmDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!open) { setDeleting(false); setError(''); }
  }, [open]);

  const handleConfirm = async () => {
    setDeleting(true);
    setError('');
    try {
      await onConfirm();
    } catch (err) {
      const e = err as { code?: string; message?: string };
      setError(
        e.code === 'DB_ERROR'
          ? "Couldn't delete — a database error occurred."
          : e.message || 'Failed to delete company',
      );
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onClose={deleting ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogContent sx={{ pt: 3 }}>
        <Typography variant="body1" sx={{ fontWeight: 600, textAlign: 'center' }}>
          Delete this company and all its contacts? This cannot be undone.
        </Typography>
        {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'center', pb: 2.5, gap: 1 }}>
        <Button onClick={onClose} disabled={deleting} variant="outlined">Cancel</Button>
        <Button onClick={handleConfirm} disabled={deleting} variant="contained" color="error">
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ── TradesPage ─────────────────────────────────────────────────────────────────

export function TradesPage() {
  const { isAdmin, isManager } = usePrivilege();
  const isPriv = isAdmin || isManager;

  const [trades, setTrades] = React.useState<Trade[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState('');
  const [directory, setDirectory] = React.useState<PhoneDirectory>({ team: [], trades: [], customers: [] });

  const [typeFilter, setTypeFilter] = React.useState<string>(() => {
    try { return localStorage.getItem('tradesTypeFilter') || ''; } catch { return ''; }
  });
  const [search, setSearch] = React.useState<string>(() => {
    return new URLSearchParams(location.search).get('q') || '';
  });

  const [formOpen, setFormOpen] = React.useState(false);
  const [editingTrade, setEditingTrade] = React.useState<Trade | null>(null);
  const [deleteId, setDeleteId] = React.useState<number | null>(null);

  const [snackbar, setSnackbar] = React.useState<{ message: string; severity: 'success' | 'error' } | null>(null);
  // autoHideDuration is set to null while the document is hidden so the MUI
  // Snackbar timer is paused (Page Visibility API).  Restored to 4 s when the
  // tab returns to the foreground.
  const [snackbarHideDuration, setSnackbarHideDuration] = React.useState<number | null>(4000);
  const snackbarRef = React.useRef<{ message: string; severity: 'success' | 'error' } | null>(null);
  React.useEffect(() => { snackbarRef.current = snackbar; }, [snackbar]);
  React.useEffect(() => {
    const onVis = () => {
      if (!snackbarRef.current) return;
      setSnackbarHideDuration(document.hidden ? null : 4000);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const data = await apiFetch<Trade[]>('GET', '/api/trades');
      setTrades(Array.isArray(data) ? data : []);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      setLoadError(
        e.code === 'DB_ERROR'
          ? "The contacts list couldn't be loaded — there was a problem reaching the database."
          : e.message || 'Failed to load contacts',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
    apiFetch<PhoneDirectory>('GET', '/api/admin/phone-directory')
      .then(d => {
        if (d && typeof d === 'object') {
          setDirectory({
            team:      Array.isArray(d.team)      ? d.team      : [],
            trades:    Array.isArray(d.trades)    ? d.trades    : [],
            customers: Array.isArray(d.customers) ? d.customers : [],
          });
        }
      })
      .catch(() => {});
  }, [load]);

  React.useEffect(() => {
    (window as unknown as { _cpGetTradeContacts?: () => Trade[] })._cpGetTradeContacts = () => trades;
  }, [trades]);

  const types = React.useMemo(
    () => [...new Set(trades.map(c => c.trade_type).filter(Boolean))].sort() as string[],
    [trades],
  );

  const validTypeFilter = types.includes(typeFilter) ? typeFilter : '';

  const filtered = React.useMemo(() => {
    let list = trades;
    if (validTypeFilter) list = list.filter(c => (c.trade_type || '').trim() === validTypeFilter);
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      list = list.filter(c => {
        const name = (c.company_name || '').toLowerCase();
        const contactNames = (c.contacts || []).map(ct => (ct.name || '').toLowerCase()).join(' ');
        return name.includes(q) || contactNames.includes(q);
      });
    }
    return list;
  }, [trades, validTypeFilter, search]);

  const handleTypeFilter = (type: string) => {
    setTypeFilter(type);
    try { localStorage.setItem('tradesTypeFilter', type); } catch { /* ignore */ }
  };

  const handleEdit = (trade: Trade) => {
    setEditingTrade(trade);
    setFormOpen(true);
  };

  const handleAdd = () => {
    setEditingTrade(null);
    setFormOpen(true);
  };

  const handleFormClose = () => {
    setFormOpen(false);
    setEditingTrade(null);
  };

  const handleJumpToTrade = (id: number) => {
    const trade = trades.find(t => t.id === id);
    if (trade) {
      handleFormClose();
      setTimeout(() => handleEdit(trade), 100);
    }
  };

  const handleSaved = (saved: Trade, isNew: boolean) => {
    if (isNew && saved.id) {
      setTrades(prev => [...prev, saved]);
      setSnackbar({ message: 'Company added', severity: 'success' });
    } else if (!isNew && saved.id) {
      setTrades(prev => prev.map(t => t.id === saved.id ? saved : t));
      setSnackbar({ message: 'Company updated', severity: 'success' });
    } else {
      setSnackbar({ message: 'Submitted — an admin will review it before it appears in the list', severity: 'success' });
    }
    handleFormClose();
  };

  const handleDelete = (id: number) => setDeleteId(id);

  const handleDeleteConfirm = async () => {
    if (deleteId === null) return;
    await apiFetch('DELETE', `/api/trades/${deleteId}`);
    setTrades(prev => prev.filter(t => t.id !== deleteId));
    setDeleteId(null);
    setSnackbar({ message: 'Company deleted', severity: 'success' });
  };

  return (
    <Container maxWidth="lg" sx={{ pb: 10 }}>
      {/* Header */}
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', pt: 2, pb: 1.5, px: { xs: 0, sm: 0 } }}>
        <Box>
          <Typography
            sx={{ fontFamily: "'Anton', system-ui, sans-serif", fontSize: 22, letterSpacing: 0.04, textTransform: 'uppercase', color: 'secondary.main', lineHeight: 1.2 }}
          >
            Vendors &amp; Trades
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.25, display: 'block' }}>
            Manage your trusted subcontractors and vendor relationships.
          </Typography>
        </Box>
        {isPriv && (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={handleAdd}
            size="small"
            sx={{ borderRadius: 999, whiteSpace: 'nowrap' }}
          >
            {isAdmin ? 'Add Company' : 'Submit for Approval'}
          </Button>
        )}
      </Stack>

      {/* Filter bar */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ alignItems: { xs: 'stretch', sm: 'center' }, justifyContent: 'space-between', mb: 2 }}
      >
        <Box sx={{ display: 'flex', gap: 0.75, overflowX: 'auto', flexWrap: 'nowrap', pb: 0.25, '::-webkit-scrollbar': { display: 'none' } }}>
          {['All', ...types].map(t => {
            const val = t === 'All' ? '' : t;
            const active = validTypeFilter === val;
            return (
              <Chip
                key={t}
                label={t}
                size="small"
                onClick={() => handleTypeFilter(val)}
                color={active ? 'primary' : 'default'}
                variant={active ? 'filled' : 'outlined'}
                sx={{ cursor: 'pointer', flexShrink: 0, height: 28 }}
              />
            );
          })}
        </Box>
        <TextField
          size="small"
          placeholder="Search companies, contacts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              inputProps: { 'aria-label': 'Search trades' },
            },
          }}
          sx={{ minWidth: 220, '.MuiOutlinedInput-root': { borderRadius: 999 } }}
        />
      </Stack>

      {/* List */}
      {loading && (
        <>
          <TradeCardSkeleton />
          <TradeCardSkeleton />
          <TradeCardSkeleton />
          <TradeCardSkeleton />
          <TradeCardSkeleton />
        </>
      )}

      {!loading && loadError && (
        <Alert
          severity="error"
          action={
            <Button size="small" startIcon={<RefreshIcon />} onClick={load} color="inherit">
              Retry
            </Button>
          }
          sx={{ mb: 2 }}
        >
          {loadError}
        </Alert>
      )}

      {!loading && !loadError && filtered.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
          No trade companies found.
        </Typography>
      )}

      {!loading && !loadError && filtered.map(trade => (
        <TradeCard
          key={trade.id}
          trade={trade}
          isPriv={isPriv}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      ))}

      {/* Dialogs */}
      <TradeFormDialog
        open={formOpen}
        editingTrade={editingTrade}
        trades={trades}
        directory={directory}
        isAdmin={isAdmin}
        isManager={isManager}
        onClose={handleFormClose}
        onSaved={handleSaved}
        onJumpToTrade={handleJumpToTrade}
      />

      <DeleteConfirmDialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDeleteConfirm}
      />

      {/* Snackbar */}
      <Snackbar
        open={!!snackbar}
        autoHideDuration={snackbarHideDuration}
        onClose={() => setSnackbar(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert
          severity={snackbar?.severity || 'success'}
          onClose={() => setSnackbar(null)}
          variant="filled"
          sx={{ minWidth: 280 }}
        >
          {snackbar?.message}
        </Alert>
      </Snackbar>
    </Container>
  );
}

export default TradesPage;
