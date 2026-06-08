import React, {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import Box from '@mui/material/Box';
import FormHelperText from '@mui/material/FormHelperText';

import { STATUS_COLORS } from '../theme';

// ── Token analysis ────────────────────────────────────────────────────────────

// Matches any run of 1–2 opening braces, a word, then 1–2 closing braces.
// A perfectly-balanced `{{word}}` is a real token; anything else with a
// mismatched brace count (`{word}`, `{{word}`, `{word}}`) is a malformed
// placeholder — a likely typo that would render literally in the sent email.
const PLACEHOLDER_RE = /(\{{1,2})(\w+)(\}{1,2})/g;

type SegmentKind = 'plain' | 'known' | 'unknown' | 'malformed';

interface Segment {
  text: string;
  kind: SegmentKind;
}

/**
 * Split `text` into plain / known-token / unknown-token / malformed segments.
 * A well-formed token is a balanced `{{word}}` sequence (classified known or
 * unknown). A brace run with a mismatched open/close count — `{word}`,
 * `{{word}`, `{word}}` — is flagged as `malformed` so an obvious typo stands
 * out from a well-formed-but-unknown token. Partial typing with no closing
 * brace (`{{fo`) stays plain until it is closed.
 */
export function buildSegments(text: string, known: Set<string>): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ text: text.slice(last, m.index), kind: 'plain' });
    }
    const balanced = m[1].length === 2 && m[3].length === 2;
    segments.push({
      text: m[0],
      kind: balanced ? (known.has(m[2]) ? 'known' : 'unknown') : 'malformed',
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ text: text.slice(last), kind: 'plain' });
  }
  return segments;
}

// ── Shared metrics ─────────────────────────────────────────────────────────────
// These must match between the transparent <textarea>/<input> and the backdrop
// so the highlighted mirror lines up character-for-character.

const PAD_Y = 16.5;
const PAD_X = 14;
const FONT_SIZE = '1rem';
const LINE_HEIGHT = 1.4375; // matches MUI OutlinedInput input line-height (1.4375em)

const textMetrics: React.CSSProperties = {
  fontFamily: 'inherit',
  fontSize: FONT_SIZE,
  lineHeight: LINE_HEIGHT,
  letterSpacing: 'inherit',
  margin: 0,
  padding: `${PAD_Y}px ${PAD_X}px`,
  border: 0,
  boxSizing: 'border-box',
};

// ── Component ──────────────────────────────────────────────────────────────────

