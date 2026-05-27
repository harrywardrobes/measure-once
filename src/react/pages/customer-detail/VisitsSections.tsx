import React, { useState, useCallback } from 'react';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import { Visit, STAGE_COLOURS, STAGE_KEYS } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';
import { DELETE as apiDELETE } from '../../utils/api';
import { DeliveryWindowModal } from '../../components/modals/DeliveryWindowModal';
import { InstallationSlotModal } from '../../components/modals/InstallationSlotModal';

const VISIT_TYPE_LABELS: Record<string, string> = {
  design:       'Design visit',
  survey:       'Survey',
  installation: 'Installation slot',
  delivery:     'Delivery window',
  remedial:     'Remedial',
  workshop:     'Workshop',
  other:        'Other',
};

function visitTypeLabel(type?: string): string {
  if (!type) return 'Visit';
  return VISIT_TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

function VisitTypeBadge({ type }: { type?: string }) {
  if (!type) return null;
  const idx = STAGE_KEYS.indexOf(type);
  const colours = idx >= 0 ? STAGE_COLOURS[idx] : null;
  const bg   = colours ? colours.light : 'var(--status-neutral-bg)';
  const text = colours ? colours.text  : 'var(--ink-3)';
  return (
    <span style={{
      display: 'inline-block',
      fontSize: '0.68rem',
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      padding: '1px 7px',
      borderRadius: 'var(--radius-sm)',
      background: bg,
      color: text,
      marginBottom: 5,
    }}>
      {visitTypeLabel(type)}
    </span>
  );
}

const sxHeader: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 };
const sxHeaderLabel: React.CSSProperties = { fontSize: '0.875rem', fontWeight: 600, color: 'var(--ink-2)' };
const sxItem: React.CSSProperties = { background: 'var(--paper)', border: '1px solid var(--stone)', borderRadius: 'var(--radius-lg)', padding: '11px 14px', boxShadow: 'var(--shadow-sm)' };
const sxMeta: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 };
const sxMetaSep: React.CSSProperties = { fontSize: '0.65rem', color: 'var(--ink-4)' };
const sxDate: React.CSSProperties = { fontSize: '0.68rem', color: 'var(--ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' };
const sxText: React.CSSProperties = { fontSize: '0.875rem', color: 'var(--ink-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' };
const sxMuted: React.CSSProperties = { fontSize: '0.875rem', fontStyle: 'italic', padding: '0 4px', color: 'var(--stone-deep)' };
const sxStack: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 };

interface Props {
  contactId: string;
  contact: { id: string; properties: { firstname?: string; lastname?: string; email?: string } };
  upcomingVisits: Visit[];
  pastVisits: Visit[];
  loadingVisits: boolean;
  onRefresh?: () => void;
}

