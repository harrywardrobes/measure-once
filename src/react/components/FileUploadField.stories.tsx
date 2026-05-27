import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { FileUploadField } from './FileUploadField';

const meta: Meta<typeof FileUploadField> = {
  title: 'Components/FileUploadField',
  tags: ['autodocs'],
  component: FileUploadField,
  parameters: { layout: 'padded' },
  argTypes: {
    label:        { control: 'text' },
    accept:       { control: 'text' },
    multiple:     { control: 'boolean' },
    disabled:     { control: 'boolean' },
    error:        { control: 'boolean' },
    uploading:    { control: 'boolean' },
    progress:     { control: { type: 'range', min: 0, max: 100, step: 1 } },
    uploadStatus: {
      control: 'select',
      options: ['idle', 'uploading', 'success', 'error'],
    },
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

export const UploadInProgressIndeterminate: Story = {
  name: 'Upload in progress (indeterminate)',
  render: () => (
    <Box sx={{ maxWidth: 480 }}>
      <FileUploadField
        label="Design drawings"
        accept=".pdf,.dwg"
        value="floor-plan-v2.pdf"
        uploading
        helperText="Uploading…"
      />
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
        Upload size unknown — indeterminate progress bar shown.
      </Typography>
    </Box>
  ),
};

export const UploadSuccess: Story = {
  name: 'Upload success',
  render: () => (
    <Box sx={{ maxWidth: 480 }}>
      <FileUploadField
        label="Design drawings"
        accept=".pdf,.dwg"
        value="floor-plan-v2.pdf"
        uploadStatus="success"
        helperText="File uploaded successfully."
      />
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
        Green checkmark in adornment; progress bar fades out in green.
      </Typography>
    </Box>
  ),
};

export const UploadError: Story = {
  name: 'Upload error',
  render: () => (
    <Box sx={{ maxWidth: 480 }}>
      <FileUploadField
        label="Design drawings"
        accept=".pdf,.dwg"
        value="floor-plan-v2.pdf"
        uploadStatus="error"
        helperText="Upload failed — the server rejected the file. Please try again."
      />
      <Typography variant="caption" color="error" sx={{ mt: 0.5, display: 'block' }}>
        Red error icon in adornment; progress bar fades out in red.
      </Typography>
    </Box>
  ),
};

function UploadLifecycleDemo() {
  type Phase = 'idle' | 'uploading' | 'success' | 'error';
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);

  function simulate(outcome: 'success' | 'error') {
    setPhase('uploading');
    setProgress(0);
    let p = 0;
    const timer = setInterval(() => {
      p = Math.min(p + 8, 100);
      setProgress(p);
      if (p >= 100) {
        clearInterval(timer);
        setTimeout(() => setPhase(outcome), 200);
      }
    }, 120);
  }

  const helperMap: Record<Phase, string> = {
    idle: 'Choose a file then click Simulate below.',
    uploading: `Uploading… ${progress}%`,
    success: 'File uploaded successfully.',
    error: 'Upload failed — please try again.',
  };

  return (
    <Box sx={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <FileUploadField
        label="Design drawings"
        accept=".pdf,.dwg"
        value={phase !== 'idle' ? 'floor-plan-v2.pdf' : undefined}
        uploadStatus={phase}
        progress={phase === 'uploading' ? progress : undefined}
        helperText={helperMap[phase]}
      />
      <Box sx={{ display: 'flex', gap: 1 }}>
        <button onClick={() => simulate('success')} disabled={phase === 'uploading'}>
          Simulate success
        </button>
        <button onClick={() => simulate('error')} disabled={phase === 'uploading'}>
          Simulate error
        </button>
        <button onClick={() => { setPhase('idle'); setProgress(0); }} disabled={phase === 'uploading'}>
          Reset
        </button>
      </Box>
    </Box>
  );
}

export const UploadLifecycle: Story = {
  name: 'Upload lifecycle (interactive)',
  render: () => <UploadLifecycleDemo />,
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

function AutoResetDemo() {
  type Phase = 'idle' | 'uploading' | 'success' | 'error';
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [resetCount, setResetCount] = useState(0);

  const RESET_DELAY_MS = 2500;

  function simulate(outcome: 'success' | 'error') {
    setPhase('uploading');
    setProgress(0);
    let p = 0;
    const timer = setInterval(() => {
      p = Math.min(p + 10, 100);
      setProgress(p);
      if (p >= 100) {
        clearInterval(timer);
        setTimeout(() => setPhase(outcome), 200);
      }
    }, 100);
  }

  const helperMap: Record<Phase, string> = {
    idle: `Choose a file, then click Simulate below. After success or error the field auto-resets in ${RESET_DELAY_MS / 1000}s.`,
    uploading: `Uploading… ${progress}%`,
    success: `Upload complete — field resets automatically in ${RESET_DELAY_MS / 1000}s.`,
    error: `Upload failed — field resets automatically in ${RESET_DELAY_MS / 1000}s.`,
  };

  return (
    <Box sx={{ maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <FileUploadField
        label="Design drawings"
        accept=".pdf,.dwg"
        value={phase !== 'idle' ? 'floor-plan-v2.pdf' : undefined}
        uploadStatus={phase}
        progress={phase === 'uploading' ? progress : undefined}
        helperText={helperMap[phase]}
        resetDelay={RESET_DELAY_MS}
        onStatusReset={() => {
          setPhase('idle');
          setProgress(0);
          setResetCount((c) => c + 1);
        }}
      />
      <Box sx={{ display: 'flex', gap: 1 }}>
        <button onClick={() => simulate('success')} disabled={phase === 'uploading'}>
          Simulate success
        </button>
        <button onClick={() => simulate('error')} disabled={phase === 'uploading'}>
          Simulate error
        </button>
      </Box>
      {resetCount > 0 && (
        <Typography variant="caption" color="text.secondary">
          Auto-reset fired {resetCount} time{resetCount !== 1 ? 's' : ''}.
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ mt: -1 }}>
        After a success or error the green/red adornment fades and the Browse
        button reappears automatically — no manual Reset needed.
      </Typography>
    </Box>
  );
}

export const AutoReset: Story = {
  name: 'Auto-reset after success / error',
  render: () => <AutoResetDemo />,
};
