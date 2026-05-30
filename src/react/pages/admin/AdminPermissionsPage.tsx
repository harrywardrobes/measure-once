import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, CardContent, Chip, Divider, FormControl, IconButton,
  MenuItem, Select, Skeleton, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import DeleteIcon from '@mui/icons-material/Delete';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import TuneIcon from '@mui/icons-material/Tune';
import {
  api, toast, emitAdminChange, onAdminChange, PRIVILEGE_LEVELS, PRIVILEGE_LABEL,
} from './adminApi';
import { NAV } from '../../components/BottomNav';
import { NavCustomiseDialog } from '../../components/NavCustomiseDialog';
import { usePageTitle } from '../../hooks/usePageTitle';

// Ensure icon-lint scanner can detect these imports before apostrophe text below.
type _Icons = typeof CheckIcon | typeof CloseIcon | typeof DeleteIcon | typeof InfoOutlinedIcon | typeof TuneIcon;

type JobRole = { name: string; privilege_level?: string }; // privilege-read-ok: data field managed by admin
type Feature = { feat: string; desc?: string; levels?: string[]; group?: string };
type Capabilities = { levels: string[]; features: Feature[] };
type NavRoleConfig = { role_name: string; primary_keys: string[]; is_customized: boolean };

type NavConfigEntry = { primary_keys: string[]; is_customized: boolean };

