import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  CircularProgress,
  Popover,
  Typography,
} from '@mui/material';
import { BRAND_COLORS } from '../../theme';

// ── Types ──────────────────────────────────────────────────────────────────────

interface LeadStatusOption {
  value: string;
  label: string;
  excluded_from_sales?: boolean;
}

interface WindowGlobals {
  LEAD_STATUS_OPTIONS?: LeadStatusOption[];
  quickSetLeadStatus?: (contactId: string, newStatus: string) => void;
  showToast?: (msg: string, isError?: boolean) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getLeadStatuses(): LeadStatusOption[] {
  return (window as unknown as WindowGlobals).LEAD_STATUS_OPTIONS || [];
}

// ── Picker button ──────────────────────────────────────────────────────────────

function PickerButton({
  label,
  isActive,
  isDisabled,
  isClear,
  onClick,
  extraClass,
  leadStatusKey,
}: {
  label: string;
  isActive?: boolean;
  isDisabled?: boolean;
  isClear?: boolean;
  onClick?: () => void;
  extraClass?: string;
  leadStatusKey?: string;
}) {
  return (
    <Box
      component="button"
      disabled={isDisabled}
      onClick={onClick}
      className={extraClass}
      data-lead-status={leadStatusKey}
      sx={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        background: isActive ? BRAND_COLORS.orchidTintDeep : 'none',
        color: isClear ? 'error.main' : isActive ? BRAND_COLORS.orchidDeep : isDisabled ? BRAND_COLORS.stoneDeep : BRAND_COLORS.ink1,
        fontWeight: isActive ? 700 : isClear ? 500 : 400,
        fontSize: '0.82rem',
        fontFamily: 'inherit',
        px: '12px',
        py: '7px',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        borderRadius: '4px',
        lineHeight: 1.35,
        letterSpacing: 0,
        transition: 'background 0.1s',
        '&:hover:not(:disabled)': { background: isActive ? BRAND_COLORS.orchidTintHover : BRAND_COLORS.paper },
      }}
    >
      {label}
    </Box>
  );
}

// ── LeadStatusPicker ──────────────────────────────────────────────────────────

export interface LeadStatusPickerProps {
  anchorEl: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  contactId: string;
  currentStatus: string;
}

export function LeadStatusPicker({
  anchorEl,
  open,
  onClose,
  contactId,
  currentStatus,
}: LeadStatusPickerProps) {
  const [loading, setLoading] = useState(false);
  const [liveStatus, setLiveStatus] = useState(currentStatus);
  const closedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      closedRef.current = false;
      return;
    }
    setLiveStatus(currentStatus);
    setLoading(true);
    closedRef.current = false;

    fetch(`/api/contacts/${encodeURIComponent(contactId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((fresh: { properties?: { hs_lead_status?: string } } | null) => {
        if (closedRef.current || !fresh) return;
        const freshStatus = fresh.properties?.hs_lead_status || '';
        const drifted = freshStatus !== currentStatus;
        setLiveStatus(freshStatus);
        if (drifted) {
          const statuses = getLeadStatuses();
          const newLabel = freshStatus
            ? statuses.find((o) => o.value === freshStatus)?.label || freshStatus
            : 'No status';
          const w = window as unknown as WindowGlobals;
          if (typeof w.showToast === 'function') {
            w.showToast(`Lead status was updated in HubSpot to ${newLabel}`);
          }
        }
      })
      .catch(() => {
        const w = window as unknown as WindowGlobals;
        if (!closedRef.current && typeof w.showToast === 'function') {
          w.showToast('Could not refresh lead status from HubSpot — showing last known value.', true);
        }
      })
      .finally(() => {
        if (!closedRef.current) setLoading(false);
      });

    return () => { closedRef.current = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contactId]);

  const handleSelect = (statusKey: string) => {
    onClose();
    const w = window as unknown as WindowGlobals;
    if (typeof w.quickSetLeadStatus === 'function') {
      w.quickSetLeadStatus(contactId, statusKey);
    }
  };

  const handleClear = () => {
    onClose();
    const w = window as unknown as WindowGlobals;
    if (typeof w.quickSetLeadStatus === 'function') {
      w.quickSetLeadStatus(contactId, '');
    }
  };

  const statuses = getLeadStatuses();

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
      data-testid="lead-status-picker"
      slotProps={{
        paper: {
          id: 'card-picker-popup',
          sx: {
            mt: 0.5,
            minWidth: 200,
            maxHeight: 340,
            overflowY: 'auto',
            p: '6px',
            border: '1.5px solid',
            borderColor: 'divider',
            borderRadius: 1.5,
            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
          },
        },
      }}
    >
      {loading ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: '10px 14px' }}>
          <CircularProgress size={14} sx={{ flexShrink: 0 }} />
          <Typography sx={{ fontSize: '0.82rem', color: 'text.secondary' }}>
            Loading current status…
          </Typography>
        </Box>
      ) : (
        <>
          <PickerButton
            label="✕ Clear status"
            isClear
            isDisabled={!liveStatus}
            onClick={liveStatus ? handleClear : undefined}
            extraClass="card-picker-opt card-picker-opt--clear"
          />
          {statuses.map(({ value, label }) => (
            <PickerButton
              key={value}
              label={label}
              isActive={value === liveStatus}
              onClick={() => handleSelect(value)}
              extraClass="card-picker-opt"
              leadStatusKey={value}
            />
          ))}
        </>
      )}
    </Popover>
  );
}
