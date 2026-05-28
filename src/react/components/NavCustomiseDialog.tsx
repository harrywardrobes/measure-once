import { useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import Typography from '@mui/material/Typography';

import type { NavItem } from './BottomNav';

const BAR_SIZE = 3;

type Props = {
  open: boolean;
  onClose: () => void;
  availableItems: NavItem[];
  currentKeys: string[];
  defaultKeys: string[];
  onSave: (keys: string[]) => void;
  /**
   * When defined (admin Permissions context), indicates whether this role has
   * been explicitly customised. When true, a "Reset to default" button is
   * shown that calls onReset and closes the dialog.
   */
  isCustomized?: boolean;
  /**
   * Called when the admin clicks "Reset to default". Should call the DELETE
   * endpoint and close the dialog. Only rendered when provided.
   */
  onReset?: () => void;
};

/**
 * Dialog that lets the user choose exactly 3 tabs to pin in the main nav bar.
 * The remaining accessible tabs automatically go to the More drawer.
 *
 * `selected` is always reset from `currentKeys` when the dialog opens so that:
 * - cancelled edits are discarded on next open, and
 * - prefs loaded asynchronously after mount are reflected correctly.
 */
export function NavCustomiseDialog({ open, onClose, availableItems, currentKeys, defaultKeys, onSave, isCustomized, onReset }: Props) {
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    const validKeys = currentKeys.filter((k) => availableItems.some((n) => n.key === k));
    setSelected(validKeys.slice(0, BAR_SIZE));
  }, [open, currentKeys, availableItems]);

  function toggle(key: string) {
    setSelected((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= BAR_SIZE) return prev;
      return [...prev, key];
    });
  }

  function handleReset() {
    const validDefaults = defaultKeys.filter((k) => availableItems.some((n) => n.key === k));
    setSelected(validDefaults.slice(0, BAR_SIZE));
  }

  function handleSave() {
    if (selected.length !== BAR_SIZE) return;
    onSave(selected);
    onClose();
  }

  const atLimit = selected.length >= BAR_SIZE;

  const defaultSet = new Set(defaultKeys);
  const isAtDefaults =
    selected.length === defaultKeys.length &&
    selected.every((k) => defaultSet.has(k));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="xs"
      slotProps={{ paper: { sx: { borderRadius: 3 } } }}
    >
      <DialogTitle sx={{ pb: 0.5 }}>Customise navigation</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Choose exactly {BAR_SIZE} tabs to show in the main bar. The rest will appear in the More
          drawer.
        </Typography>
        <FormGroup>
          {availableItems.map((n) => {
            const checked = selected.includes(n.key);
            return (
              <FormControlLabel
                key={n.key}
                control={
                  <Checkbox
                    checked={checked}
                    disabled={!checked && atLimit}
                    onChange={() => toggle(n.key)}
                    size="small"
                  />
                }
                label={n.label}
              />
            );
          })}
        </FormGroup>
        {atLimit && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            {BAR_SIZE} selected — uncheck one to change your selection.
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {onReset ? (
          <Button
            onClick={onReset}
            color="inherit"
            disabled={!isCustomized}
            sx={{ mr: 'auto' }}
            title={isCustomized ? 'Clear custom layout and inherit default' : 'Already using default'}
          >
            Reset to default
          </Button>
        ) : (
          <Button onClick={handleReset} color="inherit" disabled={isAtDefaults} sx={{ mr: 'auto' }}>
            Reset to defaults
          </Button>
        )}
        <Button onClick={onClose} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={selected.length !== BAR_SIZE}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
