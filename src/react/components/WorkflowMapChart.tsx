/**
 * WorkflowMapChart — interactive ReactFlow flowchart for the Card Actions tab.
 *
 * Renders the full stage → lead status → sub-status hierarchy as a
 * top-to-bottom tree. Each node is clickable; clicks surface a detail drawer
 * via the `onNodeClick` callback.
 *
 * CSS import: @xyflow/react/dist/style.css is imported here so the chart
 * renders correctly; Vite tree-shakes unused styles.
 */

import '@xyflow/react/dist/style.css';

import React, { memo, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  type NodeProps,
  type Node,
  type Edge,
} from '@xyflow/react';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import { useTheme } from '@mui/material/styles';
import BoltIcon from '@mui/icons-material/Bolt';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { STAGE_COLORS, NEUTRAL_COLORS, STATUS_COLORS } from '../theme';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WMLeadStatus {
  key: string;
  label: string;
  stage: string | null;
  shorthand: string;
  sort_order: number;
  excluded_from_sales: boolean;
  is_null_row: boolean;
}

export interface WMSubstatus {
  id: number;
  status_key: string;
  substatus_key: string;
  label: string;
  action_label: string;
  sort_order: number;
  default_handler_type?: string;
}

export interface WMCALabel {
  stage_key: string;
  status_key: string;
  label: string;
}

export interface WMBinding {
  stage_key?: string;
  status_key?: string;
  substatus_id?: number | null;
}

export interface WMHandler {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
  bindings: WMBinding[];
}

/** A single status entry from workflow.json (used for read-only stages). */
export interface WMWorkflowStageStatus {
  id: string;
  label: string;
  hint?: string;
}

/** A pipeline stage sourced from workflow.json that has no card-action support. */
export interface WMWorkflowStage {
  key: string;
  label: string;
  statuses: WMWorkflowStageStatus[];
}

/**
 * Unified stage descriptor for the Workflow Map.
 *
 * Ordering contract: `buildFlowGraph` renders stages in the exact order of
 * this array. Callers must derive the array from `Object.keys(workflow.json
 * .stages)` so the chart always reflects the pipeline sequence declared in
 * that file, regardless of future edits to key insertion order.
 *
 * - `kind: 'card-action'` — a stage backed by the card-actions system
 *   (Sales / Design Visit / Survey). Its lead-statuses, sub-statuses, and
 *   handler bindings are rendered from the DB.
 * - `kind: 'read-only'` — a stage that exists only in workflow.json and has
 *   no card-action support. Its statuses come from the JSON file and are
 *   rendered as informational nodes without handler bindings.
 */
export type WMAllStage =
  | { kind: 'card-action'; key: string; label: string; lsStage: string }
  | { kind: 'read-only';   key: string; label: string; statuses: WMWorkflowStageStatus[] };

export type WorkflowMapNodeKind = 'stage' | 'status' | 'substatus';

