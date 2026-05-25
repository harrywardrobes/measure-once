import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';

import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Chip from '@mui/material/Chip';
import Avatar from '@mui/material/Avatar';

import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActions from '@mui/material/CardActions';
import Paper from '@mui/material/Paper';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemText from '@mui/material/ListItemText';
import ListItemAvatar from '@mui/material/ListItemAvatar';
import Skeleton from '@mui/material/Skeleton';
import Divider from '@mui/material/Divider';

import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Tooltip from '@mui/material/Tooltip';
import Menu from '@mui/material/Menu';

import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Drawer from '@mui/material/Drawer';

import DeleteIcon from '@mui/icons-material/Delete';
import FavoriteIcon from '@mui/icons-material/Favorite';
import HomeIcon from '@mui/icons-material/Home';
import PersonIcon from '@mui/icons-material/Person';
import SettingsIcon from '@mui/icons-material/Settings';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import MenuIcon from '@mui/icons-material/Menu';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import SaveIcon from '@mui/icons-material/Save';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';
import InfoIcon from '@mui/icons-material/Info';
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty';
import EmailIcon from '@mui/icons-material/Email';
import PhoneIcon from '@mui/icons-material/Phone';
import EventIcon from '@mui/icons-material/Event';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import DescriptionIcon from '@mui/icons-material/Description';
import ImageIcon from '@mui/icons-material/Image';

import { ComponentShowcase } from '../components/mui/ComponentShowcase';

/**
 * <DesignSystemPage/> — MUI-first docs showcase of the components we
 * intend to use on the migrated React pages. Grouped by category in
 * the same way the MUI docs site is. Each entry has a live demo plus
 * a "Show code" toggle revealing the JSX snippet.
 *
 * Adding a new component: pick the right category, add a
 * <ComponentShowcase> entry with a `demo` (the live JSX) and a `code`
 * string (the snippet shown to admins). Keep the snippet small and
 * paste-ready — this page is a recipe book, not exhaustive API docs.
 */

const CATEGORIES = ['Inputs', 'Data Display', 'Feedback', 'Navigation', 'Surfaces', 'Layout', 'Icons'] as const;
type Category = typeof CATEGORIES[number];

function StorybookLink() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/storybook/index.html', { method: 'HEAD' })
      .then((r) => { if (!cancelled && r && r.ok) setAvailable(true); })
      .catch(() => { /* swallow — link stays hidden */ });
    return () => { cancelled = true; };
  }, []);
  if (!available) return null;
  return (
    <Link href="/storybook/" target="_blank" rel="noopener" sx={{ fontWeight: 600 }}>
      Open Storybook →
    </Link>
  );
}

// --- Demo helpers (kept tiny — each lives inside its showcase) ---------

function MenuDemo() {
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  return (
    <>
      <Button variant="outlined" onClick={(e) => setAnchorEl(e.currentTarget)}>
        Open menu
      </Button>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
        <MenuItem onClick={() => setAnchorEl(null)}>Profile</MenuItem>
        <MenuItem onClick={() => setAnchorEl(null)}>Settings</MenuItem>
        <MenuItem onClick={() => setAnchorEl(null)}>Sign out</MenuItem>
      </Menu>
    </>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="contained" onClick={() => setOpen(true)}>Open dialog</Button>
      <Dialog open={open} onClose={() => setOpen(false)}>
        <DialogTitle>Delete contact?</DialogTitle>
        <DialogContent>
          <DialogContentText>This action cannot be undone.</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={() => setOpen(false)}>Delete</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function SnackbarDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outlined" onClick={() => setOpen(true)}>Show snackbar</Button>
      <Snackbar
        open={open}
        autoHideDuration={2500}
        onClose={() => setOpen(false)}
        message="Saved ✓"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </>
  );
}

function DrawerDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outlined" onClick={() => setOpen(true)}>Open drawer</Button>
      <Drawer anchor="right" open={open} onClose={() => setOpen(false)}>
        <Box sx={{ width: 280, p: 2 }} role="presentation" onClick={() => setOpen(false)}>
          <Typography variant="h6" sx={{ mb: 1 }}>Filters</Typography>
          <List>
            <ListItem><ListItemText primary="All customers" /></ListItem>
            <ListItem><ListItemText primary="Sales stage" /></ListItem>
            <ListItem><ListItemText primary="Workshop" /></ListItem>
          </List>
        </Box>
      </Drawer>
    </>
  );
}

