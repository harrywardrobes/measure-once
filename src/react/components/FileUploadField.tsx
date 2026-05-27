import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
import LinearProgress from '@mui/material/LinearProgress';
import OutlinedInput from '@mui/material/OutlinedInput';
import Typography from '@mui/material/Typography';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';

export type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

export interface FileUploadFieldProps {
  label: string;
  accept?: string;
  multiple?: boolean;
  onChange?: (files: FileList | null) => void;
  value?: string;
  helperText?: React.ReactNode;
  error?: boolean;
  disabled?: boolean;
  /** @deprecated Use uploadStatus instead */
  uploading?: boolean;
  progress?: number;
  /**
   * First-class upload lifecycle state.
   * - 'idle'      — no upload in progress (default)
   * - 'uploading' — upload in progress; shows spinner / progress bar
   * - 'success'   — upload completed successfully; shows green checkmark
   * - 'error'     — upload failed; shows red error icon
   *
   * When provided, `uploadStatus` takes precedence over the legacy `uploading` prop.
   */
  uploadStatus?: UploadStatus;
  /**
   * When set (milliseconds), the field automatically returns to the 'idle'
   * appearance after a 'success' or 'error' outcome and fires `onStatusReset`
   * so the caller can sync its own state.  The reset timer starts as soon as
   * the terminal status is first observed.
   */
  resetDelay?: number;
  /**
   * Called once, after `resetDelay` ms, whenever `uploadStatus` settles on
   * 'success' or 'error'.  Use this to set your own `uploadStatus` state back
   * to `'idle'` so the Browse button reappears and the user can pick another
   * file without any extra UI.
   */
  onStatusReset?: () => void;
}

const PROGRESS_FADE_MS = 1200;