export interface WorkflowMapNodeData extends Record<string, unknown> {
  kind: WorkflowMapNodeKind;
  label: string;
  key: string;
  stageKey: string;
  stageLabel: string;
  /** All handlers currently bound to this slot — may be empty, one, or many. */
  boundHandlers: WMHandler[];
  /** True for stages/statuses that have no card-action support (workflow.json only). */
  isReadOnly?: boolean;
  /** Optional hint text surfaced in the detail drawer for read-only status nodes. */
  hint?: string;
  isNullRow?: boolean;
  statusKey?: string;
  substatusId?: number;
  actionLabel?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const CARD_ACTION_STAGES: Array<{ key: string; label: string; lsStage: string }> = [
  { key: 'sales',       label: 'Sales',        lsStage: 'SALES'        },
  { key: 'designvisit', label: 'Design Visit', lsStage: 'DESIGN_VISIT' },
  { key: 'survey',      label: 'Survey',       lsStage: 'SURVEY'       },
];

const STAGE_FOR_LS: Record<string, string> = Object.fromEntries(
  CARD_ACTION_STAGES.map(s => [s.lsStage, s.key]),
);

export const HANDLER_TYPE_LABELS: Record<string, string> = {
  add_design_visit_to_calendar: 'Add design visit to calendar',
  summarise_phone_call:         'Summarise phone call',
  show_message:                 'Show informational message',
  start_design_visit:           'Start design visit wizard',
  review_customer_photos:       'Review customer photos',
  schedule_delivery_window:     'Schedule delivery window',
  schedule_installation_slot:   'Schedule installation slot',
  schedule_visit:               'Schedule visit',
  upload_photos_and_info:       'Upload photos & info',
};

export const USER_INPUT_TYPES = new Set([
  'review_customer_photos',
  'start_design_visit',
  'summarise_phone_call',
  'upload_photos_and_info',
  'schedule_visit',
  'schedule_delivery_window',
  'schedule_installation_slot',
]);

export const CONFIRMATION_TYPES = new Set([
  'add_design_visit_to_calendar',
  'show_message',
]);

/** Returns the human-readable interaction requirement for a handler type, or null if unknown. */
export function handlerInteraction(type: string): 'user-input' | 'confirmation' | null {
  if (USER_INPUT_TYPES.has(type))    return 'user-input';
  if (CONFIRMATION_TYPES.has(type))  return 'confirmation';
  return null;
}

/** Display name for a handler, preferring config.action_name. */
export function handlerDisplayName(h: WMHandler): string {
  return String(h.config?.action_name || HANDLER_TYPE_LABELS[h.type] || h.name || h.type);
}

// ── Layout constants ───────────────────────────────────────────────────────────

const STAGE_H   = 56;
const STATUS_H  = 48;
const SUB_H     = 42;
const STATUS_W  = 360;
const SUB_W     = 340;
const H_GAP     = 16;  // horizontal gap between status and substatus columns
const V_GAP     = 6;   // vertical gap between nodes
const STAGE_GAP = 28;  // extra gap between stages

/** Total width of the chart area: status column + gap + substatus column */
export const CHART_TOTAL_W = STATUS_W + H_GAP + SUB_W; // 716

// ── Graph builder ─────────────────────────────────────────────────────────────

function handlersForSlot(
  handlers: WMHandler[],
  stageKey: string,
  statusKey: string,
  substatusId?: number | null,
): WMHandler[] {
  return handlers.filter(h => h.bindings?.some(b => {
    if (substatusId != null) return Number(b.substatus_id) === substatusId;
    if (b.substatus_id != null) return false;
    return (b.stage_key || '').toLowerCase()  === (stageKey  || '').toLowerCase()
        && (b.status_key || '').toLowerCase() === (statusKey || '').toLowerCase();
  }));
}

/**
 * Build the ReactFlow node + edge graph from a unified, ordered stage list.
 *
 * Ordering contract: stages are rendered in the exact order they appear in
 * `allStages`. Callers must derive this array from `Object.keys(workflow.json
 * .stages)` so the chart always mirrors the pipeline sequence declared in that
 * file — a future reorder of keys there will automatically reorder the map.
 */
export function buildFlowGraph(
  labels: WMCALabel[],
  statuses: WMLeadStatus[],
  substatuses: WMSubstatus[],
  handlers: WMHandler[],
  allStages: WMAllStage[],
): { nodes: Node<WorkflowMapNodeData>[]; edges: Edge[] } {
  const nodes: Node<WorkflowMapNodeData>[] = [];
  const edges: Edge[] = [];

  // Group substatuses by status key (upper-cased for consistency)
  const subsByLs: Record<string, WMSubstatus[]> = {};
  for (const s of substatuses) {
    const k = String(s.status_key).toUpperCase();
    (subsByLs[k] = subsByLs[k] || []).push(s);
  }

  // Lookup map: lsStage value → stage key (for card-action stages)
  const stageForLs: Record<string, string> = {};
  for (const st of allStages) {
    if (st.kind === 'card-action') stageForLs[st.lsStage] = st.key;
  }

  let currentY = 0;

  for (const stage of allStages) {
    const stageNodeId = `stage-${stage.key}`;
    const sc = STAGE_COLORS[stage.key] || { bg: '#94a3b8', light: '#f1f5f9', text: '#475569' };

    if (stage.kind === 'card-action') {
      // ── Card-action stage (Sales / Design Visit / Survey) ────────────────
      const stageStatuses = statuses.filter(s => {
        const sk = stageForLs[s.stage || ''];
        return sk === stage.key && !s.is_null_row;
      }).slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

      nodes.push({
        id: stageNodeId,
        type: 'stage-node',
        position: { x: 0, y: currentY },
        data: {
          kind: 'stage',
          label: stage.label,
          key: stage.key,
          stageKey: stage.key,
          stageLabel: stage.label,
          boundHandlers: [],
        },
        draggable: false,
        selectable: true,
        style: { width: CHART_TOTAL_W },
      });

      currentY += STAGE_H + 10;

      for (const s of stageStatuses) {
        const lsKey = String(s.key || '');
        const statusNodeId = `status-${stage.key}-${lsKey}`;
        const subs = (subsByLs[lsKey.toUpperCase()] || [])
          .slice().sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));

        const statusHandlers = handlersForSlot(handlers, stage.key, lsKey.toLowerCase());

        nodes.push({
          id: statusNodeId,
          type: 'status-node',
          position: { x: 0, y: currentY },
          data: {
            kind: 'status',
            label: s.label,
            key: lsKey,
            stageKey: stage.key,
            stageLabel: stage.label,
            statusKey: lsKey.toLowerCase(),
            boundHandlers: statusHandlers,
          },
          draggable: false,
          selectable: true,
          style: { width: STATUS_W },
        });

        edges.push({
          id: `edge-stage-${stageNodeId}-${statusNodeId}`,
          source: stageNodeId,
          target: statusNodeId,
          type: 'smoothstep',
          animated: false,
          style: { stroke: sc.bg || NEUTRAL_COLORS[400], strokeWidth: 1.5 },
        });

        let subY = currentY;

        for (const sub of subs) {
          const subNodeId = `sub-${sub.id}`;
          const subHandlers = handlersForSlot(handlers, stage.key, lsKey.toLowerCase(), sub.id);

          nodes.push({
            id: subNodeId,
            type: 'substatus-node',
            position: { x: STATUS_W + H_GAP, y: subY },
            data: {
              kind: 'substatus',
              label: sub.label,
              key: sub.substatus_key,
              stageKey: stage.key,
              stageLabel: stage.label,
              statusKey: lsKey.toLowerCase(),
              substatusId: sub.id,
              actionLabel: sub.action_label,
              boundHandlers: subHandlers,
            },
            draggable: false,
            selectable: true,
            style: { width: SUB_W },
          });

          edges.push({
            id: `edge-sub-${statusNodeId}-${subNodeId}`,
            source: statusNodeId,
            target: subNodeId,
            type: 'smoothstep',
            animated: false,
            style: { stroke: sc.light || NEUTRAL_COLORS[200], strokeWidth: 1.5, strokeDasharray: '4 3' },
          });

          subY += SUB_H + V_GAP;
        }

        const rowHeight = Math.max(STATUS_H, subs.length > 0 ? subs.length * (SUB_H + V_GAP) - V_GAP : 0);
        currentY += rowHeight + V_GAP;
      }
    } else {
      // ── Read-only pipeline stage (workflow.json only, no card-action support)
      nodes.push({
        id: stageNodeId,
        type: 'stage-node',
        position: { x: 0, y: currentY },
        data: {
          kind: 'stage',
          label: stage.label,
          key: stage.key,
          stageKey: stage.key,
          stageLabel: stage.label,
          boundHandlers: [],
          isReadOnly: true,
        },
        draggable: false,
        selectable: true,
        style: { width: CHART_TOTAL_W },
      });

      currentY += STAGE_H + 10;

      for (const status of stage.statuses) {
        const statusNodeId = `status-${stage.key}-${status.id}`;

        nodes.push({
          id: statusNodeId,
          type: 'status-node',
          position: { x: 0, y: currentY },
          data: {
            kind: 'status',
            label: status.label,
            key: status.id,
            stageKey: stage.key,
            stageLabel: stage.label,
            statusKey: status.id,
            boundHandlers: [],
            isReadOnly: true,
          },
          draggable: false,
          selectable: true,
          style: { width: STATUS_W },
        });

        edges.push({
          id: `edge-stage-${stageNodeId}-${statusNodeId}`,
          source: stageNodeId,
          target: statusNodeId,
          type: 'smoothstep',
          animated: false,
          style: { stroke: sc.bg, strokeWidth: 1.5, opacity: 0.5 },
        });

        currentY += STATUS_H + V_GAP;
      }
    }

