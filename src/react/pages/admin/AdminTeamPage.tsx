import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Avatar, Box, Button, Card, CardContent, Chip, CircularProgress,
  Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControl,
  Grid, InputLabel, MenuItem, Select, Skeleton, Stack, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import {
  api, toast, fmtDate, fmtDateShort, emitAdminChange, onAdminChange,
  setTeamCount, PRIVILEGE_LEVELS, PRIVILEGE_LABEL,
} from './adminApi';

type User = {
  id: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  job_role?: string;
  privilege_level?: string;
  onboarding_status?: string;
  has_password?: boolean;
  has_custom_photo?: boolean;
  profile_image_url?: string;
  created_at?: string;
  metadata?: Record<string, string>;
  note?: string;
};

type Allowed = {
  email: string;
  note?: string;
  approved_at?: string;
  protected?: boolean;
  metadata?: Record<string, string>;
};

type JobRole = { name: string; privilege_level?: string };

function fullName(u: User): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}

function initials(s: string): string {
  return s.split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

function avatarSrc(u: User): string | undefined {
  if (u.has_custom_photo) return `/api/users/${u.id}/photo`;
  if (u.profile_image_url) return u.profile_image_url;
  return undefined;
}

function PrivilegeChip({ level }: { level?: string }) {
  const l = level || 'member';
  const color: Record<string, 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'> = {
    viewer: 'default', member: 'info', manager: 'warning', admin: 'error',
  };
  return <Chip size="small" label={PRIVILEGE_LABEL[l] || l} color={color[l] || 'default'} variant="outlined" />;
}

const EMPTY_INVITE = {
  email: '', first_name: '', last_name: '', date_of_birth: '', ni_number: '',
  mobile_number: '', ec_first_name: '', ec_last_name: '', ec_phone: '',
  job_role: '', note: '',
};