export function FileUploadField({
  label,
  accept,
  multiple = false,
  onChange,
  value,
  helperText,
  error = false,
  disabled = false,
  uploading = false,
  progress,
  uploadStatus,
  resetDelay,
  onStatusReset,
}: FileUploadFieldProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [displayValue, setDisplayValue] = useState<string>(value ?? '');
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [progressVisible, setProgressVisible] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localStatus, setLocalStatus] = useState<UploadStatus | null>(null);

  const resolvedStatus: UploadStatus =
    uploadStatus ?? (uploading ? 'uploading' : 'idle');
  const effectiveStatus: UploadStatus = localStatus ?? resolvedStatus;

  const isUploading = effectiveStatus === 'uploading';
  const isSuccess = effectiveStatus === 'success';
  const isError = effectiveStatus === 'error';
  const isDone = isSuccess || isError;

  const isImageAccept = (accept ?? '').toLowerCase().includes('image');
  const isDisabled = disabled || isUploading;

  useEffect(() => {
    setDisplayValue(value ?? '');
  }, [value]);

  useEffect(() => {
    return () => {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [previewUrls]);

  useEffect(() => {
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);

    if (isUploading) {
      setProgressVisible(true);
    } else if (isDone) {
      setProgressVisible(true);
      fadeTimerRef.current = setTimeout(() => {
        setProgressVisible(false);
      }, PROGRESS_FADE_MS);
    } else {
      setProgressVisible(false);
    }

    return () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [isUploading, isDone]);

  const isResolvedDone = resolvedStatus === 'success' || resolvedStatus === 'error';

  useEffect(() => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);

    if (isResolvedDone && resetDelay !== undefined) {
      resetTimerRef.current = setTimeout(() => {
        setLocalStatus('idle');
        onStatusReset?.();
      }, resetDelay);
    } else {
      setLocalStatus(null);
    }

    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, [isResolvedDone, resetDelay, onStatusReset]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || files.length === 0) {
      setDisplayValue('');
      setPreviewUrls([]);
      onChange?.(null);
      return;
    }

    const names = Array.from(files)
      .map((f) => f.name)
      .join(', ');
    setDisplayValue(names);

    if (isImageAccept) {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
      const urls = Array.from(files).map((f) => URL.createObjectURL(f));
      setPreviewUrls(urls);
    }

    onChange?.(files);
  }

  function openPicker() {
    if (!isDisabled) fileInputRef.current?.click();
  }

  const hasProgress = isUploading && progress !== undefined;

  const adornmentBgColor = isSuccess
    ? 'success.main'
    : isError
    ? 'error.main'
    : 'action.disabledBackground';

  const progressColor = isSuccess ? 'success' : isError ? 'error' : 'primary';

  return (
    <FormControl fullWidth error={error || isError} disabled={isDisabled}>
      <InputLabel htmlFor={undefined}>{label}</InputLabel>
      <OutlinedInput
        label={label}
        value={displayValue}
        readOnly
        placeholder="No file chosen"
        onClick={openPicker}
        sx={{ cursor: isDisabled ? 'default' : 'pointer', pr: 0 }}
        inputProps={{ style: { cursor: isDisabled ? 'default' : 'pointer' } }}
        endAdornment={
          <InputAdornment position="end" sx={{ mr: 0 }}>
            {isUploading ? (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '0 6px 6px 0',
                  height: '100%',
                  px: 2,
                  minWidth: 80,
                  bgcolor: 'action.disabledBackground',
                }}
              >
                <CircularProgress
                  size={18}
                  thickness={4}
                  variant={hasProgress ? 'determinate' : 'indeterminate'}
                  value={hasProgress ? progress : undefined}
                  color="inherit"
                />
              </Box>
            ) : isDone ? (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '0 6px 6px 0',
                  height: '100%',
                  px: 2,
                  minWidth: 80,
                  bgcolor: adornmentBgColor,
                  color: 'common.white',
                  transition: 'background-color 0.3s ease',
                }}
                aria-label={isSuccess ? 'Upload successful' : 'Upload failed'}
              >
                {isSuccess ? (
                  <CheckCircleIcon fontSize="small" />
                ) : (
                  <ErrorIcon fontSize="small" />
                )}
              </Box>
            ) : (
              <Button
                component="span"
                variant="contained"
                size="small"
                disabled={isDisabled}
                onClick={(e) => { e.stopPropagation(); openPicker(); }}
                startIcon={<FolderOpenIcon fontSize="small" />}
                sx={{
                  borderRadius: '0 6px 6px 0',
                  height: '100%',
                  px: 2,
                  boxShadow: 'none',
                  '&:hover': { boxShadow: 'none' },
                }}
              >
                Browse
              </Button>
            )}
          </InputAdornment>
        }
      />
      {progressVisible && (
        <LinearProgress
          variant={isUploading && hasProgress ? 'determinate' : isUploading ? 'indeterminate' : 'determinate'}
          value={isUploading && hasProgress ? progress : 100}
          color={progressColor as 'primary' | 'success' | 'error'}
          sx={{
            mt: 0.5,
            borderRadius: 1,
            opacity: isDone ? 0 : 1,
            transition: isDone ? `opacity ${PROGRESS_FADE_MS}ms ease` : 'none',
          }}
        />
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
        style={{ display: 'none' }}
        tabIndex={-1}
        aria-hidden="true"
      />
      {helperText && <FormHelperText>{helperText}</FormHelperText>}
      {isImageAccept && previewUrls.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
          {previewUrls.map((url, i) => (
            <Box
              key={url}
              component="img"
              src={url}
              alt={`Preview ${i + 1}`}
              sx={{
                width: 72,
                height: 72,
                objectFit: 'cover',
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
              }}
            />
          ))}
          <Typography
            variant="caption"
            sx={{ alignSelf: 'flex-end', color: 'text.secondary' }}
          >
            {previewUrls.length} image{previewUrls.length !== 1 ? 's' : ''} selected
          </Typography>
        </Box>
      )}
    </FormControl>
  );
}

export default FileUploadField;
