import type { Meta, StoryObj } from '@storybook/react';
import { TemplateRow, type EmailTemplate } from '../pages/admin/EmailTemplatesPage';

const sampleTemplate: EmailTemplate = {
  key: 'visit_confirmation',
  label: 'Visit confirmation',
  description: 'Sent to the customer to confirm a booked visit.',
  audience: 'customer',
  variables: ['customer_name', 'visit_date'],
  subject: 'Your visit is confirmed for {{visit_date}}',
  body_text: 'Hi {{customer_name}}, your visit is confirmed.',
  body_html: '<p>Hi {{customer_name}}, your visit is confirmed.</p>',
  footer_text: 'Measure Once',
  updated_at: '2026-06-01T10:00:00.000Z',
  updated_by: 'admin@measureonce.test',
};

const meta: Meta<typeof TemplateRow> = {
  title: 'Admin/EmailTemplateRow',
  component: TemplateRow,
  tags: ['autodocs'],
  parameters: { layout: 'padded' },
  args: {
    templateKey: 'visit_confirmation',
    template: sampleTemplate,
    shared: false,
    system: false,
    trigger: 'Sent when "Visit booked" is selected on the Arrange visit action.',
    onEdit: () => {},
  },
  argTypes: {
    onEdit: { action: 'edit' },
  },
};
export default meta;

type Story = StoryObj<typeof TemplateRow>;

export const Default: Story = {};

export const Shared: Story = {
  args: { shared: true },
};

export const InternalTeam: Story = {
  args: {
    templateKey: 'admin_notification',
    template: {
      ...sampleTemplate,
      key: 'admin_notification',
      label: 'Admin notification',
      audience: 'team',
      subject: 'New customer submission',
    },
    trigger: 'Sent automatically when the customer submits their uploaded photos & info.',
  },
};

export const System: Story = {
  args: {
    templateKey: 'set_password_welcome',
    template: {
      ...sampleTemplate,
      key: 'set_password_welcome',
      label: 'Set password — welcome',
      audience: 'team',
      subject: 'Set your password',
    },
    system: true,
    trigger: 'Welcome email with a one-time set-password link, sent when an admin approves access.',
    sentFrom: 'auth.js',
  },
};

export const SystemInFlow: Story = {
  args: {
    templateKey: 'open_deal_deposit_invoice_sent',
    template: {
      ...sampleTemplate,
      key: 'open_deal_deposit_invoice_sent',
      label: 'Deposit invoice sent',
      audience: 'customer',
      subject: 'Your deposit invoice',
    },
    system: true,
    sentFrom: 'quickbooks.js',
  },
};

export const TemplateNotFound: Story = {
  args: {
    templateKey: 'orphaned_template_key',
    template: undefined,
  },
};