export function AdminPermissionsPage() {
  usePageTitle('Permissions · Measure Once');
  const [loading, setLoading] = useState(true);
  const [jobRoles, setJobRoles] = useState<JobRole[]>([]);
  const [caps, setCaps] = useState<Capabilities>({ levels: [...PRIVILEGE_LEVELS], features: [] });
  const [edits, setEdits] = useState<Record<string, string[]>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Nav role configs
  const [navConfigs, setNavConfigs] = useState<Record<string, NavConfigEntry>>({});
  const [navEditTarget, setNavEditTarget] = useState<string | null>(null);

  // Add-role form
  const [newRole, setNewRole] = useState('');
  const [newPriv, setNewPriv] = useState('member');

  async function load() {
    try {
      const [roles, capabilities, navConfigRows] = await Promise.all([
        api<JobRole[]>('GET', '/api/admin/job-roles'),
        api<Capabilities>('GET', '/api/admin/capabilities'),
        api<NavRoleConfig[]>('GET', '/api/admin/nav-role-configs'),
      ]);
      setJobRoles(Array.isArray(roles) ? roles : []);
      const c = capabilities || { levels: [...PRIVILEGE_LEVELS], features: [] };
      setCaps(c);
      const seed: Record<string, string[]> = {};
      (c.features || []).forEach(f => { if (!f.group) seed[f.feat] = [...(f.levels || [])]; });
      setEdits(seed);
      setDirty(false);
      const navMap: Record<string, NavConfigEntry> = {};
      (Array.isArray(navConfigRows) ? navConfigRows : []).forEach(row => {
        navMap[row.role_name] = { primary_keys: row.primary_keys, is_customized: row.is_customized };
      });
      setNavConfigs(navMap);
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
      await api('POST', '/api/admin/job-roles', { name, privilege_level: newPriv }); // privilege-read-ok: admin API payload
      toast(existingRole ? 'Role updated' : 'Role added');
      setNewRole(''); setNewPriv('member');
      emitAdminChange('roles');
      load();
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function updatePriv(name: string, level: string) {
    try {
      await api('POST', '/api/admin/job-roles', { name, privilege_level: level }); // privilege-read-ok: admin API payload
      setJobRoles(prev => prev.map(r => r.name === name ? { ...r, privilege_level: level } : r)); // privilege-read-ok: admin state update
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

  async function saveNavConfig(roleName: string, keys: string[]) {
    try {
      await api('PATCH', `/api/admin/nav-role-config/${encodeURIComponent(roleName)}`, { primary_keys: keys });
      setNavConfigs(prev => ({ ...prev, [roleName]: { primary_keys: keys, is_customized: true } }));
      toast(`Nav layout saved for "${roleName}"`);
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function resetNavConfig(roleName: string) {
    try {
      await api('DELETE', `/api/admin/nav-role-config/${encodeURIComponent(roleName)}`);
      setNavConfigs(prev => ({
        ...prev,
        [roleName]: { primary_keys: prev[roleName]?.primary_keys ?? defaultNavKeys, is_customized: false },
      }));
      setNavEditTarget(null);
      toast(`Nav layout for "${roleName}" reset to default`);
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

  const FALLBACK_NAV_KEYS = ['home', 'calendar', 'trades'];
  const defaultNavKeys = navConfigs['__default__']?.primary_keys || FALLBACK_NAV_KEYS;

  const editingTargetEntry = navEditTarget ? navConfigs[navEditTarget] : null;
  const editingIsCustomized = editingTargetEntry?.is_customized ?? false;
  // When the role is not customised (or has no entry), start the dialog from
  // the live default so the admin sees what the role actually inherits.
  const editingNavKeys = (editingIsCustomized && editingTargetEntry?.primary_keys)
    ? editingTargetEntry.primary_keys
    : defaultNavKeys;
  const dialogDefaultKeys = navEditTarget === '__default__' ? FALLBACK_NAV_KEYS : defaultNavKeys;

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
              slotProps={{ htmlInput: { maxLength: 64 }}} />
            <FormControl size="small" sx={{ minWidth: 140 }}>
              <Select value={existingRole?.privilege_level || newPriv} /* privilege-read-ok: admin form reads another role's data */
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
                {jobRoles.map((r) => {
                  const roleEntry = navConfigs[r.name];
                  const isCustomized = roleEntry?.is_customized ?? false;
                  const roleNavKeys: string[] = isCustomized
                    ? (roleEntry?.primary_keys ?? defaultNavKeys)
                    : defaultNavKeys;
                  return (
                    <Stack key={r.name} direction="row" spacing={1.5} data-testid={`role-row-${r.name}`}
                      sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1, flexWrap: 'wrap', gap: 1, alignItems: 'center' }}>
                      <Typography variant="body2" sx={{ flex: 1, fontWeight: 600, minWidth: 100 }}>{r.name}</Typography>
                      <FormControl size="small" sx={{ minWidth: 140 }}>
                        <Select value={r.privilege_level || 'member'} /* privilege-read-ok: admin form displays another role's data */
                          onChange={(e) => updatePriv(r.name, e.target.value)}>
                          {PRIVILEGE_LEVELS.map(p => (
                            <MenuItem key={p} value={p}>{PRIVILEGE_LABEL[p]}</MenuItem>
                          ))}
                        </Select>
                      </FormControl>
                      <Stack direction="row" spacing={0.5} sx={{ flex: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                        {isCustomized ? (
                          roleNavKeys.map(k => {
                            const item = NAV.find(n => n.key === k);
                            return item ? (
                              <Chip key={k} label={item.label} size="small" variant="outlined" />
                            ) : null;
                          })
                        ) : (
                          <>
                            <Tooltip
                              title="This role inherits the Default layout — changes to the Default row will apply here automatically. Click the tune icon to give this role its own custom layout."
                              arrow
                            >
                              <Chip
                                label="Inheriting default"
                                size="small"
                                icon={<InfoOutlinedIcon />}
                                sx={{ fontStyle: 'italic', cursor: 'help' }}
                              />
                            </Tooltip>
                            {defaultNavKeys.map(k => {
                              const item = NAV.find(n => n.key === k);
                              return item ? (
                                <Chip
                                  key={k}
                                  label={item.label}
                                  size="small"
                                  variant="outlined"
                                  sx={{ opacity: 0.45 }}
                                />
                              ) : null;
                            })}
                          </>
                        )}
                        <Tooltip title="Edit navigation layout">
                          <IconButton size="small" onClick={() => setNavEditTarget(r.name)}>
                            <TuneIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                      <IconButton size="small" color="error" onClick={() => deleteRole(r.name)} title="Remove role">
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  );
                })}
              </Stack>
            )}
          </Box>

          {!loading && (
            <>
              <Divider sx={{ my: 1.5 }} />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                The row below is the fallback layout used for any user whose job role is not listed above (or who has no job role set). Roles showing "Inheriting default" inherit this layout automatically.
              </Typography>
              <Stack direction="row" spacing={1.5} data-testid="role-row-default"
                sx={{ p: 1, border: 1, borderColor: 'divider', borderRadius: 1, flexWrap: 'wrap', gap: 1, alignItems: 'center', bgcolor: 'action.hover' }}>
                <Typography variant="body2" sx={{ flex: 1, fontWeight: 600, minWidth: 100, fontStyle: 'italic' }}>
                  Default (all other roles)
                </Typography>
                <Stack direction="row" spacing={0.5} sx={{ flex: 2, flexWrap: 'wrap', alignItems: 'center' }}>
                  {defaultNavKeys.map(k => {
                    const item = NAV.find(n => n.key === k);
                    return item ? (
                      <Chip key={k} label={item.label} size="small" variant="outlined" />
                    ) : null;
                  })}
                  <Tooltip title="Edit default navigation layout">
                    <IconButton size="small" onClick={() => setNavEditTarget('__default__')}>
                      <TuneIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Stack>
            </>
          )}

          <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
            The navigation chips show which tabs appear in the bottom bar for each role.
            Click the <strong>tune icon</strong> to change a role's primary tabs. Roles showing <em>Inheriting default</em> automatically pick up whatever is set in the Default row — their faded chips preview that layout. Changes take effect the next time users with that role load the app.
          </Alert>
        </CardContent>
      </Card>

      {/* Nav layout editor dialog */}
      <NavCustomiseDialog
        open={navEditTarget !== null}
        onClose={() => setNavEditTarget(null)}
        availableItems={NAV.filter(n => !n.adminOnly)}
        currentKeys={editingNavKeys}
        defaultKeys={dialogDefaultKeys}
        isCustomized={navEditTarget !== '__default__' ? editingIsCustomized : undefined}
        onSave={(keys) => {
          if (navEditTarget) saveNavConfig(navEditTarget, keys);
          setNavEditTarget(null);
        }}
        onReset={navEditTarget && navEditTarget !== '__default__' ? () => resetNavConfig(navEditTarget) : undefined}
      />

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
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>{row.feat}</Typography>
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
          <Stack direction="row" spacing={2} sx={{  mt: 2, alignItems: 'center' }}>
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
