import React, { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import FormControl from '@mui/material/FormControl';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormHelperText from '@mui/material/FormHelperText';
import FormLabel from '@mui/material/FormLabel';
import IconButton from '@mui/material/IconButton';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Select from '@mui/material/Select';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { DateRangePicker } from '@mui/x-date-pickers-pro/DateRangePicker';
import { TimeRangePicker } from '@mui/x-date-pickers-pro/TimeRangePicker';
import type { DateRange, RangePosition } from '@mui/x-date-pickers-pro/models';
import type { FieldOwnerState } from '@mui/x-date-pickers/models';
import { TimePicker } from '@mui/x-date-pickers/TimePicker';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import SearchIcon from '@mui/icons-material/Search';
import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';

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

const STAGE_OPTIONS = [
  { value: 'sales',        label: 'Sales' },
  { value: 'designvisit',  label: 'Design Visit' },
  { value: 'survey',       label: 'Survey' },
  { value: 'order',        label: 'Order' },
  { value: 'workshop',     label: 'Workshop' },
  { value: 'delivery',     label: 'Delivery' },
  { value: 'installation', label: 'Installation' },
];

export const SelectField: Story = {
  name: 'Select',
  render: () => {
    const [stage, setStage] = useState('sales');
    const [status, setStatus] = useState('');
    const [size, setSize] = useState<string[]>(['medium']);

    return (
      <Stack spacing={3} sx={{ maxWidth: 400 }}>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>Select</Typography>

        <FormControl fullWidth>
          <InputLabel id="stage-label">Project stage</InputLabel>
          <Select
            labelId="stage-label"
            value={stage}
            label="Project stage"
            onChange={(e) => setStage(e.target.value)}
          >
            {STAGE_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>
            ))}
          </Select>
          <FormHelperText>Current value: {stage}</FormHelperText>
        </FormControl>

        <FormControl fullWidth error={status === ''}>
          <InputLabel id="status-label">Lead status</InputLabel>
          <Select
            labelId="status-label"
            value={status}
            label="Lead status"
            displayEmpty
            onChange={(e) => setStatus(e.target.value)}
          >
            <MenuItem value=""><em>None</em></MenuItem>
            <MenuItem value="new_lead">New Lead</MenuItem>
            <MenuItem value="contacted">Contacted</MenuItem>
            <MenuItem value="qualified">Qualified</MenuItem>
            <MenuItem value="closed_won">Closed Won</MenuItem>
            <MenuItem value="closed_lost">Closed Lost</MenuItem>
          </Select>
          {status === '' && <FormHelperText>A lead status is required.</FormHelperText>}
        </FormControl>

        <FormControl fullWidth>
          <InputLabel id="size-label">Room sizes (multi-select)</InputLabel>
          <Select
            labelId="size-label"
            multiple
            value={size}
            label="Room sizes (multi-select)"
            onChange={(e) => {
              const val = e.target.value;
              setSize(typeof val === 'string' ? val.split(',') : val);
            }}
            renderValue={(selected) => (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                {selected.map((v) => <Chip key={v} label={v} size="small" />)}
              </Box>
            )}
          >
            {['small', 'medium', 'large', 'extra-large'].map((v) => (
              <MenuItem key={v} value={v}>{v}</MenuItem>
            ))}
          </Select>
          <FormHelperText>Hold Ctrl / Cmd to select multiple values</FormHelperText>
        </FormControl>

        <FormControl fullWidth disabled>
          <InputLabel id="disabled-label">Disabled select</InputLabel>
          <Select labelId="disabled-label" value="survey" label="Disabled select">
            <MenuItem value="survey">Survey</MenuItem>
          </Select>
          <FormHelperText>This field cannot be changed.</FormHelperText>
        </FormControl>
      </Stack>
    );
  },
};

const TEAM_MEMBERS = [
  { id: '1', label: 'Alice Johnson', role: 'Designer' },
  { id: '2', label: 'Bob Smith',    role: 'Surveyor' },
  { id: '3', label: 'Carol White',  role: 'Sales' },
  { id: '4', label: 'David Brown',  role: 'Installer' },
  { id: '5', label: 'Eve Davis',    role: 'Manager' },
];

