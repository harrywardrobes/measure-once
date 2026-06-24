import React, { useEffect, useState } from 'react';
import {
  Box, Button, Card, CardContent, Chip, Skeleton, Stack, Tooltip, Typography,
} from '@mui/material';
import SettingsIcon from '@mui/icons-material/Settings';
import { api, toast, fmtDate, onAdminChange } from './adminApi';
import { usePageTitle } from '../../hooks/usePageTitle';

type AuditEntry = {
  source?: string;        // 'trade' or undefined
  ts?: string;
  action_type?: string;
  admin_email?: string;
  target_email?: string;
  details?: string;
  // trade variant
  company_name?: string;
  trade_type?: string;
  actor_name?: string;
  action?: string;
};

const ACTION_LABELS: Record<string, string> = {
  approve_request:           'Approved access request',
  reject_request:            'Rejected access request',
  add_allowed_email:         'Added email to allow-list',
  revoke_allowed_email:      'Revoked email from allow-list',
  edit_user_profile:         'Edited user profile',
  add_job_role:              'Added job role',
  delete_job_role:           'Deleted job role',
  edit_permissions:          'Updated permission matrix',
  approve_profile_photo:     'Approved profile photo',
  reject_profile_photo:      'Rejected profile photo',
  resend_set_password_email: 'Resent set-password email',
  force_password_reset:      'Forced password reset',
  startup_migration:         'System startup migration',
};

const PAGE_SIZE = 50;

export function AdminAuditLogPage() {
  usePageTitle('Audit Log · Measure Once');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const data = await api<{ items?: AuditEntry[]; hasMore?: boolean }>(
        'GET', `/api/admin/audit-log-unified?limit=${PAGE_SIZE}&offset=0`,
      );
      setEntries(data?.items || []);
      setHasMore(!!data?.hasMore);
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e) || 'Failed to load audit log', true);
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    setLoadingMore(true);
    try {
      const data = await api<{ items?: AuditEntry[]; hasMore?: boolean }>(
        'GET', `/api/admin/audit-log-unified?limit=${PAGE_SIZE}&offset=${entries.length}`,
      );
      const items = data?.items || [];
      setEntries(prev => prev.concat(items));
      setHasMore(!!data?.hasMore);
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    load();
    const off = onAdminChange((k) => { if (k === 'audit') load(); });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" spacing={1} sx={{  mb: 1, alignItems: 'center' }}>
          <Typography variant="h6">Audit log</Typography>
          <Chip size="small" label="read-only" variant="outlined" />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          A unified, time-ordered record of admin actions and trade company changes.
        </Typography>
        <Box id="audit-feed">
          {loading ? (
            <Skeleton data-testid="loading-skeleton" variant="rectangular" height={200} />
          ) : entries.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No audit entries recorded yet.</Typography>
          ) : (
            <Stack divider={<Box sx={{ borderBottom: 1, borderColor: 'divider' }} />} spacing={0}>
              {entries.map((e, i) => {
                if (e.source === 'trade') {
                  return (
                    <Stack key={i} direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ py: 1.5 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 160 }}>{fmtDate(e.ts)}</Typography>
                      <Box sx={{ flex: 1 }}>
                        <Stack direction="row" spacing={1} sx={{  alignItems: 'center', flexWrap: 'wrap' }}>
                          <Chip size="small" label="trade company" color="secondary" variant="outlined" />
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>{e.company_name || ''}</Typography>
                          {e.trade_type && <Chip size="small" label={e.trade_type} />}
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          {e.action || ''}{e.actor_name ? <> · By <strong>{e.actor_name}</strong></> : null}
                        </Typography>
                      </Box>
                    </Stack>
                  );
                }
                const label = ACTION_LABELS[e.action_type || ''] || e.action_type || '';
                const meta = [
                  e.target_email && `Target: ${e.target_email}`,
                  e.details,
                ].filter(Boolean).join(' · ');
                const isSystem = e.admin_email === '[system]';
                return (
                  <Stack key={i} direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ py: 1.5, opacity: isSystem ? 0.75 : 1 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ minWidth: 160 }}>{fmtDate(e.ts)}</Typography>
                    <Box sx={{ flex: 1 }}>
                      <Stack direction="row" spacing={1} sx={{  alignItems: 'center', flexWrap: 'wrap' }}>
                        <Chip size="small" label={(e.action_type || '').replace(/_/g, ' ')} variant="outlined" />
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>{label}</Typography>
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {isSystem ? (
                          <Tooltip title="Performed automatically by the server on startup">
                            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.4 }}>
                              <SettingsIcon sx={{ fontSize: 12, verticalAlign: 'middle', color: 'text.disabled' }} />
                              <Box component="span" sx={{ color: 'text.disabled', fontStyle: 'italic' }}>system</Box>
                            </Box>
                          </Tooltip>
                        ) : (
                          <>By <strong>{e.admin_email || ''}</strong></>
                        )}{meta ? ' · ' + meta : ''}
                      </Typography>
                    </Box>
                  </Stack>
                );
              })}
            </Stack>
          )}
        </Box>
        {hasMore && (
          <Stack sx={{  mt: 2, alignItems: 'center' }}>
            <Button onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export default AdminAuditLogPage;
