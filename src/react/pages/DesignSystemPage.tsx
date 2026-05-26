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
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Chip from '@mui/material/Chip';
import Badge from '@mui/material/Badge';
import MailIcon from '@mui/icons-material/Mail';
import NotificationsIcon from '@mui/icons-material/Notifications';
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

import { useTheme } from '@mui/material/styles';

import { ComponentShowcase } from '../components/mui/ComponentShowcase';
import { Pill } from '../components/Pill';
import { EmptyState } from '../components/EmptyState';
import { BRAND_COLORS, STAGE_COLORS, RADIUS } from '../theme';
import { DesignVisitSignOffPage } from './DesignVisitSignOffPage';
import {
  PageLoadingSkeleton,
  CustomersPageSkeleton,
  CalendarPageSkeleton,
  HomePageSkeleton,
  ProfilePageSkeleton,
  AdminTeamPageSkeleton,
  AdminPermissionsPageSkeleton,
  AdminRequestsPageSkeleton,
  AdminAuditLogPageSkeleton,
  AdminSettingsPageSkeleton,
  CardActionsPageSkeleton,
  ActionHandlersPageSkeleton,
} from '../components/PageLoadingSkeleton';

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

const CATEGORIES = ['Tokens', 'Inputs', 'Data Display', 'Feedback', 'Navigation', 'Surfaces', 'Layout', 'Icons', 'Skeletons', 'Sign-off'] as const;
type Category = typeof CATEGORIES[number];

const SIGN_OFF_MOCK_DATA = {
  contactName: 'Jane Smith',
  visitDate: '2026-03-15',
  location: 'London',
  handleName: 'Brushed Nickel',
  furnitureRange: 'Shaker Classic',
  rooms: [
    { roomName: 'Kitchen', doorStyleName: 'Cream Gloss', unitCount: 12, totalPence: 1200000 },
    { roomName: 'Master Bedroom', doorStyleName: 'White Matt', unitCount: 6, totalPence: 600000 },
  ],
  terms: 'By signing off this design visit summary you confirm that the room measurements, door styles, furniture ranges, and unit counts listed above are correct to the best of your knowledge. Final pricing is subject to a full survey and may vary. Measure Once Ltd reserves the right to adjust the estimate following survey findings.',
  termsVersionNumber: 3,
};

// ── Icon catalogue ────────────────────────────────────────────────────────
// Defined here — before any JSX text containing apostrophes — so that the
// icon-lint scanner (which uses a simple single-quote string stripper) can
// reliably detect every import as used.

interface IconEntry { Icon: React.ComponentType<{ fontSize?: 'small' | 'medium' | 'large' }>; name: string; }

