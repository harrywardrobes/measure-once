import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActions from '@mui/material/CardActions';
import CardContent from '@mui/material/CardContent';
import CardHeader from '@mui/material/CardHeader';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Avatar from '@mui/material/Avatar';
import IconButton from '@mui/material/IconButton';
import MoreVertIcon from '@mui/icons-material/MoreVert';

const meta: Meta = {
  title: 'Surfaces/MUI Surfaces',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const Papers: Story = {
  name: 'Paper',
  render: () => (
    <Stack spacing={3}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Paper — variants</Typography>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Paper sx={{ p: 2, width: 180 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Default</Typography>
          <Typography variant="body2" color="text.secondary">elevation=1</Typography>
        </Paper>
        <Paper variant="outlined" sx={{ p: 2, width: 180 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Outlined</Typography>
          <Typography variant="body2" color="text.secondary">No shadow, uses divider border</Typography>
        </Paper>
        <Paper elevation={3} sx={{ p: 2, width: 180 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Elevation 3</Typography>
          <Typography variant="body2" color="text.secondary">Higher shadow</Typography>
        </Paper>
        <Paper elevation={8} sx={{ p: 2, width: 180 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>Elevation 8</Typography>
          <Typography variant="body2" color="text.secondary">Modal/popover shadow</Typography>
        </Paper>
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Paper — with theme background</Typography>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Paper variant="outlined" sx={{ p: 2, bgcolor: 'background.default', width: 200 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>background.default</Typography>
          <Typography variant="body2" color="text.secondary">Uses brand paper colour</Typography>
        </Paper>
        <Paper variant="outlined" sx={{ p: 2, bgcolor: 'primary.light', color: 'primary.dark', width: 200 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>primary.light</Typography>
          <Typography variant="body2">Orchid tint background</Typography>
        </Paper>
      </Box>
    </Stack>
  ),
};

export const Cards: Story = {
  name: 'Card',
  render: () => (
    <Stack spacing={3}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Card — basic</Typography>
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <Card sx={{ maxWidth: 300 }}>
          <CardContent>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>Jane Smith</Typography>
            <Typography variant="body2" color="text.secondary">jane@example.com</Typography>
          </CardContent>
          <CardActions>
            <Button size="small">View</Button>
            <Button size="small">Edit</Button>
          </CardActions>
        </Card>

        <Card variant="outlined" sx={{ maxWidth: 300 }}>
          <CardContent>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>Bob Jones</Typography>
            <Typography variant="body2" color="text.secondary">Outlined card variant</Typography>
          </CardContent>
          <CardActions>
            <Button size="small">View</Button>
          </CardActions>
        </Card>
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Card — with header</Typography>
      <Card sx={{ maxWidth: 360 }}>
        <CardHeader
          avatar={<Avatar sx={{ bgcolor: 'primary.main' }}>JS</Avatar>}
          action={<IconButton aria-label="more"><MoreVertIcon /></IconButton>}
          title="Jane Smith"
          subheader="Sales · New Lead"
        />
        <Divider />
        <CardContent>
          <Stack direction="row" spacing={1} flexWrap="wrap">
            <Chip label="Design visit booked" size="small" color="primary" variant="outlined" />
            <Chip label="Survey pending" size="small" />
          </Stack>
        </CardContent>
        <CardActions>
          <Button size="small" variant="contained">View contact</Button>
          <Button size="small">Notes</Button>
        </CardActions>
      </Card>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Card — settings panel pattern (outlined + CardContent only)</Typography>
      <Card variant="outlined">
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>Integrations</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Connection status for external services used by Measure Once.
          </Typography>
          <Box sx={{ p: 1.25, borderRadius: 1, border: 1, borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>HubSpot CRM</Typography>
            <Chip label="Connected" size="small" color="success" />
          </Box>
        </CardContent>
      </Card>
    </Stack>
  ),
};
