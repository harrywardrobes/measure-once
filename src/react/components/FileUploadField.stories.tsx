import type { Meta, StoryObj } from '@storybook/react';
import { FileUploadField } from './FileUploadField';

const meta: Meta<typeof FileUploadField> = {
  title: 'Inputs/FileUploadField',
  component: FileUploadField,
  parameters: { layout: 'padded' },
  argTypes: {
    label:    { control: 'text' },
    accept:   { control: 'text' },
    multiple: { control: 'boolean' },
    disabled: { control: 'boolean' },
    error:    { control: 'boolean' },
  },
};
export default meta;

type Story = StoryObj<typeof FileUploadField>;

export const Default: Story = {
  args: {
    label: 'Upload document',
    accept: '.pdf,.doc,.docx',
  },
};

export const SingleImage: Story = {
  args: {
    label: 'Profile photo',
    accept: 'image/*',
    helperText: 'JPEG, PNG or WebP · max 5 MB',
  },
};

export const MultiImage: Story = {
  args: {
    label: 'Room photos',
    accept: 'image/*',
    multiple: true,
    helperText: 'Select up to 10 images',
  },
};

export const WithError: Story = {
  args: {
    label: 'Contract document',
    accept: '.pdf',
    error: true,
    helperText: 'Please upload a PDF file.',
  },
};

export const Disabled: Story = {
  args: {
    label: 'Proof of address',
    accept: 'image/*,.pdf',
    disabled: true,
  },
};

export const WithExistingValue: Story = {
  args: {
    label: 'Replace photo',
    accept: 'image/*',
    value: 'current-photo.jpg',
  },
};
