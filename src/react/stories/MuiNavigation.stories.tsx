import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import HomeIcon from '@mui/icons-material/Home';
import MenuIcon from '@mui/icons-material/Menu';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PersonIcon from '@mui/icons-material/Person';
import SettingsIcon from '@mui/icons-material/Settings';

const meta: Meta = {
  title: 'Navigation/MUI Navigation',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const TabsStory: Story = {
  name: 'Tabs',
  render: () => {
    const [value, setValue] = useState(0);
    return (
      <Stack spacing={3}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>Tabs — scrollable (admin bar pattern)</Typography>
          <AppBar
            position="static"
            color="default"
            elevation={0}
            sx={{ backgroundColor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}
          >
            <Toolbar disableGutters sx={{ minHeight: 48, px: 1 }}>
              <Tabs
                value={value}
                onChange={(_, v) => setValue(v)}
                variant="scrollable"
                scrollButtons="auto"
                allowScrollButtonsMobile
                sx={{ minHeight: 48 }}
              >
                {['Team', 'Permissions', 'Requests', 'Audit log', 'Settings', 'Card actions', 'Action handlers'].map((label, i) => (
                  <Tab key={label} label={label} value={i} sx={{ minHeight: 48, textTransform: 'none', fontWeight: 600 }} />
                ))}
              </Tabs>
            </Toolbar>
          </AppBar>
          <Box sx={{ p: 2, border: 1, borderTop: 0, borderColor: 'divider', borderRadius: '0 0 4px 4px' }}>
            <Typography variant="body2" color="text.secondary">
              Active tab: <strong>{['Team', 'Permissions', 'Requests', 'Audit log', 'Settings', 'Card actions', 'Action handlers'][value]}</strong>
            </Typography>
          </Box>
        </Box>

        <Box>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>Tabs — simple centred</Typography>
          <Tabs value={value % 3} onChange={(_, v) => setValue(v)} centered>
            <Tab label="Overview" sx={{ textTransform: 'none' }} />
            <Tab label="Activity" sx={{ textTransform: 'none' }} />
            <Tab label="Settings" sx={{ textTransform: 'none' }} />
          </Tabs>
        </Box>
      </Stack>
    );
  },
};

export const AppBarStory: Story = {
  name: 'AppBar',
  render: () => (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>AppBar — primary (top nav pattern)</Typography>
        <AppBar position="static" sx={{ bgcolor: 'secondary.main' }}>
          <Toolbar>
            <Typography variant="h6" sx={{ flex: 1, fontWeight: 700 }}>Measure Once</Typography>
            <Button color="inherit">Log out</Button>
          </Toolbar>
        </AppBar>
      </Box>
      <Box>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>AppBar — default (admin tabs bar pattern)</Typography>
        <AppBar position="static" color="default" elevation={0} sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider' }}>
          <Toolbar>
            <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 600 }}>Admin Panel</Typography>
            <IconButton><SettingsIcon /></IconButton>
            <IconButton><PersonIcon /></IconButton>
          </Toolbar>
        </AppBar>
      </Box>
    </Stack>
  ),
};

function DrawerDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outlined" startIcon={<MenuIcon />} onClick={() => setOpen(true)}>
        Open Drawer
      </Button>
      <Drawer anchor="left" open={open} onClose={() => setOpen(false)}>
        <Box sx={{ width: 260 }} role="presentation">
          <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>Navigation</Typography>
          </Box>
          <List>
            {[
              { label: 'Home', Icon: HomeIcon },
              { label: 'Customers', Icon: PersonIcon },
              { label: 'Settings', Icon: SettingsIcon },
            ].map(({ label, Icon }) => (
              <ListItem key={label} disablePadding>
                <ListItemButton onClick={() => setOpen(false)}>
                  <ListItemIcon><Icon /></ListItemIcon>
                  <ListItemText primary={label} />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
          <Divider />
          <List>
            <ListItem disablePadding>
              <ListItemButton onClick={() => setOpen(false)}>
                <ListItemText primary="Log out" />
              </ListItemButton>
            </ListItem>
          </List>
        </Box>
      </Drawer>
    </>
  );
}

export const DrawerStory: Story = {
  name: 'Drawer',
  render: () => (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Drawer — left navigation</Typography>
      <DrawerDemo />
    </Stack>
  ),
};

function MenuDemo() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  return (
    <>
      <IconButton onClick={(e) => setAnchorEl(e.currentTarget)} aria-label="open menu">
        <MoreVertIcon />
      </IconButton>
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
      >
        <MenuItem onClick={() => setAnchorEl(null)}>Edit</MenuItem>
        <MenuItem onClick={() => setAnchorEl(null)}>Duplicate</MenuItem>
        <Divider />
        <MenuItem onClick={() => setAnchorEl(null)} sx={{ color: 'error.main' }}>Delete</MenuItem>
      </Menu>
    </>
  );
}

export const MenuStory: Story = {
  name: 'Menu',
  render: () => (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>Menu — context / overflow menu</Typography>
      <MenuDemo />
    </Stack>
  ),
};
