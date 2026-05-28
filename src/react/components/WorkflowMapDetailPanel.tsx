/**
 * WorkflowMapDetailPanel — MUI Drawer that slides in from the right when
 * a node is clicked in the WorkflowMapChart. Shows label, key, stage context,
 * and all bound handlers with their type, config, and interaction requirement.
 */

import React from 'react';
import Drawer from '@mui/material/Drawer';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/Close';
import BoltIcon from '@mui/icons-material/Bolt';
import AccountTreeIcon from '@mui/icons-material/AccountTree';
import TouchAppIcon from '@mui/icons-material/TouchApp';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutlined';
import LabelIcon from '@mui/icons-material/Label';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { STAGE_COLORS } from '../theme';
import {
  type WorkflowMapNodeData,
  type WMHandler,
  HANDLER_TYPE_LABELS,
  USER_INPUT_TYPES,
  CONFIRMATION_TYPES,
  handlerInteraction,
  handlerDisplayName,
} from './WorkflowMapChart';

// ── Helpers ───────────────────────────────────────────────────────────────────

function kindLabel(kind: string) {
  if (kind === 'stage')     return 'Stage';
  if (kind === 'status')    return 'Lead status';
  if (kind === 'substatus') return 'Sub-status';
  return kind;
}

function configEntries(config: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(config)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
}

// ── Detail section ────────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, fontSize: '0.65rem' }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
        {value}
      </Typography>
    </Box>
  );
}

// ── Single handler block ──────────────────────────────────────────────────────

function HandlerBlock({ handler, index, total }: { handler: WMHandler; index: number; total: number }) {
  const interaction = handlerInteraction(handler.type);
  const displayName = handlerDisplayName(handler);
  const cfgEntries = configEntries(handler.config || {});

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: total > 1 ? 'warning.light' : 'divider',
        borderRadius: '6px',
        p: 1.5,
        bgcolor: total > 1 ? '#fffbeb' : 'background.paper',
      }}
    >
      {total > 1 && (
        <Typography variant="caption" sx={{ color: 'warning.dark', fontWeight: 700, display: 'block', mb: 0.75, fontSize: '0.65rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Handler {index + 1} of {total} (conflict)
        </Typography>
      )}

      {/* Handler name */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, mb: 1 }}>
        <BoltIcon sx={{ fontSize: 15, color: '#5b21b6', mt: '1px', flexShrink: 0 }} />
        <Box>
          <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
            {displayName}
          </Typography>
          {handler.name && handler.name !== displayName && (
            <Typography variant="caption" color="text.secondary">
              {handler.name}
            </Typography>
          )}
        </Box>
      </Box>

      {/* Handler type */}
      <Box sx={{ mb: interaction ? 1 : 0 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, fontSize: '0.65rem' }}>
          Handler type
        </Typography>
        <Box component="code" sx={{ fontFamily: 'monospace', fontSize: '0.78rem', background: '#f3f4f6', px: 0.75, py: 0.25, borderRadius: 1 }}>
          {handler.type}
        </Box>
        {!HANDLER_TYPE_LABELS[handler.type] && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, fontSize: '0.68rem', fontStyle: 'italic' }}>
            Unknown type — interaction requirement not determined.
          </Typography>
        )}
      </Box>

      {/* Interaction requirement */}
      {interaction && (
        <Box
          sx={{
            display: 'flex', alignItems: 'center', gap: 1,
            px: 1.25, py: 0.75, mt: 1,
            borderRadius: '6px',
            bgcolor: interaction === 'user-input' ? '#fef3c7' : '#dbeafe',
            color: interaction === 'user-input' ? '#92400e' : '#1d4ed8',
          }}
        >
          {interaction === 'user-input'
            ? <TouchAppIcon sx={{ fontSize: 15 }} />
            : <CheckCircleOutlineIcon sx={{ fontSize: 15 }} />
          }
          <Typography variant="caption" sx={{ fontWeight: 700, fontSize: '0.75rem' }}>
            {interaction === 'user-input' ? 'User input required' : 'User confirmation'}
          </Typography>
        </Box>
      )}

      {/* Handler config */}
      {cfgEntries.length > 0 && (
        <Box sx={{ mt: 1.25 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, fontSize: '0.65rem' }}>
            Config
          </Typography>
          <Stack spacing={0.75}>
            {cfgEntries.map(([k, v]) => (
              <DetailRow key={k} label={k.replace(/_/g, ' ')} value={v} />
            ))}
          </Stack>
        </Box>
      )}
    </Box>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface WorkflowMapDetailPanelProps {
  node: WorkflowMapNodeData | null;
  onClose: () => void;
}

