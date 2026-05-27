import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, AlertTitle, Box, Button, Card, CardContent, Chip, Dialog, DialogActions,
  DialogContent, DialogTitle, FormControl, Grid, InputLabel, LinearProgress, Link,
  MenuItem, Select, Skeleton, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import LanguageIcon from '@mui/icons-material/Language';
import PhoneIcon from '@mui/icons-material/Phone';
import { api, toast, fmtDate, emitAdminChange, onAdminChange, setRequestsBadge } from './adminApi';
import {
  findPhoneDuplicate,
  describePhoneDuplicate,
  type PhoneDuplicateMatch,
} from './adminPhoneHelpers';

type Req = { id: number; name: string; email: string; status: string; created_at?: string };
type User = {
  id: string; email?: string; first_name?: string; last_name?: string;
  privilege_level?: string;
};
type Allowed = {
  email: string; metadata?: Record<string, string>;
};
type ApproveForm = { mobile_number: string; ec_phone: string };
const EMPTY_APPROVE_FORM: ApproveForm = { mobile_number: '', ec_phone: '' };
type ApproveDuplicate =
  | { kind: 'user'; label: string; email: string }
  | { kind: 'allowed'; label: string; email: string };

function normalizeEmail(e: string): string {
  return (e || '').trim().toLowerCase();
}
type PhotoReq = { id: string; first_name?: string; last_name?: string; email?: string; pending_photo: string };
type Contact = { name?: string; role?: string; phone?: string; email?: string; preferred_contact?: string };
type TradeSub = {
  id: number; company_name: string; trade_type: string; areas_served?: string | string[];
  timescale?: string; invoice_method?: string; payment_terms?: string;
  website?: string; company_phone?: string; notes?: string;
  contacts?: Contact[]; submitter_name?: string; submitter_email?: string; created_at?: string;
};
type JobRole = { name: string };

function safeUrl(url?: string): string {
  const s = (url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return s;
  } catch { return ''; }
}

