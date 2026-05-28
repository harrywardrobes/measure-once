import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import { type Step1Data, type CatalogueItem } from './DesignVisitStep1';
import { type RoomData } from './DesignVisitRoomsStep';

export interface DesignVisitStep3Props {
  step1Data: Step1Data;
  rooms: RoomData[];
  handles: CatalogueItem[];
  furnitureRanges: CatalogueItem[];
  doorStyles: CatalogueItem[];
  termsText: string;
  termsVersionNumber?: number | null;
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: '.88rem',
        py: '5px',
        borderBottom: '1px solid #f3f4f6',
        '&:last-child': { borderBottom: 'none' },
      }}
    >
      <Typography component="span" sx={{ fontWeight: 600, color: '#6b7280', fontSize: 'inherit' }/* hex-color-ok: pre-existing raw hex */}>
        {label}
      </Typography>
      <Typography component="span" sx={{ color: '#1f2937', fontSize: 'inherit', textAlign: 'right', ml: 2 }/* hex-color-ok: pre-existing raw hex */}>
        {value}
      </Typography>
    </Box>
  );
}

function ReviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: '18px' }}>
      <Typography
        sx={{
          fontSize: '.7rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: '#9ca3af', // hex-color-ok: pre-existing raw hex
          mb: '8px',
        }}
      >
        {title}
      </Typography>
      {children}
    </Box>
  );
}

export function DesignVisitStep3({
  step1Data,
  rooms,
  handles,
  furnitureRanges,
  doorStyles,
  termsText,
  termsVersionNumber,
}: DesignVisitStep3Props) {
  const handleName =
    handles.find(h => String(h.id) === String(step1Data.handleId))?.name || '—';
  const furnitureName =
    furnitureRanges.find(f => String(f.id) === String(step1Data.furnitureRangeId))?.name || '—';

  let grandTotal = 0;
  const roomRowData = rooms.map(r => {
    const dsName =
      doorStyles.find(d => String(d.id) === String(r.doorStyleId))?.name || '—';
    const tot = r.unitCount * r.unitPricePence;
    grandTotal += tot;
    return { ...r, dsName, tot };
  });

  const visitDateDisplay = step1Data.visitDate
    ? new Date(step1Data.visitDate).toLocaleString()
    : null;

  return (
    <Box>
      <ReviewSection title="Visit details">
        {visitDateDisplay && <ReviewRow label="Date" value={visitDateDisplay} />}
        <ReviewRow label="Duration" value={`${step1Data.duration} min`} />
        {step1Data.location && <ReviewRow label="Location" value={step1Data.location} />}
        {step1Data.designerName && <ReviewRow label="Designer" value={step1Data.designerName} />}
        {handles.length > 0 && <ReviewRow label="Handle" value={handleName} />}
        {furnitureRanges.length > 0 && <ReviewRow label="Furniture range" value={furnitureName} />}
      </ReviewSection>

      <ReviewSection title="Room breakdown">
        {roomRowData.map((r, idx) => (
          <Box
            key={idx}
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '.88rem',
              py: '5px',
              borderBottom: '1px solid #f3f4f6',
            }}
          >
            <Box>
              <Typography
                component="span"
                sx={{ fontWeight: 700, fontSize: 'inherit', color: '#1f2937' }} // hex-color-ok: pre-existing raw hex
              >
                {r.roomName}
              </Typography>{' '}
              <Typography
                component="span"
                sx={{ fontWeight: 400, color: '#9ca3af', fontSize: 'inherit' }} // hex-color-ok: pre-existing raw hex
              >
                ({r.dsName}, {r.unitCount} unit{r.unitCount !== 1 ? 's' : ''})
              </Typography>
            </Box>
            <Typography
              component="span"
              sx={{ fontSize: 'inherit', color: '#1f2937', ml: 2 }} // hex-color-ok: pre-existing raw hex
            >
              £{(r.tot / 100).toFixed(2)}
            </Typography>
          </Box>
        ))}
        <Typography
          sx={{
            fontSize: '1rem',
            fontWeight: 700,
            textAlign: 'right',
            pt: '10px',
            color: '#1f2937', // hex-color-ok: pre-existing raw hex
          }}
        >
          Estimate total: £{(grandTotal / 100).toFixed(2)}
        </Typography>
      </ReviewSection>

      {termsText && (
        <ReviewSection title="Terms &amp; Conditions">
          <ReviewRow
            label="Accepted"
            value={
              <Box
                component="span"
                sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: '#059669' }} // hex-color-ok: pre-existing raw hex
              >
                <CheckIcon sx={{ fontSize: '1rem' }} />
                {termsVersionNumber != null && (
                  <Box
                    component="span"
                    sx={{
                      display: 'inline-block',
                      px: '7px',
                      py: '1px',
                      borderRadius: '999px',
                      background: '#e5e7eb', // hex-color-ok: pre-existing raw hex
                      color: '#374151', // hex-color-ok: pre-existing raw hex
                      fontSize: '.7rem',
                      fontWeight: 700,
                    }}
                  >
                    v{termsVersionNumber}
                  </Box>
                )}
              </Box>
            }
          />
        </ReviewSection>
      )}
    </Box>
  );
}

export default DesignVisitStep3;
