import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormLabel from '@mui/material/FormLabel';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SearchIcon from '@mui/icons-material/Search';

const meta: Meta = {
  title: 'Inputs/MUI Inputs',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const TextFields: Story = {
  name: 'TextField',
  render: () => (
    <Stack spacing={2} sx={{ maxWidth: 400 }}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>TextField</Typography>
      <TextField label="Default" placeholder="Enter a value" />
      <TextField label="With helper text" helperText="This field is required." />
      <TextField label="Error state" error helperText="This field has an error." defaultValue="bad value" />
      <TextField label="Disabled" disabled defaultValue="Cannot edit this" />
      <TextField label="Small size" size="small" placeholder="Compact input" />
      <TextField label="Multiline" multiline minRows={3} placeholder="Write something…" />
      <TextField
        label="With select"
        select
        defaultValue="SALES"
      >
        {['SALES', 'DESIGN_VISIT', 'SURVEY', 'ORDER'].map((v) => (
          <MenuItem key={v} value={v}>{v}</MenuItem>
        ))}
      </TextField>
    </Stack>
  ),
};

export const Checkboxes: Story = {
  name: 'Checkbox',
  render: () => {
    const [checked, setChecked] = useState(true);
    return (
      <Stack spacing={1}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>Checkbox</Typography>
        <FormControlLabel
          control={<Checkbox checked={checked} onChange={(e) => setChecked(e.target.checked)} />}
          label="Checked state"
        />
        <FormControlLabel
          control={<Checkbox defaultChecked={false} />}
          label="Unchecked state"
        />
        <FormControlLabel
          control={<Checkbox indeterminate />}
          label="Indeterminate"
        />
        <FormControlLabel
          control={<Checkbox disabled defaultChecked />}
          label="Disabled checked"
        />
        <FormControlLabel
          control={<Checkbox disabled />}
          label="Disabled unchecked"
        />
        <FormControlLabel
          control={<Checkbox color="secondary" defaultChecked />}
          label="Secondary colour"
        />
      </Stack>
    );
  },
};

export const Radios: Story = {
  name: 'Radio',
  render: () => {
    const [value, setValue] = useState('option1');
    return (
      <Stack spacing={2}>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>Radio</Typography>
        <FormControl>
          <FormLabel>Contact stage</FormLabel>
          <RadioGroup value={value} onChange={(e) => setValue(e.target.value)}>
            <FormControlLabel value="option1" control={<Radio />} label="Sales" />
            <FormControlLabel value="option2" control={<Radio />} label="Design Visit" />
            <FormControlLabel value="option3" control={<Radio />} label="Survey" />
            <FormControlLabel value="option4" control={<Radio />} label="Order" disabled />
          </RadioGroup>
        </FormControl>
      </Stack>
    );
  },
};

export const Switches: Story = {
  name: 'Switch',
  render: () => {
    const [on, setOn] = useState(true);
    return (
      <Stack spacing={1}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>Switch</Typography>
        <FormControlLabel
          control={<Switch checked={on} onChange={(e) => setOn(e.target.checked)} />}
          label={on ? 'Enabled' : 'Disabled'}
        />
        <FormControlLabel
          control={<Switch defaultChecked={false} />}
          label="Notifications"
        />
        <FormControlLabel
          control={<Switch disabled defaultChecked />}
          label="Disabled on"
        />
        <FormControlLabel
          control={<Switch disabled />}
          label="Disabled off"
        />
        <FormControlLabel
          control={<Switch color="secondary" defaultChecked />}
          label="Secondary colour"
        />
      </Stack>
    );
  },
};

export const IconButtons: Story = {
  name: 'IconButton',
  render: () => (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>IconButton</Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <IconButton aria-label="search"><SearchIcon /></IconButton>
        <IconButton aria-label="edit"><EditIcon /></IconButton>
        <IconButton aria-label="delete" color="error"><DeleteIcon /></IconButton>
        <IconButton aria-label="more"><MoreVertIcon /></IconButton>
      </Stack>
      <Typography variant="subtitle2">Sizes</Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <IconButton size="small" aria-label="small"><EditIcon fontSize="small" /></IconButton>
        <IconButton size="medium" aria-label="medium"><EditIcon /></IconButton>
        <IconButton size="large" aria-label="large"><EditIcon fontSize="large" /></IconButton>
      </Stack>
      <Typography variant="subtitle2">Colours</Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <IconButton color="primary" aria-label="primary"><SearchIcon /></IconButton>
        <IconButton color="secondary" aria-label="secondary"><SearchIcon /></IconButton>
        <IconButton color="error" aria-label="error"><DeleteIcon /></IconButton>
        <IconButton disabled aria-label="disabled"><EditIcon /></IconButton>
      </Stack>
      <Typography variant="subtitle2">With visible background (contained variant via sx)</Typography>
      <Box sx={{ display: 'flex', gap: 1 }}>
        <IconButton
          aria-label="edit filled"
          sx={{ bgcolor: 'primary.main', color: '#fff', '&:hover': { bgcolor: 'primary.dark' } }}
        >
          <EditIcon />
        </IconButton>
        <IconButton
          aria-label="delete filled"
          sx={{ bgcolor: 'error.light', color: 'error.dark', '&:hover': { bgcolor: 'error.main', color: '#fff' } }}
        >
          <DeleteIcon />
        </IconButton>
      </Box>
    </Stack>
  ),
};