const ACTIONS_ICONS: IconEntry[] = [
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

const NAVIGATION_ICONS: IconEntry[] = [
  { Icon: MenuIcon, name: 'Menu' },
  { Icon: HomeIcon, name: 'Home' },
  { Icon: ArrowBackIcon, name: 'ArrowBack' },
  { Icon: ArrowForwardIcon, name: 'ArrowForward' },
  { Icon: ChevronLeftIcon, name: 'ChevronLeft' },
  { Icon: ChevronRightIcon, name: 'ChevronRight' },
  { Icon: ExpandMoreIcon, name: 'ExpandMore' },
  { Icon: OpenInNewIcon, name: 'OpenInNew' },
];

const STATUS_ICONS: IconEntry[] = [
  { Icon: CheckCircleIcon, name: 'CheckCircle' },
  { Icon: ErrorIcon, name: 'Error' },
  { Icon: WarningIcon, name: 'Warning' },
  { Icon: InfoIcon, name: 'Info' },
  { Icon: HourglassEmptyIcon, name: 'HourglassEmpty' },
  { Icon: FavoriteIcon, name: 'Favorite' },
];

const CONTENT_ICONS: IconEntry[] = [
  { Icon: PersonIcon, name: 'Person' },
  { Icon: MailIcon, name: 'Mail' },
  { Icon: NotificationsIcon, name: 'Notifications' },
  { Icon: EmailIcon, name: 'Email' },
  { Icon: PhoneIcon, name: 'Phone' },
  { Icon: EventIcon, name: 'Event' },
  { Icon: AttachFileIcon, name: 'AttachFile' },
  { Icon: DescriptionIcon, name: 'Description' },
  { Icon: ImageIcon, name: 'Image' },
  { Icon: SettingsIcon, name: 'Settings' },
];

// ── Token card helpers ───────────────────────────────────────────────────

function CodeRef({ children }: { children: React.ReactNode }) {
  return (
    <Box
      component="code"
      sx={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        bgcolor: 'grey.100',
        color: 'text.primary',
        px: 0.75,
        py: 0.25,
        borderRadius: 0.5,
        border: '1px solid',
        borderColor: 'divider',
        wordBreak: 'break-all',
      }}
    >
      {children}
    </Box>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Tooltip title={copied ? 'Copied' : 'Copy'}>
        <IconButton
          size="small"
          onClick={async () => {
            try { await navigator.clipboard.writeText(text); setCopied(true); } catch { /* ignore */ }
          }}
          aria-label={`Copy ${text}`}
        >
          <ContentCopyIcon fontSize="inherit" />
        </IconButton>
      </Tooltip>
      <Snackbar
        open={copied}
        autoHideDuration={1200}
        onClose={() => setCopied(false)}
        message="Copied to clipboard"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </>
  );
}

interface SwatchCardProps {
  name: string;
  hex: string;
  themePath: string;
  cssVar: string;
}

function resolveCssVar(cssVar: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
}

function useLiveCssVar(cssVar: string, fallback: string): string {
  const [value, setValue] = useState<string>(() => resolveCssVar(cssVar) || fallback);

  useEffect(() => {
    const update = () => {
      const live = resolveCssVar(cssVar);
      setValue(live || fallback);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, [cssVar, fallback]);

  return value;
}

interface StageColorRowProps {
  stageKey: string;
  fallback: Record<'bg' | 'light' | 'text', string>;
}

function StageColorRow({ stageKey, fallback }: StageColorRowProps) {
  const bg   = useLiveCssVar(`--stage-${stageKey}-bg`,    fallback.bg);
  const light = useLiveCssVar(`--stage-${stageKey}-light`, fallback.light);
  const text  = useLiveCssVar(`--stage-${stageKey}-text`,  fallback.text);
  const liveColors = { bg, light, text };

  return (
    <Paper variant="outlined" sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Box sx={{ minWidth: 140 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, textTransform: 'capitalize' }}>{stageKey}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'ui-monospace, monospace' }}>
          palette.stage.{stageKey}
        </Typography>
      </Box>
      <Chip
        size="small"
        label="Sample pill"
        sx={{ bgcolor: liveColors.light, color: liveColors.text, fontWeight: 600 }}
      />
      {(['bg', 'light', 'text'] as const).map((slot) => (
        <Box key={slot} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box sx={{ width: 22, height: 22, bgcolor: liveColors[slot], border: '1px solid', borderColor: 'divider', borderRadius: 0.5 }} />
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <Typography variant="caption" sx={{ fontFamily: 'ui-monospace, monospace' }}>
              .{slot} · {liveColors[slot].toUpperCase()}
            </Typography>
            <Typography variant="caption" sx={{ fontFamily: 'ui-monospace, monospace', color: 'text.secondary' }}>
              var(--stage-{stageKey}-{slot})
            </Typography>
          </Box>
        </Box>
      ))}
    </Paper>
  );
}

