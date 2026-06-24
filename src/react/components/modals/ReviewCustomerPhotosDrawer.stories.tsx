import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Button from '@mui/material/Button';
import { ReviewCustomerPhotosDrawer } from './ReviewCustomerPhotosDrawer';
import type { CardActionHandlerData } from '../../hooks/useCardActionHandlers';
import type { CardActionContext } from '../../utils/dispatchCardActionHandler';

const meta: Meta = {
  title: 'Features/CustomerDetail/ReviewCustomerPhotosDrawer',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Drawer that lets staff review a customer photo submission, ' +
          'then mark it not suitable or send a rough estimate email. ' +
          'When photos were too large to attach to the admin email an ' +
          'Alert is shown with a clickable "still viewable here" link.',
      },
    },
  },
};
export default meta;

type Story = StoryObj;

const HANDLER: CardActionHandlerData = {
  id: 1,
  type: 'review_customer_photos',
  config: { action_name: 'Review photos' },
};

const CTX: CardActionContext = {
  contactId: 'contact-123',
  contactName: 'Sarah Mitchell',
  contactEmail: 'sarah.mitchell@example.com',
};

const PHOTO_URL = 'https://example.com/photo-skipped.jpg';

function mockFetch(submission: object | null) {
  return (url: unknown): Promise<Response> => {
    if (typeof url === 'string' && url.includes('/api/card-actions/review-customer-photos/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ submission }),
      } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  };
}

function DrawerDemo({ submission }: { submission: object | null }) {
  const [open, setOpen] = useState(false);

  React.useEffect(() => {
    const original = window.fetch;
    window.fetch = mockFetch(submission) as typeof window.fetch;
    return () => { window.fetch = original; };
  }, [submission]);

  return (
    <>
      <Button variant="contained" onClick={() => setOpen(true)} sx={{ m: 4 }}>
        Open drawer
      </Button>
      <ReviewCustomerPhotosDrawer
        handler={HANDLER}
        ctx={CTX}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export const SkippedPhotoWarning: Story = {
  name: 'Skipped-photo warning with clickable link',
  render: () => (
    <DrawerDemo
      submission={{
        id: 1,
        contactId: 'contact-123',
        contactName: 'Sarah Mitchell',
        contactEmail: 'sarah.mitchell@example.com',
        maskedEmail: 'sa***@example.com',
        addressLine1: '12 Oak Street',
        city: 'London',
        postcode: 'SW1A 1AA',
        roomCount: '2',
        roomNotes: 'Kitchen and living room',
        submittedAt: '2026-05-01T10:00:00Z',
        emailSkippedCount: 1,
        photoUrls: [PHOTO_URL, 'https://example.com/photo2.jpg'],
      }}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'When `emailSkippedCount > 0` the warning Alert renders with an ' +
          '`<a data-testid="skipped-photo-link">` anchor pointing to ' +
          '`photoUrls[0]`. Click "Open drawer" to see it.',
      },
    },
  },
};

export const MultipleSkippedPhotos: Story = {
  name: 'Multiple skipped photos warning',
  render: () => (
    <DrawerDemo
      submission={{
        id: 2,
        contactId: 'contact-123',
        contactName: 'James Patel',
        contactEmail: 'james.patel@example.com',
        maskedEmail: 'ja***@example.com',
        addressLine1: '5 Elm Avenue',
        city: 'Manchester',
        postcode: 'M1 2AB',
        roomCount: '3+',
        roomNotes: null,
        submittedAt: '2026-05-10T14:30:00Z',
        emailSkippedCount: 3,
        photoUrls: [PHOTO_URL, 'https://example.com/p2.jpg', 'https://example.com/p3.jpg'],
      }}
    />
  ),
};

export const NoSkippedPhotos: Story = {
  name: 'All photos attached — no warning',
  render: () => (
    <DrawerDemo
      submission={{
        id: 3,
        contactId: 'contact-123',
        contactName: 'Emma Clarke',
        contactEmail: 'emma.clarke@example.com',
        maskedEmail: 'em***@example.com',
        addressLine1: '9 Birch Road',
        city: 'Bristol',
        postcode: 'BS1 3CD',
        roomCount: '1',
        roomNotes: 'Bedroom',
        submittedAt: '2026-05-15T09:00:00Z',
        emailSkippedCount: 0,
        photoUrls: ['https://example.com/ok-photo.jpg'],
      }}
    />
  ),
};
