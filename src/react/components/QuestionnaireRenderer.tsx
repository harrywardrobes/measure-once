import React from 'react';
import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

/**
 * Shared questionnaire engine types + renderer.
 *
 * Mirrors the backend `visit_questions` / `visit_answers` model (see
 * design-visits.js and migrations/*_questionnaire-tables.js). Used by both the
 * Design Visit wizard and, in future, the Survey visit — any visit type can
 * render its question set with this component.
 */

export type VisitQuestionScope = 'room' | 'visit';
export type VisitQuestionType = 'yesno' | 'choice' | 'text' | 'number';

/** Member-facing question shape returned by GET /api/visit-questions. */
export interface VisitQuestion {
  id: number;
  scope: VisitQuestionScope;
  applies_to: string[];
  label: string;
  type: VisitQuestionType;
  options: string[];
  required: boolean;
  sort_order: number;
}

/** A captured answer value. Stored as JSONB on the server. */
export type AnswerValue = string | number | boolean | null;

/** Map of question id → answer value. */
export type AnswerMap = Record<number, AnswerValue>;

export interface QuestionnaireRendererProps {
  questions: VisitQuestion[];
  answers: AnswerMap;
  onChange: (questionId: number, value: AnswerValue) => void;
  disabled?: boolean;
  /** When true, required questions with no answer show an error state. */
  showValidation?: boolean;
}

/** True when a value counts as "answered" for required-field validation. */
export function isAnswered(value: AnswerValue): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/** Returns the ids of required questions that have no answer. */
export function missingRequired(questions: VisitQuestion[], answers: AnswerMap): number[] {
  return questions
    .filter((q) => q.required && !isAnswered(answers[q.id] ?? null))
    .map((q) => q.id);
}

function QuestionField({
  q,
  value,
  onChange,
  disabled,
  showValidation,
}: {
  q: VisitQuestion;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
  disabled?: boolean;
  showValidation?: boolean;
}) {
  const invalid = !!showValidation && q.required && !isAnswered(value ?? null);
  const requiredMark = q.required ? ' *' : '';

  if (q.type === 'yesno') {
    const strVal = value === true ? 'yes' : value === false ? 'no' : '';
    return (
      <FormControl fullWidth size="small" error={invalid} disabled={disabled}>
        <InputLabel>{q.label + requiredMark}</InputLabel>
        <Select
          label={q.label + requiredMark}
          value={strVal}
          onChange={(e) => onChange(e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)}
        >
          <MenuItem value=""><em>—</em></MenuItem>
          <MenuItem value="yes">Yes</MenuItem>
          <MenuItem value="no">No</MenuItem>
        </Select>
      </FormControl>
    );
  }

  if (q.type === 'choice') {
    const strVal = typeof value === 'string' ? value : '';
    return (
      <FormControl fullWidth size="small" error={invalid} disabled={disabled}>
        <InputLabel>{q.label + requiredMark}</InputLabel>
        <Select
          label={q.label + requiredMark}
          value={strVal}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
        >
          <MenuItem value=""><em>—</em></MenuItem>
          {q.options.map((opt) => (
            <MenuItem key={opt} value={opt}>{opt}</MenuItem>
          ))}
        </Select>
      </FormControl>
    );
  }

  if (q.type === 'number') {
    return (
      <TextField
        fullWidth
        size="small"
        type="number"
        label={q.label + requiredMark}
        value={value == null ? '' : String(value)}
        error={invalid}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  }

  // text
  return (
    <TextField
      fullWidth
      size="small"
      multiline
      minRows={1}
      label={q.label + requiredMark}
      value={typeof value === 'string' ? value : ''}
      error={invalid}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
    />
  );
}

/**
 * Renders a list of questions as editable form fields. Stateless — the parent
 * owns the answer map and persists it (draft-save + submit).
 */
export function QuestionnaireRenderer({
  questions,
  answers,
  onChange,
  disabled,
  showValidation,
}: QuestionnaireRendererProps) {
  if (!questions.length) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {questions.map((q) => (
        <QuestionField
          key={q.id}
          q={q}
          value={answers[q.id] ?? null}
          onChange={(v) => onChange(q.id, v)}
          disabled={disabled}
          showValidation={showValidation}
        />
      ))}
    </Box>
  );
}

/** Convenience: a labelled section wrapper for a question group. */
export function QuestionnaireSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box>
        <Typography variant="subtitle1">{title}</Typography>
        {description && (
          <Typography variant="body2" color="text.secondary">{description}</Typography>
        )}
      </Box>
      {children}
    </Box>
  );
}

export default QuestionnaireRenderer;
