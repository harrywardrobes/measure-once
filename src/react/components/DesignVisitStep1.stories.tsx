import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { DesignVisitStep1 } from './DesignVisitStep1';
import type { Step1Data } from './DesignVisitStep1';
import { emptyAddress } from '../../../shared/address';

const meta: Meta<typeof DesignVisitStep1> = {
  title: 'Features/DesignVisitStep1',
  component: DesignVisitStep1,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Step 1 of the Design Visit wizard. Captures the visit date & time ' +
          '(via DateTimePicker), duration, location, designer name, handle and ' +
          'furniture range selections, and terms acceptance.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof DesignVisitStep1>;

const HANDLES = [
  { id: 1, name: 'Brushed Nickel Bar' },
  { id: 2, name: 'Polished Chrome Cup' },
  { id: 3, name: 'Matt Black T-Bar' },
];

const FURNITURE_RANGES = [
  { id: 1, name: 'Shaker Classic' },
  { id: 2, name: 'Linear Gloss' },
  { id: 3, name: 'Sophia Oak' },
];

const TERMS_TEXT =
  'These terms and conditions govern the supply of fitted furniture.\n\n' +
  '1. The estimate provided is valid for 30 days from the date of issue.\n' +
  '2. A 50% deposit is required to proceed with manufacture.\n' +
  '3. The remaining balance is due upon delivery and installation.';

const DEFAULT_DATA: Step1Data = {
  visitDate: '',
  duration: '90',
  structuredAddress: emptyAddress(),
  designerName: '',
  handleId: '',
  furnitureRangeId: '',
  termsAccepted: false,
};

const PREFILLED_DATA: Step1Data = {
  visitDate: '2026-06-15T10:00',
  duration: '120',
  structuredAddress: {
    ...emptyAddress(),
    addressLines: ['14 Maple Avenue'],
    locality: 'Oxford',
    postalCode: 'OX1 2AB',
  },
  designerName: 'Sarah Jones',
  handleId: '1',
  furnitureRangeId: '2',
  termsAccepted: true,
};

export const Default: Story = {
  name: 'Empty (new visit)',
  args: {
    initialData: DEFAULT_DATA,
    handles: HANDLES,
    furnitureRanges: FURNITURE_RANGES,
    termsText: TERMS_TEXT,
    onDataChange: (data) => console.log('[story] onDataChange', data),
  },
};

export const PreFilled: Story = {
  name: 'Pre-filled (edit mode)',
  args: {
    initialData: PREFILLED_DATA,
    handles: HANDLES,
    furnitureRanges: FURNITURE_RANGES,
    termsText: TERMS_TEXT,
    onDataChange: (data) => console.log('[story] onDataChange', data),
  },
};

export const NoHandlesOrRanges: Story = {
  name: 'No catalogue items',
  args: {
    initialData: DEFAULT_DATA,
    handles: [],
    furnitureRanges: [],
    termsText: TERMS_TEXT,
    onDataChange: () => {},
  },
};

export const NoTerms: Story = {
  name: 'No terms text',
  args: {
    initialData: DEFAULT_DATA,
    handles: HANDLES,
    furnitureRanges: FURNITURE_RANGES,
    termsText: '',
    onDataChange: () => {},
  },
};
