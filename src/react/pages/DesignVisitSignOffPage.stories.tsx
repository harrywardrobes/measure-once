import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { DesignVisitSignOffPage } from './DesignVisitSignOffPage';

const meta: Meta<typeof DesignVisitSignOffPage> = {
  title: 'Features/Pages/DesignVisitSignOff',
  component: DesignVisitSignOffPage,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Public-facing design-visit sign-off page sent to customers via email. ' +
          'Pass an `EmbeddedPreview` object to `embedded` to pin the page into a ' +
          'specific UI state without a real token or network call.',
      },
    },
  },
};
export default meta;

type Story = StoryObj<typeof DesignVisitSignOffPage>;

const SAMPLE_DATA = {
  contactName: 'Sarah Thompson',
  visitDate: '2026-04-15T10:00:00Z',
  location: '14 Maple Avenue, Oxford, OX1 2AB',
  handleName: 'Brushed Nickel Bar',
  furnitureRange: 'Shaker Classic',
  status: 'pending',
  termsVersionNumber: 3,
  terms:
    'These terms and conditions govern the supply of fitted furniture by Measure Once Ltd.\n\n' +
    '1. The estimate provided is valid for 30 days from the date of issue.\n' +
    '2. A 50% deposit is required to proceed with manufacture.\n' +
    '3. The remaining balance is due upon delivery and installation.\n' +
    '4. Cancellations made within 14 days of the survey date are subject to a £250 administration fee.\n' +
    '5. All goods remain the property of Measure Once Ltd until paid in full.',
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
  render: () => <DesignVisitSignOffPage embedded={{ state: 'loading' }} />,
};

export const MainView: Story = {
  name: 'Main — awaiting sign-off',
  render: () => (
    <DesignVisitSignOffPage
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
    <DesignVisitSignOffPage
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

export const MainNoDetails: Story = {
  name: 'Main — no visit details',
  render: () => (
    <DesignVisitSignOffPage
      embedded={{
        state: 'main',
        data: {
          ...SAMPLE_DATA,
          visitDate: undefined,
          location: undefined,
          handleName: undefined,
          furnitureRange: undefined,
        },
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Edge case where the designer has not yet filled in any visit metadata ' +
          '(date, location, handle, or furniture range). The Visit Details card ' +
          'remains visible but shows a short placeholder note rather than an empty card.',
      },
    },
  },
};

export const MainWithPhotos: Story = {
  name: 'Main — with room photos',
  render: () => (
    <DesignVisitSignOffPage
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
                { storageKey: 'https://picsum.photos/seed/kitchen1/800/600' },
                { storageKey: 'https://picsum.photos/seed/kitchen2/800/600' },
                { storageKey: 'https://picsum.photos/seed/kitchen3/800/600' },
              ],
            },
            {
              roomName: 'Utility Room',
              doorStyleName: 'Shaker Ivory',
              unitCount: 6,
              totalPence: 185000,
              images: [
                { storageKey: 'https://picsum.photos/seed/utility1/800/600' },
              ],
            },
            {
              roomName: 'Master Bedroom',
              doorStyleName: 'Handleless Dust Grey',
              unitCount: 8,
              totalPence: 310000,
              images: [
                { storageKey: 'https://picsum.photos/seed/bedroom1/800/600' },
                { storageKey: 'https://picsum.photos/seed/bedroom2/800/600' },
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
    <DesignVisitSignOffPage
      embedded={{
        state: 'superseded',
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'When the designer reopens a visit after the customer already received a sign-off ' +
          'link, the stale link returns a 410 with status="superseded". The page shows a ' +
          '"Changes in progress" notice and exposes no visit data.',
      },
    },
  },
};

export const SuccessApproved: Story = {
  name: 'Success — approved',
  render: () => (
    <DesignVisitSignOffPage
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
    <DesignVisitSignOffPage
      embedded={{
        state: 'success',
        successKind: 'revision',
      }}
    />
  ),
};

export const Expired: Story = {
  name: 'Expired link',
  render: () => <DesignVisitSignOffPage embedded={{ state: 'expired' }} />,
};

export const ErrorDefault: Story = {
  name: 'Error — default',
  render: () => <DesignVisitSignOffPage embedded={{ state: 'error' }} />,
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
    <DesignVisitSignOffPage
      embedded={{
        state: 'error',
        errorTitle: 'Already signed off',
        errorSub:
          'This design visit has already been signed off. ' +
          'Please contact your designer if you believe this is a mistake.',
      }}
    />
  ),
};
