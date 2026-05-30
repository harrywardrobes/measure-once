import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/Delete';
import DescriptionIcon from '@mui/icons-material/Description';
import EditIcon from '@mui/icons-material/Edit';
import EmailIcon from '@mui/icons-material/Email';
import ErrorIcon from '@mui/icons-material/Error';
import EventIcon from '@mui/icons-material/Event';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FavoriteIcon from '@mui/icons-material/Favorite';
import HomeIcon from '@mui/icons-material/Home';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import ImageIcon from '@mui/icons-material/Image';
import InfoIcon from '@mui/icons-material/Info';
import MailIcon from '@mui/icons-material/Mail';
import MenuIcon from '@mui/icons-material/Menu';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import NotificationsIcon from '@mui/icons-material/Notifications';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import PersonIcon from '@mui/icons-material/Person';
import PhoneIcon from '@mui/icons-material/Phone';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import SearchIcon from '@mui/icons-material/Search';
import SettingsIcon from '@mui/icons-material/Settings';
import WarningIcon from '@mui/icons-material/Warning';

const meta: Meta = {
  title: 'Foundations/Icons',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

type IconEntry = { Icon: React.ComponentType<{ fontSize?: 'small' | 'medium' | 'large' }>; name: string };

function IconGrid({ title, icons }: { title: string; icons: IconEntry[] }) {
  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>{title}</Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
        {icons.map(({ Icon, name }) => (
          <Paper
            key={name}
            variant="outlined"
            sx={{ p: 1.5, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, minWidth: 80 }}
          >
            <Icon fontSize="medium" />
            <Typography variant="caption" sx={{ fontFamily: (theme) => theme.typography.monoFontFamily, fontSize: 10, textAlign: 'center' }}>
              {name}
            </Typography>
          </Paper>
        ))}
      </Box>
    </Box>
  );
}

const ACTIONS: IconEntry[] = [
  { Icon: AddIcon, name: 'Add' },
  { Icon: EditIcon, name: 'Edit' },
  { Icon: DeleteIcon, name: 'Delete' },
  { Icon: SaveIcon, name: 'Save' },
  { Icon: CloseIcon, name: 'Close' },
  { Icon: SearchIcon, name: 'Search' },
  { Icon: RefreshIcon, name: 'Refresh' },
  { Icon: ContentCopyIcon, name: 'ContentCopy' },
  { Icon: MoreVertIcon, name: 'MoreVert' },
];

const NAVIGATION: IconEntry[] = [
  { Icon: MenuIcon, name: 'Menu' },
  { Icon: HomeIcon, name: 'Home' },
  { Icon: ArrowBackIcon, name: 'ArrowBack' },
  { Icon: ArrowForwardIcon, name: 'ArrowForward' },
  { Icon: ChevronLeftIcon, name: 'ChevronLeft' },
  { Icon: ChevronRightIcon, name: 'ChevronRight' },
  { Icon: ExpandMoreIcon, name: 'ExpandMore' },
  { Icon: OpenInNewIcon, name: 'OpenInNew' },
];

const STATUS: IconEntry[] = [
  { Icon: CheckCircleIcon, name: 'CheckCircle' },
  { Icon: ErrorIcon, name: 'Error' },
  { Icon: WarningIcon, name: 'Warning' },
  { Icon: InfoIcon, name: 'Info' },
  { Icon: HourglassEmptyIcon, name: 'HourglassEmpty' },
  { Icon: FavoriteIcon, name: 'Favorite' },
];

const CONTENT: IconEntry[] = [
  { Icon: PersonIcon, name: 'Person' },
  { Icon: MailIcon, name: 'Mail' },
  { Icon: NotificationsIcon, name: 'Notifications' },
  { Icon: EmailIcon, name: 'Email' },
  { Icon: PhoneIcon, name: 'Phone' },
  { Icon: EventIcon, name: 'Event' },
  { Icon: CalendarTodayIcon, name: 'CalendarToday' },
  { Icon: AttachFileIcon, name: 'AttachFile' },
  { Icon: DescriptionIcon, name: 'Description' },
  { Icon: ImageIcon, name: 'Image' },
  { Icon: SettingsIcon, name: 'Settings' },
];

export const AllGroups: Story = {
  name: 'All Icons',
  render: () => (
    <Box>
      <IconGrid title="Actions" icons={ACTIONS} />
      <IconGrid title="Navigation" icons={NAVIGATION} />
      <IconGrid title="Status" icons={STATUS} />
      <IconGrid title="Content" icons={CONTENT} />

      <Box sx={{ mb: 4 }}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>Icon sizes</Typography>
        <Stack direction="row" spacing={3} sx={{ alignItems: 'center' }}>
          <Box sx={{ textAlign: 'center' }}>
            <SearchIcon fontSize="small" />
            <Typography variant="caption" sx={{ display: 'block', fontFamily: (theme) => theme.typography.monoFontFamily }}>small</Typography>
          </Box>
          <Box sx={{ textAlign: 'center' }}>
            <SearchIcon fontSize="medium" />
            <Typography variant="caption" sx={{ display: 'block', fontFamily: (theme) => theme.typography.monoFontFamily }}>medium</Typography>
          </Box>
          <Box sx={{ textAlign: 'center' }}>
            <SearchIcon fontSize="large" />
            <Typography variant="caption" sx={{ display: 'block', fontFamily: (theme) => theme.typography.monoFontFamily }}>large</Typography>
          </Box>
        </Stack>
      </Box>

      <Box>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>Icon colours</Typography>
        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
          {(['primary', 'secondary', 'action', 'error', 'warning', 'success', 'info', 'disabled'] as const).map((color) => (
            <Box key={color} sx={{ textAlign: 'center' }}>
              <SearchIcon color={color} />
              <Typography variant="caption" sx={{ display: 'block', fontFamily: (theme) => theme.typography.monoFontFamily, fontSize: 10 }}>{color}</Typography>
            </Box>
          ))}
        </Stack>
      </Box>
    </Box>
  ),
};
