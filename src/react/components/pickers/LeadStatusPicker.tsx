import React, { useEffect, useRef, useState } from 'react';
import {
  Box,
  CircularProgress,
  Popover,
  Typography,
} from '@mui/material';

// ── Types ──────────────────────────────────────────────────────────────────────

interface LeadStatusOption {
  value: string;
  label: string;
  excluded_from_sales?: boolean;
}

interface LeadSubstatus {
  id?: number;
  status_key: string;
  substatus_key: string;
  label?: string;
  sort_order?: number;
}

interface WindowGlobals {
  LEAD_STATUS_OPTIONS?: LeadStatusOption[];
  LEAD_SUBSTATUSES?: LeadSubstatus[];
  quickSetLeadStatus?: (contactId: string, newStatus: string) => void;
  _quickSetLeadStatusWithSub?: (contactId: string, statusKey: string, substatusKey: string) => void;
  showToast?: (msg: string, isError?: boolean) => void;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getLeadStatuses(): LeadStatusOption[] {
  return (window as unknown as WindowGlobals).LEAD_STATUS_OPTIONS || [];
}

function getLeadSubstatuses(): LeadSubstatus[] {
  return (window as unknown as WindowGlobals).LEAD_SUBSTATUSES || [];
}

function substatusesForStatus(statusKey: string): LeadSubstatus[] {
  if (!statusKey) return [];
  const sk = String(statusKey).toUpperCase();
  return getLeadSubstatuses()
    .filter((s) => String(s.status_key).toUpperCase() === sk)
    .slice()
    .sort(
      (a, b) =>
        (b.sort_order ?? 0) - (a.sort_order ?? 0) ||
        String(b.substatus_key).localeCompare(String(a.substatus_key)),
    );
}

function currentSubstatusKey(statusKey: string, hwSubstatus: string): string {
  if (!statusKey || !hwSubstatus) return '';
  const prefix = `${String(statusKey).toUpperCase()}__`;
  const v = String(hwSubstatus).toUpperCase();
  if (!v.startsWith(prefix)) return '';
  return v.slice(prefix.length);
}

// ── Sub-item button ────────────────────────────────────────────────────────────

function PickerButton({
  label,
  isActive,
  isDisabled,
  isClear,
  isSub,
  onClick,
  extraClass,
  leadStatusKey,
}: {
  label: string;
  isActive?: boolean;
  isDisabled?: boolean;
  isClear?: boolean;
  isSub?: boolean;
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
        background: isActive ? '#EDE8FF' : 'none', // hex-color-ok: pre-existing raw hex
        color: isClear ? '#ef4444' : isActive ? '#6A12D9' : isDisabled ? '#B8AE99' : '#141413', // hex-color-ok: pre-existing raw hex
        fontWeight: isActive ? 700 : isClear ? 500 : 400,
        fontSize: isSub ? '0.78rem' : '0.82rem',
        fontFamily: 'inherit',
        px: isSub ? '20px' : '12px',
        py: '7px',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        borderRadius: '4px',
        lineHeight: 1.35,
        letterSpacing: 0,
        transition: 'background 0.1s',
        '&:hover:not(:disabled)': { background: isActive ? '#E0D8FF' : '#F6F1E7' }, // hex-color-ok: pre-existing raw hex
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
  currentHwSubstatus: string;
  showSubstatuses?: boolean;
}

export function LeadStatusPicker({
  anchorEl,
  open,
  onClose,
  contactId,
  currentStatus,
  currentHwSubstatus,
  showSubstatuses = false,
}: LeadStatusPickerProps) {
  const [loading, setLoading] = useState(false);
  const [liveStatus, setLiveStatus] = useState(currentStatus);
  const [liveHwSub, setLiveHwSub] = useState(currentHwSubstatus);
  const closedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      closedRef.current = false;
      return;
    }
    setLiveStatus(currentStatus);
    setLiveHwSub(currentHwSubstatus);
    setLoading(true);
    closedRef.current = false;

    fetch(`/api/contacts/${encodeURIComponent(contactId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((fresh: { properties?: { hs_lead_status?: string; hw_lead_substatus?: string } } | null) => {
        if (closedRef.current || !fresh) return;
        const freshStatus = fresh.properties?.hs_lead_status || '';
        const freshHw = fresh.properties?.hw_lead_substatus || '';
        const drifted = freshStatus !== currentStatus;
        setLiveStatus(freshStatus);
        setLiveHwSub(freshHw);
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

  const handleSelectWithSub = (statusKey: string, subKey: string) => {
    onClose();
    const w = window as unknown as WindowGlobals;
    if (typeof w._quickSetLeadStatusWithSub === 'function') {
      w._quickSetLeadStatusWithSub(contactId, statusKey, subKey);
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
  const curSubKey = currentSubstatusKey(liveStatus, liveHwSub);

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      transformOrigin={{ vertical: 'top', horizontal: 'left' }}
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
          {statuses.map(({ value, label }) => {
            const subs = showSubstatuses ? substatusesForStatus(value) : [];
            const parentIsActive = showSubstatuses
              ? value === liveStatus && !curSubKey
              : value === liveStatus;
            return (
              <React.Fragment key={value}>
                <PickerButton
                  label={label}
                  isActive={parentIsActive}
                  onClick={() => handleSelect(value)}
                  extraClass="card-picker-opt"
                  leadStatusKey={value}
                />
                {showSubstatuses &&
                  subs.map((sub) => {
                    const subIsActive =
                      value === liveStatus &&
                      String(sub.substatus_key).toUpperCase() === curSubKey;
                    return (
                      <PickerButton
                        key={sub.substatus_key}
                        label={sub.label || sub.substatus_key}
                        isActive={subIsActive}
                        isSub
                        onClick={() => handleSelectWithSub(value, sub.substatus_key)}
                        extraClass="card-picker-opt card-picker-opt--sub"
                      />
                    );
                  })}
              </React.Fragment>
            );
          })}
        </>
      )}
    </Popover>
  );
}
