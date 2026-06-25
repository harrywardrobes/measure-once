import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { FullScreenModal } from '../components/modals/FullScreenModal';

const meta: Meta<typeof FullScreenModal> = {
  title: 'Modals/FullScreenModal',
  component: FullScreenModal,
  tags: ['autodocs'],
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    title: 'Modal title',
    onClose: () => {},
  },
};
export default meta;

type Story = StoryObj<typeof FullScreenModal>;

const shortBody = (
  <Typography variant="body2" color="text.secondary">
    This is a short piece of content inside the unified modal shell. On desktop the panel is a large
    centred card; on mobile it fills the whole screen.
  </Typography>
);

const longBody = (
  <Stack spacing={2}>
    {Array.from({ length: 30 }).map((_, i) => (
      <TextField key={i} label={`Field ${i + 1}`} size="small" fullWidth />
    ))}
  </Stack>
);

const footerButtons = (onClose: () => void) => (
  <>
    <Button onClick={onClose}>Cancel</Button>
    <Button variant="contained" onClick={onClose}>
      Save
    </Button>
  </>
);

export const ShortContent: Story = {
  name: 'Short content (no footer)',
  args: { children: shortBody },
};

export const WithFooter: Story = {
  name: 'Short content with footer',
  render: (args) => (
    <FullScreenModal {...args} footer={footerButtons(args.onClose)}>
      {shortBody}
    </FullScreenModal>
  ),
};

export const LongScrolling: Story = {
  name: 'Long / scrolling content',
  render: (args) => (
    <FullScreenModal {...args} title="Long form" footer={footerButtons(args.onClose)}>
      {longBody}
    </FullScreenModal>
  ),
};

export const WithHeaderActions: Story = {
  name: 'Header actions slot',
  render: (args) => (
    <FullScreenModal
      {...args}
      headerActions={<Chip label="Demo preview" size="small" color="info" variant="outlined" />}
      footer={footerButtons(args.onClose)}
    >
      {shortBody}
    </FullScreenModal>
  ),
};

export const CenteredConfirm: Story = {
  name: 'Centred confirmation',
  render: (args) => (
    <FullScreenModal
      {...args}
      title="Discard changes?"
      centerContent
      footer={
        <>
          <Button onClick={args.onClose}>Keep editing</Button>
          <Button color="error" onClick={args.onClose}>
            Discard changes
          </Button>
        </>
      }
    >
      <Typography variant="body2">
        You have unsaved changes — are you sure you want to discard them?
      </Typography>
    </FullScreenModal>
  ),
};

export const MobileViewport: Story = {
  name: 'Mobile viewport (375px)',
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  render: (args) => (
    <FullScreenModal {...args} footer={footerButtons(args.onClose)}>
      {longBody}
    </FullScreenModal>
  ),
};

export const DesktopViewport: Story = {
  name: 'Desktop viewport (1280px)',
  parameters: { viewport: { defaultViewport: 'responsive' } },
  render: (args) => (
    <FullScreenModal {...args} footer={footerButtons(args.onClose)}>
      {longBody}
    </FullScreenModal>
  ),
};

export const Interactive: Story = {
  name: 'Interactive (toggle open)',
  render: (args) => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="contained" onClick={() => setOpen(true)}>
          Open modal
        </Button>
        <FullScreenModal
          {...args}
          open={open}
          onClose={() => setOpen(false)}
          footer={footerButtons(() => setOpen(false))}
        >
          {shortBody}
        </FullScreenModal>
      </>
    );
  },
};