    currentY += STAGE_GAP;
  }

  return { nodes, edges };
}

// ── HandlerBadgeSummary — compact badge shown on each node ────────────────────

/**
 * Shows compact handler badge(s) on a node.
 *
 * - 0 handlers: renders nothing
 * - 1 handler: shows ⚡ + interaction type chip
 * - 2+ handlers: shows ⚠ conflict badge with count
 */
function HandlerBadgeSummary({
  handlers,
  small = false,
}: {
  handlers: WMHandler[];
  small?: boolean;
}) {
  if (!handlers.length) return null;

  if (handlers.length > 1) {
    return (
      <Tooltip title={`${handlers.length} handlers bound — conflict`} placement="top" arrow>
        <Chip
          icon={<WarningAmberIcon sx={{ fontSize: small ? 11 : 13, color: `${STATUS_COLORS.warning.text} !important` }} />}
          label={`⚠ ${handlers.length}`}
          size="small"
          sx={{
            height: small ? 18 : 20,
            fontSize: small ? '0.6rem' : '0.65rem',
            fontWeight: 700,
            bgcolor: STATUS_COLORS.warning.bg,
            color: STATUS_COLORS.warning.text,
            border: `1px solid ${STATUS_COLORS.warning.border}`,
            flexShrink: 0,
            '.MuiChip-label': { px: small ? 0.5 : 0.75 },
            '.MuiChip-icon': { ml: small ? 0.3 : 0.5, mr: -0.25 },
          }}
        />
      </Tooltip>
    );
  }

  const h = handlers[0];
  const interaction = handlerInteraction(h.type);
  const chipLabel = interaction === 'user-input'
    ? 'Input req.'
    : interaction === 'confirmation'
    ? 'Confirm'
    : '⚡';

  const tooltipTitle = [handlerDisplayName(h), interaction ? '' : h.type].filter(Boolean).join(' — ');

  return (
    <Tooltip title={tooltipTitle} placement="top" arrow>
      <Chip
        icon={<BoltIcon sx={{ fontSize: small ? 11 : 13, color: `${STATUS_COLORS.violet.text} !important` }} />}
        label={chipLabel}
        size="small"
        sx={{
          height: small ? 18 : 20,
          fontSize: small ? '0.6rem' : '0.65rem',
          fontWeight: 700,
          bgcolor: STATUS_COLORS.violet.bg,
          color: STATUS_COLORS.violet.text,
          border: 'none',
          flexShrink: 0,
          '.MuiChip-label': { px: small ? 0.5 : 0.75 },
          '.MuiChip-icon': { ml: small ? 0.3 : 0.5, mr: -0.25 },
        }}
      />
    </Tooltip>
  );
}

