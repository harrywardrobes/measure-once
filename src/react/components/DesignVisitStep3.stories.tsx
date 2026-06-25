import type { Meta, StoryObj } from '@storybook/react';
import { DesignVisitStep3 } from './DesignVisitStep3';
import {
  DEMO_STEP1,
  DEMO_ROOMS,
  DEMO_HANDLES,
  DEMO_FURNITURE_RANGES,
  DEMO_DOOR_STYLES,
  DEMO_TERMS_TEXT,
  DEMO_VISIT_QUESTIONS,
  DEMO_VISIT_ANSWERS,
  DEMO_ROOM_QUESTIONS,
} from '../components/modals/demoData';

const meta: Meta<typeof DesignVisitStep3> = {
  title: 'Design Visit/DesignVisitStep3',
  component: DesignVisitStep3,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  args: {
    step1Data: { ...DEMO_STEP1 },
    rooms: DEMO_ROOMS.map(r => ({ ...r })),
    handles: DEMO_HANDLES,
    furnitureRanges: DEMO_FURNITURE_RANGES,
    doorStyles: DEMO_DOOR_STYLES,
    termsText: DEMO_TERMS_TEXT,
    termsVersionNumber: 1,
  },
};
export default meta;

type Story = StoryObj<typeof DesignVisitStep3>;

/** Review screen with whole-visit and per-room questionnaire answers shown. */
export const WithQuestionnaireAnswers: Story = {
  args: {
    visitQuestions: DEMO_VISIT_QUESTIONS,
    answers: DEMO_VISIT_ANSWERS,
    roomQuestions: DEMO_ROOM_QUESTIONS,
  },
};

/** Review screen with no questionnaire configured — sections are omitted. */
export const WithoutQuestionnaire: Story = {
  args: {
    visitQuestions: [],
    answers: {},
    roomQuestions: [],
  },
};
