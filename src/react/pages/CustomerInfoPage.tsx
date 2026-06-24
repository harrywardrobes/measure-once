import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  CUSTOMER_INFO_DRAFT_PREFIX,
  GENERIC_CI_DRAFT_TOKEN_KEY,
} from '../constants/localStorageKeys';
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
import { AddressInput } from '../components/AddressInput';
import { emptyAddress, type StructuredAddress } from '../../../shared/address';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { BRAND_COLORS, STATUS_COLORS } from '../theme';
import { normalizePhone, formatPhone } from '../utils/phoneFormatters';

// ── Types ─────────────────────────────────────────────────────────────────────

type PageState = 'loading' | 'main' | 'submitted' | 'expired' | 'already_submitted' | 'error';

interface FormData {
  structuredAddress: StructuredAddress;
  roomCount:         string;
  roomNotes:         string;
}

interface GenericFields {
  name:         string;
  email:        string;
  phone:        string;
  haveWeSpoken: string;
}

interface DraftPayload extends FormData {
  savedPhotoKeys?:  string[];
  savedPhotoNames?: string[];
  genericFields?:   GenericFields;
}

interface UploadedPhoto {
  key:          string;
  previewUrl:   string;
  name:         string;
  isPdf?:       boolean;
  unavailable?: boolean;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_PHOTOS = 15;
const TARGET_COMPRESSED_BYTES = 1.5 * 1024 * 1024;
const MAX_CANVAS_DIM = 2048;

// ── URL helpers ───────────────────────────────────────────────────────────────

/**
 * Returns the token from the URL path, or an empty string if at /customer-info
 * (generic mode — no token).
 */
function getUrlToken(): string {
  const parts = window.location.pathname.split('/').filter(Boolean);
  // /customer-info          → parts = ['customer-info']            → no token
  // /customer-info/:token   → parts = ['customer-info', '<token>'] → token present
  if (parts.length >= 2 && parts[0] === 'customer-info') return parts[1];
  return '';
}

/** Returns true when the page was loaded at /customer-info (no token in the URL). */
function isGenericUrl(): boolean {
  return getUrlToken() === '';
}

// ── Draft helpers ─────────────────────────────────────────────────────────────

function lsKey(token: string): string {
  return CUSTOMER_INFO_DRAFT_PREFIX + token;
}

function loadDraft(token: string): Partial<DraftPayload> {
  if (!token) return {};
  try {
    const raw = localStorage.getItem(lsKey(token));
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function saveDraft(token: string, data: FormData, photos: UploadedPhoto[], generic?: GenericFields) {
  if (!token) return;
  try {
    const payload: DraftPayload = {
      ...data,
      savedPhotoKeys:  photos.map(p => p.key),
      savedPhotoNames: photos.map(p => p.name),
    };
    if (generic) payload.genericFields = generic;
    localStorage.setItem(lsKey(token), JSON.stringify(payload));
  } catch { /* ignore */ }
}

function clearDraft(token: string) {
  if (!token) return;
  try {
    localStorage.removeItem(lsKey(token));
    localStorage.removeItem(GENERIC_CI_DRAFT_TOKEN_KEY);
  } catch { /* ignore */ }
}

function buildRestoredPhotos(keys: string[], names?: string[]): UploadedPhoto[] {
  return keys.map((k, i) => {
    const isPdf = k.split('?')[0].toLowerCase().endsWith('.pdf');
    const fallback = isPdf ? 'document.pdf' : 'photo';
    return {
      key:        k,
      previewUrl: '',
      name:       names?.[i] || fallback,
      isPdf,
    };
  });
}

async function resignSavedPhotosAfterRestore(
  token: string,
  initialPhotos: UploadedPhoto[],
  setPhotosFn: (updater: (prev: UploadedPhoto[]) => UploadedPhoto[]) => void,
): Promise<void> {
  if (!initialPhotos.length) return;
  try {
    const r = await fetch(`/api/customer-info/${encodeURIComponent(token)}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: initialPhotos.map(p => p.key) }),
    });
    const d = await r.json();
    if (!r.ok) return;
    const byKey: Record<string, string | null> = {};
    for (const result of d.results as Array<{ key: string; url: string | null }>) {
      byKey[result.key] = result.url;
    }
    setPhotosFn(prev => prev.map(p => {
      if (!(p.key in byKey)) return p;
      const url = byKey[p.key];
      if (!url) return { ...p, unavailable: true };
      return { ...p, previewUrl: url };
    }));
  } catch {
    /* Graceful: leave placeholder state if the sign request fails */
  }
}

function getStoredGenericToken(): string {
  try { return localStorage.getItem(GENERIC_CI_DRAFT_TOKEN_KEY) || ''; } catch { return ''; }
}

function setStoredGenericToken(token: string) {
  try { localStorage.setItem(GENERIC_CI_DRAFT_TOKEN_KEY, token); } catch { /* ignore */ }
}

// ── Image compression ─────────────────────────────────────────────────────────

const COMPRESS_TIMEOUT_MS = 8000;

async function compressImage(file: File): Promise<File> {
  return new Promise(resolve => {
    let settled = false;
    const done = (result: File) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    // Safety net: if onload never fires (e.g. iOS Chrome Files-app picker),
    // resolve after the timeout with the original file so the upload proceeds.
    const timeoutId = setTimeout(() => {
      console.warn('[compressImage] decode timed out — sending original file');
      URL.revokeObjectURL(objectUrl);
      done(file);
    }, COMPRESS_TIMEOUT_MS);

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
      if (!ctx) { done(file); return; }
      ctx.drawImage(img, 0, 0, width, height);
      const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
      const outName  = `${baseName}.jpg`;
      const tryQuality = (q: number) => {
        canvas.toBlob(blob => {
          if (!blob) { done(file); return; }
          if (blob.size <= TARGET_COMPRESSED_BYTES || q <= 0.3) {
            done(new File([blob], outName, { type: 'image/jpeg' }));
          } else {
            tryQuality(Math.max(+(q - 0.1).toFixed(1), 0.3));
          }
        }, 'image/jpeg', q);
      };
      tryQuality(0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); done(file); };
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
        setSiteKey('');
      }
    }).catch(() => setSiteKey(''));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const ready = siteKey !== null && (siteKey === '' || captchaToken.length > 0);
  return { siteKey, captchaToken, captchaError, ready, resetWidget };
}

// ── Main component ────────────────────────────────────────────────────────────

export function CustomerInfoPage() {
  // URL token: empty string means we're at /customer-info (generic mode).
  const urlToken = getUrlToken();
  const startGeneric = isGenericUrl();

  const [pageState, setPageState]   = useState<PageState>('loading');
  const [isGeneric, setIsGeneric]   = useState(startGeneric);
  const [genericDraftToken, setGenericDraftToken] = useState('');
  const [maskedEmail, setMaskedEmail] = useState('');
  const [maskedPhone, setMaskedPhone] = useState('');
  const [contactName, setContactName] = useState('');
  const [errorMsg, setErrorMsg]     = useState('');

  const [formData, setFormData] = useState<FormData>({
    structuredAddress: emptyAddress(),
    roomCount:         '1',
    roomNotes:         '',
  });

  const [genericFields, setGenericFields] = useState<GenericFields>({
    name: '', email: '', phone: '', haveWeSpoken: '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [photos, setPhotos]         = useState<UploadedPhoto[]>([]);
  const [uploading, setUploading]   = useState(false);
  const [uploadErr, setUploadErr]   = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr]   = useState('');

  const [phoneError, setPhoneError]   = useState('');

  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [resendErr, setResendErr]     = useState('');
  const turnstile = useTurnstileResend('ts-resend-expired', pageState === 'expired' && !!maskedEmail);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const draftSavedRef = useRef(false);

  // The token used for all API calls (photo uploads, submit).
  // For token-mode: the URL token. For generic-mode: the anonymous draft token.
  const activeToken = isGeneric ? genericDraftToken : urlToken;

  // ── Obtain or create a generic draft token ─────────────────────────────────

  const initGenericMode = useCallback(async () => {
    // Check for a stored token from a previous visit
    const stored = getStoredGenericToken();
    if (stored) {
      try {
        const r = await fetch(`/api/customer-info/${encodeURIComponent(stored)}`);
        const d = await r.json();
        if (r.ok && d.isGeneric) {
          // Stored token is still valid — reuse it
          setGenericDraftToken(stored);
          const draft = loadDraft(stored);
          setFormData(prev => ({ ...prev, ...draft, roomCount: draft.roomCount || '1' }));
          if (draft.genericFields) setGenericFields(draft.genericFields);
          if (draft.savedPhotoKeys?.length) {
            const restored = buildRestoredPhotos(draft.savedPhotoKeys, draft.savedPhotoNames);
            setPhotos(restored);
            void resignSavedPhotosAfterRestore(stored, restored, setPhotos);
          }
          setIsGeneric(true);
          setPageState('main');
          return;
        }
      } catch { /* fall through to create new */ }
    }

    // Create a new anonymous draft token
    try {
      const r = await fetch('/api/customer-info/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const d = await r.json();
      if (!r.ok || !d.token) throw new Error(d.error || 'Could not initialise form.');
      setStoredGenericToken(d.token);
      setGenericDraftToken(d.token);
      setIsGeneric(true);
      setPageState('main');
    } catch (e) {
      setErrorMsg((e as Error).message);
      setPageState('error');
    }
  }, []);

  // ── Mount effect ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (startGeneric) {
      // Generic page (/customer-info) — no URL token
      initGenericMode();
      return;
    }

    // Token-mode: fetch token data; fall back to generic on not_found/expired
    fetch(`/api/customer-info/${encodeURIComponent(urlToken)}`)
      .then(async r => {
        const d = await r.json();
        if (r.status === 410) {
          if (d.status === 'submitted') { setPageState('already_submitted'); return; }
          // expired or not_found → silently enter generic mode (task requirement)
          if (d.status === 'not_found' || d.status === 'expired') {
            await initGenericMode();
            return;
          }
          // Fallback for unexpected 410 variants → generic mode
          await initGenericMode();
          return;
        }
        if (!r.ok) {
          setErrorMsg(d.error || 'Could not load this form.');
          setPageState('error');
          return;
        }
        // Generic row via token URL (shouldn't normally happen, but handle gracefully)
        if (d.isGeneric) {
          setGenericDraftToken(urlToken);
          setIsGeneric(true);
          const draft = loadDraft(urlToken);
          setFormData(prev => ({ ...prev, ...draft, roomCount: draft.roomCount || '1' }));
          if (draft.genericFields) setGenericFields(draft.genericFields);
          if (draft.savedPhotoKeys?.length) {
            const restored = buildRestoredPhotos(draft.savedPhotoKeys, draft.savedPhotoNames);
            setPhotos(restored);
            void resignSavedPhotosAfterRestore(urlToken, restored, setPhotos);
          }
          setPageState('main');
          return;
        }
        setMaskedEmail(d.maskedEmail || '');
        setMaskedPhone(d.maskedPhone || '');
        setContactName(d.contactName || '');

        const draft = loadDraft(urlToken);
        setFormData(prev => ({
          ...prev,
          ...draft,
          roomCount: draft.roomCount || '1',
        }));
        if (draft.savedPhotoKeys?.length) {
          const restored = buildRestoredPhotos(draft.savedPhotoKeys, draft.savedPhotoNames);
          setPhotos(restored);
          void resignSavedPhotosAfterRestore(urlToken, restored, setPhotos);
        }
        setPageState('main');
      })
      .catch(() => {
        setErrorMsg('Failed to load the form. Please try again.');
        setPageState('error');
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Draft-save whenever formData, photos, or genericFields change (after initial restore)
  useEffect(() => {
    if (pageState !== 'main' || !activeToken) return;
    if (!draftSavedRef.current) { draftSavedRef.current = true; return; }
    saveDraft(activeToken, formData, photos, isGeneric ? genericFields : undefined);
  }, [formData, photos, genericFields]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleFieldChange(field: keyof FormData) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setFormData(prev => {
        const updated = { ...prev, [field]: e.target.value };
        if (activeToken) saveDraft(activeToken, updated, photos, isGeneric ? genericFields : undefined);
        return updated;
      });
    };
  }

  function handleGenericFieldChange(field: keyof GenericFields) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setGenericFields(prev => {
        const updated = { ...prev, [field]: e.target.value };
        if (activeToken) saveDraft(activeToken, formData, photos, updated);
        return updated;
      });
      if (fieldErrors[field]) setFieldErrors(prev => ({ ...prev, [field]: '' }));
    };
  }

  async function handlePhotoUpload(files: FileList) {
    if (!files.length || !activeToken) return;
    setUploadErr('');

    const currentCount = photos.length;
    if (currentCount >= MAX_PHOTOS) {
      setUploadErr(`You've reached the ${MAX_PHOTOS} file limit — remove one to add another.`);
      return;
    }

    const remaining = MAX_PHOTOS - currentCount;
    const fileArray = Array.from(files).slice(0, remaining);
    const truncated = files.length > remaining;

    setUploading(true);
    try {
      const prepared = await Promise.all(fileArray.map(f => {
        if (f.type === 'application/pdf') return Promise.resolve(f);
        return compressImage(f);
      }));
      const fd = new FormData();
      for (const f of prepared) {
        fd.append('photos', f);
      }
      const r = await fetch(`/api/customer-info/${encodeURIComponent(activeToken)}/photos`, {
        method: 'POST',
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Upload failed');
      const newPhotos: UploadedPhoto[] = (d.keys as string[]).map((key, i) => {
        const f = prepared[i];
        const isPdf = f.type === 'application/pdf';
        return {
          key,
          previewUrl: isPdf ? '' : URL.createObjectURL(f),
          name: f.name,
          isPdf,
        };
      });
      setPhotos(prev => {
        const updated = [...prev, ...newPhotos];
        if (activeToken) saveDraft(activeToken, formData, updated, isGeneric ? genericFields : undefined);
        return updated;
      });
      if (truncated) {
        setUploadErr(`Only ${remaining} file${remaining === 1 ? '' : 's'} added — you've reached the ${MAX_PHOTOS} file limit.`);
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
      if (activeToken) saveDraft(activeToken, formData, updated, isGeneric ? genericFields : undefined);
      return updated;
    });
  }

  // Blur handler for the generic phone field.
  // Reformats the raw input to international display form and validates.
  function handlePhoneBlur() {
    const raw = genericFields.phone.trim();
    if (!raw) {
      setPhoneError('');
      return;
    }
    const e164 = normalizePhone(raw, 'GB');
    if (e164 === null) {
      setPhoneError('Please enter a valid phone number (e.g. 07700 900123).');
    } else {
      const displayVal = formatPhone(e164);
      setGenericFields(prev => ({ ...prev, phone: displayVal }));
      setPhoneError('');
      if (activeToken) saveDraft(activeToken, formData, photos, { ...genericFields, phone: displayVal });
    }
  }


  async function handleSubmit() {
    setSubmitErr('');

    // Validate generic-specific required fields
    if (isGeneric) {
      const errors: Record<string, string> = {};
      if (!genericFields.name.trim())  errors.name  = 'Please enter your full name.';
      if (!genericFields.email.trim()) errors.email = 'Please enter your email address.';
      else if (!genericFields.email.includes('@')) errors.email = 'Please enter a valid email address.';
      if (!genericFields.phone.trim()) {
        errors.phone = 'Please enter your phone number.';
      } else {
        const phoneNorm = normalizePhone(genericFields.phone.trim(), 'GB');
        if (phoneNorm === null) errors.phone = 'Please enter a valid phone number (e.g. 07700 900123).';
      }
      if (Object.keys(errors).length > 0) {
        setFieldErrors(errors);
        setSubmitErr('Please fill in all required fields above.');
        return;
      }
    }

    const addr = formData.structuredAddress;
    if (!(addr.addressLines[0] || '').trim()) { setSubmitErr('Please enter the first line of your address.'); return; }
    if (!(addr.locality || '').trim())        { setSubmitErr('Please enter your city or town.'); return; }
    if (!(addr.postalCode || '').trim())      { setSubmitErr('Please enter your postcode.'); return; }
    if (!formData.roomCount)                  { setSubmitErr('Please select how many rooms.'); return; }

    const hasUnavailable = photos.some(p => p.unavailable);
    if (hasUnavailable) {
      setSubmitErr('One or more previously uploaded files are no longer available — please remove them and re-upload before submitting.');
      return;
    }

    if (!activeToken) { setSubmitErr('Form not ready — please refresh the page.'); return; }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        structuredAddress: formData.structuredAddress,
        roomCount:         formData.roomCount,
        roomNotes:         formData.roomNotes.trim() || undefined,
        photoKeys:         photos.map(p => p.key),
      };
      if (isGeneric) {
        body.name         = genericFields.name.trim();
        body.email        = genericFields.email.trim();
        body.phone        = genericFields.phone.trim();
        body.haveWeSpoken = genericFields.haveWeSpoken.trim() || undefined;
      }

      const r = await fetch(`/api/customer-info/${encodeURIComponent(activeToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        if (d.code === 'LEAD_STATUS_REMOVED') {
          throw new Error('This form is temporarily unavailable due to a configuration change. Please contact us directly and we\'ll be happy to help.');
        }
        throw new Error(d.error || 'Submission failed');
      }
      clearDraft(activeToken);
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
      <Box sx={{ maxWidth: 640, mx: 'auto', px: 2.5 }}>
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
                            `/api/customer-info/${encodeURIComponent(urlToken)}/resend-expired`,
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
            {!isGeneric && contactName && (
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
                Hi {contactName.split(' ')[0]}, please fill in the details below so we can prepare the best possible quote for you.
              </Typography>
            )}
            {isGeneric && (
              <Typography variant="body2" sx={{ color: 'text.secondary', mb: 3 }}>
                Please fill in the details below so we can prepare the best possible quote for you.
              </Typography>
            )}

            {/* Section 1 — Your Information */}
            <SectionCard title="Your Information">
              <Stack spacing={2}>
                {isGeneric ? (
                  /* Generic mode: full name / email / phone required */
                  <>
                    <TextField
                      label="Full name"
                      placeholder="e.g. Jane Smith"
                      value={genericFields.name}
                      onChange={handleGenericFieldChange('name')}
                      fullWidth
                      size="small"
                      required
                      error={!!fieldErrors.name}
                      helperText={fieldErrors.name}
                      disabled={submitting}
                    />
                    <TextField
                      label="Email address"
                      placeholder="e.g. jane@example.com"
                      value={genericFields.email}
                      onChange={handleGenericFieldChange('email')}
                      fullWidth
                      size="small"
                      required
                      type="email"
                      error={!!fieldErrors.email}
                      helperText={fieldErrors.email}
                      disabled={submitting}
                    />
                    <TextField
                      label="Phone number"
                      placeholder="e.g. 07700 900123"
                      value={genericFields.phone}
                      onChange={e => {
                        handleGenericFieldChange('phone')(e);
                        if (phoneError) setPhoneError('');
                      }}
                      onBlur={handlePhoneBlur}
                      fullWidth
                      size="small"
                      required
                      type="tel"
                      error={!!(fieldErrors.phone || phoneError)}
                      helperText={fieldErrors.phone || phoneError || undefined}
                      disabled={submitting}
                    />
                  </>
                ) : (
                  /* Token mode: show masked details read-only */
                  <>
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
                      </Box>
                    )}
                  </>
                )}

                <Divider sx={{ my: 0.5 }} />

                <AddressInput
                  value={formData.structuredAddress}
                  onChange={(next) => {
                    setFormData(prev => {
                      const updated = { ...prev, structuredAddress: next };
                      if (activeToken) saveDraft(activeToken, updated, photos);
                      return updated;
                    });
                  }}
                  required
                  disabled={submitting}
                  idPrefix="ci-address"
                  surface="customerInfo"
                  postcodeFirst
                />
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

                  {(() => {
                    const atLimit = photos.length >= MAX_PHOTOS;
                    const disabled = uploading || atLimit || !activeToken;
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
                          accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
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
                              Tap to upload photos or PDFs
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              Up to {MAX_PHOTOS} files · JPEG, PNG, WebP or PDF
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
                        p.isPdf ? (
                          /* PDF file — show a filename chip instead of an image thumbnail */
                          <Box
                            key={p.key}
                            sx={{
                              position: 'relative',
                              borderRadius: 1.5,
                              aspectRatio: '1',
                              bgcolor: p.unavailable ? 'grey.50' : 'grey.100',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexDirection: 'column',
                              gap: 0.5,
                              p: 0.75,
                              border: '1px solid',
                              borderColor: p.unavailable ? 'warning.light' : 'grey.200',
                            }}
                          >
                            <PictureAsPdfIcon
                              sx={{ fontSize: 28, color: p.unavailable ? 'text.disabled' : 'error.main' }}
                            />
                            {p.unavailable ? (
                              <Typography
                                variant="caption"
                                sx={{
                                  fontSize: '0.55rem',
                                  color: 'text.disabled',
                                  lineHeight: 1.2,
                                  textAlign: 'center',
                                }}
                              >
                                File no longer available
                              </Typography>
                            ) : (
                              <>
                                <Typography
                                  variant="caption"
                                  sx={{
                                    fontSize: '0.55rem',
                                    color: 'text.secondary',
                                    lineHeight: 1.2,
                                    wordBreak: 'break-all',
                                    textAlign: 'center',
                                    maxWidth: '100%',
                                    overflow: 'hidden',
                                    display: '-webkit-box',
                                    WebkitLineClamp: 2,
                                    WebkitBoxOrient: 'vertical',
                                  }}
                                >
                                  {p.name}
                                </Typography>
                                {p.previewUrl && (
                                  <Typography
                                    component="a"
                                    href={p.previewUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    variant="caption"
                                    sx={{
                                      fontSize: '0.5rem',
                                      color: 'primary.main',
                                      textDecoration: 'underline',
                                      lineHeight: 1,
                                    }}
                                  >
                                    View
                                  </Typography>
                                )}
                              </>
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
                        ) : (
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
                        )
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

                {/* Have we spoken? — generic mode only */}
                {isGeneric && (
                  <Box>
                    <TextField
                      label="Have we spoken? (optional)"
                      placeholder="I messaged you on Instagram a few weeks ago..."
                      value={genericFields.haveWeSpoken}
                      onChange={handleGenericFieldChange('haveWeSpoken')}
                      fullWidth
                      multiline
                      minRows={3}
                      size="small"
                      disabled={submitting}
                    />
                  </Box>
                )}
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
              disabled={submitting || uploading || photos.some(p => p.unavailable)}
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
