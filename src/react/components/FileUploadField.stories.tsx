import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { FileUploadField } from './FileUploadField';

const meta: Meta<typeof FileUploadField> = {
  title: 'Inputs/FileUploadField',
  component: FileUploadField,
  parameters: { layout: 'padded' },
  argTypes: {
    label:     { control: 'text' },
    accept:    { control: 'text' },
    multiple:  { control: 'boolean' },
    disabled:  { control: 'boolean' },
    error:     { control: 'boolean' },
    uploading: { control: 'boolean' },
    progress:  { control: { type: 'range', min: 0, max: 100, step: 1 } },
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

function UploadInProgressDemo() {
  const [progress, setProgress] = useState(42);

  React.useEffect(() => {
    const timer = setInterval(() => {
      setProgress((prev) => {
        if (prev >= 100) {
          clearInterval(timer);
          return 100;
        }
        return Math.min(prev + 3, 100);
      });
    }, 200);
    return () => clearInterval(timer);
  }, []);

  const done = progress >= 100;

  return (
    <Box sx={{ maxWidth: 480 }}>
      <FileUploadField
        label="Design drawings"
        accept=".pdf,.dwg"
        value="floor-plan-v2.pdf"
        uploading={!done}
        progress={done ? undefined : progress}
        helperText={done ? 'Upload complete' : `Uploading… ${progress}%`}
      />
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
        {done
          ? 'File uploaded successfully.'
          : 'Please wait while the file is being uploaded.'}
      </Typography>
    </Box>
  );
}

export const UploadInProgress: Story = {
  name: 'Upload in progress',
  render: () => <UploadInProgressDemo />,
};

export const ErrorFallback: Story = {
  name: 'Error fallback (upload failed)',
  render: () => (
    <Box sx={{ maxWidth: 480 }}>
      <FileUploadField
        label="Design drawings"
        accept=".pdf,.dwg"
        value="floor-plan-v2.pdf"
        error
        helperText="Upload failed — the server rejected the file. Please try again or choose a different file."
      />
      <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
        Tip: files must be under 10 MB and in PDF or DWG format.
      </Typography>
    </Box>
  ),
};
