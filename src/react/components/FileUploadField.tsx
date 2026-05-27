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
import FolderOpenIcon from '@mui/icons-material/FolderOpen';

export interface FileUploadFieldProps {
  label: string;
  accept?: string;
  multiple?: boolean;
  onChange?: (files: FileList | null) => void;
  value?: string;
  helperText?: React.ReactNode;
  error?: boolean;
  disabled?: boolean;
  uploading?: boolean;
  progress?: number;
}

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
}: FileUploadFieldProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [displayValue, setDisplayValue] = useState<string>(value ?? '');
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  const isImageAccept = (accept ?? '').toLowerCase().includes('image');
  const isDisabled = disabled || uploading;

  useEffect(() => {
    setDisplayValue(value ?? '');
  }, [value]);

  useEffect(() => {
    return () => {
      previewUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [previewUrls]);

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

  const hasProgress = uploading && progress !== undefined;

  return (
    <FormControl fullWidth error={error} disabled={isDisabled}>
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
            {uploading ? (
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
      {uploading && (
        <LinearProgress
          variant={hasProgress ? 'determinate' : 'indeterminate'}
          value={hasProgress ? progress : undefined}
          sx={{ mt: 0.5, borderRadius: 1 }}
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