export interface TokenHighlightFieldProps {
  label: string;
  value: string;
  onChange: (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  /** Variable names recognised by the template — anything else renders as an unknown token. */
  knownVariables: string[];
  multiline?: boolean;
  minRows?: number;
  required?: boolean;
  helperText?: React.ReactNode;
  'data-testid'?: string;
}

/**
 * TokenHighlightField — an outlined text field that highlights `{{token}}`
 * placeholders directly in the text as the user types. Known variables are
 * tinted green; unknown ones get a red, spell-checker-style wavy underline so a
 * typo is obvious without reading a separate banner.
 *
 * Built from MUI primitives: a transparent native input/textarea is layered on
 * top of a styled "backdrop" mirror that renders the same text with coloured
 * token spans. Both layers share identical font metrics and padding so they
 * stay aligned; the textarea auto-grows and the single-line input syncs its
 * horizontal scroll into the backdrop.
 */
export function TokenHighlightField({
  label,
  value,
  onChange,
  knownVariables,
  multiline = false,
  minRows = 1,
  required = false,
  helperText,
  'data-testid': dataTestId,
}: TokenHighlightFieldProps) {
  const reactId = useId();
  const inputId = `token-field-${reactId}`;
  const [focused, setFocused] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const knownSet = useMemo(() => new Set(knownVariables), [knownVariables]);
  const segments = useMemo(() => buildSegments(value, knownSet), [value, knownSet]);

  // Auto-grow the textarea to fit its content (mirrors MUI's TextareaAutosize).
  useLayoutEffect(() => {
    if (!multiline) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value, multiline]);

  // Keep the backdrop's horizontal scroll in sync for the single-line input.
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      if (backdropRef.current) {
        backdropRef.current.scrollLeft = el.scrollLeft;
        backdropRef.current.scrollTop = el.scrollTop;
      }
    },
    [],
  );

  const minHeight = multiline
    ? `calc(${minRows} * ${LINE_HEIGHT}em + ${PAD_Y * 2}px)`
    : undefined;

  const wrapperBorder = focused ? 'primary.main' : 'rgba(0, 0, 0, 0.23)';

  const sharedLayer: React.CSSProperties = {
    ...textMetrics,
    width: '100%',
    whiteSpace: multiline ? 'pre-wrap' : 'pre',
    overflowWrap: multiline ? 'break-word' : 'normal',
    wordBreak: 'normal',
    overflow: 'hidden',
  };

  return (
    <Box sx={{ width: '100%' }} data-testid={dataTestId}>
      <Box
        sx={{
          position: 'relative',
          borderRadius: 1,
          border: '1px solid',
          borderColor: focused ? 'primary.main' : wrapperBorder,
          transition: 'border-color 120ms ease, box-shadow 120ms ease',
          boxShadow: focused ? (t) => `0 0 0 1px ${t.palette.primary.main}` : 'none',
          bgcolor: 'background.paper',
          '&:hover': { borderColor: focused ? 'primary.main' : 'text.primary' },
        }}
      >
        {/* Floating label (always shrunk, notching the top border). */}
        <Box
          component="label"
          htmlFor={inputId}
          sx={{
            position: 'absolute',
            top: 0,
            left: 0,
            transform: 'translate(11px, -9px) scale(0.75)',
            transformOrigin: 'top left',
            px: '5px',
            bgcolor: 'background.paper',
            color: focused ? 'primary.main' : 'text.secondary',
            fontSize: FONT_SIZE,
            lineHeight: 1,
            pointerEvents: 'none',
            maxWidth: 'calc(133% - 24px)',
            zIndex: 1,
          }}
        >
          {label}
          {required ? ' *' : ''}
        </Box>

        {/* Backdrop mirror — visible, highlighted text. */}
        <Box
          ref={backdropRef}
          aria-hidden
          sx={{
            ...sharedLayer,
            position: 'absolute',
            inset: 0,
            color: 'text.primary',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        >
          {segments.map((seg, i) => {
            if (seg.kind === 'plain') {
              return <React.Fragment key={i}>{seg.text}</React.Fragment>;
            }
            const isUnknown = seg.kind === 'unknown';
            const isMalformed = seg.kind === 'malformed';
            const underlined = isUnknown || isMalformed;
            const palette = isMalformed
              ? STATUS_COLORS.warning
              : isUnknown
                ? STATUS_COLORS.error
                : STATUS_COLORS.success;
            const underlineColor = isMalformed
              ? STATUS_COLORS.warningDeep.bg
              : STATUS_COLORS.danger.text;
            return (
              <Box
                key={i}
                component="span"
                sx={{
                  bgcolor: palette.bg,
                  color: palette.text,
                  borderRadius: '2px',
                  textDecoration: underlined ? 'underline' : 'none',
                  textDecorationStyle: underlined ? 'wavy' : undefined,
                  textDecorationColor: underlined ? underlineColor : undefined,
                  WebkitBoxDecorationBreak: 'clone',
                  boxDecorationBreak: 'clone',
                }}
              >
                {seg.text}
              </Box>
            );
          })}
          {/* Guarantee the backdrop is at least as tall as a trailing blank line. */}
          {value.endsWith('\n') ? '\u200b' : ''}
        </Box>

        {/* Transparent text input layered on top — provides caret, selection, editing. */}
        <Box
          component={multiline ? 'textarea' : 'input'}
          id={inputId}
          ref={textareaRef as React.Ref<HTMLTextAreaElement>}
          value={value}
          onChange={onChange}
          onScroll={handleScroll}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          rows={multiline ? minRows : undefined}
          required={required}
          aria-required={required || undefined}
          spellCheck={false}
          sx={{
            ...sharedLayer,
            position: 'relative',
            display: 'block',
            minHeight,
            resize: 'none',
            background: 'transparent',
            color: 'transparent',
            caretColor: (t) => t.palette.text.primary,
            outline: 'none',
            '&::selection': { color: 'transparent' },
            '&::-moz-selection': { color: 'transparent' },
          }}
        />
      </Box>

      {helperText != null && helperText !== '' && (
        <FormHelperText sx={{ mx: '14px' }}>{helperText}</FormHelperText>
      )}
    </Box>
  );
}

export default TokenHighlightField;
