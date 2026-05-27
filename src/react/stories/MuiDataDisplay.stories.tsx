import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Avatar from '@mui/material/Avatar';
import Badge from '@mui/material/Badge';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import ListItemText from '@mui/material/ListItemText';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import HomeIcon from '@mui/icons-material/Home';
import MailIcon from '@mui/icons-material/Mail';
import NotificationsIcon from '@mui/icons-material/Notifications';
import PersonIcon from '@mui/icons-material/Person';
import { STAGE_COLORS } from '../theme';

const meta: Meta = {
  title: 'Data Display/MUI Data Display',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const Chips: Story = {
  render: () => (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Chip — default & variants</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Chip label="Default" />
        <Chip label="Primary" color="primary" />
        <Chip label="Secondary" color="secondary" />
        <Chip label="Success" color="success" />
        <Chip label="Error" color="error" />
        <Chip label="Warning" color="warning" />
        <Chip label="Info" color="info" />
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Chip — outlined</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Chip label="Default" variant="outlined" />
        <Chip label="Primary" variant="outlined" color="primary" />
        <Chip label="Error" variant="outlined" color="error" />
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Chip — with icon and delete</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        <Chip icon={<PersonIcon />} label="With icon" />
        <Chip label="Deletable" onDelete={() => {}} />
        <Chip label="Small" size="small" />
        <Chip label="Small + delete" size="small" onDelete={() => {}} />
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Chip — stage colours (themed)</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {Object.entries(STAGE_COLORS).map(([key, c]) => (
          <Chip
            key={key}
            label={key}
            size="small"
            sx={{ bgcolor: c.light, color: c.text, fontWeight: 600, textTransform: 'capitalize' }}
          />
        ))}
      </Box>
    </Stack>
  ),
};

export const Badges: Story = {
  render: () => (
    <Stack spacing={3}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Badge</Typography>
      <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        <Badge badgeContent={4} color="primary">
          <MailIcon />
        </Badge>
        <Badge badgeContent={12} color="error">
          <NotificationsIcon />
        </Badge>
        <Badge badgeContent={0} color="primary" showZero>
          <MailIcon />
        </Badge>
        <Badge color="secondary" variant="dot">
          <MailIcon />
        </Badge>
        <Badge badgeContent={99} max={9} color="error">
          <NotificationsIcon />
        </Badge>
      </Box>
    </Stack>
  ),
};

export const Avatars: Story = {
  render: () => (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Avatar</Typography>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <Avatar>JD</Avatar>
        <Avatar sx={{ bgcolor: 'primary.main' }}>AB</Avatar>
        <Avatar sx={{ bgcolor: 'secondary.main' }}>CD</Avatar>
        <Avatar sx={{ bgcolor: 'error.main' }}>EF</Avatar>
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Avatar — with icon</Typography>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        <Avatar><PersonIcon /></Avatar>
        <Avatar sx={{ bgcolor: 'primary.main' }}><HomeIcon /></Avatar>
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Avatar — sizes</Typography>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        <Avatar sx={{ width: 24, height: 24, fontSize: 12 }}>S</Avatar>
        <Avatar>M</Avatar>
        <Avatar sx={{ width: 56, height: 56, fontSize: 22 }}>L</Avatar>
      </Box>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>Avatar — with Badge</Typography>
      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
        <Badge
          overlap="circular"
          anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
          variant="dot"
          color="success"
        >
          <Avatar sx={{ bgcolor: 'primary.main' }}>JS</Avatar>
        </Badge>
        <Badge badgeContent={3} color="error">
          <Avatar>TM</Avatar>
        </Badge>
      </Box>
    </Stack>
  ),
};

export const Tables: Story = {
  render: () => (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Table</Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Stage</TableCell>
              <TableCell>Lead status</TableCell>
              <TableCell align="right">Value</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {[
              { name: 'Jane Smith', stage: 'Sales', status: 'New Lead', value: '£12,000' },
              { name: 'Bob Jones', stage: 'Design Visit', status: 'Qualified', value: '£8,500' },
              { name: 'Alice Brown', stage: 'Survey', status: 'Proposal Sent', value: '£15,200' },
              { name: 'Charlie Davis', stage: 'Order', status: 'Closed Won', value: '£9,800' },
            ].map((row) => (
              <TableRow key={row.name}>
                <TableCell>{row.name}</TableCell>
                <TableCell>{row.stage}</TableCell>
                <TableCell><Chip label={row.status} size="small" /></TableCell>
                <TableCell align="right">{row.value}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  ),
};

export const Lists: Story = {
  render: () => (
    <Stack spacing={2} sx={{ maxWidth: 480 }}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>List — with avatars</Typography>
      <Paper variant="outlined">
        <List>
          {[
            { name: 'Jane Smith', info: 'jane@example.com', initials: 'JS' },
            { name: 'Bob Jones', info: 'bob@example.com', initials: 'BJ' },
            { name: 'Alice Brown', info: 'alice@example.com', initials: 'AB' },
          ].map((item, i, arr) => (
            <React.Fragment key={item.name}>
              <ListItem alignItems="flex-start">
                <ListItemAvatar>
                  <Avatar sx={{ bgcolor: 'primary.main' }}>{item.initials}</Avatar>
                </ListItemAvatar>
                <ListItemText
                  primary={item.name}
                  secondary={item.info}
                />
              </ListItem>
              {i < arr.length - 1 && <Divider variant="inset" component="li" />}
            </React.Fragment>
          ))}
        </List>
      </Paper>

      <Typography variant="h6" sx={{ fontWeight: 700 }}>List — simple</Typography>
      <Paper variant="outlined">
        <List dense>
          {['Sales board', 'Design visit', 'Survey board', 'Customer list', 'Invoices'].map((item) => (
            <ListItem key={item}>
              <ListItemText primary={item} />
            </ListItem>
          ))}
        </List>
      </Paper>
    </Stack>
  ),
};
