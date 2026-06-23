import React, { useEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { CustomerInfoSubmissionsRail } from './CustomerInfoSubmissionsRail';

const CONTACT_ID = 'contact-001';
const MOCK_LINK =
  'https://example.replit.app/customer-info/abc123def456abc123def456abc123def456abc123def456abc123def456abc123';

const ACTIVE_SUBMISSION = {
  id: 1,
  created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  submitted_at: null,
  expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
  contact_name: 'Jane Smith',
  contact_email: 'jane@example.com',
  corrected_email: null,
  corrected_mobile: null,
  address_line1: null,
  city: null,
  postcode: null,
  structuredAddress: null,
  room_count: null,
  room_notes: null,
  photo_keys: [],
  photoUrls: [],
  email_skipped_count: 0,
  form_link: MOCK_LINK,
};

const SUBMITTED_SUBMISSION = {
  id: 2,
  created_at: new Date(Date.now() - 10 * 86400000).toISOString(),
  submitted_at: new Date(Date.now() - 8 * 86400000).toISOString(),
  expires_at: new Date(Date.now() - 6 * 86400000).toISOString(),
  contact_name: 'Jane Smith',
  contact_email: 'jane@example.com',
  corrected_email: null,
  corrected_mobile: null,
  address_line1: '12 Oak Street',
  city: 'London',
  postcode: 'SW1A 1AA',
  structuredAddress: null,
  room_count: '2',
  room_notes: 'Needs new wardrobe in master bedroom',
  photo_keys: [],
  photoUrls: [],
  email_skipped_count: 0,
  form_link: null,
};

type PrivilegeLevel = 'manager' | 'admin' | 'member';

function setPrivilege(level: PrivilegeLevel) {
  (window as unknown as { __moHeaderUser?: object }).__moHeaderUser = {
    privilege_level: level,
    id: 1,
    email: 'staff@example.com',
    name: 'Staff User',
    onboarding_status: 'active',
  };
}

function mockFetch(submissions: object[], resendDelay = 500) {
  const origFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = ((init?.method) || 'GET').toUpperCase();

    if (url.includes(`/api/customer-info/by-contact/${CONTACT_ID}`) && method === 'GET') {
      return new Response(JSON.stringify(submissions), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/link-status')) {
      const active = submissions.find(
        (s: object) => !(s as { submitted_at: string | null }).submitted_at
      ) as { expires_at: string } | undefined;
      return new Response(
        JSON.stringify({
          hasActiveLink: !!active,
          expiresAt: active?.expires_at,
          formLink: MOCK_LINK,
          token: 'abc123',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/resend') && method === 'POST') {
      await new Promise(r => setTimeout(r, resendDelay));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return origFetch(input, init);
  };
  return () => { window.fetch = origFetch; };
}

function RailDemo({
  privilege,
  submissions,
}: {
  privilege: PrivilegeLevel;
  submissions: object[];
}) {
  useEffect(() => {
    setPrivilege(privilege);
    return mockFetch(submissions);
  }, [privilege, submissions]);

  return (
    <Box sx={{ maxWidth: 500, p: 2 }}>
      <CustomerInfoSubmissionsRail contactId={CONTACT_ID} />
    </Box>
  );
}

const meta: Meta = {
  title: 'Pages/CustomerDetail/CustomerInfoSubmissionsRail',
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const ManagerActiveLink: Story = {
  name: 'Manager — active link (inline Copy, Re-send, Open for customer)',
  render: () => <RailDemo privilege="manager" submissions={[ACTIVE_SUBMISSION]} />,
};

export const AdminActiveLink: Story = {
  name: 'Admin — active link (same inline actions)',
  render: () => <RailDemo privilege="admin" submissions={[ACTIVE_SUBMISSION]} />,
};

export const MemberActiveLink: Story = {
  name: 'Member — active link (icon buttons only, no Re-send)',
  render: () => <RailDemo privilege="member" submissions={[ACTIVE_SUBMISSION]} />,
};

export const ManagerSubmitted: Story = {
  name: 'Manager — submitted (Review button, no inline link row)',
  render: () => <RailDemo privilege="manager" submissions={[SUBMITTED_SUBMISSION]} />,
};

export const ManagerBothCards: Story = {
  name: 'Manager — active link + older submitted card',
  render: () => (
    <RailDemo
      privilege="manager"
      submissions={[ACTIVE_SUBMISSION, SUBMITTED_SUBMISSION]}
    />
  ),
};

const PDF_SUBMISSION = {
  ...SUBMITTED_SUBMISSION,
  id: 3,
  room_count: '1',
  room_notes: 'Living room — see attached PDF floor plan',
  photo_keys: ['obj:ci_aaaabbbbccccdddd.jpg', 'obj:ci_eeeeffffgggghhhh.pdf'],
  photoUrls: [
    '/api/customer-info-photos/obj%3Aci_aaaabbbbccccdddd.jpg?exp=9999999999&sig=fakesig',
    '/api/customer-info-photos/obj%3Aci_eeeeffffgggghhhh.pdf?exp=9999999999&sig=fakesig',
  ],
  email_skipped_count: 0,
};

const PDF_ONLY_SUBMISSION = {
  ...SUBMITTED_SUBMISSION,
  id: 4,
  room_count: '2',
  room_notes: 'Two rooms — PDF floor plan only, no photos',
  photo_keys: ['obj:ci_iiiijjjjkkkkllll.pdf', 'obj:ci_mmmmnnnnooookppp.pdf'],
  photoUrls: [
    '/api/customer-info-photos/obj%3Aci_iiiijjjjkkkkllll.pdf?exp=9999999999&sig=fakesig',
    '/api/customer-info-photos/obj%3Aci_mmmmnnnnooookppp.pdf?exp=9999999999&sig=fakesig',
  ],
  email_skipped_count: 0,
};

export const SubmittedWithPdf: Story = {
  name: 'Submitted — mixed photo + PDF attachment',
  render: () => <RailDemo privilege="manager" submissions={[PDF_SUBMISSION]} />,
};

export const SubmittedPdfOnly: Story = {
  name: 'Submitted — PDF attachments only (no photos)',
  render: () => <RailDemo privilege="manager" submissions={[PDF_ONLY_SUBMISSION]} />,
};

export const AllPrivilegeSideBySide: Story = {
  name: 'All privilege levels — active link side by side',
  render: () => (
    <Stack direction="row" spacing={3} sx={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {(['manager', 'admin', 'member'] as PrivilegeLevel[]).map(level => (
        <Box key={level} sx={{ minWidth: 320 }}>
          <Typography variant="subtitle2" sx={{ mb: 1, textTransform: 'capitalize' }}>
            {level}
          </Typography>
          <RailDemo privilege={level} submissions={[ACTIVE_SUBMISSION]} />
        </Box>
      ))}
    </Stack>
  ),
};
