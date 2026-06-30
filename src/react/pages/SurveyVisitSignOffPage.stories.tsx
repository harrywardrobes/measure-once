import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { SurveyVisitSignOffPage } from './SurveyVisitSignOffPage';

const meta: Meta<typeof SurveyVisitSignOffPage> = {
  title: 'Features/Pages/SurveyVisitSignOff',
  component: SurveyVisitSignOffPage,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Public-facing survey-visit sign-off page sent to customers via email. ' +
          'It reuses DesignVisitSignOffPage wholesale via SURVEY_SIGNOFF_CONFIG, ' +
          'swapping in the survey API base path and copy. Pass an ' +
          '`EmbeddedPreview` object to `embedded` to pin the page into a specific ' +
          'UI state without a real token or network call.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof SurveyVisitSignOffPage>;

const SAMPLE_DATA = {
  contactName: 'Sarah Thompson',
  visitDate: '2026-04-15T10:00:00Z',
  location: '14 Maple Avenue, Oxford, OX1 2AB',
  handleName: 'Brushed Nickel Bar',
  furnitureRange: 'Shaker Classic',
  status: 'pending',
  termsVersionNumber: 3,
  terms:
    'These terms and conditions govern the supply of fitted furniture by Gautier Design Ltd.\n\n' +
    '1. The estimate provided is valid for 30 days from the date of issue.\n' +
    '2. A 50% deposit is required to proceed with manufacture.\n' +
    '3. The remaining balance is due upon delivery and installation.\n' +
    '4. Cancellations made within 14 days of the survey date are subject to a £250 administration fee.\n' +
    '5. All goods remain the property of Gautier Design Ltd until paid in full.',
  rooms: [
    {
      roomName: 'Kitchen',
      doorStyleName: 'Shaker Ivory',
      unitCount: 14,
      totalPence: 620000,
      images: [],
    },
    {
      roomName: 'Utility Room',
      doorStyleName: 'Shaker Ivory',
      unitCount: 6,
      totalPence: 185000,
      images: [],
    },
    {
      roomName: 'Master Bedroom',
      doorStyleName: 'Handleless Dust Grey',
      unitCount: 8,
      totalPence: 310000,
      images: [],
    },
  ],
};

export const Loading: Story = {
  name: 'Loading',
  render: () => <SurveyVisitSignOffPage embedded={{ state: 'loading' }} />,
};

export const MainView: Story = {
  name: 'Main — awaiting sign-off',
  render: () => (
    <SurveyVisitSignOffPage
      embedded={{
        state: 'main',
        data: SAMPLE_DATA,
      }}
    />
  ),
};

export const MainNoRooms: Story = {
  name: 'Main — no rooms',
  render: () => (
    <SurveyVisitSignOffPage
      embedded={{
        state: 'main',
        data: { ...SAMPLE_DATA, rooms: [] },
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Edge case where the server returns an empty rooms array — valid for a visit ' +
          'that has no room data recorded yet. The rooms table and photo section should ' +
          'gracefully degrade or show an empty state.',
      },
    },
  },
};

export const MainWithPhotos: Story = {
  name: 'Main — with room photos',
  render: () => (
    <SurveyVisitSignOffPage
      embedded={{
        state: 'main',
        data: {
          ...SAMPLE_DATA,
          rooms: [
            {
              roomName: 'Kitchen',
              doorStyleName: 'Shaker Ivory',
              unitCount: 14,
              totalPence: 620000,
              images: [
                { storageKey: 'https://picsum.photos/seed/skitchen1/800/600' },
                { storageKey: 'https://picsum.photos/seed/skitchen2/800/600' },
              ],
            },
            {
              roomName: 'Utility Room',
              doorStyleName: 'Shaker Ivory',
              unitCount: 6,
              totalPence: 185000,
              images: [
                { storageKey: 'https://picsum.photos/seed/sutility1/800/600' },
              ],
            },
          ],
        },
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Shows the "Room Photos" section rendered with placeholder images. ' +
          'In production the storageKey values are opaque object-store keys; ' +
          'here we use public picsum.photos URLs which safeImageSrc passes through directly.',
      },
    },
  },
};

export const MainSuperseded: Story = {
  name: 'Superseded — changes in progress',
  render: () => (
    <SurveyVisitSignOffPage
      embedded={{
        state: 'superseded',
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'When the surveyor reopens a visit after the customer already received a sign-off ' +
          'link, the stale link returns a 410 with status="superseded". The page shows a ' +
          '"Changes in progress" notice and exposes no visit data.',
      },
    },
  },
};

export const SuccessApproved: Story = {
  name: 'Success — approved',
  render: () => (
    <SurveyVisitSignOffPage
      embedded={{
        state: 'success',
        successKind: 'approved',
      }}
    />
  ),
};

export const SuccessRevision: Story = {
  name: 'Success — revision requested',
  render: () => (
    <SurveyVisitSignOffPage
      embedded={{
        state: 'success',
        successKind: 'revision',
      }}
    />
  ),
};

export const Expired: Story = {
  name: 'Expired link',
  render: () => <SurveyVisitSignOffPage embedded={{ state: 'expired' }} />,
};

export const ErrorDefault: Story = {
  name: 'Error — default',
  render: () => <SurveyVisitSignOffPage embedded={{ state: 'error' }} />,
  parameters: {
    docs: {
      description: {
        story: 'Default error state shown when no custom title or subtitle is supplied.',
      },
    },
  },
};

export const ErrorAlreadySigned: Story = {
  name: 'Error — already signed off',
  render: () => (
    <SurveyVisitSignOffPage
      embedded={{
        state: 'error',
        errorTitle: 'Already signed off',
        errorSub:
          'This survey visit has already been signed off. ' +
          'Please contact your surveyor if you believe this is a mistake.',
      }}
    />
  ),
};
