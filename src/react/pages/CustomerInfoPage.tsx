import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  LinearProgress,
  Radio,
  RadioGroup,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import { BRAND_COLORS, STATUS_COLORS } from '../theme';

// ── Types ─────────────────────────────────────────────────────────────────────

type PageState = 'loading' | 'main' | 'submitted' | 'expired' | 'already_submitted' | 'error';

interface FormData {
  correctedEmail:  string;
  correctedMobile: string;
  addressLine1:    string;
  city:            string;
  postcode:        string;
  roomCount:       string;
  roomNotes:       string;
}

interface DraftPayload extends FormData {
  savedPhotoKeys?: string[];
}

interface UploadedPhoto {
  key:      string;
  previewUrl: string;
  name:     string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_PHOTOS = 15;
const TARGET_COMPRESSED_BYTES = 1.5 * 1024 * 1024; // 1.5 MB target after compression
const MAX_CANVAS_DIM = 2048;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getToken(): string {
  const parts = window.location.pathname.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

function lsKey(token: string): string {
  return `ci_draft_${token}`;
}

function loadDraft(token: string): Partial<DraftPayload> {
  try {
    const raw = localStorage.getItem(lsKey(token));
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function saveDraft(token: string, data: FormData, photoKeys: string[]) {
  try {
    const payload: DraftPayload = { ...data, savedPhotoKeys: photoKeys };
    localStorage.setItem(lsKey(token), JSON.stringify(payload));
  } catch { /* ignore */ }
}

function clearDraft(token: string) {
  try {
    localStorage.removeItem(lsKey(token));
  } catch { /* ignore */ }
}

async function compressImage(file: File): Promise<File> {
  return new Promise(resolve => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let { width, height } = img;
      if (width > MAX_CANVAS_DIM || height > MAX_CANVAS_DIM) {
        const scale = MAX_CANVAS_DIM / Math.max(width, height);
        width  = Math.round(width  * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width  = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(file); return; }
      ctx.drawImage(img, 0, 0, width, height);
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
      const outName  = `${baseName}.jpg`;
      const tryQuality = (q: number) => {
        canvas.toBlob(blob => {
          if (!blob) { resolve(file); return; }
          if (blob.size <= TARGET_COMPRESSED_BYTES || q <= 0.3) {
            resolve(new File([blob], outName, { type: 'image/jpeg' }));
          } else {
            tryQuality(Math.max(+(q - 0.1).toFixed(1), 0.3));
          }
        }, 'image/jpeg', q);
      };
      tryQuality(0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); resolve(file); };
    img.src = objectUrl;
  });
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

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box
      sx={{
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: '12px',
        p: '20px 22px',
        mb: '18px',
        boxShadow: '0 1px 3px rgba(0,0,0,.05)',
      }}
    >
      <Typography
        variant="overline"
        sx={{ color: 'text.disabled', letterSpacing: '0.06em', lineHeight: 1, display: 'block', mb: 2 }}
      >
        {title}
      </Typography>
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
      <Typography variant="body1" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
        {subtitle}
      </Typography>
    </Box>
  );
}

// ── Turnstile hook (for the expired-link resend widget) ───────────────────────

type TW = { render: (el: Element, opts: object) => string; getResponse: (id: string) => string; reset: (id: string) => void };

function useTurnstileResend(containerId: string, active: boolean) {
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaError, setCaptchaError] = useState(false);
  const widgetIdRef = useRef<string | null>(null);
  const attemptedRef = useRef(false);
  const siteKeyRef = useRef<string>('');

  const renderWidget = useCallback(() => {
    if (attemptedRef.current) return;
    const key = siteKeyRef.current;
    if (!key) return;
    const tw = (window as unknown as { turnstile?: TW }).turnstile;
    const el = document.getElementById(containerId);
    if (!tw || !el) return;
    attemptedRef.current = true;
    const id = tw.render(el, {
      sitekey: key,
      theme: 'light',
      appearance: 'always',
      size: 'flexible',
      callback: () => { setCaptchaToken(tw.getResponse(id) || ''); setCaptchaError(false); },
      'error-callback': () => setCaptchaError(true),
      'unsupported-callback': () => setCaptchaError(true),
    });
    widgetIdRef.current = id;
  }, [containerId]);

  useEffect(() => {
    fetch('/api/turnstile-config').then(r => r.json()).then(cfg => {
      if (cfg?.enabled && cfg?.siteKey) {
        siteKeyRef.current = cfg.siteKey;
        setSiteKey(cfg.siteKey);
        const w = window as unknown as { _turnstileApiReady?: boolean; onTurnstileReady?: () => void };
        (window as unknown as { onTurnstileReady: () => void }).onTurnstileReady = () => renderWidget();
        if (w._turnstileApiReady) {
          renderWidget();
        } else {
          const script = document.createElement('script');
          script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileReady';
          script.async = true; script.defer = true;
          document.head.appendChild(script);
        }
      } else {
        setSiteKey(''); // disabled / not configured
      }
    }).catch(() => setSiteKey(''));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-attempt rendering whenever the widget becomes active (element enters the DOM)
  // or when siteKey first resolves. attemptedRef prevents double-render.
  useEffect(() => {
    if (active && siteKey !== null) {
      setTimeout(() => renderWidget(), 50);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey, active]);

  const resetWidget = useCallback(() => {
    const tw = (window as unknown as { turnstile?: TW }).turnstile;
    const id = widgetIdRef.current;
    setCaptchaToken('');
    setCaptchaError(false);
    attemptedRef.current = false;
    widgetIdRef.current = null;
    if (id != null && tw) { tw.reset(id); }
  }, []);

  // siteKey===null means still loading; siteKey==='' means disabled (no captcha required)
  const ready = siteKey !== null && (siteKey === '' || captchaToken.length > 0);
  return { siteKey, captchaToken, captchaError, ready, resetWidget };
}

// ── Main component ────────────────────────────────────────────────────────────

export function CustomerInfoPage() {
  const token = getToken();

  const [pageState, setPageState]   = useState<PageState>('loading');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [maskedPhone, setMaskedPhone] = useState('');
  const [contactName, setContactName] = useState('');
  const [errorMsg, setErrorMsg]     = useState('');

  const [formData, setFormData] = useState<FormData>({
    correctedEmail:  '',
    correctedMobile: '',
    addressLine1:    '',
    city:            '',
    postcode:        '',
    roomCount:       '1',
    roomNotes:       '',
  });

  const [photos, setPhotos]         = useState<UploadedPhoto[]>([]);
  const [uploading, setUploading]   = useState(false);
  const [uploadErr, setUploadErr]   = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr]   = useState('');

  // Resend-expired flow
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [resendErr, setResendErr]     = useState('');
  const turnstile = useTurnstileResend('ts-resend-expired', pageState === 'expired' && !!maskedEmail);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftSavedRef = useRef(false);

  // Load token data + restore draft
  useEffect(() => {
    if (!token) {
      setErrorMsg('No form token found in the URL.');
      setPageState('error');
      return;
    }

    fetch(`/api/customer-info/${encodeURIComponent(token)}`)
      .then(async r => {
        const d = await r.json();
        if (r.status === 410) {
          if (d.status === 'submitted') { setPageState('already_submitted'); return; }
          // Capture masked email from the expired response so the resend UI can display it
          if (d.maskedEmail) setMaskedEmail(d.maskedEmail);
          setPageState('expired');
          return;
        }
        if (!r.ok) {
          setErrorMsg(d.error || 'Could not load this form.');
          setPageState('error');
          return;
        }
        setMaskedEmail(d.maskedEmail || '');
        setMaskedPhone(d.maskedPhone || '');
        setContactName(d.contactName || '');

        // Restore draft
        const draft = loadDraft(token);
        setFormData(prev => ({
          ...prev,
          ...draft,
          roomCount: draft.roomCount || '1',
        }));
        // Restore saved photo keys (preview URLs are session-only so we use a placeholder)
        if (draft.savedPhotoKeys?.length) {
          setPhotos(draft.savedPhotoKeys.map(k => ({
            key: k,
            previewUrl: '',
            name: k.replace(/^obj:ci_[^.]+\./, '').replace(/^/, 'photo.') || 'photo',
          })));
        }
        setPageState('main');
      })
      .catch(() => {
        setErrorMsg('Failed to load the form. Please try again.');
        setPageState('error');
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Draft-save whenever formData or photos change (after initial restore)
  useEffect(() => {
    if (pageState !== 'main') return;
    if (!draftSavedRef.current) { draftSavedRef.current = true; return; }
    saveDraft(token, formData, photos.map(p => p.key));
  }, [formData, photos]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleFieldChange(field: keyof FormData) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData(prev => {
        const updated = { ...prev, [field]: e.target.value };
        saveDraft(token, updated, photos.map(p => p.key));
        return updated;
      });
    };
  }

  async function handlePhotoUpload(files: FileList) {
    if (!files.length) return;
    setUploadErr('');

    const currentCount = photos.length;
    if (currentCount >= MAX_PHOTOS) {
      setUploadErr(`You've reached the ${MAX_PHOTOS} photo limit — remove one to add another.`);
      return;
    }

    const remaining = MAX_PHOTOS - currentCount;
    const fileArray = Array.from(files).slice(0, remaining);
    const truncated = files.length > remaining;

    setUploading(true);
    try {
      const compressed = await Promise.all(fileArray.map(f => compressImage(f)));
      const fd = new FormData();
      for (const f of compressed) {
        fd.append('photos', f);
      }
      const r = await fetch(`/api/customer-info/${encodeURIComponent(token)}/photos`, {
        method: 'POST',
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Upload failed');
      const newPhotos: UploadedPhoto[] = (d.keys as string[]).map((key, i) => ({
        key,
        previewUrl: URL.createObjectURL(compressed[i]),
        name: compressed[i].name,
      }));
      setPhotos(prev => {
        const updated = [...prev, ...newPhotos];
        saveDraft(token, formData, updated.map(p => p.key));
        return updated;
      });
      if (truncated) {
        setUploadErr(`Only ${remaining} photo${remaining === 1 ? '' : 's'} added — you've reached the ${MAX_PHOTOS} photo limit.`);
      }
    } catch (e) {
      setUploadErr((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function removePhoto(key: string) {
    setPhotos(prev => {
      const updated = prev.filter(p => p.key !== key);
      saveDraft(token, formData, updated.map(p => p.key));
      return updated;
    });
  }

  async function handleSubmit() {
    setSubmitErr('');

    if (!formData.addressLine1.trim()) { setSubmitErr('Please enter the first line of your address.'); return; }
    if (!formData.city.trim())         { setSubmitErr('Please enter your city or town.'); return; }
    if (!formData.postcode.trim())     { setSubmitErr('Please enter your postcode.'); return; }
    if (!formData.roomCount)           { setSubmitErr('Please select how many rooms.'); return; }

    setSubmitting(true);
    try {
      const r = await fetch(`/api/customer-info/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          correctedEmail:  formData.correctedEmail.trim()  || undefined,
          correctedMobile: formData.correctedMobile.trim() || undefined,
          addressLine1:    formData.addressLine1.trim(),
          city:            formData.city.trim(),
          postcode:        formData.postcode.trim(),
          roomCount:       formData.roomCount,
          roomNotes:       formData.roomNotes.trim() || undefined,
          photoKeys:       photos.map(p => p.key),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Submission failed');
      clearDraft(token);
      setPageState('submitted');
    } catch (e) {
      setSubmitErr((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const roomLabel = formData.roomCount === '1' ? 'space' : 'spaces';

  return (
    <Box
      sx={{
        bgcolor: 'var(--neutral-50)',
        minHeight: '100vh',
        fontFamily: 'inherit',
        color: BRAND_COLORS.ink1,
      }}
    >
      <Box sx={{ maxWidth: 640, mx: 'auto', px: 2.5, pt: 4, pb: 8 }}>
        <Logo />

        {/* Loading */}
        {pageState === 'loading' && (
          <Box sx={{ textAlign: 'center', py: 8, color: 'text.disabled' }}>
            <CircularProgress size={28} sx={{ mb: 2, color: BRAND_COLORS.orchid }} />
            <Typography variant="body2" color="text.disabled">Loading your form…</Typography>
          </Box>
        )}

        {/* Error */}
        {pageState === 'error' && (
          <StateBlock
            icon={<ErrorOutlinedIcon />}
            title="This link isn't valid"
            subtitle={errorMsg || 'Please use the link from your email, or contact us for a new one.'}
          />
        )}

        {/* Expired */}
        {pageState === 'expired' && (
          <Box sx={{ textAlign: 'center', py: 6, px: 2.5 }}>
            <Box sx={{ mb: 1.5, color: 'text.disabled', '& svg': { fontSize: '3rem' } }}>
              <HourglassBottomIcon />
            </Box>
            <Typography variant="h3" sx={{ mb: 1 }}>This link has expired</Typography>
            <Typography variant="body1" sx={{ color: 'text.secondary', lineHeight: 1.6, mb: maskedEmail ? 2.5 : 0 }}>
              Links are valid for 28 days.
              {!maskedEmail && ' Please contact us and we\'ll send you a fresh one.'}
            </Typography>

            {maskedEmail && (
              <>
                {resendState === 'sent' ? (
                  <Box
                    sx={{
                      mt: 2,
                      p: 2.5,
                      bgcolor: STATUS_COLORS.successLight.bg,
                      border: `1px solid ${STATUS_COLORS.successDeep.bg}`,
                      borderRadius: 2,
                      textAlign: 'center',
                    }}
                  >
                    <CheckCircleOutlinedIcon sx={{ color: 'success.main', fontSize: 32, mb: 1 }} />
                    <Typography variant="body1" sx={{ fontWeight: 600 }}>
                      A new link has been sent to {maskedEmail}
                    </Typography>
                    <Typography variant="body2" sx={{ color: 'text.secondary', mt: 0.5 }}>
                      Please check your inbox (and spam folder).
                    </Typography>
                  </Box>
                ) : (
                  <Box
                    sx={{
                      mt: 2,
                      p: 2.5,
                      bgcolor: 'background.paper',
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 2,
                      textAlign: 'left',
                    }}
                  >
                    <Typography variant="body2" sx={{ color: 'text.secondary', mb: 2 }}>
                      We can send a fresh link to <strong>{maskedEmail}</strong>.
                      Complete the check below, then click the button.
                    </Typography>

                    {/* Turnstile widget */}
                    <Box id="ts-resend-expired" sx={{ mb: 2 }} />
                    {turnstile.captchaError && (
                      <Typography variant="caption" color="error" sx={{ display: 'block', mb: 1 }}>
                        Verification failed — please refresh the page and try again.
                      </Typography>
                    )}

                    {resendErr && (
                      <Alert severity={resendErr.startsWith('Too many') ? 'warning' : 'error'} sx={{ mb: 1.5 }}>
                        {resendErr}
                      </Alert>
                    )}

                    <Button
                      variant="contained"
                      fullWidth
                      disabled={!turnstile.ready || resendState === 'sending'}
                      onClick={async () => {
                        setResendState('sending');
                        setResendErr('');
                        try {
                          const r = await fetch(
                            `/api/customer-info/${encodeURIComponent(token)}/resend-expired`,
                            {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ captchaToken: turnstile.captchaToken }),
                            }
                          );
                          const d = await r.json();
                          if (r.status === 429) {
                            setResendErr('Too many requests — please try again later.');
                            setResendState('error');
                            turnstile.resetWidget();
                          } else if (!r.ok) {
                            throw new Error(d.error || 'Failed to send a new link.');
                          } else {
                            setResendState('sent');
                          }
                        } catch (e) {
                          setResendErr((e as Error).message);
                          setResendState('error');
                          turnstile.resetWidget();
                        }
                      }}
                      sx={{
                        bgcolor: BRAND_COLORS.orchid,
                        '&:hover': { bgcolor: BRAND_COLORS.orchidDeep },
                        borderRadius: 2,
                        py: 1.25,
                        fontWeight: 600,
                      }}
                    >
                      {resendState === 'sending'
                        ? <CircularProgress size={20} color="inherit" />
                        : 'Send me a new link'}
                    </Button>
                  </Box>
                )}
              </>
            )}
          </Box>
        )}

        {/* Already submitted */}
        {pageState === 'already_submitted' && (
          <StateBlock
            icon={<CheckCircleOutlinedIcon sx={{ color: 'success.main !important' }} />}
            title="Already submitted"
            subtitle="We've already received your information — thank you! We'll be in touch shortly."
          />
        )}

        {/* Thank you */}
        {pageState === 'submitted' && (
          <StateBlock
            icon={<CheckCircleOutlinedIcon sx={{ color: 'success.main !important' }} />}
            title="Thank you!"
            subtitle="We've received your information and photos. We'll be in touch shortly."
          />
        )}

        {/* Main form */}
        {pageState === 'main' && (
          <>
            <Typography variant="h2" sx={{ mb: 0.75 }}>
              Tell us about your home
            </Typography>
            {contactName && (
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
                Hi {contactName.split(' ')[0]}, please fill in the details below so we can prepare the best possible quote for you.
              </Typography>
            )}

            {/* Section 1 — Your Information */}
            <SectionCard title="Your Information">
              <Stack spacing={2}>
                {(maskedEmail || maskedPhone) && (
                  <Box
                    sx={{
                      bgcolor: 'grey.50',
                      border: '1px solid',
                      borderColor: 'grey.200',
                      borderRadius: 1.5,
                      p: 1.5,
                    }}
                  >
                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, display: 'block', mb: 0.5 }}>
                      We have these details on file
                    </Typography>
                    {maskedEmail && (
                      <Typography variant="body2">Email: <strong>{maskedEmail}</strong></Typography>
                    )}
                    {maskedPhone && (
                      <Typography variant="body2">Phone: <strong>{maskedPhone}</strong></Typography>
                    )}
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                      If anything looks wrong, you can correct it below.
                    </Typography>
                  </Box>
                )}

                <TextField
                  label="Correct my mobile number (optional)"
                  placeholder="e.g. 07700 900123"
                  value={formData.correctedMobile}
                  onChange={handleFieldChange('correctedMobile')}
                  fullWidth
                  size="small"
                />
                <TextField
                  label="Correct my email address (optional)"
                  placeholder="e.g. me@example.com"
                  value={formData.correctedEmail}
                  onChange={handleFieldChange('correctedEmail')}
                  fullWidth
                  size="small"
                  type="email"
                />

                <Divider sx={{ my: 0.5 }} />

                <TextField
                  label="First line of address"
                  placeholder="e.g. 12 Oak Avenue"
                  value={formData.addressLine1}
                  onChange={handleFieldChange('addressLine1')}
                  fullWidth
                  size="small"
                  required
                />
                <Stack direction="row" spacing={1.5}>
                  <TextField
                    label="City / Town"
                    placeholder="e.g. Manchester"
                    value={formData.city}
                    onChange={handleFieldChange('city')}
                    fullWidth
                    size="small"
                    required
                  />
                  <TextField
                    label="Postcode"
                    placeholder="e.g. M1 1AB"
                    value={formData.postcode}
                    onChange={handleFieldChange('postcode')}
                    sx={{ minWidth: 130 }}
                    size="small"
                    required
                  />
                </Stack>
              </Stack>
            </SectionCard>

            {/* Section 2 — Your Home */}
            <SectionCard title="Your Home">
              <Stack spacing={3}>
                <FormControl>
                  <FormLabel sx={{ fontSize: '0.875rem', fontWeight: 600, color: 'text.primary', mb: 1 }}>
                    How many rooms / spaces are you looking to do?
                  </FormLabel>
                  <RadioGroup
                    row
                    value={formData.roomCount}
                    onChange={handleFieldChange('roomCount')}
                  >
                    {['1', '2', '3+'].map(v => (
                      <FormControlLabel
                        key={v}
                        value={v}
                        control={<Radio size="small" />}
                        label={v === '3+' ? '3 or more' : `${v} room${v === '1' ? '' : 's'}`}
                      />
                    ))}
                  </RadioGroup>
                </FormControl>

                {/* Photo upload */}
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                    Photos of your {roomLabel}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                    Please upload photos of the {roomLabel} — the more angles the better. Include any tricky corners, alcoves, or features.
                  </Typography>

                  {/* Drop zone */}
                  {(() => {
                    const atLimit = photos.length >= MAX_PHOTOS;
                    const disabled = uploading || atLimit;
                    return (
                      <Box
                        component={disabled ? 'div' : 'label'}
                        sx={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 1,
                          py: 3,
                          px: 2,
                          border: '2px dashed',
                          borderColor: uploading
                            ? BRAND_COLORS.orchid
                            : atLimit
                              ? 'grey.200'
                              : 'grey.300',
                          borderRadius: 2,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          bgcolor: uploading
                            ? 'rgba(124,58,237,0.04)'
                            : atLimit
                              ? 'grey.100'
                              : 'grey.50',
                          opacity: atLimit ? 0.6 : 1,
                          transition: 'border-color 0.15s, background 0.15s, opacity 0.15s',
                          '&:hover': disabled ? {} : { borderColor: BRAND_COLORS.orchid, bgcolor: 'rgba(124,58,237,0.04)' },
                        }}
                        onDragOver={(e: React.DragEvent) => e.preventDefault()}
                        onDrop={(e: React.DragEvent) => {
                          e.preventDefault();
                          if (!disabled && e.dataTransfer.files?.length) handlePhotoUpload(e.dataTransfer.files);
                        }}
                      >
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          multiple
                          disabled={disabled}
                          style={{ display: 'none' }}
                          onChange={e => { if (e.target.files?.length) handlePhotoUpload(e.target.files); }}
                        />
                        {uploading ? (
                          <>
                            <CircularProgress size={24} sx={{ color: BRAND_COLORS.orchid }} />
                            <Typography variant="caption" color="text.secondary">Uploading…</Typography>
                          </>
                        ) : atLimit ? (
                          <>
                            <CloudUploadIcon sx={{ fontSize: 32, color: 'grey.300' }} />
                            <Typography variant="body2" sx={{ fontWeight: 500, color: 'text.disabled' }}>
                              Photo limit reached
                            </Typography>
                            <Typography variant="caption" color="text.disabled">
                              Remove a photo to add another
                            </Typography>
                          </>
                        ) : (
                          <>
                            <CloudUploadIcon sx={{ fontSize: 32, color: 'grey.400' }} />
                            <Typography variant="body2" sx={{ fontWeight: 500 }}>
                              Tap to upload photos
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              Up to {MAX_PHOTOS} photos · JPEG, PNG or WebP
                            </Typography>
                          </>
                        )}
                      </Box>
                    );
                  })()}

                  {uploadErr && (
                    <Typography variant="caption" color="error" sx={{ mt: 1, display: 'block' }}>
                      {uploadErr}
                    </Typography>
                  )}

                  {/* Preview thumbnails */}
                  {photos.length > 0 && (
                    <Box
                      sx={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
                        gap: 1,
                        mt: 2,
                      }}
                    >
                      {photos.map(p => (
                        <Box
                          key={p.key}
                          sx={{
                            position: 'relative',
                            borderRadius: 1.5,
                            overflow: 'hidden',
                            aspectRatio: '1',
                            bgcolor: 'grey.100',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {p.previewUrl ? (
                            <Box
                              component="img"
                              src={p.previewUrl}
                              alt={p.name}
                              sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                            />
                          ) : (
                            <Box sx={{ textAlign: 'center', p: 0.5 }}>
                              <CloudUploadIcon sx={{ fontSize: 22, color: 'grey.400' }} />
                              <Typography variant="caption" sx={{ display: 'block', fontSize: '0.6rem', color: 'text.disabled', lineHeight: 1.2, mt: 0.25 }}>
                                saved
                              </Typography>
                            </Box>
                          )}
                          <Button
                            size="small"
                            onClick={() => removePhoto(p.key)}
                            sx={{
                              position: 'absolute',
                              top: 2, right: 2,
                              minWidth: 0,
                              width: 22, height: 22,
                              borderRadius: '50%',
                              bgcolor: 'rgba(0,0,0,0.6)',
                              color: 'common.white',
                              fontSize: '0.7rem',
                              p: 0,
                              lineHeight: 1,
                              '&:hover': { bgcolor: 'rgba(0,0,0,0.85)' },
                            }}
                          >
                            ×
                          </Button>
                        </Box>
                      ))}
                    </Box>
                  )}
                </Box>

                {/* Notes */}
                <Box>
                  <TextField
                    label={`Tell us as much as possible about your ${roomLabel}`}
                    placeholder={`e.g. The ${roomLabel === 'space' ? 'room is' : 'rooms are'} approximately 3m × 4m. I'd love a modern style — light wood or white finish. There's a tricky L-shaped wall on the left side. I've attached a rough sketch in the photos. Budget is flexible for the right solution.`}
                    value={formData.roomNotes}
                    onChange={handleFieldChange('roomNotes')}
                    fullWidth
                    multiline
                    minRows={5}
                    size="small"
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: 'block' }}>
                    The more detail the better — include measurements (even rough ones), style preferences, any awkward areas, and anything else you think we should know. Diagrams or sketches in the photos are really helpful too.
                  </Typography>
                </Box>
              </Stack>
            </SectionCard>

            {submitErr && (
              <Alert severity="error" sx={{ mb: 2 }}>{submitErr}</Alert>
            )}

            {submitting && <LinearProgress sx={{ mb: 2, borderRadius: 1 }} />}

            <Button
              variant="contained"
              size="large"
              fullWidth
              onClick={handleSubmit}
              disabled={submitting || uploading}
              sx={{
                bgcolor: BRAND_COLORS.orchid,
                '&:hover': { bgcolor: BRAND_COLORS.orchidDeep },
                borderRadius: 2,
                py: 1.5,
                fontSize: '1rem',
                fontWeight: 600,
              }}
            >
              {submitting ? 'Sending…' : 'Submit my details'}
            </Button>

            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textAlign: 'center', mt: 1.5 }}>
              Your information is only shared with the Measure Once team and is used solely to prepare your quote.
            </Typography>
          </>
        )}
      </Box>
    </Box>
  );
}