// ── Custom nodes ──────────────────────────────────────────────────────────────

const StageNode = memo(function StageNode({ data, selected }: NodeProps<Node<WorkflowMapNodeData>>) {
  const sc = STAGE_COLORS[data.stageKey] || { bg: '#475569', light: '#f1f5f9', text: '#1e293b' };
  const isReadOnly = !!data.isReadOnly;
  const theme = useTheme();
  const white = theme.palette.common.white;
  return (
    <Box
      sx={{
        width: '100%',
        height: STAGE_H,
        display: 'flex',
        alignItems: 'center',
        px: 2,
        gap: 1,
        borderRadius: '8px',
        background: isReadOnly ? `linear-gradient(90deg, ${sc.bg}cc, ${sc.bg}99)` : sc.bg,
        color: 'common.white',
        boxShadow: selected ? `0 0 0 2px ${white}, 0 0 0 4px ${sc.bg}` : '0 1px 4px rgba(0,0,0,.18)',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'box-shadow .15s',
        '&:hover': { boxShadow: `0 0 0 2px ${white}, 0 0 0 4px ${sc.bg}` },
        opacity: isReadOnly ? 0.85 : 1,
      }}
    >
      <Typography variant="subtitle1" sx={{ color: 'common.white', letterSpacing: '.01em', fontWeight: 700, flex: 1 }}>
        {data.label}
      </Typography>
      {isReadOnly && (
        <Chip
          label="No actions"
          size="small"
          sx={{
            height: 20,
            fontSize: '0.62rem',
            fontWeight: 600,
            bgcolor: 'rgba(255,255,255,0.2)',
            color: 'rgba(255,255,255,0.9)',
            border: '1px solid rgba(255,255,255,0.3)',
            flexShrink: 0,
            '.MuiChip-label': { px: 0.75 },
          }}
        />
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
    </Box>
  );
});

const StatusNode = memo(function StatusNode({ data, selected }: NodeProps<Node<WorkflowMapNodeData>>) {
  const sc = STAGE_COLORS[data.stageKey] || { bg: '#475569', light: '#f1f5f9', text: '#1e293b' };
  const isReadOnly = !!data.isReadOnly;
  return (
    <Box
      sx={{
        width: '100%',
        height: STATUS_H,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        borderRadius: '6px',
        border: isReadOnly ? '1.5px solid #e5e7eb' : `1.5px solid ${sc.light}`,
        background: isReadOnly ? NEUTRAL_COLORS[50] : 'background.paper',
        boxShadow: selected
          ? `0 0 0 2px ${sc.bg}`
          : '0 1px 3px rgba(0,0,0,.08)',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'box-shadow .15s',
        '&:hover': { boxShadow: `0 0 0 2px ${sc.bg}` },
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="body2"
          noWrap
          sx={{ color: isReadOnly ? 'text.secondary' : 'text.primary', fontWeight: 600 }}
        >
          {data.label}
        </Typography>
        <Typography variant="caption" noWrap sx={{ color: 'text.disabled', display: 'block' }}>
          {data.key}
        </Typography>
      </Box>
      {!isReadOnly && <HandlerBadgeSummary handlers={data.boundHandlers as WMHandler[]} />}
      <Handle type="source" position={Position.Right} style={{ opacity: 0, pointerEvents: 'none' }} />
    </Box>
  );
});

const SubstatusNode = memo(function SubstatusNode({ data, selected }: NodeProps<Node<WorkflowMapNodeData>>) {
  const sc = STAGE_COLORS[data.stageKey] || { bg: '#475569', light: '#f1f5f9', text: '#1e293b' };
  return (
    <Box
      sx={{
        width: '100%',
        height: SUB_H,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.25,
        borderRadius: '6px',
        border: `1px dashed ${sc.light}`,
        background: sc.light,
        boxShadow: selected
          ? `0 0 0 2px ${sc.bg}`
          : '0 1px 2px rgba(0,0,0,.05)',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'box-shadow .15s',
        '&:hover': { boxShadow: `0 0 0 2px ${sc.bg}` },
      }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0, pointerEvents: 'none' }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="caption" noWrap sx={{ color: sc.text, display: 'block', fontWeight: 600 }}>
          {data.label}
        </Typography>
        {data.actionLabel && (
          <Typography variant="caption" noWrap sx={{ color: sc.text, opacity: 0.7, display: 'block', fontSize: '0.68rem' }}>
            ↳ {data.actionLabel as string}
          </Typography>
        )}
      </Box>
      <HandlerBadgeSummary handlers={data.boundHandlers as WMHandler[]} small />
    </Box>
  );
});

// ── Node types registry ───────────────────────────────────────────────────────

const NODE_TYPES = {
  'stage-node':     StageNode,
  'status-node':    StatusNode,
  'substatus-node': SubstatusNode,
};

// ── WorkflowMapChart ──────────────────────────────────────────────────────────

export interface WorkflowMapChartProps {
  labels: WMCALabel[];
  statuses: WMLeadStatus[];
  substatuses: WMSubstatus[];
  handlers: WMHandler[];
  onNodeClick: (data: WorkflowMapNodeData) => void;
  /**
   * Complete ordered stage list derived from `Object.keys(workflow.json.stages)`.
   * Stages are rendered in the exact order they appear here, which must match
   * the pipeline sequence in workflow.json. See `WMAllStage` for the shape.
   */
  allStages: WMAllStage[];
}

export function WorkflowMapChart({
  labels,
  statuses,
  substatuses,
  handlers,
  onNodeClick,
  allStages,
}: WorkflowMapChartProps) {
  const { nodes, edges } = useMemo(
    () => buildFlowGraph(labels, statuses, substatuses, handlers, allStages),
    [labels, statuses, substatuses, handlers, allStages],
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onNodeClick(node.data as WorkflowMapNodeData);
    },
    [onNodeClick],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodeClick={handleNodeClick}
      fitView
      fitViewOptions={{ padding: 0.08 }}
      minZoom={0.3}
      maxZoom={1.5}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
      panOnScroll
      zoomOnScroll={false}
      zoomOnPinch
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} color={NEUTRAL_COLORS[200]} />
    </ReactFlow>
  );
}

export default WorkflowMapChart;
