import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { AccessRequestGate } from '../components/AccessRequestGate';

const meta: Meta<typeof AccessRequestGate> = {
  title: 'Feedback/AccessRequestGate',
  component: AccessRequestGate,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof AccessRequestGate>;

export const FormView: Story = {
  name: 'Form (request access)',
  render: () => (
    <AccessRequestGate
      forceNoTurnstile
      open
      onClose={() => {}}
      initialView="form"
    />
  ),
};

export const ConfirmedView: Story = {
  name: 'Confirmed (request submitted)',
  render: () => (
    <AccessRequestGate
      forceNoTurnstile
      open
      onClose={() => {}}
      initialView="confirmed"
    />
  ),
};

export const EmailConflictView: Story = {
  name: 'Email conflict',
  render: () => (
    <AccessRequestGate
      forceNoTurnstile
      open
      onClose={() => {}}
      initialView="email_conflict"
    />
  ),
};

export const PendingView: Story = {
  name: 'Already pending',
  render: () => (
    <AccessRequestGate
      forceNoTurnstile
      open
      onClose={() => {}}
      initialView="pending"
    />
  ),
};

export const AlreadyApprovedView: Story = {
  name: 'Already approved',
  render: () => (
    <AccessRequestGate
      forceNoTurnstile
      open
      onClose={() => {}}
      initialView="already_approved"
    />
  ),
};
