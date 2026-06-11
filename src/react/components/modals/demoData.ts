/**
 * Single source of truth for placeholder contact data shown in admin demo mode.
 *
 * Demo mode lets admins preview a card-action modal from the Workflow tab
 * without touching any real contact, API, or storage. Every demo-mode code
 * path reads from these constants instead of fetching from the server.
 */

export interface DemoContact {
  name: string;
  phone: string;
  mobile: string;
  whatsapp: string;
  email: string;
  address: string;
  visitType: 'design' | 'survey';
}

export const DEMO_CONTACT: DemoContact = {
  name: 'Jane Smith',
  phone: '020 7946 0123',
  mobile: '07700 900456',
  whatsapp: '07700 900456',
  email: 'jane.smith@example.com',
  address: '12 Willow Lane, London, SW1A 1AA',
  visitType: 'design',
};

/** Tooltip shown on every disabled primary button while in demo mode. */
export const DEMO_TOOLTIP = 'Demo mode — no changes will be saved';