export function WorkflowMapDetailPanel({ node, onClose }: WorkflowMapDetailPanelProps) {
  const sc = node ? (STAGE_COLORS[node.stageKey] || { bg: '#475569', light: '#f1f5f9', text: '#1e293b' }) : null;
  const boundHandlers = (node?.boundHandlers ?? []) as WMHandler[];
  const hasConflict = boundHandlers.length > 1;

  return (
    <Drawer
      anchor="right"
      open={node !== null}
      onClose={onClose}
      slotProps={{ paper: { sx: { width: { xs: '100%', sm: 400 }, display: 'flex', flexDirection: 'column' } } }}
    >
      {/* Header */}
      <Box
        sx={{
          px: 2.5,
          py: 2,
          background: sc?.bg || 'background.paper',
          color: '#fff',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 1,
          flexShrink: 0,
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,.75)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', fontSize: '0.65rem', display: 'block', mb: 0.25 }}>
            {node ? kindLabel(node.kind) : ''}
          </Typography>
          <Typography variant="h6" sx={{ color: '#fff', wordBreak: 'break-word', fontWeight: 700 }}>
            {node?.label}
          </Typography>
        </Box>
        <Tooltip title="Close">
          <IconButton
            size="small"
            onClick={onClose}
            sx={{ color: 'rgba(255,255,255,.85)', mt: -0.5, flexShrink: 0 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Body */}
      <Box sx={{ flex: 1, overflowY: 'auto', px: 2.5, py: 2.5 }}>
        {node && (
          <Stack spacing={2.5}>
            {/* Key + context */}
            <Stack spacing={1.5}>
              <DetailRow
                label="Key"
                value={
                  <Box component="code" sx={{ fontFamily: 'monospace', fontSize: '0.82rem', background: '#f3f4f6', px: 0.75, py: 0.25, borderRadius: 1 }}>
                    {node.key}
                  </Box>
                }
              />
              {node.kind !== 'stage' && (
                <DetailRow
                  label="Stage"
                  value={
                    <Chip
                      icon={<AccountTreeIcon sx={{ fontSize: 13, color: `${sc?.text} !important` }} />}
                      label={node.stageLabel}
                      size="small"
                      sx={{ bgcolor: sc?.light, color: sc?.text, fontWeight: 600, height: 22, border: 'none' }}
                    />
                  }
                />
              )}
              {node.statusKey && node.kind === 'substatus' && (
                <DetailRow
                  label="Parent lead status"
                  value={
                    <Box component="code" sx={{ fontFamily: 'monospace', fontSize: '0.82rem', background: '#f3f4f6', px: 0.75, py: 0.25, borderRadius: 1 }}>
                      {node.statusKey}
                    </Box>
                  }
                />
              )}
              {node.actionLabel && (
                <DetailRow
                  label="Action label"
                  value={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <LabelIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                      <Typography variant="body2">{node.actionLabel as string}</Typography>
                    </Box>
                  }
                />
              )}
            </Stack>

            <Divider />

            {/* Read-only stage explanation */}
            {node.isReadOnly ? (
              <Stack spacing={1.5}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 1.25,
                    px: 1.5,
                    py: 1.25,
                    borderRadius: '8px',
                    bgcolor: '#f8fafc',
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <LockOutlinedIcon sx={{ fontSize: 16, color: 'text.secondary', mt: '1px', flexShrink: 0 }} />
                  <Typography variant="body2" color="text.secondary">
                    This is a read-only pipeline stage. Card-action handlers are not supported here.
                  </Typography>
                </Box>
                {node.hint && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 1.25,
                      px: 1.5,
                      py: 1.25,
                      borderRadius: '8px',
                      bgcolor: '#eff6ff',
                      border: '1px solid #bfdbfe',
                    }}
                  >
                    <InfoOutlinedIcon sx={{ fontSize: 16, color: '#3b82f6', mt: '1px', flexShrink: 0 }} />
                    <Typography variant="body2" sx={{ color: '#1e40af' }}>
                      {node.hint as string}
                    </Typography>
                  </Box>
                )}
              </Stack>
            ) : (
              /* Handlers */
              <Stack spacing={1.5}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="overline" color="text.secondary">
                    Bound handlers
                  </Typography>
                  {boundHandlers.length > 0 && (
                    <Chip
                      label={boundHandlers.length}
                      size="small"
                      sx={{
                        height: 18,
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        bgcolor: hasConflict ? '#fef3c7' : '#ede9fe',
                        color: hasConflict ? '#92400e' : '#5b21b6',
                        border: 'none',
                      }}
                    />
                  )}
                  {hasConflict && (
                    <Tooltip title="Multiple handlers bound to this slot — resolve in the Action handlers tab" arrow>
                      <WarningAmberIcon sx={{ fontSize: 16, color: 'warning.main' }} />
                    </Tooltip>
                  )}
                </Box>

                {boundHandlers.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                    No handler bound to this {kindLabel(node.kind).toLowerCase()}.
                  </Typography>
                ) : (
                  <Stack spacing={1.25}>
                    {boundHandlers.map((h, i) => (
                      <HandlerBlock key={h.id} handler={h} index={i} total={boundHandlers.length} />
                    ))}
                  </Stack>
                )}
              </Stack>
            )}
          </Stack>
        )}
      </Box>
    </Drawer>
  );
}

export default WorkflowMapDetailPanel;
