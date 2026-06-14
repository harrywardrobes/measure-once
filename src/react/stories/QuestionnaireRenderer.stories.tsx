import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import {
  QuestionnaireRenderer,
  missingRequired,
  type VisitQuestion,
  type AnswerMap,
} from '../components/QuestionnaireRenderer';

const SAMPLE_QUESTIONS: VisitQuestion[] = [
  {
    id: 1,
    scope: 'visit',
    applies_to: ['design'],
    label: 'Is the customer the property owner?',
    type: 'yesno',
    options: [],
    required: true,
    sort_order: 0,
  },
  {
    id: 2,
    scope: 'visit',
    applies_to: ['design'],
    label: 'How did the customer hear about us?',
    type: 'choice',
    options: ['Referral', 'Website', 'Showroom', 'Social media'],
    required: true,
    sort_order: 1,
  },
  {
    id: 3,
    scope: 'visit',
    applies_to: ['design'],
    label: 'Approximate budget (£)',
    type: 'number',
    options: [],
    required: false,
    sort_order: 2,
  },
  {
    id: 4,
    scope: 'visit',
    applies_to: ['design'],
    label: 'Additional notes',
    type: 'text',
    options: [],
    required: false,
    sort_order: 3,
  },
];

const meta: Meta<typeof QuestionnaireRenderer> = {
  title: 'Components/QuestionnaireRenderer',
  component: QuestionnaireRenderer,
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj<typeof QuestionnaireRenderer>;

function Harness({
  initial,
  showValidation,
  disabled,
}: {
  initial: AnswerMap;
  showValidation?: boolean;
  disabled?: boolean;
}) {
  const [answers, setAnswers] = useState<AnswerMap>(initial);
  const missing = missingRequired(SAMPLE_QUESTIONS, answers);
  return (
    <Box sx={{ maxWidth: 560 }}>
      <QuestionnaireRenderer
        questions={SAMPLE_QUESTIONS}
        answers={answers}
        onChange={(id, value) => setAnswers((prev) => ({ ...prev, [id]: value }))}
        showValidation={showValidation}
        disabled={disabled}
      />
      <Typography variant="caption" sx={{ display: 'block', mt: 2, color: 'var(--neutral-600)' }}>
        Missing required: {missing.length ? missing.join(', ') : '—'}
      </Typography>
      <Box component="pre" sx={{ mt: 1, fontSize: '.7rem', color: 'var(--neutral-500)', whiteSpace: 'pre-wrap' }}>
        {JSON.stringify(answers, null, 2)}
      </Box>
    </Box>
  );
}

export const Empty: Story = {
  render: () => <Harness initial={{}} />,
};

export const Answered: Story = {
  render: () => (
    <Harness
      initial={{ 1: true, 2: 'Referral', 3: 12000, 4: 'Customer keen to start in spring.' }}
    />
  ),
};

export const WithValidationErrors: Story = {
  render: () => <Harness initial={{}} showValidation />,
};

export const Disabled: Story = {
  render: () => <Harness initial={{ 1: false, 2: 'Website' }} disabled />,
};
