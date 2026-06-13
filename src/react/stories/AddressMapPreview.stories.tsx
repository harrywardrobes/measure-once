import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { AddressMapPreview } from '../components/AddressMapPreview';
import type { GoogleMapsConfig } from '../lib/googleMapsConfig';

/**
 * AddressMapPreview renders a static Google Map thumbnail for a saved address.
 * It reads the runtime config from `GET /api/google-maps/config`, so these
 * stories stub `window.fetch` for that endpoint. The actual map tile only
 * renders when a valid `GOOGLE_PLACES_API_KEY` is configured on the server;
 * without one the component degrades to nothing (its design intent).
 */

const ENABLED_CONFIG: GoogleMapsConfig = {
  enabled: true,
  apiKey: 'DEMO_KEY',
  autocomplete: {
    countries: ['GB'],
    language: 'en-GB',
    types: 'address',
    debounceMs: 300,
    minChars: 3,
    sessionTokens: true,
  },
  surfaces: {
    customerInfo: { autocomplete: true, mapPreview: true },
    designVisit: { autocomplete: true, mapPreview: true },
    arrangeVisit: { autocomplete: true, mapPreview: true },
    contactEdit: { autocomplete: true, mapPreview: true },
  },
  mapPreview: { enabled: true, zoom: 15, mapType: 'roadmap' },
  fallback: { mode: 'silent', allowManualEntry: true },
};

function mockConfigFetch(config: GoogleMapsConfig) {
  return ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/google-maps/config')) {
      return Promise.resolve(new Response(JSON.stringify(config), { status: 200 }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  }) as typeof fetch;
}

const meta: Meta<typeof AddressMapPreview> = {
  title: 'Components/AddressMapPreview',
  component: AddressMapPreview,
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => {
      const orig = window.fetch;
      window.fetch = mockConfigFetch(ENABLED_CONFIG);
      // Restore once the decorator unmounts so other stories are unaffected.
      queueMicrotask(() => {
        window.addEventListener('beforeunload', () => {
          window.fetch = orig;
        });
      });
      return (
        <Box sx={{ maxWidth: 520 }}>
          <Story />
        </Box>
      );
    },
  ],
};
export default meta;

type Story = StoryObj<typeof AddressMapPreview>;

export const Enabled: Story = {
  args: {
    address: '12 Baker Street, London NW1 6XE, UK',
    surface: 'contactEdit',
    height: 200,
  },
  render: (args) => (
    <Box>
      <Typography variant="body2" sx={{ mb: 1 }}>{args.address}</Typography>
      <AddressMapPreview {...args} />
      <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'var(--neutral-500)' }}>
        The tile only renders with a valid server-side API key; otherwise the
        component renders nothing.
      </Typography>
    </Box>
  ),
};

export const EmptyAddress: Story = {
  args: { address: '', surface: 'contactEdit' },
  render: (args) => (
    <Box>
      <AddressMapPreview {...args} />
      <Typography variant="caption" sx={{ color: 'var(--neutral-500)' }}>
        With no address the component renders nothing.
      </Typography>
    </Box>
  ),
};