function fmtVisitRange(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const dateStr = s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const startTime = s.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const endTime   = e.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${dateStr} · ${startTime}–${endTime}`;
}

function isEditable(type?: string): boolean {
  return type === 'delivery' || type === 'installation';
}

interface CancelDialogProps {
  visit: Visit;
  onClose: () => void;
  onConfirm: (deleteGcal: boolean) => void;
  deleting: boolean;
}

function CancelVisitDialog({ visit, onClose, onConfirm, deleting }: CancelDialogProps) {
  const hasGcal = !!visit.googleEventId;
  const [deleteGcal, setDeleteGcal] = useState(hasGcal);

  return (
    <Dialog open onClose={deleting ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle>Cancel {visitTypeLabel(visit.type)}?</DialogTitle>
      <DialogContent>
        <DialogContentText sx={{ mb: hasGcal ? 1 : 0 }}>
          This will permanently remove this {visitTypeLabel(visit.type).toLowerCase()} from the system. This cannot be undone.
        </DialogContentText>
        {hasGcal && (
          <FormControlLabel
            sx={{ mt: 1 }}
            control={
              <Checkbox
                checked={deleteGcal}
                onChange={e => setDeleteGcal(e.target.checked)}
                size="small"
                disabled={deleting}
              />
            }
            label="Also delete from my Google Calendar"
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={deleting}>Keep it</Button>
        <Button
          variant="contained"
          color="error"
          onClick={() => onConfirm(deleteGcal)}
          disabled={deleting}
          startIcon={deleting ? <CircularProgress size={14} color="inherit" /> : undefined}
          data-testid="confirm-cancel-visit"
        >
          {deleting ? 'Cancelling…' : 'Cancel visit'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function UpcomingVisitsSection({ contactId, contact, upcomingVisits, loadingVisits, onRefresh }: Omit<Props, 'pastVisits'>) {
  const { isAdmin, isManager } = usePrivilege();
  const canEdit = isAdmin || isManager;

  const [editVisit, setEditVisit] = useState<Visit | null>(null);
  const [cancelVisit, setCancelVisit] = useState<Visit | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleEditClose = useCallback(() => setEditVisit(null), []);
  const handleEditSaved = useCallback(() => {
    setEditVisit(null);
    onRefresh?.();
  }, [onRefresh]);

  const handleCancelClose = useCallback(() => {
    if (!deleting) setCancelVisit(null);
  }, [deleting]);

  const handleCancelConfirm = useCallback(async (deleteGcal: boolean) => {
    if (!cancelVisit) return;
    setDeleting(true);
    const w = window as unknown as { showToast?: (m: string, e: boolean) => void };
    try {
      await apiDELETE(`/api/visits/${cancelVisit.id}`);

      if (deleteGcal && cancelVisit.googleEventId) {
        try {
          await apiDELETE(`/api/events/${cancelVisit.googleEventId}`);
        } catch (gcalErr) {
          const msg = gcalErr instanceof Error ? gcalErr.message : 'error';
          w.showToast?.(`Visit cancelled; Google Calendar delete failed: ${msg}`, true);
          setCancelVisit(null);
          onRefresh?.();
          return;
        }
      }

      w.showToast?.(`${visitTypeLabel(cancelVisit.type)} cancelled`, false);
      setCancelVisit(null);
      onRefresh?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'error';
      w.showToast?.(`Could not cancel visit: ${msg}`, true);
    } finally {
      setDeleting(false);
    }
  }, [cancelVisit, onRefresh]);

  return (
    <div id="upcoming-visits-section" style={{ marginBottom: 20 }}>
      <div style={sxHeader}>
        <span style={sxHeaderLabel}>Upcoming visits</span>
      </div>
      {loadingVisits && <p style={sxMuted}>Loading…</p>}
      {!loadingVisits && upcomingVisits.length === 0 && (
        <p style={sxMuted}>No upcoming visits.</p>
      )}
      {!loadingVisits && upcomingVisits.length > 0 && (
        <div style={sxStack}>
          {upcomingVisits.map(v => (
            <div key={v.id} style={sxItem}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <VisitTypeBadge type={v.type} />
                  <div style={{ ...sxText, fontWeight: 500 }}>
                    {v.title || visitTypeLabel(v.type)}
                  </div>
                  <div style={sxMeta}>
                    <span style={sxDate}>{fmtVisitRange(v.startAt, v.endAt)}</span>
                    {v.location && <><span style={sxMetaSep}>·</span><span>{v.location}</span></>}
                  </div>
                </div>
                {canEdit && isEditable(v.type) && (
                  <div style={{ display: 'flex', gap: 2, flexShrink: 0, marginTop: -2 }}>
                    <Tooltip title={`Edit ${visitTypeLabel(v.type).toLowerCase()}`}>
                      <IconButton
                        size="small"
                        onClick={() => setEditVisit(v)}
                        aria-label={`Edit ${visitTypeLabel(v.type).toLowerCase()}`}
                        data-testid={`edit-visit-${v.id}`}
                      >
                        <EditIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={`Cancel ${visitTypeLabel(v.type).toLowerCase()}`}>
                      <IconButton
                        size="small"
                        color="error"
                        onClick={() => setCancelVisit(v)}
                        aria-label={`Cancel ${visitTypeLabel(v.type).toLowerCase()}`}
                        data-testid={`cancel-visit-${v.id}`}
                      >
                        <DeleteIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editVisit && editVisit.type === 'delivery' && (
        <DeliveryWindowModal
          mode="edit"
          visit={editVisit}
          open
          onClose={handleEditClose}
          onSaved={handleEditSaved}
        />
      )}

      {editVisit && editVisit.type === 'installation' && (
        <InstallationSlotModal
          mode="edit"
          visit={editVisit}
          open
          onClose={handleEditClose}
          onSaved={handleEditSaved}
        />
      )}

      {cancelVisit && (
        <CancelVisitDialog
          visit={cancelVisit}
          onClose={handleCancelClose}
          onConfirm={handleCancelConfirm}
          deleting={deleting}
        />
      )}
    </div>
  );
}

export function PastVisitsSection({ pastVisits, loadingVisits }: Pick<Props, 'pastVisits' | 'loadingVisits'>) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);
  const recent = pastVisits.slice(0, 3);
  const rest   = pastVisits.slice(3);

  return (
    <div id="past-visits-section" style={{ marginBottom: 20 }}>
      <div style={sxHeader}>
        <span style={sxHeaderLabel}>Past visits</span>
      </div>
      {loadingVisits && <p style={sxMuted}>Loading…</p>}
      {!loadingVisits && pastVisits.length === 0 && (
        <p style={sxMuted}>No past visits.</p>
      )}
      {!loadingVisits && pastVisits.length > 0 && (
        <>
          <div style={sxStack}>
            {recent.map(v => (
              <div key={v.id} style={sxItem}>
                <VisitTypeBadge type={v.type} />
                <div style={sxText}>{v.title || visitTypeLabel(v.type)}</div>
                <div style={sxMeta}>
                  <span style={sxDate}>{fmtVisitRange(v.startAt, v.endAt)}</span>
                </div>
              </div>
            ))}
            {expanded && rest.map(v => (
              <div key={v.id} style={sxItem}>
                <VisitTypeBadge type={v.type} />
                <div style={sxText}>{v.title || visitTypeLabel(v.type)}</div>
                <div style={sxMeta}>
                  <span style={sxDate}>{fmtVisitRange(v.startAt, v.endAt)}</span>
                </div>
              </div>
            ))}
          </div>
          {rest.length > 0 && (
            <button
              style={{ fontSize: '0.75rem', marginTop: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--orchid)', textDecoration: hovered ? 'underline' : 'none' }}
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
              onClick={() => setExpanded(v => !v)}
            >
              {expanded ? 'Show fewer' : `Show ${rest.length} more`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
