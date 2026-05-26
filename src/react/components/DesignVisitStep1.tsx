import React, { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

export interface Step1Data {
  visitDate: string;
  duration: string;
  location: string;
  designerName: string;
  handleId: string;
  furnitureRangeId: string;
  termsAccepted: boolean;
}

export interface CatalogueItem {
  id: string | number;
  name: string;
}

export interface DesignVisitStep1Props {
  initialData: Step1Data;
  handles: CatalogueItem[];
  furnitureRanges: CatalogueItem[];
  termsText: string;
  termsVersionNumber?: number | null;
  onDataChange: (data: Step1Data) => void;
}

export function DesignVisitStep1({
  initialData,
  handles,
  furnitureRanges,
  termsText,
  onDataChange,
}: DesignVisitStep1Props) {
  const [data, setData] = useState<Step1Data>({ ...initialData });

  const onDataChangeRef = useRef(onDataChange);
  useEffect(() => { onDataChangeRef.current = onDataChange; }, [onDataChange]);

  const update = useCallback((patch: Partial<Step1Data>) => {
    setData(prev => {
      const next = { ...prev, ...patch };
      onDataChangeRef.current(next);
      return next;
    });
  }, []);

  return (
    <Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', mb: 1.5 }}>
        <TextField
          label="Visit date & time"
          type="datetime-local"
          size="small"
          fullWidth
          value={data.visitDate}
          onChange={e => update({ visitDate: e.target.value })}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <TextField
          label="Duration (minutes)"
          type="number"
          size="small"
          fullWidth
          slotProps={{ htmlInput: { min: 15, max: 1440, step: 15 } }}
          value={data.duration}
          onChange={e => update({ duration: e.target.value })}
        />
      </Box>

      <TextField
        label="Location"
        size="small"
        fullWidth
        placeholder="e.g. 12 Baker Street, London"
        value={data.location}
        onChange={e => update({ location: e.target.value })}
        sx={{ mb: 1.5 }}
      />

      <TextField
        label="Designer name"
        size="small"
        fullWidth
        placeholder="e.g. Sarah Jones"
        slotProps={{ htmlInput: { maxLength: 200 } }}
        value={data.designerName}
        onChange={e => update({ designerName: e.target.value })}
        sx={{ mb: 1.5 }}
      />

      {handles.length > 0 && (
        <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
          <InputLabel>Handle selection</InputLabel>
          <Select
            label="Handle selection"
            value={data.handleId ? String(data.handleId) : ''}
            onChange={e => update({ handleId: e.target.value })}
          >
            <MenuItem value="">— select handle —</MenuItem>
            {handles.map(h => (
              <MenuItem key={h.id} value={String(h.id)}>{h.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      {furnitureRanges.length > 0 && (
        <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
          <InputLabel>Furniture range</InputLabel>
          <Select
            label="Furniture range"
            value={data.furnitureRangeId ? String(data.furnitureRangeId) : ''}
            onChange={e => update({ furnitureRangeId: e.target.value })}
          >
            <MenuItem value="">— select range —</MenuItem>
            {furnitureRanges.map(fr => (
              <MenuItem key={fr.id} value={String(fr.id)}>{fr.name}</MenuItem>
            ))}
          </Select>
        </FormControl>
      )}

      {termsText && (
        <>
          <Typography
            variant="caption"
            sx={{ fontWeight: 600, color: '#4b5563', display: 'block', mb: '4px', mt: '12px' }}
          >
            Terms &amp; Conditions
          </Typography>
          <Box
            sx={{
              background: '#f9fafb',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              p: '10px 12px',
              fontSize: '.78rem',
              color: '#4b5563',
              maxHeight: 120,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              mb: '6px',
              lineHeight: 1.5,
            }}
          >
            {termsText}
          </Box>
        </>
      )}

      <FormControlLabel
        control={
          <Checkbox
            checked={data.termsAccepted}
            onChange={e => update({ termsAccepted: e.target.checked })}
            size="small"
            sx={{ mt: '-2px' }}
          />
        }
        label={
          <Typography sx={{ fontSize: '.82rem', color: '#374151' }}>
            Customer has read and accepted the terms &amp; conditions
          </Typography>
        }
        sx={{ mt: '10px', alignItems: 'flex-start' }}
      />
    </Box>
  );
}

export default DesignVisitStep1;