export function AdminTeamPage() {
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState<User[]>([]);
  const [allowed, setAllowed] = useState<Allowed[]>([]);
  const [jobRoles, setJobRoles] = useState<JobRole[]>([]);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [editing, setEditing] = useState<User | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});
  const [editErr, setEditErr] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [invite, setInvite] = useState({ ...EMPTY_INVITE });
  const [inviteErr, setInviteErr] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const mountedRef = useRef(true);

  async function load() {
    try {
      const [u, a, r] = await Promise.all([
        api<User[]>('GET', '/api/admin/users'),
        api<Allowed[]>('GET', '/api/admin/allowed'),
        api<JobRole[]>('GET', '/api/admin/job-roles'),
      ]);
      if (!mountedRef.current) return;
      setUsers(Array.isArray(u) ? u : []);
      setAllowed(Array.isArray(a) ? a : []);
      setJobRoles(Array.isArray(r) ? r : []);
      setTeamCount(Array.isArray(u) ? u.length : 0);
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    load();
    const off = onAdminChange((kind) => {
      if (kind === 'team' || kind === 'roles' || kind === 'photos') load();
    });
    return () => { mountedRef.current = false; off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleResendSetPassword(email: string) {
    if (!confirm(`Send a new "set your password" email to ${email}?\n\nAny previous link for this user will be invalidated.`)) return;
    setBusyEmail(email);
    try {
      await api('POST', `/api/admin/users/${encodeURIComponent(email)}/resend-set-password`);
      toast(`Set-password email sent to ${email}`);
      emitAdminChange('audit');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusyEmail(null);
    }
  }

  async function handleForceReset(email: string) {
    if (!confirm(
      `Force a password reset for ${email}?\n\n` +
      `Their current password will be invalidated, all of their active sessions will be signed out, ` +
      `and they'll receive an email with a new set-password link.`
    )) return;
    setBusyEmail(email);
    try {
      await api('POST', `/api/admin/users/${encodeURIComponent(email)}/force-password-reset`);
      toast(`Password reset — email sent to ${email}`);
      emitAdminChange('team');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusyEmail(null);
    }
  }

  async function handleRevoke(email: string) {
    if (!confirm('Revoke access for ' + email + '?')) return;
    try {
      await api('DELETE', '/api/admin/allowed/' + encodeURIComponent(email));
      toast('Access revoked');
      emitAdminChange('team');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  function openEdit(u: User) {
    const m = u.metadata || {};
    setEditing(u);
    setEditErr(null);
    setEditForm({
      first_name: u.first_name || '',
      last_name: u.last_name || '',
      email: u.email || '',
      date_of_birth: m.date_of_birth || '',
      ni_number: m.ni_number || '',
      mobile_number: m.mobile_number || '',
      ec_first_name: m.ec_first_name || '',
      ec_last_name: m.ec_last_name || '',
      ec_phone: m.ec_phone || '',
      job_role: u.job_role || '',
      privilege_level: u.privilege_level || 'member',
      note: u.note || '',
    });
  }

  async function saveEdit() {
    if (!editing) return;
    setEditSaving(true);
    setEditErr(null);
    try {
      await api('PATCH', `/api/users/${encodeURIComponent(editing.id)}/profile`, editForm);
      toast('Changes saved');
      setEditing(null);
      emitAdminChange('team');
    } catch (e: unknown) {
      setEditErr(e instanceof Error ? e.message : String(e));
    } finally {
      setEditSaving(false);
    }
  }

  async function submitInvite() {
    setInviteErr(null);
    const email = invite.email.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setInviteErr('Please enter a valid email address.');
      return;
    }
    setInviteBusy(true);
    try {
      await api('POST', '/api/admin/allowed', {
        ...invite,
        email,
        job_role: invite.job_role || null,
      });
      const name = [invite.first_name, invite.last_name].filter(Boolean).join(' ').trim();
      toast(name ? `${name} added — they can now sign in` : 'Email added — they can now sign in');
      setInvite({ ...EMPTY_INVITE });
      emitAdminChange('team');
    } catch (e: unknown) {
      setInviteErr(e instanceof Error ? e.message : String(e));
    } finally {
      setInviteBusy(false);
    }
  }

  const jobRoleOptionEls = useMemo(() => (
    jobRoles.map((r) => <MenuItem key={r.name} value={r.name}>{r.name}</MenuItem>)
  ), [jobRoles]);

  return (
    <Stack spacing={3}>
      {/* Team table */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
            <Typography variant="h6">Team</Typography>
            <Chip size="small" label={users.length} />
          </Stack>
          {loading ? (
            <Skeleton variant="rectangular" height={120} />
          ) : (
            <TableContainer>
              <Table size="small" id="team-body-table">
                <TableHead>
                  <TableRow>
                    <TableCell>Member</TableCell>
                    <TableCell>Job role</TableCell>
                    <TableCell>Privilege</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Joined</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                {/* id="team-body" preserved for tests */}
                <TableBody id="team-body">
                  {users.length === 0 ? (
                    <TableRow><TableCell colSpan={6} align="center"><Typography variant="body2" color="text.secondary">No users yet.</Typography></TableCell></TableRow>
                  ) : users.map((u) => {
                    const name = fullName(u) || '—';
                    const needsInfo = u.onboarding_status === 'more_info_required';
                    return (
                      <TableRow key={u.id} hover>
                        <TableCell>
                          <Stack direction="row" spacing={1.5} alignItems="center">
                            <Avatar src={avatarSrc(u)} sx={{ width: 32, height: 32, fontSize: 14 }}>
                              {initials(name || u.email || '?')}
                            </Avatar>
                            <Box>
                              <Typography variant="body2" fontWeight={600}>{name}</Typography>
                              <Typography variant="caption" color="text.secondary">{u.email || ''}</Typography>
                            </Box>
                          </Stack>
                        </TableCell>
                        <TableCell>{u.job_role || '—'}</TableCell>
                        <TableCell><PrivilegeChip level={u.privilege_level} /></TableCell>
                        <TableCell>
                          {needsInfo
                            ? <Chip size="small" color="warning" icon={<WarningAmberIcon />} label="More info required" />
                            : <Chip size="small" color="success" label="Active" />}
                        </TableCell>
                        <TableCell><Typography variant="body2">{fmtDateShort(u.created_at)}</Typography></TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={1} justifyContent="flex-end">
                            {u.email && (
                              <Button
                                size="small" variant="text"
                                disabled={busyEmail === u.email}
                                onClick={() => handleResendSetPassword(u.email!)}
                                title="Email this user a new set-password link"
                              >
                                {busyEmail === u.email ? <CircularProgress size={14} /> : 'Resend set-password'}
                              </Button>
                            )}
                            {u.email && u.has_password && (
                              <Button
                                size="small" variant="text" color="warning"
                                disabled={busyEmail === u.email}
                                onClick={() => handleForceReset(u.email!)}
                                title="Invalidate this user's password, sign them out, and email a new set-password link"
                              >Force password reset</Button>
                            )}
                            <Button size="small" variant="outlined" onClick={() => openEdit(u)}>Edit</Button>
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

      {/* Add team member */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 0.5 }}>Add team member</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Approve an email address so this person can sign in straight away, and capture their key details at the same time.
          </Typography>

          <Typography variant="overline">Personal details</Typography>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid size={12}>
              <TextField fullWidth label="Work email address" type="email"
                value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })}
                placeholder="colleague@example.com" inputProps={{ maxLength: 254 }} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField fullWidth label="First name" value={invite.first_name}
                onChange={(e) => setInvite({ ...invite, first_name: e.target.value })}
                placeholder="Jane" inputProps={{ maxLength: 100 }} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField fullWidth label="Last name" value={invite.last_name}
                onChange={(e) => setInvite({ ...invite, last_name: e.target.value })}
                placeholder="Smith" inputProps={{ maxLength: 100 }} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField fullWidth type="date" label="Date of birth" InputLabelProps={{ shrink: true }}
                value={invite.date_of_birth}
                onChange={(e) => setInvite({ ...invite, date_of_birth: e.target.value })} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField fullWidth label="National Insurance number" value={invite.ni_number}
                onChange={(e) => setInvite({ ...invite, ni_number: e.target.value.toUpperCase() })}
                placeholder="AB 12 34 56 C" inputProps={{ maxLength: 20, style: { textTransform: 'uppercase' } }} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField fullWidth label="Mobile number" type="tel" value={invite.mobile_number}
                onChange={(e) => setInvite({ ...invite, mobile_number: e.target.value })}
                placeholder="+44 7700 900000" inputProps={{ maxLength: 30 }} />
            </Grid>
          </Grid>

          <Typography variant="overline">Emergency contact</Typography>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField fullWidth label="First name" value={invite.ec_first_name}
                onChange={(e) => setInvite({ ...invite, ec_first_name: e.target.value })}
                placeholder="John" inputProps={{ maxLength: 100 }} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField fullWidth label="Last name" value={invite.ec_last_name}
                onChange={(e) => setInvite({ ...invite, ec_last_name: e.target.value })}
                placeholder="Smith" inputProps={{ maxLength: 100 }} />
            </Grid>
            <Grid size={{ xs: 12, sm: 6 }}>
              <TextField fullWidth label="Mobile number" type="tel" value={invite.ec_phone}
                onChange={(e) => setInvite({ ...invite, ec_phone: e.target.value })}
                placeholder="+44 7700 900000" inputProps={{ maxLength: 30 }} />
            </Grid>
          </Grid>

          <Typography variant="overline">Role (optional)</Typography>
          <FormControl fullWidth sx={{ mt: 1, mb: 2 }}>
            <InputLabel id="invite-jobrole-label">Job role</InputLabel>
            <Select labelId="invite-jobrole-label" label="Job role"
              value={invite.job_role}
              onChange={(e) => setInvite({ ...invite, job_role: e.target.value })}>
              <MenuItem value=""><em>— No role (member access) —</em></MenuItem>
              {jobRoleOptionEls}
            </Select>
          </FormControl>

          <Typography variant="overline">Note (optional)</Typography>
          <TextField fullWidth sx={{ mt: 1 }} value={invite.note}
            onChange={(e) => setInvite({ ...invite, note: e.target.value })}
            placeholder="e.g. New hire · Site manager" inputProps={{ maxLength: 200 }} />

          <Stack direction="row" alignItems="center" spacing={2} sx={{ mt: 2 }}>
            <Button variant="contained" disabled={inviteBusy} onClick={submitInvite}>
              {inviteBusy ? 'Adding…' : 'Add team member'}
            </Button>
            {inviteErr && <Alert severity="error" sx={{ flex: 1 }}>{inviteErr}</Alert>}
          </Stack>
        </CardContent>
      </Card>

      {/* Approved emails */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
            <Typography variant="h6">Approved team members</Typography>
            <Chip size="small" label={allowed.length} />
          </Stack>
          {loading ? (
            <Skeleton variant="rectangular" height={80} />
          ) : allowed.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No approved emails yet.</Typography>
          ) : (
            <TableContainer id="team-allowed-content">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Name / Email</TableCell>
                    <TableCell>HR details</TableCell>
                    <TableCell>Note</TableCell>
                    <TableCell>Approved</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {allowed.map((a) => {
                    const m = a.metadata || {};
                    const name = [m.first_name, m.last_name].filter(Boolean).join(' ');
                    const ec = [m.ec_first_name, m.ec_last_name].filter(Boolean).join(' ');
                    return (
                      <TableRow key={a.email}>
                        <TableCell>
                          <Typography variant="body2" fontWeight={600}>{name || a.email}</Typography>
                          {name && <Typography variant="caption" color="text.secondary">{a.email}</Typography>}
                        </TableCell>
                        <TableCell>
                          {[
                            m.date_of_birth && `DOB: ${m.date_of_birth}`,
                            m.ni_number && `NI: ${m.ni_number}`,
                            m.mobile_number && `Mobile: ${m.mobile_number}`,
                            ec && `EC: ${ec}${m.ec_phone ? ' · ' + m.ec_phone : ''}`,
                          ].filter(Boolean).map((line, i) => (
                            <Typography key={i} variant="body2" color="text.secondary">{line as string}</Typography>
                          ))}
                          {!m.date_of_birth && !m.ni_number && !m.mobile_number && !ec && <Typography variant="caption" color="text.disabled">—</Typography>}
                        </TableCell>
                        <TableCell><Chip size="small" label={a.note || '—'} variant="outlined" /></TableCell>
                        <TableCell><Typography variant="body2">{fmtDate(a.approved_at)}</Typography></TableCell>
                        <TableCell align="right">
                          {a.protected
                            ? <Typography variant="caption" color="text.disabled">Protected</Typography>
                            : <Button size="small" color="error" variant="outlined" onClick={() => handleRevoke(a.email)}>Revoke</Button>}
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

      {/* Edit user dialog */}
      <Dialog open={!!editing} onClose={() => !editSaving && setEditing(null)} maxWidth="md" fullWidth>
        <DialogTitle>
          Edit team member
          <Typography variant="caption" component="div" color="text.secondary">
            {editing && (fullName(editing) || editing.email || '—')}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          <Typography variant="overline">Personal details</Typography>
          <Grid container spacing={2} sx={{ mb: 2, mt: 0.5 }}>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="First name" value={editForm.first_name || ''} onChange={(e) => setEditForm({ ...editForm, first_name: e.target.value })} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Last name" value={editForm.last_name || ''} onChange={(e) => setEditForm({ ...editForm, last_name: e.target.value })} /></Grid>
            <Grid size={12}><TextField fullWidth label="Work email address" type="email" value={editForm.email || ''} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth type="date" label="Date of birth" InputLabelProps={{ shrink: true }} value={editForm.date_of_birth || ''} onChange={(e) => setEditForm({ ...editForm, date_of_birth: e.target.value })} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="National Insurance number" value={editForm.ni_number || ''} onChange={(e) => setEditForm({ ...editForm, ni_number: e.target.value.toUpperCase() })} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Mobile number" type="tel" value={editForm.mobile_number || ''} onChange={(e) => setEditForm({ ...editForm, mobile_number: e.target.value })} /></Grid>
          </Grid>
          <Divider sx={{ mb: 2 }} />
          <Typography variant="overline">Emergency contact</Typography>
          <Grid container spacing={2} sx={{ mb: 2, mt: 0.5 }}>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="First name" value={editForm.ec_first_name || ''} onChange={(e) => setEditForm({ ...editForm, ec_first_name: e.target.value })} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Last name" value={editForm.ec_last_name || ''} onChange={(e) => setEditForm({ ...editForm, ec_last_name: e.target.value })} /></Grid>
            <Grid size={{ xs: 12, sm: 6 }}><TextField fullWidth label="Mobile number" type="tel" value={editForm.ec_phone || ''} onChange={(e) => setEditForm({ ...editForm, ec_phone: e.target.value })} /></Grid>
          </Grid>
          <Divider sx={{ mb: 2 }} />
          <Typography variant="overline">Role &amp; permissions</Typography>
          <Grid container spacing={2} sx={{ mt: 0.5 }}>
            <Grid size={12}>
              <FormControl fullWidth>
                <InputLabel>Job role</InputLabel>
                <Select label="Job role" value={editForm.job_role || ''}
                  onChange={(e) => setEditForm({ ...editForm, job_role: e.target.value })}>
                  <MenuItem value=""><em>— None —</em></MenuItem>
                  {jobRoles.map((r) => <MenuItem key={r.name} value={r.name}>{r.name}</MenuItem>)}
                  {editForm.job_role && !jobRoles.find(r => r.name === editForm.job_role) && (
                    <MenuItem value={editForm.job_role}>{editForm.job_role}</MenuItem>
                  )}
                </Select>
              </FormControl>
            </Grid>
            <Grid size={12}>
              <FormControl fullWidth>
                <InputLabel>Privilege level</InputLabel>
                <Select label="Privilege level" value={editForm.privilege_level || 'member'}
                  onChange={(e) => setEditForm({ ...editForm, privilege_level: e.target.value })}>
                  {PRIVILEGE_LEVELS.map((p) => (
                    <MenuItem key={p} value={p}>{PRIVILEGE_LABEL[p]}</MenuItem>
                  ))}
                </Select>
              </FormControl>
            </Grid>
            <Grid size={12}>
              <TextField fullWidth label="Note (optional)" value={editForm.note || ''}
                onChange={(e) => setEditForm({ ...editForm, note: e.target.value })} inputProps={{ maxLength: 200 }} />
            </Grid>
          </Grid>
          {editErr && <Alert severity="error" sx={{ mt: 2 }}>{editErr}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditing(null)} disabled={editSaving}>Cancel</Button>
          <Button variant="contained" onClick={saveEdit} disabled={editSaving}>
            {editSaving ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export default AdminTeamPage;
