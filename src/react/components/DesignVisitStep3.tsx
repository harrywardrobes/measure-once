import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import CheckIcon from '@mui/icons-material/Check';
import { type Step1Data, type CatalogueItem } from './DesignVisitStep1';
import { type RoomData } from './DesignVisitRoomsStep';
import {
  isAnswered,
  type AnswerMap,
  type AnswerValue,
  type VisitQuestion,
} from './QuestionnaireRenderer';
import { formatAddress, isAddressEmpty } from '../../../shared/address';

export interface DesignVisitStep3Props {
  step1Data: Step1Data;
  rooms: RoomData[];
  handles: CatalogueItem[];
  furnitureRanges: CatalogueItem[];
  doorStyles: CatalogueItem[];
  termsText: string;
  termsVersionNumber?: number | null;
  /** Whole-visit questionnaire questions (scope='visit'). */
  visitQuestions?: VisitQuestion[];
  /** Whole-visit answers keyed by question id. */
  answers?: AnswerMap;
  /** Per-room questionnaire questions (scope='room'). */
  roomQuestions?: VisitQuestion[];
  /** Show the duration review row. Defaults to true. The Design Visit wizard
   *  passes false — duration isn't captured/edited in that wizard. */
  showDuration?: boolean;
  /**
   * How to present the terms & conditions section. Defaults to 'accepted',
   * which shows the captured customer acceptance (a tick + version). The Design
   * Visit wizard passes 'reference': the applicable terms are shown as a
   * minimised read-only excerpt with their version so the designer can see
   * which T&Cs accompany the quotation — no customer acceptance is implied.
   */
  termsMode?: 'accepted' | 'reference';
}

/** Formats a captured answer value for read-only display. */
function formatAnswer(value: AnswerValue): string {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (typeof value === 'number') return String(value);
  return String(value);
}

/** Renders answered questions from a question set as read-only review rows. */
function AnswerRows({ questions, answers }: { questions: VisitQuestion[]; answers: AnswerMap }) {
  const answered = questions.filter(q => isAnswered(answers[q.id] ?? null));
  if (!answered.length) return null;
  return (
    <>
      {answered.map(q => (
        <ReviewRow key={q.id} label={q.label} value={formatAnswer(answers[q.id] ?? null)} />
      ))}
    </>
  );
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'space-between',
        fontSize: '.88rem',
        py: '5px',
        borderBottom: '1px solid var(--neutral-100)',
        '&:last-child': { borderBottom: 'none' },
      }}
    >
      <Typography component="span" sx={{ fontWeight: 600, color: 'var(--neutral-500)', fontSize: 'inherit' }}>
        {label}
      </Typography>
      <Typography component="span" sx={{ color: 'var(--neutral-800)', fontSize: 'inherit', textAlign: 'right', ml: 2 }}>
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
          color: 'var(--neutral-400)',
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
  visitQuestions = [],
  answers = {},
  roomQuestions = [],
  showDuration = true,
  termsMode = 'accepted',
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
        {showDuration && <ReviewRow label="Duration" value={`${step1Data.duration} min`} />}
        {!isAddressEmpty(step1Data.structuredAddress) && (
          <ReviewRow label="Location" value={formatAddress(step1Data.structuredAddress).replace(/\n/g, ', ')} />
        )}
        {step1Data.designerName && <ReviewRow label="Designer" value={step1Data.designerName} />}
        {handles.length > 0 && <ReviewRow label="Handle" value={handleName} />}
        {furnitureRanges.length > 0 && <ReviewRow label="Furniture range" value={furnitureName} />}
      </ReviewSection>

      {visitQuestions.some(q => isAnswered(answers[q.id] ?? null)) && (
        <ReviewSection title="Questionnaire">
          <AnswerRows questions={visitQuestions} answers={answers} />
        </ReviewSection>
      )}

      <ReviewSection title="Room breakdown">
        {roomRowData.map((r, idx) => {
          const roomAnswers = r.answers || {};
          const hasRoomAnswers = roomQuestions.some(q => isAnswered(roomAnswers[q.id] ?? null));
          return (
            <Box key={idx} sx={{ borderBottom: '1px solid var(--neutral-100)' }}>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: '.88rem',
                  py: '5px',
                }}
              >
                <Box>
                  <Typography
                    component="span"
                    sx={{ fontWeight: 700, fontSize: 'inherit', color: 'var(--neutral-800)' }}
                  >
                    {r.roomName}
                  </Typography>{' '}
                  <Typography
                    component="span"
                    sx={{ fontWeight: 400, color: 'var(--neutral-400)', fontSize: 'inherit' }}
                  >
                    ({r.dsName}, {r.unitCount} unit{r.unitCount !== 1 ? 's' : ''})
                  </Typography>
                </Box>
                <Typography
                  component="span"
                  sx={{ fontSize: 'inherit', color: 'var(--neutral-800)', ml: 2 }}
                >
                  £{(r.tot / 100).toFixed(2)}
                </Typography>
              </Box>
              {hasRoomAnswers && (
                <Box sx={{ pl: 2, pb: '6px' }}>
                  <AnswerRows questions={roomQuestions} answers={roomAnswers} />
                </Box>
              )}
            </Box>
          );
        })}
        <Typography
          sx={{
            fontSize: '1rem',
            fontWeight: 700,
            textAlign: 'right',
            pt: '10px',
            color: 'var(--neutral-800)',
          }}
        >
          Estimate total: £{(grandTotal / 100).toFixed(2)}
        </Typography>
      </ReviewSection>

      {termsText && termsMode === 'accepted' && (
        <ReviewSection title="Terms &amp; Conditions">
          <ReviewRow
            label="Accepted"
            value={
              <Box
                component="span"
                sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'success.main' }}
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
                      background: 'var(--neutral-200)',
                      color: 'var(--neutral-700)',
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

      {termsText && termsMode === 'reference' && (
        <ReviewSection title="Terms &amp; Conditions sent with quotation">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: '8px' }}>
            <Typography sx={{ fontSize: '.8rem', color: 'var(--neutral-600)' }}>
              These terms will be attached to the quotation.
            </Typography>
            {termsVersionNumber != null && (
              <Box
                component="span"
                sx={{
                  display: 'inline-block',
                  px: '7px',
                  py: '1px',
                  borderRadius: '999px',
                  background: 'var(--neutral-200)',
                  color: 'var(--neutral-700)',
                  fontSize: '.7rem',
                  fontWeight: 700,
                }}
              >
                v{termsVersionNumber}
              </Box>
            )}
          </Box>
          <Box
            sx={{
              background: 'var(--neutral-50)',
              border: '1px solid var(--neutral-200)',
              borderRadius: '8px',
              p: '10px 12px',
              fontSize: '.78rem',
              color: 'var(--neutral-600)',
              maxHeight: 120,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.5,
            }}
          >
            {termsText}
          </Box>
        </ReviewSection>
      )}
    </Box>
  );
}

export default DesignVisitStep3;
