import React, { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import FormControl from '@mui/material/FormControl';
import FormHelperText from '@mui/material/FormHelperText';
import InputAdornment from '@mui/material/InputAdornment';
import InputLabel from '@mui/material/InputLabel';
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
}: FileUploadFieldProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [displayValue, setDisplayValue] = useState<string>(value ?? '');
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);

  const isImageAccept = (accept ?? '').toLowerCase().includes('image');

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
    if (!disabled) fileInputRef.current?.click();
  }

  return (
    <FormControl fullWidth error={error} disabled={disabled}>
      <InputLabel htmlFor={undefined}>{label}</InputLabel>
      <OutlinedInput
        label={label}
        value={displayValue}
        readOnly
        placeholder="No file chosen"
        onClick={openPicker}
        sx={{ cursor: disabled ? 'default' : 'pointer', pr: 0 }}
        inputProps={{ style: { cursor: disabled ? 'default' : 'pointer' } }}
        endAdornment={
          <InputAdornment position="end" sx={{ mr: 0 }}>
            <Button
              component="span"
              variant="contained"
              size="small"
              disabled={disabled}
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
          </InputAdornment>
        }
      />
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
