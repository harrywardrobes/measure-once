import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom';
import { BRAND_COLORS } from '../theme';
import type { GalleryEmbedded } from '../types/gallery';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RoomImage {
  storageKey: string;
}

interface Room {
  roomName: string;
  doorStyleName?: string;
  unitCount: number | string;
  totalPence: number;
  images?: RoomImage[];
}

interface SignOffData {
  contactName?: string;
  visitDate?: string;
  location?: string;
  handleName?: string;
  furnitureRange?: string;
  rooms?: Room[];
  terms?: string;
  termsVersionNumber?: number;
  status?: string;
}

type PageState = 'loading' | 'expired' | 'error' | 'success' | 'main';
type SuccessKind = 'approved' | 'revision';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(pence: number): string {
  return '£' + (pence / 100).toFixed(2);
}

function safeImageSrc(s: unknown): string {
  if (typeof s !== 'string') return '';
  const v = s.trim();
  if (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(v)) return v;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.startsWith('/')) return v;
  return '';
}

function formatVisitDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'long' });
  } catch {
    return iso;
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Logo() {
  return (
    <Typography
      variant="subtitle1"
      sx={{
        fontWeight: 700,
        color: BRAND_COLORS.orchid,
        letterSpacing: '-0.01em',
        mb: 3.5,
        fontSize: '1.1rem',
      }}
    >
      Measure Once
    </Typography>
  );
}

function SectionCard({ title, versionBadge, children }: {
  title: string;
  versionBadge?: number | null;
  children: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        bgcolor: '#ffffff',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '12px',
        p: '20px 22px',
        mb: '18px',
        boxShadow: '0 1px 3px rgba(0,0,0,.05)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1.5 }}>
        <Typography
          variant="overline"
          sx={{ color: 'text.disabled', letterSpacing: '0.06em', lineHeight: 1 }}
        >
          {title}
        </Typography>
        {versionBadge != null && (
          <Chip
            label={`v${versionBadge}`}
            size="small"
            sx={{
              ml: 1,
              height: 18,
              fontSize: '0.68rem',
              fontWeight: 700,
              bgcolor: 'rgba(0,0,0,0.06)',
              color: 'text.secondary',
            }}
          />
        )}
      </Box>
      {children}
    </Box>
  );
}

function StateBlock({ icon, title, subtitle }: {
  icon: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
}) {
  return (
    <Box sx={{ textAlign: 'center', py: 6, px: 2.5 }}>
      <Box sx={{ mb: 1.5, color: 'text.disabled', '& svg': { fontSize: '3rem' } }}>{icon}</Box>
      <Typography variant="h3" sx={{ mb: 1 }}>{title}</Typography>
      <Typography variant="body1" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>{subtitle}</Typography>
    </Box>
  );
}

function SupersededBanner() {
  return (
    <Alert
      severity="warning"
      sx={{ mb: 2, borderRadius: '8px' }}
    >
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Changes in progress</Typography>
      <Typography variant="body2">
        Your designer is currently making changes to this visit.
        A new link will be sent when it's ready for your approval.
        The summary below shows the version you previously received.
      </Typography>
    </Alert>
  );
}

// ── Embedded / gallery config ─────────────────────────────────────────────────
// See `src/react/types/gallery.ts` for the full convention. `embedded` is the
// canonical prop name for gallery embedding across all full-page components.
// This page uses a rich preview object so the gallery can control which UI
// state is shown without a real token or API call.

export interface EmbeddedPreview extends GalleryEmbedded {
  state: PageState;
  successKind?: SuccessKind;
  data?: SignOffData;
  errorTitle?: string;
  errorSub?: string;
}

// ── Main component ────────────────────────────────────────────────────────────

export function DesignVisitSignOffPage({ embedded }: { embedded?: EmbeddedPreview } = {}) {
  const [pageState, setPageState] = useState<PageState>(embedded?.state ?? 'loading');
  const [data, setData] = useState<SignOffData | null>(embedded?.data ?? null);
  const [errorTitle, setErrorTitle] = useState(embedded?.errorTitle ?? 'Link not valid');
  const [errorSub, setErrorSub] = useState(
    embedded?.errorSub ?? 'This link may have already been used. Please contact us if you need a new one.',
  );
  const [successKind, setSuccessKind] = useState<SuccessKind>(embedded?.successKind ?? 'approved');

  const [approving, setApproving] = useState(false);
  const [approveErr, setApproveErr] = useState('');

  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionNote, setRevisionNote] = useState('');
  const [submittingRevision, setSubmittingRevision] = useState(false);
  const [revisionErr, setRevisionErr] = useState('');

  const [termsOpen, setTermsOpen] = useState(false);

  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (embedded) return;

    const token = new URLSearchParams(window.location.search).get('token');
    tokenRef.current = token;

    if (!token) {
      setErrorTitle('No sign-off token');
      setErrorSub('This URL is missing a sign-off token. Please use the link from your email.');
      setPageState('error');
      return;
    }

    fetch('/api/design-visits/sign-off/' + encodeURIComponent(token))
      .then(async r => {
        if (r.status === 410) {
          const d = await r.json();
          const err: Error & { _410?: boolean; _status?: string } = new Error(
            d.message || d.error || 'expired',
          );
          err._410 = true;
          err._status = d.status || '';
          throw err;
        }
        if (!r.ok) {
          const d = await r.json();
          throw new Error(d.message || d.error || 'Failed to load');
        }
        return r.json() as Promise<SignOffData>;
      })
      .then(d => {
        setData(d);
        setPageState('main');
      })
      .catch((err: Error & { _410?: boolean; _status?: string }) => {
        if (err._410 && err._status === 'expired') {
          setPageState('expired');
          return;
        }
        if (err._410) {
          setErrorTitle(
            err.message.includes('expired') ? 'Link expired' : 'Already signed off',
          );
          setErrorSub(err.message);
        } else {
          setErrorSub(err.message);
        }
        setPageState('error');
      });
  }, []);

  async function handleApprove() {
    setApproveErr('');
    setApproving(true);
    try {
      const r = await fetch(
        '/api/design-visits/sign-off/' + encodeURIComponent(tokenRef.current ?? ''),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve' }),
        },
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || 'Failed');
      setSuccessKind('approved');
      setPageState('success');
    } catch (e) {
      setApproveErr((e as Error).message);
    } finally {
      setApproving(false);
    }
  }

  async function handleSubmitRevision() {
    setRevisionErr('');
    const note = revisionNote.trim();
    if (!note) {
      setRevisionErr('Please describe the changes you\'d like.');
      return;
    }
    setSubmittingRevision(true);
    try {
      const r = await fetch(
        '/api/design-visits/sign-off/' + encodeURIComponent(tokenRef.current ?? ''),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'revision', note }),
        },
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.message || d.error || 'Failed');
      setSuccessKind('revision');
      setPageState('success');
    } catch (e) {
      setRevisionErr((e as Error).message);
    } finally {
      setSubmittingRevision(false);
    }
  }

  const isSuperseded = data?.status === 'superseded';

  const grandTotal = (data?.rooms ?? []).reduce((sum, r) => sum + (r.totalPence || 0), 0);

  const metaPairs: [string, string][] = [];
  if (data?.visitDate)      metaPairs.push(['Visit date', formatVisitDate(data.visitDate)]);
  if (data?.location)       metaPairs.push(['Location', data.location]);
  if (data?.handleName)     metaPairs.push(['Handle', data.handleName]);
  if (data?.furnitureRange) metaPairs.push(['Furniture range', data.furnitureRange]);

  const photoRooms = (data?.rooms ?? [])
    .map(r => ({
      roomName: r.roomName,
      images: (Array.isArray(r.images) ? r.images : [])
        .map(img => safeImageSrc(img?.storageKey))
        .filter(Boolean),
    }))
    .filter(r => r.images.length > 0);

  return (
    <Box
      sx={{
        bgcolor: '#f9fafb',
        minHeight: '100vh',
        fontFamily: 'inherit',
        color: BRAND_COLORS.ink1,
      }}
    >
      <Box sx={{ maxWidth: 660, mx: 'auto', px: 2.5, pt: 4, pb: 8 }}>
        <Logo />

        {/* Loading */}
        {pageState === 'loading' && (
          <Box sx={{ textAlign: 'center', py: 8, color: 'text.disabled' }}>
            <CircularProgress size={28} sx={{ mb: 2, color: BRAND_COLORS.orchid }} />
            <Typography variant="body2" color="text.disabled">
              Loading your design visit…
            </Typography>
          </Box>
        )}

        {/* Error */}
        {pageState === 'error' && (
          <StateBlock
            icon={<ErrorOutlinedIcon />}
            title={errorTitle}
            subtitle={errorSub}
          />
        )}

        {/* Expired */}
        {pageState === 'expired' && (
          <StateBlock
            icon={<HourglassBottomIcon />}
            title="This sign-off link has expired"
            subtitle={
              <>
                Sign-off links are only valid for a short time after we send them.
                Please reply to the original email — or get in touch with your
                designer — and we'll send you a fresh link to review and approve
                your design visit.
              </>
            }
          />
        )}

        {/* Success */}
        {pageState === 'success' && (
          <StateBlock
            icon={<CheckCircleOutlinedIcon sx={{ color: '#059669 !important' }} />}
            title={successKind === 'approved' ? 'Design signed off — thank you!' : 'Changes requested'}
            subtitle={
              successKind === 'approved'
                ? "We've received your approval. We'll be in touch soon with next steps."
                : "We've received your feedback and will be in touch to discuss the changes."
            }
          />
        )}

        {/* Main content */}
        {pageState === 'main' && data && (
          <>
            {isSuperseded && <SupersededBanner />}

            <Typography variant="h2" sx={{ mb: 0.75 }}>
              Your Design Visit Summary
            </Typography>
            {data.contactName && (
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
                Hi {data.contactName.split(' ')[0]}, here's a summary of the design options we discussed.
              </Typography>
            )}

            {/* Visit Details */}
            {metaPairs.length > 0 && (
              <SectionCard title="Visit Details">
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr',
                    gap: '6px 16px',
                    fontSize: '0.88rem',
                  }}
                >
                  {metaPairs.map(([label, value]) => (
                    <React.Fragment key={label}>
                      <Typography
                        component="span"
                        variant="body2"
                        sx={{ fontWeight: 600, color: 'text.secondary', whiteSpace: 'nowrap' }}
                      >
                        {label}
                      </Typography>
                      <Typography component="span" variant="body2" sx={{ color: BRAND_COLORS.ink1 }}>
                        {value}
                      </Typography>
                    </React.Fragment>
                  ))}
                </Box>
              </SectionCard>
            )}

            {/* Room Breakdown */}
            <SectionCard title="Room Breakdown">
              {(data.rooms ?? []).length === 0 ? (
                <Typography
                  variant="body2"
                  sx={{ color: 'text.secondary', py: 1.5, fontStyle: 'italic' }}
                >
                  No rooms have been added yet. Your designer will update this summary shortly.
                </Typography>
              ) : (
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      {['Room', 'Style', 'Units', 'Total'].map((h, i) => (
                        <TableCell
                          key={h}
                          align={i === 3 ? 'right' : 'left'}
                          sx={{
                            fontSize: '0.72rem',
                            fontWeight: 700,
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            color: 'text.disabled',
                            borderBottomColor: 'divider',
                            py: 1,
                            px: '10px',
                          }}
                        >
                          {h}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {data.rooms!.map((room, idx) => (
                      <TableRow key={idx}>
                        <TableCell sx={{ py: '10px', px: '10px', fontSize: '0.88rem', borderBottomColor: '#f3f4f6' }}>
                          {room.roomName}
                        </TableCell>
                        <TableCell sx={{ py: '10px', px: '10px', fontSize: '0.88rem', borderBottomColor: '#f3f4f6' }}>
                          {room.doorStyleName || '—'}
                        </TableCell>
                        <TableCell sx={{ py: '10px', px: '10px', fontSize: '0.88rem', borderBottomColor: '#f3f4f6' }}>
                          {room.unitCount}
                        </TableCell>
                        <TableCell align="right" sx={{ py: '10px', px: '10px', fontSize: '0.88rem', borderBottomColor: '#f3f4f6' }}>
                          {fmt(room.totalPence || 0)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                  <TableFooter>
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        sx={{
                          fontWeight: 700,
                          fontSize: '0.88rem',
                          color: BRAND_COLORS.ink1,
                          borderTop: '2px solid',
                          borderTopColor: 'divider',
                          borderBottom: 'none',
                          py: '12px',
                          px: '10px',
                        }}
                      >
                        Estimate total
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{
                          fontWeight: 700,
                          fontSize: '0.88rem',
                          color: BRAND_COLORS.ink1,
                          borderTop: '2px solid',
                          borderTopColor: 'divider',
                          borderBottom: 'none',
                          py: '12px',
                          px: '10px',
                        }}
                      >
                        {fmt(grandTotal)}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                </Table>
              )}
            </SectionCard>

            {/* Room Photos */}
            {photoRooms.length > 0 && (
              <SectionCard title="Room Photos">
                {photoRooms.map(pr => (
                  <Box key={pr.roomName} sx={{ mb: 2 }}>
                    <Typography
                      variant="caption"
                      sx={{ fontWeight: 700, color: 'text.secondary', display: 'block', mb: 1 }}
                    >
                      {pr.roomName}
                    </Typography>
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
                        gap: 1,
                      }}
                    >
                      {pr.images.map((src, i) => (
                        <Box
                          key={i}
                          component="a"
                          href={src}
                          target="_blank"
                          rel="noopener noreferrer"
                          sx={{ display: 'block' }}
                        >
                          <Box
                            component="img"
                            src={src}
                            alt={`${pr.roomName} photo`}
                            loading="lazy"
                            sx={{
                              width: '100%',
                              aspectRatio: '1 / 1',
                              objectFit: 'cover',
                              borderRadius: '8px',
                              border: '1px solid',
                              borderColor: 'divider',
                              bgcolor: '#f3f4f6',
                              cursor: 'zoom-in',
                              display: 'block',
                            }}
                          />
                        </Box>
                      ))}
                    </Box>
                  </Box>
                ))}
              </SectionCard>
            )}

            {/* Terms & Conditions */}
            {data.terms && (
              <SectionCard
                title="Terms & Conditions"
                versionBadge={data.termsVersionNumber ?? null}
              >
                <Box
                  component="details"
                  sx={{ mt: 0.5 }}
                  open={termsOpen}
                  onToggle={(e: React.SyntheticEvent<HTMLDetailsElement>) => {
                    setTermsOpen(e.currentTarget.open);
                  }}
                >
                  <Box
                    component="summary"
                    sx={{
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: '0.85rem',
                      color: 'text.secondary',
                      userSelect: 'none',
                    }}
                  >
                    Read the terms and conditions
                  </Box>
                  <Box
                    sx={{
                      mt: 1.25,
                      fontSize: '0.82rem',
                      color: 'text.secondary',
                      whiteSpace: 'pre-line',
                      lineHeight: 1.6,
                    }}
                  >
                    {data.terms}
                  </Box>
                </Box>
              </SectionCard>
            )}

            {/* Action card — hidden when superseded */}
            {!isSuperseded && (
              <SectionCard title="Your decision">
                <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.75 }}>
                  Please review the summary above and let us know if everything looks correct.
                </Typography>

                <Stack spacing={1.25}>
                  <Button
                    variant="contained"
                    fullWidth
                    size="large"
                    disabled={approving}
                    onClick={handleApprove}
                    sx={{
                      bgcolor: BRAND_COLORS.orchid,
                      '&:hover': { bgcolor: BRAND_COLORS.orchidDeep },
                      '&:disabled': { opacity: 0.55 },
                      borderRadius: '10px',
                      py: '14px',
                      fontSize: '1rem',
                      fontWeight: 600,
                    }}
                  >
                    {approving ? 'Signing off…' : 'Looks great — sign off'}
                  </Button>

                  <Button
                    variant="outlined"
                    fullWidth
                    size="large"
                    disabled={approving || submittingRevision}
                    onClick={() => setRevisionOpen(v => !v)}
                    sx={{
                      borderRadius: '10px',
                      py: '14px',
                      fontSize: '1rem',
                      fontWeight: 600,
                      color: BRAND_COLORS.ink2,
                      borderColor: '#d1d5db',
                      '&:hover': { bgcolor: '#f9fafb', borderColor: '#d1d5db' },
                    }}
                  >
                    Request changes
                  </Button>
                </Stack>

                {approveErr && (
                  <Typography variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
                    {approveErr}
                  </Typography>
                )}

                <Collapse in={revisionOpen}>
                  <Box sx={{ mt: 1.5 }}>
                    <Typography
                      component="label"
                      variant="caption"
                      sx={{ fontWeight: 600, color: BRAND_COLORS.ink2, display: 'block', mb: 0.75 }}
                    >
                      Please describe the changes you'd like:
                    </Typography>
                    <TextField
                      multiline
                      minRows={4}
                      fullWidth
                      placeholder="E.g. I'd prefer the kitchen in grey rather than white…"
                      slotProps={{ htmlInput: { maxLength: 2000 } }}
                      value={revisionNote}
                      onChange={e => setRevisionNote(e.target.value)}
                      sx={{
                        '& .MuiOutlinedInput-root': {
                          borderRadius: '8px',
                          fontSize: '0.92rem',
                        },
                      }}
                    />
                    {revisionErr && (
                      <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.75 }}>
                        {revisionErr}
                      </Typography>
                    )}
                    <Button
                      variant="contained"
                      disabled={submittingRevision}
                      onClick={handleSubmitRevision}
                      sx={{
                        mt: 1,
                        bgcolor: BRAND_COLORS.ink2,
                        '&:hover': { bgcolor: BRAND_COLORS.ink1 },
                        borderRadius: '8px',
                        py: '10px',
                        px: '20px',
                        fontSize: '0.9rem',
                        fontWeight: 600,
                      }}
                    >
                      {submittingRevision ? 'Sending…' : 'Send request'}
                    </Button>
                  </Box>
                </Collapse>
              </SectionCard>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