function SwatchCard({ name, hex, themePath, cssVar }: SwatchCardProps) {
  const displayHex = useLiveCssVar(cssVar, hex);

  return (
    <Paper variant="outlined" sx={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ height: 72, bgcolor: displayHex, borderBottom: '1px solid', borderColor: 'divider' }} />
      <Box sx={{ p: 1.25, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 0.5 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{name}</Typography>
          <Typography variant="caption" sx={{ fontFamily: 'ui-monospace, monospace', color: 'text.secondary' }}>
            {displayHex.toUpperCase()}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <CodeRef>{themePath}</CodeRef>
          <CopyButton text={themePath} />
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <CodeRef>var({cssVar})</CodeRef>
          <CopyButton text={`var(${cssVar})`} />
        </Box>
      </Box>
    </Paper>
  );
}

function TokenCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
      <Typography variant="h6" component="h3" sx={{ fontWeight: 700, mb: 1.5 }}>{title}</Typography>
      {children}
    </Paper>
  );
}

// ── Token data ──────────────────────────────────────────────────────────

const BRAND_SWATCHES: SwatchCardProps[] = [
  { name: 'paper',       hex: BRAND_COLORS.paper,      themePath: 'palette.brand.paper',      cssVar: '--paper' },
  { name: 'paperDeep',   hex: BRAND_COLORS.paperDeep,  themePath: 'palette.brand.paperDeep',  cssVar: '--paper-deep' },
  { name: 'stone',       hex: BRAND_COLORS.stone,      themePath: 'palette.brand.stone',      cssVar: '--stone' },
  { name: 'stoneLight',  hex: BRAND_COLORS.stoneLight, themePath: 'palette.brand.stoneLight', cssVar: '--stone-light' },
  { name: 'stoneDeep',   hex: BRAND_COLORS.stoneDeep,  themePath: 'palette.brand.stoneDeep',  cssVar: '--stone-deep' },
  { name: 'orchid',      hex: BRAND_COLORS.orchid,     themePath: 'palette.brand.orchid',     cssVar: '--orchid' },
  { name: 'orchidDeep',  hex: BRAND_COLORS.orchidDeep, themePath: 'palette.brand.orchidDeep', cssVar: '--orchid-deep' },
  { name: 'orchidSoft',  hex: BRAND_COLORS.orchidSoft, themePath: 'palette.brand.orchidSoft', cssVar: '--orchid-soft' },
  { name: 'orchidTint',  hex: BRAND_COLORS.orchidTint, themePath: 'palette.brand.orchidTint', cssVar: '--orchid-tint' },
  { name: 'plum',        hex: BRAND_COLORS.plum,       themePath: 'palette.brand.plum',       cssVar: '--plum' },
  { name: 'walnut',      hex: BRAND_COLORS.walnut,     themePath: 'palette.brand.walnut',     cssVar: '--walnut' },
  { name: 'ink1',        hex: BRAND_COLORS.ink1,       themePath: 'palette.brand.ink1',       cssVar: '--ink-1' },
  { name: 'ink2',        hex: BRAND_COLORS.ink2,       themePath: 'palette.brand.ink2',       cssVar: '--ink-2' },
  { name: 'ink3',        hex: BRAND_COLORS.ink3,       themePath: 'palette.brand.ink3',       cssVar: '--ink-3' },
  { name: 'ink4',        hex: BRAND_COLORS.ink4,       themePath: 'palette.brand.ink4',       cssVar: '--ink-4' },
];

const SPACING_STEPS = [0.5, 1, 1.5, 2, 3, 4, 6] as const;

const RADIUS_ENTRIES: Array<{ key: keyof typeof RADIUS; cssVar: string }> = [
  { key: 'xs',   cssVar: '--radius-xs' },
  { key: 'sm',   cssVar: '--radius-sm' },
  { key: 'md',   cssVar: '--radius-md' },
  { key: 'lg',   cssVar: '--radius-lg' },
  { key: 'xl',   cssVar: '--radius-xl' },
  { key: '2xl',  cssVar: '--radius-2xl' },
  { key: '3xl',  cssVar: '--radius-3xl' },
  { key: 'pill', cssVar: '--radius-pill' },
];

