import React from 'react';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export const MIN_SCORE = 2;
export const MAX_LENGTH = 200;
export const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
export const STRENGTH_COLORS: Array<'error' | 'warning' | 'info' | 'success'> = [
  'error', 'warning', 'warning', 'success', 'success',
];

export interface ZxcvbnResult {
  score: 0 | 1 | 2 | 3 | 4;
  feedback?: { warning?: string; suggestions?: string[] };
  crack_times_display?: { offline_slow_hashing_1e4_per_second?: string };
}
export type ZxcvbnFn = (password: string, userInputs?: string[]) => ZxcvbnResult;

let _zxcvbnCache: ZxcvbnFn | null = null;
let _zxcvbnPromise: Promise<ZxcvbnFn> | null = null;

export function loadZxcvbn(): Promise<ZxcvbnFn> {
  if (_zxcvbnCache) return Promise.resolve(_zxcvbnCache);
  if (!_zxcvbnPromise) {
    _zxcvbnPromise = import('zxcvbn').then((m) => {
      let fn: ZxcvbnFn | null = null;
      if (typeof m.default === 'function') {
        fn = m.default as unknown as ZxcvbnFn;
      } else if (typeof (m as unknown as ZxcvbnFn) === 'function') {
        fn = m as unknown as ZxcvbnFn;
      } else {
        console.warn('[loadZxcvbn] Could not resolve zxcvbn as a function; strength meter will be unavailable.');
      }
      if (fn !== null) _zxcvbnCache = fn;
      return fn as ZxcvbnFn;
    });
  }
  return _zxcvbnPromise;
}

export async function checkPasswordPolicy(pw: string, userInputs: string[]): Promise<string | null> {
  if (!pw) return 'Password is required.';
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > MAX_LENGTH) return 'Password is too long.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
    return 'Password must contain both letters and numbers.';
  }
  const zxcvbnFn = await loadZxcvbn();
  let r: ZxcvbnResult;
  try {
    r = zxcvbnFn(pw.slice(0, MAX_LENGTH), userInputs);
  } catch (err) {
    console.error('[checkPasswordPolicy] zxcvbn threw during scoring:', err);
    return null;
  }
  if (r.score < MIN_SCORE) {
    const warning = r.feedback?.warning;
    return warning
      ? 'Password is too easy to guess: ' + warning
      : 'Password is too easy to guess — please choose something less common.';
  }
  return null;
}

export class StrengthMeterErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { caught: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { caught: false };
  }
  static getDerivedStateFromError() { return { caught: true }; }
  render() { return this.state.caught ? null : this.props.children; }
}

export function StrengthMeter({ value, userInputs }: { value: string; userInputs: string[] }) {
  const [zxcvbnFn, setZxcvbnFn] = React.useState<ZxcvbnFn | null>(() => _zxcvbnCache);

  React.useEffect(() => {
    if (!value || zxcvbnFn) return;
    loadZxcvbn().then((fn) => { if (fn) setZxcvbnFn(() => fn); });
  }, [value, zxcvbnFn]);

  if (typeof value !== 'string') return null;
  if (!value) return null;

  if (!zxcvbnFn) {
    return (
      <Box sx={{ mt: 1 }}>
        <LinearProgress variant="indeterminate" sx={{ height: 6, borderRadius: 999 }} />
      </Box>
    );
  }

  try {
    // zxcvbn guarantees score is 0–4, but clamp defensively here because
    // an out-of-range value (e.g. undefined from an unexpected zxcvbn build)
    // makes ((score + 1) / 5) * 100 evaluate to NaN, and MUI v9 LinearProgress
    // throws a prop-validation error on NaN `value` during React render — after
    // the try/catch has already exited, so the try/catch cannot catch it.
    // Clamping to a valid integer ensures LinearProgress always receives a
    // well-formed number, so the error boundary is only a last-resort backstop
    // rather than the primary defence.
    const r = zxcvbnFn(value.slice(0, MAX_LENGTH), userInputs);
    const rawScore = r?.score;
    const score: 0 | 1 | 2 | 3 | 4 =
      typeof rawScore === 'number' && rawScore >= 0 && rawScore <= 4
        ? (rawScore as 0 | 1 | 2 | 3 | 4)
        : 0;
    const crack = r?.crack_times_display?.offline_slow_hashing_1e4_per_second || '';
    const suggestion = score < MIN_SCORE
      ? (r?.feedback?.warning || 'Too easy to guess — try a longer or less common password.')
      : (r?.feedback?.suggestions?.[0] || '');
    return (
      <Box sx={{ mt: 1 }}>
        <LinearProgress
          variant="determinate"
          value={((score + 1) / 5) * 100}
          color={STRENGTH_COLORS[score]}
          sx={{ height: 6, borderRadius: 999 }}
        />
        <Stack direction="row" sx={{ mt: 0.5, justifyContent: 'space-between' }}>
          <Typography variant="caption" color="text.secondary">
            Strength: <Box component="strong" sx={{ color: 'text.primary' }}>{STRENGTH_LABELS[score]}</Box>
          </Typography>
          {crack && (
            <Typography variant="caption" color="text.secondary">Crack time: {crack}</Typography>
          )}
        </Stack>
        {suggestion && (
          <Typography variant="caption" sx={{ display: 'block', mt: 0.25, color: 'warning.dark' }}>
            {suggestion}
          </Typography>
        )}
      </Box>
    );
  } catch (err) {
    console.error('[StrengthMeter] threw during render:', err);
    return null;
  }
}
