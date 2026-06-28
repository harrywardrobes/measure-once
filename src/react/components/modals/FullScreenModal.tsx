import React from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useTheme } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';

export interface FullScreenModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /**
   * Called when the user dismisses the modal (× button, Escape, or backdrop
   * click). Ignored entirely while `disableClose` is true.
   */
  onClose: () => void;
  /** Header title — a plain string (rendered as a heading) or a custom node. */
  title?: React.ReactNode;
  /** Optional node rendered in the header between the title and the × button. */
  headerActions?: React.ReactNode;
  /** Optional sticky footer (typically primary/secondary action buttons). */
  footer?: React.ReactNode;
  /**
   * Blocks the × button, Escape key, and backdrop click while an action is in
   * flight so the user can't dismiss a half-finished submit.
   */
  disableClose?: boolean;
  /** Vertically centre short content in the scroll region (e.g. confirms). */
  centerContent?: boolean;
  /** Scrollable body content. */
  children?: React.ReactNode;
  /** Applied to the dialog paper element for tests/automation. */
  'data-testid'?: string;
  /** Accessible label used when `title` is not a plain string. */
  ariaLabel?: string;
}

/**
 * Unified overlay shell for the React island.
 *
 * - Mobile / tablet (< md): edge-to-edge full screen.
 * - Desktop (>= md): a large centred panel (`min(960px, 92vw)` × `92vh`) using
 *   MUI's default Fade transition.
 *
 * Provides a consistent header (title + optional actions + close ×), a
 * scrollable body, and an optional sticky footer. Preserves MUI accessibility
 * (role="dialog", aria-labelledby, focus trap, Escape-to-close).
 */
export function FullScreenModal({
  open,
  onClose,
  title,
  headerActions,
  footer,
  disableClose,
  centerContent,
  children,
  'data-testid': dataTestId,
  ariaLabel,
}: FullScreenModalProps) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('md'));
  const titleId = React.useId();

  const handleDialogClose = React.useCallback(() => {
    if (disableClose) return;
    onClose();
  }, [disableClose, onClose]);

  return (
    <Dialog
      open={open}
      onClose={handleDialogClose}
      fullScreen={fullScreen}
      maxWidth={false}
      aria-labelledby={title ? titleId : undefined}
      aria-label={!title ? ariaLabel : undefined}
      slotProps={{
        paper: {
          ...(dataTestId
            ? {
                ref: (el: HTMLElement | null) => {
                  if (el) el.setAttribute('data-testid', dataTestId);
                },
              }
            : {}),
          sx: {
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            ...(fullScreen
              ? {}
              : {
                  width: 'min(960px, 92vw)',
                  height: '92vh',
                  maxWidth: 'none',
                  borderRadius: 2,
                }),
          },
        },
      }}
    >
      {/* Header — on mobile fullscreen the top padding expands to clear the
          Dynamic Island / notch so the title and × button are always reachable. */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          px: 3,
          pt: fullScreen ? 'max(16px, env(safe-area-inset-top))' : 2,
          pb: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          flexShrink: 0,
        }}
      >
        <Box id={titleId} sx={{ flex: 1, minWidth: 0 }}>
          {typeof title === 'string' ? (
            <Typography variant="h4" component="h2" sx={{ wordBreak: 'break-word' }}>
              {title}
            </Typography>
          ) : (
            title
          )}
        </Box>
        {headerActions}
        <IconButton
          onClick={onClose}
          disabled={disableClose}
          aria-label="Close"
          size="small"
          sx={{ flexShrink: 0 }}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* Body — when fullscreen with no footer, expand bottom padding to clear
          the home-indicator / gesture bar. */}
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          px: 3,
          pt: 2.5,
          pb: fullScreen && !footer ? 'max(20px, env(safe-area-inset-bottom))' : 2.5,
          ...(centerContent
            ? { display: 'flex', flexDirection: 'column', justifyContent: 'center' }
            : {}),
        }}
      >
        {children}
      </Box>

      {/* Footer — bottom padding clears the home-indicator zone on fullscreen. */}
      {footer && (
        <Box
          sx={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 1,
            px: 3,
            pt: 2,
            pb: fullScreen ? 'max(16px, env(safe-area-inset-bottom))' : 2,
            borderTop: '1px solid',
            borderColor: 'divider',
          }}
        >
          {footer}
        </Box>
      )}
    </Dialog>
  );
}

export default FullScreenModal;