const TYPOGRAPHY_VARIANTS = [
  'h1','h2','h3','h4','h5','h6',
  'subtitle1','subtitle2',
  'body1','body2',
  'button','caption','overline',
] as const;

function TypographyRow({ variant }: { variant: typeof TYPOGRAPHY_VARIANTS[number] }) {
  const theme = useTheme();
  const spec = theme.typography[variant] as { fontSize?: string | number; fontWeight?: number | string; lineHeight?: number | string };
  const fallbackSize   = String(spec.fontSize   ?? '');
  const fallbackWeight = String(spec.fontWeight  ?? '');
  const fallbackLh     = String(spec.lineHeight  ?? '');

  const fontSize   = useLiveCssVar(`--typo-${variant}-font-size`,   fallbackSize);
  const fontWeight = useLiveCssVar(`--typo-${variant}-font-weight`,  fallbackWeight);
  const lineHeight  = useLiveCssVar(`--typo-${variant}-line-height`, fallbackLh);

  return (
    <Box sx={{ py: 1.25, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
      <Box sx={{ minWidth: 140 }}>
        <Typography variant="subtitle2" sx={{ fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>{variant}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'ui-monospace, monospace' }}>
          {fontSize} · w{fontWeight} · lh{lineHeight}
        </Typography>
      </Box>
      <Typography variant={variant} sx={{ flex: 1, minWidth: 200 }}>
        The quick brown fox jumps over the lazy dog
      </Typography>
    </Box>
  );
}

function SpacingRow({ n }: { n: typeof SPACING_STEPS[number] }) {
  const unitStr = useLiveCssVar('--spacing-unit', '8');
  const px = parseFloat(unitStr) * n;

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Box sx={{ minWidth: 120 }}>
        <CodeRef>theme.spacing({n})</CodeRef>
      </Box>
      <Box sx={{ width: px, height: 16, bgcolor: 'primary.main', borderRadius: 0.5 }} />
      <Typography variant="caption" sx={{ fontFamily: 'ui-monospace, monospace', color: 'text.secondary' }}>
        {px}px
      </Typography>
    </Box>
  );
}

function TokensTab() {
  return (
    <>
      <TokenCard title="Brand colours">
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          The neutral paper / stone / ink scales and the orchid / plum / walnut
          accents. Reference via <CodeRef>theme.palette.brand.&lt;name&gt;</CodeRef> in
          MUI components, or <CodeRef>var(--name)</CodeRef> in legacy CSS.
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 1.5 }}>
          {BRAND_SWATCHES.map((s) => <SwatchCard key={s.name} {...s} />)}
        </Box>
      </TokenCard>

      <TokenCard title="Stage colours">
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          Three tokens per stage — solid <code>bg</code>, tinted <code>light</code>,
          dark <code>text</code> — used on lead-status pills, stage badges, and
          the bottom nav. Reference via <CodeRef>theme.palette.stage.&lt;key&gt;.&lt;bg|light|text&gt;</CodeRef>
          {' '}or <CodeRef>var(--stage-&lt;key&gt;-&lt;bg|light|text&gt;)</CodeRef>.
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {Object.entries(STAGE_COLORS).map(([key, c]) => (
            <StageColorRow key={key} stageKey={key} fallback={c} />
          ))}
        </Box>
      </TokenCard>

      <TokenCard title="Typography">
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          Every MUI typography variant, themed with Open Sans. Reference via
          {' '}<CodeRef>{`<Typography variant="h3">`}</CodeRef>.
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', divider: 1 }}>
          {TYPOGRAPHY_VARIANTS.map((v) => (
            <TypographyRow key={v} variant={v} />
          ))}
        </Box>
      </TokenCard>

      <TokenCard title="Spacing">
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          MUI's 8&nbsp;px spacing scale. Reference via <CodeRef>theme.spacing(n)</CodeRef> or
          the shorthand <CodeRef>{`sx={{ p: 2 }}`}</CodeRef> (= 16&nbsp;px).
        </Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {SPACING_STEPS.map((n) => (
            <SpacingRow key={n} n={n} />
          ))}
        </Box>
      </TokenCard>

      <TokenCard title="Radii">
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
          Corner radii used on surfaces and pills. Reference via
          {' '}<CodeRef>theme.radius.&lt;key&gt;</CodeRef> or <CodeRef>var(--radius-&lt;key&gt;)</CodeRef>.
        </Typography>
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 1.5 }}>
          {RADIUS_ENTRIES.map(({ key, cssVar }) => {
            const px = RADIUS[key];
            return (
              <Paper key={key} variant="outlined" sx={{ p: 1.5, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                <Box sx={{ width: 80, height: 50, bgcolor: 'primary.light', borderRadius: `${px}px` }} />
                <Typography variant="subtitle2" sx={{ fontFamily: 'ui-monospace, monospace' }}>radius.{key}</Typography>
                <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'ui-monospace, monospace' }}>
                  {px}px · {cssVar}
                </Typography>
              </Paper>
            );
          })}
        </Box>
      </TokenCard>
    </>
  );
}

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
  const [tab, setTab] = useState<Category>('Tokens');

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

      {tab === 'Tokens' && <TokensTab />}

      {tab === 'Inputs' && (
        <>
          <ComponentShowcase
            name="Button"
            description="Primary call-to-action. Use `variant=contained` for the main action, `outlined` for secondary, `text` for tertiary. Sizes (`small`/`medium`/`large`) and colours (`primary`/`secondary`/`error`/`warning`/`info`/`success`) all shown below."
            demo={
              <Stack spacing={1.5} sx={{ width: '100%' }}>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                  <Button variant="contained">Contained</Button>
                  <Button variant="outlined">Outlined</Button>
                  <Button variant="text">Text</Button>
                  <Button variant="contained" disabled>Disabled</Button>
                </Stack>
                <Stack direction="row" spacing={1} sx={{  alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button variant="contained" size="small">Small</Button>
                  <Button variant="contained" size="medium">Medium</Button>
                  <Button variant="contained" size="large">Large</Button>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                  <Button variant="contained" color="primary">Primary</Button>
                  <Button variant="contained" color="secondary">Secondary</Button>
                  <Button variant="contained" color="success">Success</Button>
                  <Button variant="contained" color="warning">Warning</Button>
                  <Button variant="contained" color="error">Error</Button>
                  <Button variant="contained" color="info">Info</Button>
                </Stack>
              </Stack>
            }
            code={`<Button variant="contained">Contained</Button>
<Button variant="outlined">Outlined</Button>
<Button variant="text">Text</Button>

<Button size="small">Small</Button>
<Button size="medium">Medium</Button>
<Button size="large">Large</Button>

<Button color="primary">Primary</Button>
<Button color="secondary">Secondary</Button>
<Button color="error">Error</Button>`}
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
            name="Radio"
            description="Mutually exclusive choice. Group with `RadioGroup` so only one can be selected at a time."
            demo={
              <FormControl>
                <FormLabel id="ds-radio-demo">Stage</FormLabel>
                <RadioGroup row defaultValue="sales" aria-labelledby="ds-radio-demo" name="ds-radio-demo">
                  <FormControlLabel value="sales" control={<Radio />} label="Sales" />
                  <FormControlLabel value="survey" control={<Radio />} label="Survey" />
                  <FormControlLabel value="workshop" control={<Radio />} label="Workshop" />
                </RadioGroup>
              </FormControl>
            }
            code={`<FormControl>
  <FormLabel>Stage</FormLabel>
  <RadioGroup row defaultValue="sales" name="stage">
    <FormControlLabel value="sales"    control={<Radio />} label="Sales" />
    <FormControlLabel value="survey"   control={<Radio />} label="Survey" />
    <FormControlLabel value="workshop" control={<Radio />} label="Workshop" />
  </RadioGroup>
</FormControl>`}
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
            name="Badge"
            description="Small count or dot overlay on another element — unread counts, notification dots, status indicators."
            demo={
              <>
                <Badge badgeContent={4} color="primary"><MailIcon /></Badge>
                <Badge badgeContent={12} color="error"><NotificationsIcon /></Badge>
                <Badge badgeContent={99} color="warning" max={99}><MailIcon /></Badge>
                <Badge variant="dot" color="success"><MailIcon /></Badge>
              </>
            }
            code={`<Badge badgeContent={4} color="primary"><MailIcon /></Badge>
<Badge badgeContent={99} color="error" max={99}><MailIcon /></Badge>
<Badge variant="dot" color="success"><MailIcon /></Badge>`}
          />
          <ComponentShowcase
            name="Pill (lead status)"
            description="MUI Chip themed with the stage colours from `theme.palette.stage`. Replaces the legacy `.ui-pill` / `.stage-chip` HTML. Pass `stage` for a stage-coloured pill, or `variant` for a semantic one."
            demo={
              <>
                {Object.keys(STAGE_COLORS).map((k) => (
                  <Pill key={k} stage={k} label={k.charAt(0).toUpperCase() + k.slice(1)} />
                ))}
              </>
            }
            code={`<Pill stage="sales" label="Sales" />
<Pill stage="workshop" label="Workshop" />
<Pill variant="warn" label="Pending" />`}
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
            name="Alert with action"
            description={`When an Alert includes an action button, always pass \`color="inherit"\` so the button text matches the alert's severity colour instead of falling back to primary blue.`}
            demo={
              <Stack spacing={1} sx={{ width: '100%' }}>
                <Alert
                  severity="error"
                  action={<Button size="small" color="inherit" onClick={() => {}}>Retry</Button>}
                >
                  Could not load contacts.
                </Alert>
                <Alert
                  severity="warning"
                  action={<Button size="small" color="inherit" onClick={() => {}}>Dismiss</Button>}
                >
                  No HubSpot token configured.
                </Alert>
              </Stack>
            }
            code={`<Alert
  severity="error"
  action={<Button size="small" color="inherit" onClick={handleRetry}>Retry</Button>}
>
  Could not load contacts.
</Alert>`}
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
          <ComponentShowcase
            name="EmptyState"
            description="Dashed-border placeholder shown when a list or section has no content. Use the compact prop for tighter contexts."
            demo={
              <Stack spacing={2} sx={{ width: '100%' }}>
                <EmptyState message="No results found" />
                <EmptyState message="No upcoming events" compact />
              </Stack>
            }
            code={`import { EmptyState } from '../components/EmptyState';

<EmptyState message="No results found" />
<EmptyState message="No upcoming events" compact />`}
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
            icons={ACTIONS_ICONS}
          />

          <IconShowcase
            name="Navigation"
            description="Move between views, expand sections, open in a new tab."
            icons={NAVIGATION_ICONS}
          />

          <IconShowcase
            name="Status"
            description="Convey state — success, error, warning, pending — usually inline with text or in a Chip."
            icons={STATUS_ICONS}
          />

          <IconShowcase
            name="Content"
            description="Glyphs for record types — contacts, calendar events, files, communications."
            icons={CONTENT_ICONS}
          />
        </>
      )}

      {tab === 'Skeletons' && (
        <>
          <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Loading skeletons are shown via React <code>Suspense</code> fallbacks while a page
              chunk is fetching. Each variant is shape-matched to its real page so the layout
              does not jump when content arrives. Import from{' '}
              <code>components/PageLoadingSkeleton</code>.
            </Typography>
          </Paper>

          <ComponentShowcase
            name="PageLoadingSkeleton"
            description="Generic fallback — a few grey bars that work for any panel or admin tab."
            demo={<Box sx={{ width: '100%' }}><PageLoadingSkeleton forceVisible /></Box>}
            code={`import { PageLoadingSkeleton } from '../components/PageLoadingSkeleton';

// Inside a Suspense boundary:
<Suspense fallback={<PageLoadingSkeleton />}>
  <LazyAdminTab />
</Suspense>`}
          />

          <ComponentShowcase
            name="CustomersPageSkeleton"
            description="Shape-matched skeleton for the Customers list: stage filter tabs, search + dropdowns, four customer card outlines, and a pagination row."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><CustomersPageSkeleton forceVisible /></Box>}
            code={`import { CustomersPageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<CustomersPageSkeleton />}>
  <CustomersPage />
</Suspense>`}
          />

          <ComponentShowcase
            name="CalendarPageSkeleton"
            description="Shape-matched skeleton for the Calendar: toolbar with nav buttons, two mini month grids, and three agenda day rows with event cards."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><CalendarPageSkeleton forceVisible /></Box>}
            code={`import { CalendarPageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<CalendarPageSkeleton />}>
  <CalendarPage />
</Suspense>`}
          />

          <ComponentShowcase
            name="HomePageSkeleton"
            description="Shape-matched skeleton for the Home page: big date header, My Tasks section, Upcoming section, and Active Projects section."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><HomePageSkeleton forceVisible /></Box>}
            code={`import { HomePageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<HomePageSkeleton />}>
  <HomePage />
</Suspense>`}
          />

          <ComponentShowcase
            name="ProfilePageSkeleton"
            description="Shape-matched skeleton for the Profile page: back button, identity card with avatar, role card, change-password card, and account-actions card."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><ProfilePageSkeleton forceVisible /></Box>}
            code={`import { ProfilePageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<ProfilePageSkeleton />}>
  <ProfilePage />
</Suspense>`}
          />

          <ComponentShowcase
            name="AdminTeamPageSkeleton"
            description="Shape-matched skeleton for the Admin Team tab: team table card with heading, chip, header row, and four member rows; add-team-member card with fields."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><AdminTeamPageSkeleton forceVisible /></Box>}
            code={`import { AdminTeamPageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<AdminTeamPageSkeleton />}>
  <AdminTeamPage />
</Suspense>`}
          />

          <ComponentShowcase
            name="AdminPermissionsPageSkeleton"
            description="Shape-matched skeleton for the Admin Permissions tab: manage job roles card with add-role form and role list rows, and permissions matrix card with feature rows and save button."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><AdminPermissionsPageSkeleton forceVisible /></Box>}
            code={`import { AdminPermissionsPageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<AdminPermissionsPageSkeleton />}>
  <AdminPermissionsPage />
</Suspense>`}
          />

          <ComponentShowcase
            name="AdminRequestsPageSkeleton"
            description="Shape-matched skeleton for the Admin Requests tab: access requests card with table rows, photo approvals card, and trade submissions card."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><AdminRequestsPageSkeleton forceVisible /></Box>}
            code={`import { AdminRequestsPageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<AdminRequestsPageSkeleton />}>
  <AdminRequestsPage />
</Suspense>`}
          />

          <ComponentShowcase
            name="AdminAuditLogPageSkeleton"
            description="Shape-matched skeleton for the Admin Audit Log tab: single card with heading, read-only chip, subtitle, and six audit entry rows."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><AdminAuditLogPageSkeleton forceVisible /></Box>}
            code={`import { AdminAuditLogPageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<AdminAuditLogPageSkeleton />}>
  <AdminAuditLogPage />
</Suspense>`}
          />

          <ComponentShowcase
            name="AdminSettingsPageSkeleton"
            description="Shape-matched skeleton for the Admin Settings tab: integrations card with HubSpot status row, lead-status table rows, and add-new-status inset form."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><AdminSettingsPageSkeleton forceVisible /></Box>}
            code={`import { AdminSettingsPageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<AdminSettingsPageSkeleton />}>
  <AdminSettingsPage />
</Suspense>`}
          />

          <ComponentShowcase
            name="CardActionsPageSkeleton"
            description="Shape-matched skeleton for the Card Actions admin tab: single card with heading, save button, table header row, and five stage-by-status rows with input outlines."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><CardActionsPageSkeleton forceVisible /></Box>}
            code={`import { CardActionsPageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<CardActionsPageSkeleton />}>
  <CardActionsPage />
</Suspense>`}
          />

          <ComponentShowcase
            name="ActionHandlersPageSkeleton"
            description="Shape-matched skeleton for the Action Handlers admin tab: single card with heading and six handler rows each showing action label, stage chip, handler chip, and edit/delete icons."
            demo={<Box sx={{ width: '100%', bgcolor: 'background.paper' }}><ActionHandlersPageSkeleton forceVisible /></Box>}
            code={`import { ActionHandlersPageSkeleton } from '../components/PageLoadingSkeleton';

<Suspense fallback={<ActionHandlersPageSkeleton />}>
  <ActionHandlersPage />
</Suspense>`}
          />
        </>
      )}

      {tab === 'Sign-off' && (
        <>
          <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              The customer-facing sign-off page (<code>DesignVisitSignOffPage</code>) has six
              distinct states. Each is shown below using the <code>preview</code> prop so no
              real token or API call is needed. The page renders inside a max-width frame that
              matches its production layout.
            </Typography>
          </Paper>

          {([
            {
              label: 'Loading',
              description: 'Shown immediately after the page mounts while the sign-off data is being fetched.',
              preview: { state: 'loading' as const },
            },
            {
              label: 'Error',
              description: 'Shown when the token is missing, unrecognised, or the request fails unexpectedly.',
              preview: {
                state: 'error' as const,
                errorTitle: 'Link not valid',
                errorSub: 'This link may have already been used. Please contact us if you need a new one.',
              },
            },
            {
              label: 'Expired',
              description: 'Shown when the server returns HTTP 410 with status "expired" — the link is too old.',
              preview: { state: 'expired' as const },
            },
            {
              label: 'Signed off',
              description: 'Shown after the customer clicks "Looks great — sign off" and the POST succeeds.',
              preview: { state: 'success' as const, successKind: 'approved' as const },
            },
            {
              label: 'Revision requested',
              description: 'Shown after the customer submits a change request and the POST succeeds.',
              preview: { state: 'success' as const, successKind: 'revision' as const },
            },
            {
              label: 'Superseded',
              description: 'Main content state with the "Changes in progress" warning banner — the designer has already issued a revised visit.',
              preview: { state: 'main' as const, data: { ...SIGN_OFF_MOCK_DATA, status: 'superseded' } },
            },
            {
              label: 'Main content',
              description: 'Standard state: customer sees the visit summary with approve / request-changes actions.',
              preview: { state: 'main' as const, data: SIGN_OFF_MOCK_DATA },
            },
          ] as const).map(({ label, description, preview }) => (
            <ComponentShowcase
              key={label}
              name={label}
              description={description}
              demo={
                <Box
                  sx={{
                    width: '100%',
                    maxWidth: 680,
                    mx: 'auto',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: '12px',
                    overflow: 'hidden',
                    bgcolor: '#f9fafb',
                  }}
                >
                  <DesignVisitSignOffPage preview={preview} />
                </Box>
              }
              code={`import { DesignVisitSignOffPage } from './DesignVisitSignOffPage';

// In production the component reads the token from the URL and fetches data itself.
// The preview prop is only used in the Design System gallery.
<DesignVisitSignOffPage preview={{ state: '${preview.state}'${'successKind' in preview ? `, successKind: '${preview.successKind}'` : ''} }} />`}
            />
          ))}
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
