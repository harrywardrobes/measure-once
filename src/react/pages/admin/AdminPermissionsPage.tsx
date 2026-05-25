import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, FormControl, IconButton,
  InputLabel, MenuItem, Select, Skeleton, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Close';
import {
  api, toast, emitAdminChange, onAdminChange, PRIVILEGE_LEVELS, PRIVILEGE_LABEL,
} from './adminApi';

type JobRole = { name: string; privilege_level?: string };
type Feature = { feat: string; desc?: string; levels?: string[]; group?: string };
type Capabilities = { levels: string[]; features: Feature[] };

export function AdminPermissionsPage() {
  const [loading, setLoading] = useState(true);
  const [jobRoles, setJobRoles] = useState<JobRole[]>([]);
  const [caps, setCaps] = useState<Capabilities>({ levels: [...PRIVILEGE_LEVELS], features: [] });
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Add-role form
  const [newRole, setNewRole] = useState('');
  const [newPriv, setNewPriv] = useState('member');

  async function load() {
    try {
      const [roles, capabilities] = await Promise.all([
        api<JobRole[]>('GET', '/api/admin/job-roles'),
        api<Capabilities>('GET', '/api/admin/capabilities'),
      ]);
      setJobRoles(Array.isArray(roles) ? roles : []);
      const c = capabilities || { levels: [...PRIVILEGE_LEVELS], features: [] };
      setCaps(c);
      const seed: Record<string, string[]> = {};
      (c.features || []).forEach(f => { if (!f.group) seed[f.feat] = [...(f.levels || [])]; });
      setEdits(seed);
      setDirty(false);
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const off = onAdminChange((k) => { if (k === 'roles' || k === 'capabilities') load(); });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const existingRole = jobRoles.find(r => r.name.toLowerCase() === newRole.trim().toLowerCase());

  async function submitNewRole() {
    const name = newRole.trim();
    if (!name) return;
    try {
      await api('POST', '/api/admin/job-roles', { name, privilege_level: newPriv });
      toast(existingRole ? 'Role updated' : 'Role added');
      setNewRole(''); setNewPriv('member');
      emitAdminChange('roles');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function updatePriv(name: string, level: string) {
    try {
      await api('POST', '/api/admin/job-roles', { name, privilege_level: level });
      setJobRoles(prev => prev.map(r => r.name === name ? { ...r, privilege_level: level } : r));
      toast('Role updated');
      emitAdminChange('roles');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
      load();
    }
  }

  async function deleteRole(name: string) {
    if (!confirm(`Remove job role "${name}"? This won't change existing users' roles.`)) return;
    try {
      await api('DELETE', '/api/admin/job-roles/' + encodeURIComponent(name));
      setJobRoles(prev => prev.filter(r => r.name !== name));
      toast('Role removed');
      emitAdminChange('roles');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  function togglePerm(feat: string, level: string) {
    setEdits(prev => {
      const cur = prev[feat] || [];
      const has = cur.includes(level);
      const next = has ? cur.filter(l => l !== level) : [...cur, level];
      return { ...prev, [feat]: next };
    });
    setDirty(true);
  }

  async function savePerms() {
    setSaving(true);
    try {
      await api('PATCH', '/api/admin/capabilities', { overrides: edits });
      toast('Permissions saved');
      setDirty(false);
      emitAdminChange('capabilities');
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setSaving(false);
    }
  }

  const levels = caps.levels.length ? caps.levels : [...PRIVILEGE_LEVELS];

  return (
    <Stack spacing={3}>
      {/* Manage job roles */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6">Manage job roles</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            These labels are available when editing a team member's profile.
          </Typography>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
            <TextField size="small" sx={{ flex: 1 }} placeholder="New role name…"
              value={newRole} onChange={(e) => setNewRole(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitNewRole(); }}
              inputProps={{ maxLength: 64 }} />
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <Select value={existingRole?.privilege_level || newPriv}
                onChange={(e) => setNewPriv(e.target.value)}>
                {PRIVILEGE_LEVELS.map(p => (
                  <MenuItem key={p} value={p}>{PRIVILEGE_LABEL[p]}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button variant="contained" onClick={submitNewRole}>
              {existingRole ? 'Update role' : 'Add role'}
            </Button>
          </Stack>

          <Box id="roles-list">
            {loading ? (
              <Skeleton variant="rectangular" height={80} />
            ) : jobRoles.length === 0 ? (
              <Typography variant="body2" color="text.secondary">No job roles defined yet.</Typography>
            ) : (
              <Stack spacing={1}>
                {jobRoles.map((r) => (
                  <Stack key={r.name} direction="row" alignItems="center" spacing={1.5}
                    sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1 }}>
                    <Typography variant="body2" sx={{ flex: 1, fontWeight: 600 }}>{r.name}</Typography>
                    <FormControl size="small" sx={{ minWidth: 140 }}>
                      <Select value={r.privilege_level || 'member'}
                        onChange={(e) => updatePriv(r.name, e.target.value)}>
                        {PRIVILEGE_LEVELS.map(p => (
                          <MenuItem key={p} value={p}>{PRIVILEGE_LABEL[p]}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <IconButton size="small" color="error" onClick={() => deleteRole(r.name)} title="Remove role">
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </Stack>
                ))}
              </Stack>
            )}
          </Box>
        </CardContent>
      </Card>

      {/* Permissions matrix */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 2 }}>Permissions matrix</Typography>
          {loading ? (
            <Skeleton variant="rectangular" height={200} />
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Feature / action</TableCell>
                    {levels.map(l => (
                      <TableCell key={l} align="center">
                        <Chip size="small" label={PRIVILEGE_LABEL[l] || l} />
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {caps.features.map((row, i) => {
                    if (row.group) {
                      return (
                        <TableRow key={`g-${i}`} sx={{ backgroundColor: 'action.hover' }}>
                          <TableCell colSpan={levels.length + 1}>
                            <Typography variant="overline">{row.group}</Typography>
                          </TableCell>
                        </TableRow>
                      );
                    }
                    return (
                      <TableRow key={row.feat} hover>
                        <TableCell>
                          <Typography variant="body2" fontWeight={600}>{row.feat}</Typography>
                          {row.desc && <Typography variant="caption" color="text.secondary">{row.desc}</Typography>}
                        </TableCell>
                        {levels.map(l => {
                          const on = (edits[row.feat] || []).includes(l);
                          return (
                            <TableCell key={l} align="center">
                              <IconButton size="small"
                                color={on ? 'success' : 'default'}
                                onClick={() => togglePerm(row.feat, l)}
                                title={`${on ? 'Remove' : 'Grant'} ${l} access`}>
                                {on ? <CheckIcon fontSize="small" /> : <CloseIcon fontSize="small" />}
                              </IconButton>
                            </TableCell>
                          );
                        })}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <Stack direction="row" alignItems="center" spacing={2} sx={{ mt: 2 }}>
            <Button variant="contained" disabled={saving || !dirty} onClick={savePerms}>
              {saving ? 'Saving…' : 'Save permissions'}
            </Button>
            {dirty && <Typography variant="caption" color="warning.main">Unsaved changes</Typography>}
          </Stack>
          <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
            Toggles update the documented permission policy stored in the database. Server-side
            middleware enforces a minimum security floor independently — admin panel access always
            requires the <code>ADMIN_EMAILS</code> environment variable.
          </Alert>
        </CardContent>
      </Card>
    </Stack>
  );
}

export default AdminPermissionsPage;