// --- Icons showcase helper ---------------------------------------------

interface IconEntry { Icon: React.ComponentType<{ fontSize?: 'small' | 'medium' | 'large' }>; name: string; }

function IconShowcase({ name, description, icons }: { name: string; description: string; icons: IconEntry[] }) {
  const [open, setOpen] = useState(false);
  const code = icons
    .map((i) => `import ${i.name}Icon from '@mui/icons-material/${i.name}';`)
    .join('\n');
  return (
    <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h6" component="h3" sx={{ fontWeight: 700 }}>{name}</Typography>
        <Button size="small" onClick={() => setOpen((v) => !v)}>{open ? 'Hide imports' : 'Show imports'}</Button>
      </Box>
      <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>{description}</Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 1.5 }}>
        {icons.map(({ Icon, name: iconName }) => (
          <Box
            key={iconName}
            sx={{
              p: 1.5,
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 0.75,
              bgcolor: 'background.paper',
            }}
          >
            <Icon fontSize="large" />
            <Typography
              variant="caption"
              sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'text.secondary', textAlign: 'center' }}
            >
              {iconName}Icon
            </Typography>
          </Box>
        ))}
      </Box>
      {open && (
        <Box
          component="pre"
          sx={{
            mt: 1.5, m: 0, p: 2, bgcolor: '#0f172a', color: '#e2e8f0',
            borderRadius: 1, overflow: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 12.5, lineHeight: 1.5,
          }}
        >
          <code>{code}</code>
        </Box>
      )}
    </Paper>
  );
}

// --- Page ---------------------------------------------------------------