const POSTCODE_OPTIONS = [
  'SW1A 1AA', 'SW1A 2AA', 'EC1A 1BB', 'W1A 0AX', 'WC2N 5DU',
  'E1 6AN',   'N1 9GU',   'SE1 7PB',  'W2 1JB',   'NW1 4RY',
];

export const AutocompleteField: Story = {
  name: 'Autocomplete',
  render: () => {
    const [assignee, setAssignee] = useState<{ id: string; label: string; role: string } | null>(null);
    const [postcode, setPostcode] = useState<string | null>(null);
    const [tags, setTags] = useState<string[]>(['renovation', 'urgent']);

    return (
      <Stack spacing={3} sx={{ maxWidth: 400 }}>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>Autocomplete</Typography>

        <Autocomplete
          options={TEAM_MEMBERS}
          value={assignee}
          onChange={(_, v) => setAssignee(v)}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Assigned to"
              helperText={assignee ? `Role: ${assignee.role}` : 'Start typing to search team members'}
            />
          )}
          renderOption={(props, option) => (
            <Box component="li" {...props} key={option.id}>
              <Box>
                <Typography variant="body2">{option.label}</Typography>
                <Typography variant="caption" color="text.secondary">{option.role}</Typography>
              </Box>
            </Box>
          )}
        />

        <Autocomplete
          options={POSTCODE_OPTIONS}
          value={postcode}
          onChange={(_, v) => setPostcode(v)}
          freeSolo
          renderInput={(params) => (
            <TextField
              {...params}
              label="Postcode"
              helperText="Type to filter or enter a custom postcode"
            />
          )}
        />

        <Autocomplete<string, true, false, false>
          multiple
          options={['renovation', 'urgent', 'new-build', 'extension', 'loft', 'kitchen', 'bathroom']}
          value={tags}
          onChange={(_, v) => setTags(v)}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Tags"
              helperText="Add one or more tags to this contact"
            />
          )}
        />

        <Autocomplete
          options={TEAM_MEMBERS}
          disabled
          renderInput={(params) => (
            <TextField {...params} label="Assigned to (disabled)" helperText="Assignment is locked." />
          )}
        />

        <Autocomplete
          options={TEAM_MEMBERS}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Assigned to (error)"
              error
              helperText="An assignee is required before submitting."
            />
          )}
        />
      </Stack>
    );
  },
};

