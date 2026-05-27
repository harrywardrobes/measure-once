import React from 'react';
import Box from '@mui/material/Box';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { LeadStatus, LeadSubstatus, Contact, STAGE_COLOURS } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';

interface Props {
  contact: Contact | null;
  leadStatuses: LeadStatus[];
  leadSubstatuses: LeadSubstatus[];
  loaded: boolean;
  focusedLeadStatus: string | null;
  onFocusChange: (value: string) => void;
  onSubstatusChange: (statusValue: string, substatusKey: string, checked: boolean) => void;
}

export function LeadStatusRail({
  contact,
  leadStatuses,
  leadSubstatuses,
  loaded,
  focusedLeadStatus,
  onFocusChange,
  onSubstatusChange,
}: Props) {
  const { isManager } = usePrivilege();
  const canEdit = isManager;

  const rail = loaded
    ? leadStatuses.filter(o => !o.excluded_from_sales)
    : [];

  if (!loaded) {
    const labelWidths = [120, 90, 140];
    return (
      <Box id="workflow-stages" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        {[0, 1, 2].map(i => (
          <Box
            key={i}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '12px',
              p: '14px 16px',
              bgcolor: 'var(--bg)',
              border: '1px solid var(--stone)',
              borderRadius: 'var(--radius-md)',
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
              <Skeleton variant="circular" width={12} height={12} sx={{ flexShrink: 0 }} />
              <Skeleton variant="rounded" width={labelWidths[i]} height={13} />
            </Box>
            <Skeleton variant="rounded" width={36} height={13} sx={{ flexShrink: 0 }} />
          </Box>
        ))}
      </Box>
    );
  }

  if (rail.length === 0) {
    return (
      <Box id="workflow-stages" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography sx={{ p: '18px 16px', fontSize: '0.82rem', color: 'var(--ink-4)', fontStyle: 'italic' }}>
          No lead statuses configured. An admin can add them in Settings → Lead statuses.
        </Typography>
      </Box>
    );
  }

  const props      = contact?.properties || {};
  const currentLs  = String(props.hs_lead_status || '').toUpperCase();
  const currentSub = String(props.hw_lead_substatus || '');
  const currentIdx = rail.findIndex(e => String(e.value).toUpperCase() === currentLs);

  let resolvedFocused = focusedLeadStatus;
  if (!resolvedFocused || !rail.find(e => e.value === resolvedFocused)) {
    resolvedFocused = currentIdx !== -1 ? rail[currentIdx].value : rail[0].value;
  }
  const focusedIdx   = rail.findIndex(e => e.value === resolvedFocused);
  const focusedEntry = rail[focusedIdx];
  const focusedColour = STAGE_COLOURS[focusedIdx % STAGE_COLOURS.length] || STAGE_COLOURS[0];

  const isFocusedCurrent = focusedIdx === currentIdx;
  const isFocusedPast    = currentIdx !== -1 && focusedIdx < currentIdx;
  const isFocusedFuture  = currentIdx === -1 || focusedIdx > currentIdx;

  const focusedSubs = leadSubstatuses
    .filter(s => String(s.status_key).toUpperCase() === String(resolvedFocused).toUpperCase())
    .slice()
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

  const focusPrefix  = `${String(resolvedFocused).toUpperCase()}__`;
  const tickedSubKey = isFocusedCurrent && currentSub.toUpperCase().startsWith(focusPrefix)
    ? currentSub.slice(focusPrefix.length).toUpperCase()
    : '';

  const hasPrev = focusedIdx > 0;
  const hasNext = focusedIdx < rail.length - 1;

  const navBtnSx = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 32,
    height: 32,
    borderRadius: 'var(--radius-md)',
    border: '1px solid var(--stone)',
    bgcolor: '#fff',
    color: 'var(--ink-2)',
    cursor: 'pointer',
    flexShrink: 0,
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 0.1s, border-color 0.1s, opacity 0.1s',
    p: 0,
    '&:hover:not(:disabled)': { bgcolor: 'var(--paper-deep)', borderColor: 'var(--stone-deep)' },
    '&:active:not(:disabled)': { bgcolor: 'var(--paper-deep)' },
    '&:disabled': { opacity: 0.3, cursor: 'default' },
  } as const;

  return (
    <Box id="workflow-stages" sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* tracker: rail + panel side by side */}
      <Box sx={{
        display: 'flex',
        alignItems: 'stretch',
        gap: 2,
        mb: '12px',
        '@media (max-width: 640px)': { flexDirection: 'column', gap: '12px' },
      }}>

        {/* rail: vertical list of lead-status steps */}
        <Box
          role="list"
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            flex: '0 0 200px',
            minWidth: 0,
            p: '6px 4px',
            bgcolor: 'var(--paper)',
            border: '1px solid var(--stone)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-sm)',
            '@media (max-width: 640px)': { flex: '0 0 auto' },
          }}
        >
          {rail.map((entry, i) => {
            const colour    = STAGE_COLOURS[i % STAGE_COLOURS.length] || STAGE_COLOURS[0];
            const isCurrent = i === currentIdx;
            const isPast    = currentIdx !== -1 && i < currentIdx;
            const isFocused = entry.value === resolvedFocused;

            let badge: React.ReactNode;
            if (isPast) {
              badge = (
                <Box sx={{
                  flexShrink: 0, width: 26, height: 26, borderRadius: '50%',
                  border: '2px solid', borderColor: colour.bg, bgcolor: colour.bg,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.75rem', fontWeight: 700, lineHeight: 1,
                }}>
                  <svg width="11" height="9" fill="none" stroke="#fff" viewBox="0 0 12 10" aria-hidden="true">
                    <polyline points="1,5 4.5,8.5 11,1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </Box>
              );
            } else if (isCurrent) {
              badge = (
                <Box sx={{
                  flexShrink: 0, width: 26, height: 26, borderRadius: '50%',
                  border: '2px solid', borderColor: colour.bg, bgcolor: colour.bg, color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.75rem', fontWeight: 700, lineHeight: 1,
                }}>
                  {i + 1}
                </Box>
              );
            } else {
              badge = (
                <Box sx={{
                  flexShrink: 0, width: 26, height: 26, borderRadius: '50%',
                  border: '2px solid var(--stone)', bgcolor: 'var(--paper)', color: 'var(--ink-4)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.75rem', fontWeight: 700, lineHeight: 1,
                }}>
                  {i + 1}
                </Box>
              );
            }

            const labelColor  = isCurrent ? colour.text : isPast ? 'var(--ink-2)' : 'var(--ink-3)';
            const labelWeight = isCurrent ? 700 : isPast ? 600 : 500;

            return (
              <Box
                key={entry.value}
                role="listitem"
                data-ls-rail-item
                data-ls-key={entry.value}
                data-action="setFocusedLeadStatus"
                data-value={entry.value}
                data-ls-current={isCurrent || undefined}
                data-ls-past={isPast || undefined}
                data-ls-focused={isFocused || undefined}
                title={entry.label}
                onClick={() => onFocusChange(entry.value)}
                sx={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  p: '8px 10px', borderRadius: 'var(--radius-md)',
                  cursor: 'pointer', position: 'relative',
                  WebkitTapHighlightColor: 'transparent',
                  transition: 'background 0.12s', minWidth: 0,
                  bgcolor: isFocused ? colour.light : 'transparent',
                  boxShadow: isFocused ? `inset 3px 0 0 ${colour.bg}` : 'none',
                  '&:hover': { bgcolor: isFocused ? colour.light : 'var(--paper-deep)' },
                }}
              >
                {badge}
                <Box
                  component="span"
                  data-ls-rail-label
                  sx={{ fontSize: '0.82rem', lineHeight: 1.25, minWidth: 0, wordBreak: 'break-word', color: labelColor, fontWeight: labelWeight }}
                >
                  {entry.label}
                </Box>
              </Box>
            );
          })}
        </Box>

        {/* detail panel for the focused stage */}
        {focusedEntry && (
          <Box sx={{
            flex: 1, minWidth: 0,
            bgcolor: 'var(--paper)',
            border: '1px solid var(--stone)',
            borderTop: `3px solid ${focusedColour.bg}`,
            borderRadius: 'var(--radius-lg)',
            overflow: 'hidden',
            boxShadow: 'var(--shadow-sm)',
            display: 'flex', flexDirection: 'column',
          }}>

            {/* panel header */}
            <Box sx={{ display: 'flex', flexDirection: 'column', borderBottom: '1px solid var(--stone-light)' }}>
              <Box sx={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: '12px', p: '14px 16px 12px',
              }}>
                {/* title block */}
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography sx={{
                    fontSize: '1rem', fontWeight: 700, lineHeight: 1.2,
                    color: isFocusedFuture ? 'var(--ink-3)' : focusedColour.text,
                  }}>
                    {focusedEntry.label}
                  </Typography>
                  <Box sx={{ mt: '3px', display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
                    {isFocusedCurrent && (
                      <Typography component="span" sx={{ fontSize: '0.72rem', color: 'var(--ink-4)', mt: '2px' }}>
                        Current stage
                      </Typography>
                    )}
                    {isFocusedPast && (
                      <Typography component="span" sx={{ fontSize: '0.72rem', color: 'var(--ink-4)', mt: '2px' }}>
                        Completed
                      </Typography>
                    )}
                    {isFocusedFuture && (
                      <Typography component="span" sx={{ fontSize: '0.72rem', color: 'var(--ink-4)', mt: '2px' }}>
                        Upcoming
                      </Typography>
                    )}
                  </Box>
                </Box>

                {/* prev / next nav */}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                  <Box
                    component="button"
                    disabled={!hasPrev}
                    data-action="focusPrevLeadStatus"
                    title="Previous stage"
                    onClick={() => { if (hasPrev) onFocusChange(rail[focusedIdx - 1].value); }}
                    sx={navBtnSx}
                  >
                    <ChevronLeftIcon sx={{ fontSize: 16 }} />
                  </Box>
                  <Box
                    component="button"
                    disabled={!hasNext}
                    data-action="focusNextLeadStatus"
                    title="Next stage"
                    onClick={() => { if (hasNext) onFocusChange(rail[focusedIdx + 1].value); }}
                    sx={navBtnSx}
                  >
                    <ChevronRightIcon sx={{ fontSize: 16 }} />
                  </Box>
                </Box>
              </Box>
            </Box>

            {/* sub-status list */}
            <Box sx={{ borderTop: '1px solid var(--stone)', p: '4px 0' }}>
              {focusedSubs.length === 0 ? (
                <Typography sx={{ p: '18px 16px', fontSize: '0.82rem', color: 'var(--ink-4)', fontStyle: 'italic' }}>
                  No sub-statuses configured for this stage.
                </Typography>
              ) : (
                focusedSubs.map(s => {
                  const subKey = String(s.substatus_key).toUpperCase();
                  const done   = subKey === tickedSubKey;

                  return (
                    <Box
                      key={s.substatus_key}
                      data-substatus-key={subKey}
                      data-ls-done={done || undefined}
                      data-action={canEdit ? 'setLeadSubstatusChecked' : undefined}
                      data-status-value={resolvedFocused ?? ''}
                      data-checked={canEdit ? String(!done) : undefined}
                      onClick={canEdit ? () => onSubstatusChange(resolvedFocused!, subKey, !done) : undefined}
                      sx={{
                        display: 'flex', alignItems: 'flex-start', gap: '12px',
                        width: '100%', p: '12px 16px', minHeight: 48,
                        cursor: canEdit ? 'pointer' : 'default',
                        pointerEvents: canEdit ? 'auto' : 'none',
                        WebkitTapHighlightColor: 'transparent',
                        transition: 'background 0.1s',
                        opacity: done ? 0.6 : 1,
                        '&:hover': { bgcolor: canEdit ? 'var(--paper-deep)' : 'transparent' },
                        '&:active': { bgcolor: canEdit ? 'var(--paper-deep)' : 'transparent' },
                      }}
                    >
                      {/* checkbox indicator */}
                      <Box sx={{
                        width: 18, height: 18,
                        borderRadius: 'var(--radius-sm)',
                        border: '2px solid',
                        borderColor: done ? 'transparent' : 'var(--stone-deep)',
                        bgcolor: done ? focusedColour.bg : 'transparent',
                        flexShrink: 0, mt: '2px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'background 0.15s, border-color 0.15s',
                      }}>
                        {done && (
                          <svg width="10" height="8" fill="none" stroke="#fff" viewBox="0 0 12 10" aria-hidden="true">
                            <polyline points="1,5 4.5,8.5 11,1" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </Box>

                      {/* label */}
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                        <Typography
                          component="span"
                          data-ls-status-label
                          sx={{
                            fontSize: '0.875rem',
                            color: done ? 'var(--ink-4)' : 'var(--ink-2)',
                            lineHeight: 1.4,
                            textDecoration: done ? 'line-through' : 'none',
                          }}
                        >
                          {s.label}
                        </Typography>
                      </Box>
                    </Box>
                  );
                })
              )}
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}