export function DesignSystemPage() {
  const [tab, setTab] = useState<Category>('Inputs');

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: 700, mb: 0.5 }}>
          Design System
        </Typography>
        <Typography variant="body1" sx={{ color: 'text.secondary' }}>
          Live MUI component showcase for the Measure Once dashboard. Each entry has a working
          demo plus a copy-ready JSX snippet. <StorybookLink />
        </Typography>
      </Box>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v as Category)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        {CATEGORIES.map((c) => <Tab key={c} value={c} label={c} />)}
      </Tabs>

      {tab === 'Inputs' && (
        <>
          <ComponentShowcase
            name="Button"
            description="Primary call-to-action. Use `variant=contained` for the main action, `outlined` for secondary, `text` for tertiary."
            demo={
              <>
                <Button variant="contained">Save</Button>
                <Button variant="outlined">Cancel</Button>
                <Button variant="text">Skip</Button>
                <Button variant="contained" color="error">Delete</Button>
                <Button variant="contained" disabled>Disabled</Button>
              </>
            }
            code={`<Button variant="contained">Save</Button>
<Button variant="outlined">Cancel</Button>
<Button variant="text">Skip</Button>
<Button variant="contained" color="error">Delete</Button>`}
          />
          <ComponentShowcase
            name="IconButton"
            description="Compact icon-only action. Always pair with a Tooltip for screen-reader-friendly labels."
            demo={
              <>
                <Tooltip title="Favourite"><IconButton><FavoriteIcon /></IconButton></Tooltip>
                <Tooltip title="Delete"><IconButton color="error"><DeleteIcon /></IconButton></Tooltip>
                <Tooltip title="Settings"><IconButton><SettingsIcon /></IconButton></Tooltip>
              </>
            }
            code={`<Tooltip title="Delete">
  <IconButton color="error"><DeleteIcon /></IconButton>
</Tooltip>`}
          />
          <ComponentShowcase
            name="TextField"
            description="Standard form input. Use `size=small` inside dense admin forms."
            demo={
              <>
                <TextField label="Customer name" size="small" />
                <TextField label="Email" type="email" size="small" defaultValue="lead@example.com" />
                <TextField label="Notes" multiline rows={2} size="small" sx={{ minWidth: 240 }} />
              </>
            }
            code={`<TextField label="Customer name" size="small" />
<TextField label="Notes" multiline rows={2} size="small" />`}
          />
          <ComponentShowcase
            name="Select"
            description="Use TextField with `select` for inline forms — same look as the other inputs."
            demo={
              <TextField select label="Stage" size="small" defaultValue="sales" sx={{ minWidth: 200 }}>
                <MenuItem value="sales">Sales</MenuItem>
                <MenuItem value="design">Design visit</MenuItem>
                <MenuItem value="workshop">Workshop</MenuItem>
              </TextField>
            }
            code={`<TextField select label="Stage" size="small" defaultValue="sales">
  <MenuItem value="sales">Sales</MenuItem>
  <MenuItem value="design">Design visit</MenuItem>
  <MenuItem value="workshop">Workshop</MenuItem>
</TextField>`}
          />
          <ComponentShowcase
            name="Checkbox"
            description="Boolean choice. Wrap in `FormControlLabel` for an aligned label."
            demo={
              <>
                <FormControlLabel control={<Checkbox defaultChecked />} label="Send confirmation email" />
                <FormControlLabel control={<Checkbox />} label="Include in next batch" />
              </>
            }
            code={`<FormControlLabel
  control={<Checkbox defaultChecked />}
  label="Send confirmation email"
/>`}
          />
          <ComponentShowcase
            name="Switch"
            description="Use for settings that take effect immediately (no Save button)."
            demo={
              <>
                <FormControlLabel control={<Switch defaultChecked />} label="Notifications" />
                <FormControlLabel control={<Switch />} label="Dev filter" />
              </>
            }
            code={`<FormControlLabel
  control={<Switch defaultChecked />}
  label="Notifications"
/>`}
          />
        </>
      )}

      {tab === 'Data Display' && (
        <>
          <ComponentShowcase
            name="Chip"
            description="Compact status / metadata pill. Pick a `color` to convey meaning."
            demo={
              <>
                <Chip label="Active" color="success" />
                <Chip label="Pending" color="warning" />
                <Chip label="Failed" color="error" />
                <Chip label="Info" color="info" />
                <Chip label="Removable" onDelete={() => { /* noop */ }} />
              </>
            }
            code={`<Chip label="Active" color="success" />
<Chip label="Removable" onDelete={handleDelete} />`}
          />
          <ComponentShowcase
            name="Avatar"
            description="Initials or photo for users / contacts."
            demo={
              <>
                <Avatar>HW</Avatar>
                <Avatar sx={{ bgcolor: 'primary.main' }}><PersonIcon /></Avatar>
                <Avatar sx={{ bgcolor: 'secondary.main' }}>MO</Avatar>
              </>
            }
            code={`<Avatar>HW</Avatar>
<Avatar sx={{ bgcolor: 'primary.main' }}><PersonIcon /></Avatar>`}
          />
          <ComponentShowcase
            name="Table"
            description="Data grid for admin lists. Wrap in `TableContainer` + `Paper` for the standard surface."
            demo={
              <TableContainer component={Paper} variant="outlined" sx={{ width: '100%' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Customer</TableCell>
                      <TableCell>Stage</TableCell>
                      <TableCell align="right">Estimate</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    <TableRow><TableCell>Alice</TableCell><TableCell>Sales</TableCell><TableCell align="right">£2,400</TableCell></TableRow>
                    <TableRow><TableCell>Bob</TableCell><TableCell>Workshop</TableCell><TableCell align="right">£5,180</TableCell></TableRow>
                  </TableBody>
                </Table>
              </TableContainer>
            }
            code={`<TableContainer component={Paper} variant="outlined">
  <Table size="small">
    <TableHead>
      <TableRow>
        <TableCell>Customer</TableCell>
        <TableCell>Stage</TableCell>
      </TableRow>
    </TableHead>
    <TableBody>
      {rows.map((r) => (
        <TableRow key={r.id}>
          <TableCell>{r.name}</TableCell>
          <TableCell>{r.stage}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
</TableContainer>`}
          />
          <ComponentShowcase
            name="List"
            description="Vertical record list — lighter than a Table for short, mostly-text rows."
            demo={
              <List sx={{ width: 320, bgcolor: 'background.paper' }}>
                <ListItem>
                  <ListItemAvatar><Avatar><PersonIcon /></Avatar></ListItemAvatar>
                  <ListItemText primary="Alice Carter" secondary="Sales · 2 days ago" />
                </ListItem>
                <Divider variant="inset" component="li" />
                <ListItem>
                  <ListItemAvatar><Avatar><PersonIcon /></Avatar></ListItemAvatar>
                  <ListItemText primary="Bob Singh" secondary="Workshop · 4 days ago" />
                </ListItem>
              </List>
            }
            code={`<List>
  <ListItem>
    <ListItemAvatar><Avatar><PersonIcon /></Avatar></ListItemAvatar>
    <ListItemText primary="Alice Carter" secondary="Sales · 2 days ago" />
  </ListItem>
</List>`}
          />
          <ComponentShowcase
            name="Skeleton"
            description="Loading placeholder. Match the shape (`text`, `rectangular`, `circular`) of the real content."
            demo={
              <Box sx={{ width: '100%' }}>
                <Skeleton variant="text" width="60%" />
                <Skeleton variant="text" width="100%" />
                <Skeleton variant="rectangular" height={56} sx={{ mt: 1 }} />
              </Box>
            }
            code={`<Skeleton variant="text" width="60%" />
<Skeleton variant="rectangular" height={56} />`}
          />
        </>
      )}

      {tab === 'Feedback' && (
        <>
          <ComponentShowcase
            name="Alert"
            description="Inline status message. Severity sets the colour and icon."
            demo={
              <Stack spacing={1} sx={{ width: '100%' }}>
                <Alert severity="success">Saved successfully.</Alert>
                <Alert severity="info">QuickBooks connected.</Alert>
                <Alert severity="warning">No HubSpot token configured.</Alert>
                <Alert severity="error">Could not load contacts.</Alert>
              </Stack>
            }
            code={`<Alert severity="success">Saved successfully.</Alert>
<Alert severity="error">Could not load contacts.</Alert>`}
          />
          <ComponentShowcase
            name="Dialog"
            description="Modal for confirmations and short forms. Pair with `DialogActions` for primary/secondary buttons."
            demo={<DialogDemo />}
            code={`const [open, setOpen] = useState(false);

<Dialog open={open} onClose={() => setOpen(false)}>
  <DialogTitle>Delete contact?</DialogTitle>
  <DialogContent>
    <DialogContentText>This action cannot be undone.</DialogContentText>
  </DialogContent>
  <DialogActions>
    <Button onClick={() => setOpen(false)}>Cancel</Button>
    <Button color="error" variant="contained">Delete</Button>
  </DialogActions>
</Dialog>`}
          />
          <ComponentShowcase
            name="Snackbar"
            description="Transient toast. Default position is bottom-centre; auto-hide after a few seconds."
            demo={<SnackbarDemo />}
            code={`<Snackbar
  open={open}
  autoHideDuration={2500}
  onClose={() => setOpen(false)}
  message="Saved ✓"
/>`}
          />
          <ComponentShowcase
            name="Tooltip"
            description="Reveal-on-hover label. Required around IconButtons for accessibility."
            demo={
              <Tooltip title="Refresh the table"><Button variant="outlined">Hover me</Button></Tooltip>
            }
            code={`<Tooltip title="Refresh the table">
  <Button variant="outlined">Hover me</Button>
</Tooltip>`}
          />
        </>
      )}

      {tab === 'Navigation' && (
        <>
          <ComponentShowcase
            name="Tabs"
            description="Sectioned navigation within a page. Use `variant=scrollable` for long lists."
            demo={
              <Box sx={{ width: '100%' }}>
                <Tabs value={0} onChange={() => { /* demo */ }} sx={{ borderBottom: 1, borderColor: 'divider' }}>
                  <Tab label="Sales" />
                  <Tab label="Design visit" />
                  <Tab label="Survey" />
                  <Tab label="Workshop" />
                </Tabs>
              </Box>
            }
            code={`<Tabs value={tab} onChange={(_, v) => setTab(v)}>
  <Tab label="Sales" />
  <Tab label="Workshop" />
</Tabs>`}
          />
          <ComponentShowcase
            name="AppBar"
            description="Top bar — usually paired with `Toolbar` and a leading menu icon."
            demo={
              <Box sx={{ width: '100%' }}>
                <AppBar position="static" color="default" elevation={0} sx={{ borderRadius: 1 }}>
                  <Toolbar variant="dense">
                    <IconButton edge="start" sx={{ mr: 1 }}><MenuIcon /></IconButton>
                    <Typography variant="h6" sx={{ flexGrow: 1 }}>Measure Once</Typography>
                    <IconButton><HomeIcon /></IconButton>
                  </Toolbar>
                </AppBar>
              </Box>
            }
            code={`<AppBar position="static" color="default">
  <Toolbar>
    <IconButton edge="start"><MenuIcon /></IconButton>
    <Typography sx={{ flexGrow: 1 }}>Measure Once</Typography>
  </Toolbar>
</AppBar>`}
          />
          <ComponentShowcase
            name="Drawer"
            description="Side panel for filters / settings. Anchor to whichever edge fits the page."
            demo={<DrawerDemo />}
            code={`<Drawer anchor="right" open={open} onClose={() => setOpen(false)}>
  <Box sx={{ width: 280, p: 2 }}>{/* contents */}</Box>
</Drawer>`}
          />
          <ComponentShowcase
            name="Menu"
            description="Pop-up of action options anchored to a trigger."
            demo={<MenuDemo />}
            code={`const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

<Button onClick={(e) => setAnchorEl(e.currentTarget)}>Open</Button>
<Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
  <MenuItem>Profile</MenuItem>
  <MenuItem>Sign out</MenuItem>
</Menu>`}
          />
        </>
      )}

      {tab === 'Surfaces' && (
        <>
          <ComponentShowcase
            name="Paper"
            description="Base surface — pick `variant=outlined` for the muted admin look, `elevation` for raised cards."
            demo={
              <>
                <Paper variant="outlined" sx={{ p: 2, minWidth: 200 }}>Outlined</Paper>
                <Paper elevation={1} sx={{ p: 2, minWidth: 200 }}>Elevation 1</Paper>
                <Paper elevation={4} sx={{ p: 2, minWidth: 200 }}>Elevation 4</Paper>
              </>
            }
            code={`<Paper variant="outlined" sx={{ p: 2 }}>Outlined</Paper>
<Paper elevation={1} sx={{ p: 2 }}>Elevation</Paper>`}
          />
          <ComponentShowcase
            name="Card"
            description="Structured surface with content + actions. The standard wrapper for admin record blocks."
            demo={
              <Card variant="outlined" sx={{ minWidth: 280 }}>
                <CardContent>
                  <Typography variant="overline" color="text.secondary">Customer</Typography>
                  <Typography variant="h6">Alice Carter</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Stage: Sales · last touched 2 days ago
                  </Typography>
                </CardContent>
                <CardActions>
                  <Button size="small">Open</Button>
                  <IconButton size="small"><MoreVertIcon /></IconButton>
                </CardActions>
              </Card>
            }
            code={`<Card variant="outlined">
  <CardContent>
    <Typography variant="h6">{name}</Typography>
    <Typography variant="body2" color="text.secondary">{summary}</Typography>
  </CardContent>
  <CardActions>
    <Button size="small">Open</Button>
  </CardActions>
</Card>`}
          />
        </>
      )}

      {tab === 'Icons' && (
        <>
          <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Icons come from <code>@mui/icons-material</code> — one named
              export per icon. Browse the full set at{' '}
              <Link href="https://mui.com/material-ui/material-icons/" target="_blank" rel="noopener">
                mui.com/material-ui/material-icons
              </Link>{' '}
              and import directly:{' '}
              <code>{`import DeleteIcon from '@mui/icons-material/Delete';`}</code>.
              Do not add new inline <code>&lt;svg&gt;</code> blocks in React code
              — see <code>src/react/ICONS.md</code> for the full convention.
            </Typography>
          </Paper>

          <IconShowcase
            name="Actions"
            description="Verbs the user performs — buttons, menu items, row actions."
            icons={[
              { Icon: AddIcon, name: 'Add' },
              { Icon: EditIcon, name: 'Edit' },
              { Icon: DeleteIcon, name: 'Delete' },
              { Icon: SaveIcon, name: 'Save' },
              { Icon: CloseIcon, name: 'Close' },
              { Icon: SearchIcon, name: 'Search' },
              { Icon: RefreshIcon, name: 'Refresh' },
              { Icon: ContentCopyIcon, name: 'ContentCopy' },
              { Icon: MoreVertIcon, name: 'MoreVert' },
            ]}
          />

          <IconShowcase
            name="Navigation"
            description="Move between views, expand sections, open in a new tab."
            icons={[
              { Icon: MenuIcon, name: 'Menu' },
              { Icon: HomeIcon, name: 'Home' },
              { Icon: ArrowBackIcon, name: 'ArrowBack' },
              { Icon: ArrowForwardIcon, name: 'ArrowForward' },
              { Icon: ChevronLeftIcon, name: 'ChevronLeft' },
              { Icon: ChevronRightIcon, name: 'ChevronRight' },
              { Icon: ExpandMoreIcon, name: 'ExpandMore' },
              { Icon: OpenInNewIcon, name: 'OpenInNew' },
            ]}
          />

          <IconShowcase
            name="Status"
            description="Convey state — success, error, warning, pending — usually inline with text or in a Chip."
            icons={[
              { Icon: CheckCircleIcon, name: 'CheckCircle' },
              { Icon: ErrorIcon, name: 'Error' },
              { Icon: WarningIcon, name: 'Warning' },
              { Icon: InfoIcon, name: 'Info' },
              { Icon: HourglassEmptyIcon, name: 'HourglassEmpty' },
              { Icon: FavoriteIcon, name: 'Favorite' },
            ]}
          />

          <IconShowcase
            name="Content"
            description="Glyphs for record types — contacts, calendar events, files, communications."
            icons={[
              { Icon: PersonIcon, name: 'Person' },
              { Icon: EmailIcon, name: 'Email' },
              { Icon: PhoneIcon, name: 'Phone' },
              { Icon: EventIcon, name: 'Event' },
              { Icon: AttachFileIcon, name: 'AttachFile' },
              { Icon: DescriptionIcon, name: 'Description' },
              { Icon: ImageIcon, name: 'Image' },
              { Icon: SettingsIcon, name: 'Settings' },
            ]}
          />
        </>
      )}

      {tab === 'Layout' && (
        <>
          <ComponentShowcase
            name="Box"
            description="The atomic layout primitive. Use `sx` for one-off styles; reach for `Stack` when you have a list of children."
            demo={
              <Box sx={{ p: 2, bgcolor: 'primary.light', color: 'primary.contrastText', borderRadius: 1 }}>
                Box with sx
              </Box>
            }
            code={`<Box sx={{ p: 2, bgcolor: 'primary.light', borderRadius: 1 }}>
  Box with sx
</Box>`}
          />
          <ComponentShowcase
            name="Stack"
            description="Flex container with a `spacing` prop. Use `direction=row` for horizontal layouts."
            demo={
              <Stack direction="row" spacing={2} sx={{ width: '100%' }}>
                <Paper variant="outlined" sx={{ p: 2, flex: 1 }}>One</Paper>
                <Paper variant="outlined" sx={{ p: 2, flex: 1 }}>Two</Paper>
                <Paper variant="outlined" sx={{ p: 2, flex: 1 }}>Three</Paper>
              </Stack>
            }
            code={`<Stack direction="row" spacing={2}>
  <Paper>One</Paper>
  <Paper>Two</Paper>
</Stack>`}
          />
          <ComponentShowcase
            name="Container"
            description="Centred, max-width wrapper for top-level page content."
            demo={
              <Container maxWidth="sm" sx={{ bgcolor: 'background.paper', py: 2 }}>
                <Typography>Centred at maxWidth=&quot;sm&quot;</Typography>
              </Container>
            }
            code={`<Container maxWidth="lg" sx={{ py: 3 }}>
  {/* page contents */}
</Container>`}
          />
          <ComponentShowcase
            name="Divider"
            description="Visual separator between sections or list rows."
            demo={
              <Box sx={{ width: '100%' }}>
                <Typography>Above</Typography>
                <Divider sx={{ my: 1 }} />
                <Typography>Below</Typography>
              </Box>
            }
            code={`<Divider sx={{ my: 1 }} />`}
          />
        </>
      )}
    </Container>
  );
}

export default DesignSystemPage;
