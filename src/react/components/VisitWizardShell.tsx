import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { BRAND_COLORS } from '../theme';
import { FullScreenModal } from './modals/FullScreenModal';
import { ModalContactHeader } from './modals/ModalContactHeader';

/** Step progress bar shown at the top of the wizard body. */
function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <Box sx={{ display: 'flex', gap: '6px', mb: '20px' }}>
      {Array.from({ length: total }, (_, i) => (
        <Box
          key={i}
          sx={{
            flex: 1,
            height: '4px',
            borderRadius: '2px',
            background: i + 1 <= current ? BRAND_COLORS.orchid : 'var(--neutral-200)',
            transition: 'background .2s',
          }}
        />
      ))}
    </Box>
  );
}

export interface VisitWizardShellProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  headerActions?: React.ReactNode;
  /**
   * Footer content (typically the Back/Next/Submit buttons). Hidden while
   * `loading` is true so the user can't navigate before data is ready.
   */
  footer?: React.ReactNode;
  /** Contact name shown in the modal header strip. */
  contactName?: string;
  /** Contact email shown in the modal header strip. */
  contactEmail?: string;
  /** When true, shows the contact-header skeleton + a body spinner. */
  loading?: boolean;
  /** When true, shows a dismissible "Restoring your draft" notice. */
  draftNotice?: boolean;
  onDismissDraftNotice?: () => void;
  /** 1-based index of the current step. */
  step: number;
  /** Total number of steps (controls the progress bar). */
  totalSteps: number;
  /** Caption under the progress bar, e.g. "Step 1 of 3 — Visit details". */
  stepLabel: string;
  /** Current step's body content. */
  children: React.ReactNode;
}

/**
 * Reusable multi-step visit wizard scaffold.
 *
 * Owns the consistent chrome shared by every visit type: the full-screen
 * modal, contact header strip, draft-restore notice, loading spinner, step
 * progress bar, and step caption. The host wizard supplies the per-step body
 * (`children`) and footer navigation. Extracted from the Design Visit wizard so
 * future visit types (e.g. Survey) reuse the same shell.
 */
export function VisitWizardShell({
  open,
  onClose,
  title,
  headerActions,
  footer,
  contactName,
  contactEmail,
  loading,
  draftNotice,
  onDismissDraftNotice,
  step,
  totalSteps,
  stepLabel,
  children,
}: VisitWizardShellProps) {
  return (
    <FullScreenModal
      open={open}
      onClose={onClose}
      title={title}
      headerActions={headerActions}
      footer={loading ? undefined : footer}
    >
      <ModalContactHeader name={contactName} email={contactEmail} loading={loading} />
      {draftNotice && (
        <Alert
          severity="info"
          onClose={onDismissDraftNotice}
          sx={{ mb: '16px', fontSize: '.82rem' }}
        >
          Restoring your draft from last time.
        </Alert>
      )}
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', pt: 4 }}>
          <CircularProgress size={28} />
        </Box>
      ) : (
        <>
          <StepIndicator current={step} total={totalSteps} />
          <Typography sx={{ fontSize: '.82rem', color: 'var(--neutral-500)', mb: '16px' }}>
            {stepLabel}
          </Typography>
          {children}
        </>
      )}
    </FullScreenModal>
  );
}

export default VisitWizardShell;