export const DatePickerField: Story = {
  name: 'DatePicker',
  render: () => {
    const [visitDate, setVisitDate] = useState<Dayjs | null>(null);
    const [followUpDate, setFollowUpDate] = useState<Dayjs | null>(null);
    const [orderDate, setOrderDate] = useState<Dayjs | null>(null);

    return (
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <Stack spacing={3} sx={{ maxWidth: 400 }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>DatePicker</Typography>

          <DatePicker
            label="Design visit date"
            value={visitDate}
            onChange={(v) => setVisitDate(v)}
            slotProps={{
              textField: {
                helperText: visitDate
                  ? `Selected: ${visitDate.format('DD MMM YYYY')}`
                  : 'Pick a date for the design visit',
                fullWidth: true,
              },
            }}
          />

          <DatePicker
            label="Follow-up date"
            value={followUpDate}
            onChange={(v) => setFollowUpDate(v)}
            disablePast
            slotProps={{
              textField: {
                helperText: 'Must be today or a future date',
                fullWidth: true,
              },
            }}
          />

          <DatePicker
            label="Order placed (error)"
            value={orderDate}
            onChange={(v) => setOrderDate(v)}
            slotProps={{
              textField: {
                error: orderDate === null,
                helperText: orderDate === null ? 'Order date is required.' : undefined,
                fullWidth: true,
              },
            }}
          />

          <DatePicker
            label="Installation date (disabled)"
            value={null}
            onChange={() => {}}
            disabled
            slotProps={{
              textField: {
                helperText: 'Date is locked once the order is confirmed.',
                fullWidth: true,
              },
            }}
          />
        </Stack>
      </LocalizationProvider>
    );
  },
};

export const DateRangePickerField: Story = {
  name: 'DateRangePicker',
  render: () => {
    const [visitRange, setVisitRange] = useState<DateRange<Dayjs>>([null, null]);
    const [filtRange, setFiltRange] = useState<DateRange<Dayjs>>([
      dayjs().startOf('month'),
      dayjs().endOf('month'),
    ]);
    const [errRange, setErrRange] = useState<DateRange<Dayjs>>([null, null]);

    const fmt = (d: Dayjs | null) => (d ? d.format('DD MMM YYYY') : '—');

    const [errStart, errEnd] = errRange;
    const bothSet = errStart !== null && errEnd !== null;
    const rangeInvalid = bothSet && errStart.isAfter(errEnd);

    return (
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <Stack spacing={4} sx={{ maxWidth: 560 }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>DateRangePicker</Typography>

          <Box>
            <Typography variant="subtitle2" gutterBottom>Default — schedule a site visit window</Typography>
            <DateRangePicker
              value={visitRange}
              onChange={(newValue) => setVisitRange(newValue)}
              localeText={{ start: 'Visit start', end: 'Visit end' }}
              slotProps={{
                textField: { size: 'small', fullWidth: true },
              }}
            />
            {(visitRange[0] || visitRange[1]) && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
                Selected: {fmt(visitRange[0])} – {fmt(visitRange[1])}
              </Typography>
            )}
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>Pre-filled — filter reports by date range</Typography>
            <DateRangePicker
              value={filtRange}
              onChange={(newValue) => setFiltRange(newValue)}
              localeText={{ start: 'From', end: 'To' }}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
              Showing: {fmt(filtRange[0])} – {fmt(filtRange[1])}
            </Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>Error / validation state — both fields required</Typography>
            <DateRangePicker
              value={errRange}
              onChange={(newValue) => setErrRange(newValue)}
              localeText={{ start: 'Start date', end: 'End date' }}
              slotProps={{
                textField: (ownerState: FieldOwnerState) => {
                  const pos = (ownerState as FieldOwnerState & { position?: RangePosition }).position;
                  return {
                    size: 'small' as const,
                    fullWidth: true,
                    error:
                      (pos === 'start' && errStart === null) ||
                      (pos === 'end' && errEnd === null) ||
                      rangeInvalid,
                    helperText:
                      pos === 'start' && errStart === null
                        ? 'Start date is required.'
                        : pos === 'end' && errEnd === null
                        ? 'End date is required.'
                        : rangeInvalid
                        ? pos === 'start'
                          ? 'Must be before end date.'
                          : 'Must be after start date.'
                        : undefined,
                  };
                },
              }}
            />
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>Disabled — locked delivery window</Typography>
            <DateRangePicker
              value={[dayjs('2026-06-10'), dayjs('2026-06-17')]}
              onChange={() => {}}
              disabled
              localeText={{ start: 'Delivery from', end: 'Delivery to' }}
              slotProps={{
                textField: {
                  size: 'small',
                  fullWidth: true,
                  helperText: 'Locked after order confirmation.',
                },
              }}
            />
          </Box>
        </Stack>
      </LocalizationProvider>
    );
  },
};

export const TimePickerField: Story = {
  name: 'TimePicker',
  render: () => {
    const [arrivalTime, setArrivalTime] = useState<Dayjs | null>(null);
    const [startTime, setStartTime] = useState<Dayjs | null>(dayjs().hour(9).minute(0).second(0));
    const [deliveryTime, setDeliveryTime] = useState<Dayjs | null>(null);

    return (
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <Stack spacing={3} sx={{ maxWidth: 400 }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>TimePicker</Typography>

          <TimePicker
            label="Arrival time"
            value={arrivalTime}
            onChange={(v) => setArrivalTime(v)}
            slotProps={{
              textField: {
                helperText: arrivalTime
                  ? `Arrives at ${arrivalTime.format('h:mm A')}`
                  : 'Pick a time for the design visit',
                fullWidth: true,
              },
            }}
          />

          <TimePicker
            label="Start time (pre-filled)"
            value={startTime}
            onChange={(v) => setStartTime(v)}
            slotProps={{
              textField: {
                helperText: startTime ? `Selected: ${startTime.format('h:mm A')}` : undefined,
                fullWidth: true,
              },
            }}
          />

          <TimePicker
            label="Delivery time (error)"
            value={deliveryTime}
            onChange={(v) => setDeliveryTime(v)}
            slotProps={{
              textField: {
                error: deliveryTime === null,
                helperText: deliveryTime === null ? 'A delivery time is required.' : undefined,
                fullWidth: true,
              },
            }}
          />

          <TimePicker
            label="Installation time (disabled)"
            value={null}
            onChange={() => {}}
            disabled
            slotProps={{
              textField: {
                helperText: 'Time is locked once the order is confirmed.',
                fullWidth: true,
              },
            }}
          />
        </Stack>
      </LocalizationProvider>
    );
  },
};

export const TimeRangePickerField: Story = {
  name: 'TimeRangePicker',
  render: () => {
    const [visitRange, setVisitRange] = useState<DateRange<Dayjs>>([null, null]);
    const [slotRange, setSlotRange] = useState<DateRange<Dayjs>>([
      dayjs().hour(9).minute(0).second(0),
      dayjs().hour(17).minute(0).second(0),
    ]);
    const [errRange, setErrRange] = useState<DateRange<Dayjs>>([null, null]);

    const fmt = (d: Dayjs | null) => (d ? d.format('h:mm A') : '—');

    const [errStart, errEnd] = errRange;
    const bothSet = errStart !== null && errEnd !== null;
    const rangeInvalid = bothSet && !errEnd.isAfter(errStart);

    return (
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <Stack spacing={4} sx={{ maxWidth: 560 }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>TimeRangePicker</Typography>

          <Box>
            <Typography variant="subtitle2" gutterBottom>Default — schedule a design visit window</Typography>
            <TimeRangePicker
              value={visitRange}
              onChange={(v) => setVisitRange(v)}
              localeText={{ start: 'Visit start', end: 'Visit end' }}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
            {(visitRange[0] || visitRange[1]) && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
                Selected: {fmt(visitRange[0])} – {fmt(visitRange[1])}
              </Typography>
            )}
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>Pre-filled — standard working hours</Typography>
            <TimeRangePicker
              value={slotRange}
              onChange={(v) => setSlotRange(v)}
              localeText={{ start: 'From', end: 'To' }}
              slotProps={{ textField: { size: 'small', fullWidth: true } }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
              Slot: {fmt(slotRange[0])} – {fmt(slotRange[1])}
            </Typography>
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>Error / validation — end must be after start</Typography>
            <TimeRangePicker
              value={errRange}
              onChange={(v) => setErrRange(v)}
              localeText={{ start: 'Start time', end: 'End time' }}
              slotProps={{
                textField: (ownerState: FieldOwnerState) => {
                  const pos = (ownerState as FieldOwnerState & { position?: RangePosition }).position;
                  return {
                    size: 'small' as const,
                    fullWidth: true,
                    error:
                      (pos === 'start' && errStart === null) ||
                      (pos === 'end' && errEnd === null) ||
                      rangeInvalid,
                    helperText:
                      pos === 'start' && errStart === null
                        ? 'Start time is required.'
                        : pos === 'end' && errEnd === null
                        ? 'End time is required.'
                        : rangeInvalid
                        ? pos === 'start'
                          ? 'Must be before end time.'
                          : 'Must be after start time.'
                        : undefined,
                  };
                },
              }}
            />
          </Box>

          <Box>
            <Typography variant="subtitle2" gutterBottom>Disabled — locked installation slot</Typography>
            <TimeRangePicker
              value={[dayjs().hour(10).minute(0).second(0), dayjs().hour(14).minute(0).second(0)]}
              onChange={() => {}}
              disabled
              localeText={{ start: 'Start', end: 'End' }}
              slotProps={{
                textField: {
                  size: 'small',
                  fullWidth: true,
                  helperText: 'Locked after order confirmation.',
                },
              }}
            />
          </Box>
        </Stack>
      </LocalizationProvider>
    );
  },
};