export function AdminRequestsPage() {
  const [loading, setLoading] = useState(true);
  const [reqs, setReqs] = useState<Req[]>([]);
  const [photos, setPhotos] = useState<PhotoReq[]>([]);
  const [trades, setTrades] = useState<TradeSub[]>([]);
  const [jobRoles, setJobRoles] = useState<JobRole[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [allowed, setAllowed] = useState<Allowed[]>([]);

  const [photoProgress, setPhotoProgress] = useState<Record<string, number | undefined>>({});
  const [photoRejecting, setPhotoRejecting] = useState<Record<string, boolean>>({});
  const [tradeActing, setTradeActing] = useState<Record<number, 'approving' | 'rejecting'>>({});

  // Reject access-request dialog
  const [rejectReqTarget, setRejectReqTarget] = useState<number | null>(null);
  const [reqRejecting, setReqRejecting] = useState<Record<number, boolean>>({});

  // Reject trade dialog
  const [rejectTradeTarget, setRejectTradeTarget] = useState<number | null>(null);
  const [rejectTradeReason, setRejectTradeReason] = useState('');

  // Approve modal
  const [approving, setApproving] = useState<Req | null>(null);
  const [approveRole, setApproveRole] = useState('');
  const [approveErr, setApproveErr] = useState<string | null>(null);
  const [approveBusy, setApproveBusy] = useState(false);
  const [approveForm, setApproveForm] = useState<ApproveForm>({ ...EMPTY_APPROVE_FORM });
  const [debouncedApproveMobile, setDebouncedApproveMobile] = useState('');
  const [debouncedApproveEcPhone, setDebouncedApproveEcPhone] = useState('');

  async function load() {
    try {
      const [r, p, t, jr, u, a] = await Promise.all([
        api<Req[]>('GET', '/api/admin/requests'),
        api<PhotoReq[]>('GET', '/api/admin/photo-requests'),
        api<TradeSub[]>('GET', '/api/admin/trades/submissions'),
        api<JobRole[]>('GET', '/api/admin/job-roles'),
        api<User[]>('GET', '/api/admin/users'),
        api<Allowed[]>('GET', '/api/admin/allowed'),
      ]);
      const reqList = Array.isArray(r) ? r : [];
      const photoList = Array.isArray(p) ? p : [];
      const tradeList = Array.isArray(t) ? t : [];
      setReqs(reqList);
      setPhotos(photoList);
      setTrades(tradeList);
      setJobRoles(Array.isArray(jr) ? jr : []);
      setUsers(Array.isArray(u) ? u : []);
      setAllowed(Array.isArray(a) ? a : []);
      const pending = reqList.filter(x => x.status === 'pending').length;
      setRequestsBadge(pending + photoList.length + tradeList.length);
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const off = onAdminChange((k) => {
      if (k === 'requests' || k === 'photos' || k === 'photos_rejected' || k === 'trades' || k === 'roles' || k === 'team') load();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const approveDuplicate: ApproveDuplicate | null = useMemo(() => {
    if (!approving) return null;
    const needle = normalizeEmail(approving.email);
    if (!needle) return null;
    const matchedUser = users.find((x) => normalizeEmail(x.email || '') === needle);
    if (matchedUser) {
      const name = [matchedUser.first_name, matchedUser.last_name].filter(Boolean).join(' ')
        || matchedUser.email || needle;
      return { kind: 'user', label: name, email: matchedUser.email || needle };
    }
    const matchedAllowed = allowed.find((x) => normalizeEmail(x.email || '') === needle);
    if (matchedAllowed) {
      const m = matchedAllowed.metadata || {};
      const name = [m.first_name, m.last_name].filter(Boolean).join(' ') || matchedAllowed.email;
      return { kind: 'allowed', label: name, email: matchedAllowed.email };
    }
    return null;
  }, [approving, users, allowed]);

  function jumpToTeamTab() {
    const sw = (window as unknown as { switchTab?: (id: string) => void }).switchTab;
    if (typeof sw === 'function') sw('team');
  }

  function openApprove(r: Req) {
    setApproving(r); setApproveRole(''); setApproveErr(null);
    setApproveForm({ ...EMPTY_APPROVE_FORM });
    setDebouncedApproveMobile(''); setDebouncedApproveEcPhone('');
  }
  async function confirmApprove() {
    if (!approving) return;
    if (approveDuplicate) {
      setApproveErr('This email is already in use — see the notice above.');
      return;
    }
    if (mobileDuplicate || ecPhoneDuplicate) {
      setApproveErr('A phone number is already in use — see the notice above.');
      return;
    }
    setApproveBusy(true); setApproveErr(null);
    try {
      await api('POST', `/api/admin/requests/${approving.id}/approve`, {
        job_role: approveRole || null,
        mobile_number: approveForm.mobile_number.trim() || null,
        ec_phone: approveForm.ec_phone.trim() || null,
      });
      toast('Approved — user can now sign in');
      setApproving(null);
      emitAdminChange('requests'); emitAdminChange('team');
    } catch (e: unknown) {
      setApproveErr(e instanceof Error ? e.message : String(e));
    } finally {
      setApproveBusy(false);
    }
  }

  // Debounce the optional phone fields so the duplicate check only runs once
  // typing pauses (mirrors the Add team member form on the Team tab).
  useEffect(() => {
    const value = approveForm.mobile_number;
    const t = setTimeout(() => setDebouncedApproveMobile(value), 300);
    return () => clearTimeout(t);
  }, [approveForm.mobile_number]);

  useEffect(() => {
    const value = approveForm.ec_phone;
    const t = setTimeout(() => setDebouncedApproveEcPhone(value), 300);
    return () => clearTimeout(t);
  }, [approveForm.ec_phone]);

  const mobileDuplicate: PhoneDuplicateMatch | null = useMemo(
    () => findPhoneDuplicate(debouncedApproveMobile, users, allowed),
    [debouncedApproveMobile, users, allowed],
  );
  const ecPhoneDuplicate: PhoneDuplicateMatch | null = useMemo(
    () => findPhoneDuplicate(debouncedApproveEcPhone, users, allowed),
    [debouncedApproveEcPhone, users, allowed],
  );

  function viewPhoneDuplicate(match: PhoneDuplicateMatch) {
    // Both kinds live on the Team tab; jump there so admins can find the
    // existing record.
    jumpToTeamTab();
    void match;
  }

  function rejectReq(id: number) {
    setRejectReqTarget(id);
  }
  async function confirmRejectReq() {
    if (rejectReqTarget === null) return;
    const id = rejectReqTarget;
    setRejectReqTarget(null);
    setReqRejecting(r => ({ ...r, [id]: true }));
    try {
      await api('POST', `/api/admin/requests/${id}/reject`);
      toast('Rejected');
      emitAdminChange('requests');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setReqRejecting(r => { const n = { ...r }; delete n[id]; return n; });
    }
  }

  function approvePhoto(id: string) {
    setPhotoProgress(p => ({ ...p, [id]: 0 }));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/admin/photo-requests/${id}/approve`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        setPhotoProgress(p => ({ ...p, [id]: Math.round((evt.loaded / evt.total) * 100) }));
      }
    };
    xhr.onload = () => {
      setPhotoProgress(p => { const n = { ...p }; delete n[id]; return n; });
      if (xhr.status >= 400) {
        let msg = `HTTP ${xhr.status}`;
        try { msg = (JSON.parse(xhr.responseText) as { error?: string }).error || msg; } catch { /* ignore */ }
        toast(msg, true);
      } else {
        toast('Photo approved — now live');
        emitAdminChange('photos'); emitAdminChange('team');
      }
    };
    xhr.onerror = () => {
      setPhotoProgress(p => { const n = { ...p }; delete n[id]; return n; });
      toast('Network error — please try again', true);
    };
    xhr.onabort = () => {
      setPhotoProgress(p => { const n = { ...p }; delete n[id]; return n; });
    };
    xhr.send();
  }
  function rejectPhoto(id: string) {
    if (!confirm('Reject this photo? The user will need to submit a new one.')) return;
    setPhotoRejecting(r => ({ ...r, [id]: true }));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/admin/photo-requests/${id}/reject`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.onload = () => {
      setPhotoRejecting(r => { const n = { ...r }; delete n[id]; return n; });
      if (xhr.status >= 400) {
        let msg = `HTTP ${xhr.status}`;
        try { msg = (JSON.parse(xhr.responseText) as { error?: string }).error || msg; } catch { /* ignore */ }
        toast(msg, true);
      } else {
        toast('Photo rejected');
        emitAdminChange('photos_rejected');
      }
    };
    xhr.onerror = () => {
      setPhotoRejecting(r => { const n = { ...r }; delete n[id]; return n; });
      toast('Network error — please try again', true);
    };
    xhr.onabort = () => {
      setPhotoRejecting(r => { const n = { ...r }; delete n[id]; return n; });
    };
    xhr.send();
  }

  async function approveTrade(id: number) {
    if (tradeActing[id]) return;
    setTradeActing(s => ({ ...s, [id]: 'approving' }));
    try {
      await api('POST', `/api/admin/trades/submissions/${id}/approve`);
      toast('Approved — company is now live in the Trades directory');
      emitAdminChange('trades');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setTradeActing(s => { const n = { ...s }; delete n[id]; return n; });
    }
  }
  function rejectTrade(id: number) {
    if (tradeActing[id]) return;
    setRejectTradeTarget(id);
    setRejectTradeReason('');
  }
  async function confirmRejectTrade() {
    if (rejectTradeTarget === null) return;
    const id = rejectTradeTarget;
    setRejectTradeTarget(null);
    setTradeActing(s => ({ ...s, [id]: 'rejecting' }));
    try {
      await api('POST', `/api/admin/trades/submissions/${id}/reject`, { reason: rejectTradeReason.trim() });
      toast('Submission rejected');
      emitAdminChange('trades');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setTradeActing(s => { const n = { ...s }; delete n[id]; return n; });
    }
  }

  if (loading) {
    return <Box id="requests-content"><Skeleton variant="rectangular" height={200} /></Box>;
  }

  const pending = reqs.filter(r => r.status === 'pending');
  const past = reqs.filter(r => r.status !== 'pending').slice(0, 30);

  return (
    <Stack id="requests-content" spacing={3}>
      {/* Access requests */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={1} sx={{  mb: 2, alignItems: 'center' }}>
            <Typography variant="h6">Access requests</Typography>
            <Chip size="small" label={pending.length} />
          </Stack>
          {pending.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No pending requests.</Typography>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell>Submitted</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pending.map(r => {
                    const rejecting = !!reqRejecting[r.id];
                    return (
                      <TableRow key={r.id}>
                        <TableCell>{r.name}</TableCell>
                        <TableCell><Typography variant="body2" color="text.secondary">{r.email}</Typography></TableCell>
                        <TableCell><Typography variant="body2">{fmtDate(r.created_at)}</Typography></TableCell>
                        <TableCell align="right">
                          {rejecting && <LinearProgress variant="indeterminate" sx={{ height: 3, mb: 0.5 }} />}
                          <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
                            <Button size="small" variant="contained" color="success" disabled={rejecting} onClick={() => openApprove(r)}>Approve</Button>
                            <Button size="small" variant="outlined" color="error" disabled={rejecting} onClick={() => rejectReq(r.id)}>Reject</Button>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      {past.length > 0 && (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>Recent decisions</Typography>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell>Submitted</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {past.map(r => (
                    <TableRow key={r.id}>
                      <TableCell>{r.name}</TableCell>
                      <TableCell><Typography variant="body2" color="text.secondary">{r.email}</Typography></TableCell>
                      <TableCell><Typography variant="body2">{fmtDate(r.created_at)}</Typography></TableCell>
                      <TableCell><Chip size="small" label={r.status} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      )}

      {/* Photo approvals */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={1} sx={{  mb: 2, alignItems: 'center' }}>
            <Typography variant="h6">Photo approvals</Typography>
            {photos.length > 0 && <Chip size="small" label={photos.length} />}
          </Stack>
          {photos.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No pending photo submissions.</Typography>
          ) : (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Review profile photo submissions. Approved photos appear in the header and across the app.
              </Typography>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 2 }}>
                {photos.map(u => {
                  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || '—';
                  return (
                    <Card key={u.id} variant="outlined">
                      <Box component="img" src={u.pending_photo} alt=""
                        sx={{ width: '100%', aspectRatio: '1/1', objectFit: 'cover', display: 'block' }} />
                      {photoRejecting[u.id] ? (
                        <LinearProgress variant="indeterminate" sx={{ height: 3 }} />
                      ) : photoProgress[u.id] !== undefined ? (
                        <LinearProgress
                          variant="determinate"
                          value={photoProgress[u.id]}
                          sx={{ height: 3 }}
                        />
                      ) : null}
                      <CardContent>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{name}</Typography>
                        <Typography variant="caption" color="text.secondary">{u.email || ''}</Typography>
                        <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
                          <Button size="small" variant="contained"
                            disabled={photoProgress[u.id] !== undefined || !!photoRejecting[u.id]}
                            onClick={() => approvePhoto(u.id)}>Approve</Button>
                          <Button size="small" variant="outlined"
                            disabled={photoProgress[u.id] !== undefined || !!photoRejecting[u.id]}
                            onClick={() => rejectPhoto(u.id)}>Reject</Button>
                        </Stack>
                      </CardContent>
                    </Card>
                  );
                })}
              </Box>
            </>
          )}
        </CardContent>
      </Card>

      {/* Trade submissions */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={1} sx={{  mb: 1, alignItems: 'center' }}>
            <Typography variant="h6">Trade submissions</Typography>
            {trades.length > 0 && <Chip size="small" label={trades.length} />}
          </Stack>
          {trades.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No pending submissions.</Typography>
          ) : (
            <Typography variant="body2" color="text.secondary">
              Review and approve or reject trade company submissions from managers.
            </Typography>
          )}
        </CardContent>
      </Card>

      {trades.map(s => {
        const areas = Array.isArray(s.areas_served) ? s.areas_served.join(', ') : (s.areas_served || '');
        const details = [
          s.timescale && `Lead time: ${s.timescale}`,
          s.invoice_method && `Invoice: ${s.invoice_method}`,
          s.payment_terms && `Payment: ${s.payment_terms}`,
        ].filter(Boolean).join(' · ');
        const webUrl = safeUrl(s.website);
        const acting = !!tradeActing[s.id];
        return (
          <Card key={s.id} variant="outlined" id={`tsub-${s.id}`}>
            {acting && <LinearProgress variant="indeterminate" sx={{ height: 3 }} />}
            <CardContent>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ justifyContent: 'space-between' }}>
                <Box sx={{ flex: 1 }}>
                  <Typography variant="h6">{s.company_name}</Typography>
                  <Stack direction="row" spacing={1} sx={{  my: 1, flexWrap: 'wrap' }}>
                    <Chip size="small" label={s.trade_type} color="primary" variant="outlined" />
                    {areas && <Chip size="small" label={areas} />}
                  </Stack>
                  {details && <Typography variant="body2" color="text.secondary">{details}</Typography>}
                  {(webUrl || s.company_phone) && (
                    <Stack direction="row" spacing={2} sx={{ mt: 1 }}>
                      {webUrl && (
                        <Typography variant="body2" component="a" href={webUrl} target="_blank" rel="noopener"
                          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                          <LanguageIcon fontSize="inherit" />{s.website}
                        </Typography>
                      )}
                      {s.company_phone && (
                        <Typography variant="body2" component="a" href={`tel:${s.company_phone}`}
                          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                          <PhoneIcon fontSize="inherit" />{s.company_phone}
                        </Typography>
                      )}
                    </Stack>
                  )}
                  {s.notes && <Typography variant="body2" sx={{ mt: 1 }}>{s.notes}</Typography>}
                  {Array.isArray(s.contacts) && s.contacts.length > 0 && (
                    <Box sx={{ mt: 1 }}>
                      <Typography variant="overline">Contacts</Typography>
                      {s.contacts.map((c, i) => (
                        <Typography key={i} variant="body2" color="text.secondary">
                          {[c.name, c.role, c.phone, c.email, c.preferred_contact].filter(Boolean).join(' · ')}
                        </Typography>
                      ))}
                    </Box>
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                    Submitted by <strong>{s.submitter_name || s.submitter_email || 'Unknown'}</strong> · {fmtDate(s.created_at)}
                  </Typography>
                </Box>
                <Stack direction="row" spacing={1} sx={{  flexShrink: 0, alignItems: 'flex-start' }}>
                  <Button variant="contained" color="success" disabled={acting} onClick={() => approveTrade(s.id)}>Approve</Button>
                  <Button variant="outlined" color="error" disabled={acting} onClick={() => rejectTrade(s.id)}>Reject</Button>
                </Stack>
              </Stack>
            </CardContent>
          </Card>
        );
      })}

      {/* Reject access-request dialog */}
      <Dialog open={rejectReqTarget !== null} onClose={() => setRejectReqTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Reject access request</DialogTitle>
        <DialogContent>
          <Typography variant="body2">Are you sure you want to reject this request? This cannot be undone.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectReqTarget(null)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={confirmRejectReq}>Reject</Button>
        </DialogActions>
      </Dialog>

      {/* Reject trade dialog */}
      <Dialog open={rejectTradeTarget !== null} onClose={() => setRejectTradeTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Reject trade submission</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            multiline
            minRows={2}
            label="Reason (optional)"
            placeholder="Leave blank to skip"
            value={rejectTradeReason}
            onChange={(e) => setRejectTradeReason(e.target.value)}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejectTradeTarget(null)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={confirmRejectTrade}>Reject</Button>
        </DialogActions>
      </Dialog>

      {/* Approve dialog */}
      <Dialog open={!!approving} onClose={() => !approveBusy && setApproving(null)} maxWidth="sm" fullWidth>
        <DialogTitle>
          Approve request
          <Typography variant="caption" component="div" color="text.secondary">
            {approving && `${approving.name} · ${approving.email}`}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="overline">Job role (optional)</Typography>
          <Typography variant="caption" component="p" color="text.secondary" sx={{ mb: 1 }}>
            Assign a role now — you can change it later via the Team tab.
          </Typography>
          {approveDuplicate && (
            <Alert
              severity="warning"
              sx={{ mb: 2 }}
              action={
                <Button color="inherit" size="small" onClick={jumpToTeamTab}>
                  {approveDuplicate.kind === 'user' ? 'Open team member' : 'View approved entry'}
                </Button>
              }
            >
              <AlertTitle>
                {approveDuplicate.kind === 'user'
                  ? 'This email already belongs to a team member'
                  : 'This email is already on the allow-list'}
              </AlertTitle>
              {approveDuplicate.kind === 'user'
                ? `${approveDuplicate.label} (${approveDuplicate.email}) is already on the team.`
                : `${approveDuplicate.label} (${approveDuplicate.email}) has already been approved.`}{' '}
              <Link
                component="button"
                type="button"
                variant="body2"
                onClick={jumpToTeamTab}
                sx={{ verticalAlign: 'baseline' }}
              >
                {approveDuplicate.kind === 'user' ? 'Open team member' : 'View approved entry'}
              </Link>
            </Alert>
          )}
          <FormControl fullWidth>
            <InputLabel>Job role</InputLabel>
            <Select label="Job role" value={approveRole} onChange={(e) => setApproveRole(e.target.value)}>
              <MenuItem value=""><em>— No role (member access) —</em></MenuItem>
              {jobRoles.map(r => <MenuItem key={r.name} value={r.name}>{r.name}</MenuItem>)}
            </Select>
          </FormControl>

          <Typography variant="overline" sx={{ mt: 2, display: 'block' }}>Contact details (optional)</Typography>
          <Typography variant="caption" component="p" color="text.secondary" sx={{ mb: 1 }}>
            Capture phone numbers now if you have them — they'll be saved to this person's profile.
          </Typography>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField fullWidth label="Mobile number" type="tel" value={approveForm.mobile_number}
                onChange={(e) => setApproveForm({ ...approveForm, mobile_number: e.target.value })}
                placeholder="+44 7700 900000" slotProps={{ htmlInput: { maxLength: 30 }}} />
              {mobileDuplicate && (() => {
                const d = describePhoneDuplicate(mobileDuplicate);
                return (
                  <Alert severity="warning" sx={{ mt: 1 }}
                    action={
                      <Button color="inherit" size="small" onClick={() => viewPhoneDuplicate(mobileDuplicate)}>
                        {d.cta}
                      </Button>
                    }>
                    <AlertTitle>{d.title}</AlertTitle>
                    {d.body}
                  </Alert>
                );
              })()}
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField fullWidth label="Emergency contact phone" type="tel" value={approveForm.ec_phone}
                onChange={(e) => setApproveForm({ ...approveForm, ec_phone: e.target.value })}
                placeholder="+44 7700 900000" slotProps={{ htmlInput: { maxLength: 30 }}} />
              {ecPhoneDuplicate && (() => {
                const d = describePhoneDuplicate(ecPhoneDuplicate);
                return (
                  <Alert severity="warning" sx={{ mt: 1 }}
                    action={
                      <Button color="inherit" size="small" onClick={() => viewPhoneDuplicate(ecPhoneDuplicate)}>
                        {d.cta}
                      </Button>
                    }>
                    <AlertTitle>{d.title}</AlertTitle>
                    {d.body}
                  </Alert>
                );
              })()}
            </Grid>
          </Grid>

          {approveErr && <Alert severity="error" sx={{ mt: 2 }}>{approveErr}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setApproving(null)} disabled={approveBusy}>Cancel</Button>
          <Button
            variant="contained"
            color="success"
            onClick={confirmApprove}
            disabled={approveBusy || !!approveDuplicate || !!mobileDuplicate || !!ecPhoneDuplicate}
            title={
              approveDuplicate
                ? 'This email is already in use'
                : (mobileDuplicate || ecPhoneDuplicate)
                  ? 'A phone number is already in use'
                  : undefined
            }
          >
            {approveBusy ? 'Approving…' : 'Approve'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export default AdminRequestsPage;
