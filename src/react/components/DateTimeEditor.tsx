import React from 'react';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Typography from '@mui/material/Typography';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import { renderDigitalClockTimeView } from '@mui/x-date-pickers/timeViewRenderers';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import type { Dayjs } from 'dayjs';

export interface DateTimeEditorProps {
  value: Dayjs | null;
  onChange: (v: Dayjs | null) => void;
  showTime?: boolean;
  label?: string;
  disablePast?: boolean;
  disabled?: boolean;
  required?: boolean;
  id?: string;
}

const pickerSx = {
  flex: 1,
  minWidth: 0,
  '& .MuiOutlinedInput-notchedOutline': { border: 'none' },
  '& .MuiInputBase-root': {
    borderRadius: 0,
    bgcolor: 'transparent',
    '&:hover .MuiOutlinedInput-notchedOutline': { border: 'none' },
    '&.Mui-focused .MuiOutlinedInput-notchedOutline': { border: 'none' },
  },
  '& .MuiInputBase-input': { py: '7px', px: '8px', fontSize: '0.875rem' },
  '& .MuiIconButton-root': { p: '5px', mr: '2px' },
};

export function DateTimeEditor({
  value,
  onChange,
  showTime = true,
  label,
  disablePast,
  disabled,
  required,
  id,
}: DateTimeEditorProps) {
  function handleDateChange(newDate: Dayjs | null) {
    if (!newDate) { onChange(null); return; }
    if (showTime && value) {
      onChange(newDate.hour(value.hour()).minute(value.minute()).second(0).millisecond(0));
    } else {
      onChange(newDate);
    }
  }

  function handleTimeChange(newTime: Dayjs | null) {
    if (!newTime) { onChange(null); return; }
    if (value) {
      onChange(value.hour(newTime.hour()).minute(newTime.minute()).second(0).millisecond(0));
    } else {
      onChange(newTime);
    }
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Box sx={{ width: '100%' }}>
        {label && (
          <Typography
            component="label"
            htmlFor={id ? `${id}-date` : undefined}
            sx={{ display: 'block', fontSize: '0.75rem', color: 'text.secondary', mb: 0.5, lineHeight: 1.4 }}
          >
            {label}
            {required && <Box component="span" aria-hidden="true" sx={{ ml: 0.25, color: 'error.main' }}>{'*'}</Box>}
          </Typography>
        )}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            border: '1px solid',
            borderColor: disabled ? 'action.disabled' : 'divider',
            borderRadius: 1,
            overflow: 'hidden',
            bgcolor: disabled ? 'action.disabledBackground' : 'background.paper',
            transition: 'border-color 0.1s',
            '&:hover': !disabled ? { borderColor: 'text.primary' } : {},
            '&:focus-within': !disabled ? { borderColor: 'primary.main' } : {},
          }}
        >
          <DatePicker
            value={value}
            onChange={handleDateChange}
            format="DD/MM/YY"
            disablePast={disablePast}
            disabled={disabled}
            slotProps={{
              textField: {
                id: id ? `${id}-date` : undefined,
                required,
                size: 'small',
                sx: pickerSx,
              },
            }}
          />
          {showTime && (
            <>
              <Divider orientation="vertical" flexItem sx={{ my: '8px', mx: 0 }} />
              <TimePicker
                value={value}
                onChange={handleTimeChange}
                disabled={disabled}
                format="HH:mm"
                ampm={false}
                // Google-Calendar-style time selection: a single scrollable
                // list of times in 15-minute increments rather than the analog
                // clock. The text field still accepts typed HH:mm for off-grid
                // times.
                timeSteps={{ minutes: 15 }}
                viewRenderers={{
                  hours: renderDigitalClockTimeView,
                  minutes: null,
                  seconds: null,
                }}
                slotProps={{
                  textField: {
                    id: id ? `${id}-time` : undefined,
                    size: 'small',
                    sx: { ...pickerSx, flex: '0 0 auto' },
                  },
                  digitalClockItem: {
                    sx: { minHeight: 32, fontSize: '0.8125rem' },
                  },
                }}
              />
            </>
          )}
        </Box>
      </Box>
    </LocalizationProvider>
  );
}
