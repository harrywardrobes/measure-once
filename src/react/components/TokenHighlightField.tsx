import React, {
  useCallback,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import Box from '@mui/material/Box';
import FormHelperText from '@mui/material/FormHelperText';

import { STATUS_COLORS } from '../theme';

// ── Token analysis ────────────────────────────────────────────────────────────

// A perfectly-balanced `{{word}}` whose name is a clean `\w+` identifier is a
// real token. Anything else is a malformed placeholder — a likely typo that
// would render literally in the sent email:
//   - a mismatched brace count (`{word}`, `{{word}`, `{word}}`), or
//   - a balanced `{{…}}` whose name has stray characters that break
//     substitution (`{{first Name}}`, `{{first-name}}`, `{{first.name}}`), or
//   - a `{{` opener with no matching closing braces (`{{firstName`) — see the
//     over-eager guard below for when an unclosed opener becomes a warning.
// A lone-brace run around stray content (e.g. CSS `{color:red}`) is left as
// plain text — only `\w+` lone-brace runs are treated as brace-count typos.
const CLEAN_NAME_RE = /^\w+$/;
const NAME_PREFIX_RE = /^\w*/;

type SegmentKind = 'plain' | 'known' | 'unknown' | 'malformed';

interface Segment {
  text: string;
  kind: SegmentKind;
  /** Clean variable name, present only for `known` / `unknown` token segments. */
  name?: string;
}

/**
 * Split `text` into plain / known-token / unknown-token / malformed segments.
 * A well-formed token is a balanced `{{word}}` sequence (classified known or
 * unknown). The following are flagged as `malformed` so an obvious typo stands
 * out from a well-formed-but-unknown token:
 *   - a mismatched open/close brace count (`{word}`, `{{word}`, `{word}}`);
 *   - a balanced `{{…}}` whose name has stray characters (`{{first Name}}`);
 *   - a `{{` opener with no matching closing braces (`{{firstName`).
 *
 * Over-eager guard for unclosed openers: a bare `{{word` (or `{{`) sitting at
 * the very end of the input is treated as still-being-typed and left plain, so
 * the field does not flash amber on every keystroke while a token is typed.
 * It only becomes a warning once it is *followed by more text* — a space,
 * punctuation, a newline, or another brace run — which signals the user has
 * moved on and forgotten the closing `}}`.
 */
export function buildSegments(text: string, known: Set<string>): Segment[] {
  const segments: Segment[] = [];
  let plainStart = 0;
  let i = 0;

  const pushPlain = (end: number) => {
    if (end > plainStart) {
      segments.push({ text: text.slice(plainStart, end), kind: 'plain' });
    }
  };

  while (i < text.length) {
    if (text[i] !== '{') {
      i++;
      continue;
    }

    const openStart = i;
    const openLen = text[i + 1] === '{' ? 2 : 1;
    let j = openStart + openLen;
    const contentStart = j;
    while (j < text.length && text[j] !== '{' && text[j] !== '}') j++;
    const content = text.slice(contentStart, j);

    if (j < text.length && text[j] === '}') {
      // A closing brace run is present — this is a closed placeholder.
      const closeStart = j;
      const closeLen = text[j + 1] === '}' ? 2 : 1;
      const balanced = openLen === 2 && closeLen === 2;
      const cleanName = CLEAN_NAME_RE.test(content);
      // A lone-brace run around stray content (CSS, code) isn't a placeholder —
      // leave it as plain text so we only flag genuine typos.
      if (!balanced && !cleanName) {
        i = closeStart + closeLen;
        continue;
      }
      pushPlain(openStart);
      const full = text.slice(openStart, closeStart + closeLen);
      if (balanced && cleanName) {
        segments.push({
          text: full,
          kind: known.has(content) ? 'known' : 'unknown',
          name: content,
        });
      } else {
        // Wrong brace count, or a balanced `{{…}}` whose name has stray chars.
        segments.push({ text: full, kind: 'malformed' });
      }
      i = closeStart + closeLen;
      plainStart = i;
      continue;
    }

    // No closing brace before end-of-string or before the next `{`. Only a
    // two-brace opener is treated as an intended token; a lone `{name` with no
    // close is far more likely to be literal text and stays plain.
    if (openLen === 2) {
      const atEnd = j === text.length;
      const cleanPartial = content === '' || CLEAN_NAME_RE.test(content);
      if (atEnd && cleanPartial) {
        // Over-eager guard: a bare `{{word` at the very end of the input is
        // still being typed — leave the remainder plain.
        i = j;
        continue;
      }
      // Unclosed opener followed by more text — flag `{{` plus its leading name.
      const name = NAME_PREFIX_RE.exec(content)![0];
      const tokenEnd = contentStart + name.length;
      pushPlain(openStart);
      segments.push({ text: text.slice(openStart, tokenEnd), kind: 'malformed' });
      i = tokenEnd;
      plainStart = i;
      continue;
    }

    // Single-brace opener with no close — plain text; advance past it.
    i = openStart + openLen;
  }

  pushPlain(text.length);
  return segments;
}

// ── Aggregate token analysis (for save-guard banners) ──────────────────────────

export interface TemplateTokenAnalysis {
  /** Clean token names used anywhere (both known and unknown). */
  usedNames: string[];
  /** Token names not present in the known-variable set. */
  unknownNames: string[];
  /** Literal text of malformed placeholders (wrong braces, stray chars, or
   *  unclosed openers). */
  malformedTokens: string[];
}

/**
 * Analyse one or more template fields and aggregate the token findings, reusing
 * the exact `buildSegments` classification so a field's inline highlight and the
 * save-guard banner never disagree. Each field is analysed independently so the
 * unclosed-opener over-eager guard applies per field (an opener typed at the end
 * of one field is not treated as "followed by" the next field's text).
 */
export function analyzeTemplateTokens(
  texts: string[],
  known: Set<string>,
): TemplateTokenAnalysis {
  const used = new Set<string>();
  const unknown = new Set<string>();
  const malformed = new Set<string>();
  for (const text of texts) {
    for (const seg of buildSegments(text, known)) {
      if (seg.kind === 'malformed') {
        malformed.add(seg.text);
      } else if (seg.name) {
        used.add(seg.name);
        if (seg.kind === 'unknown') unknown.add(seg.name);
      }
    }
  }
  return {
    usedNames: [...used],
    unknownNames: [...unknown],
    malformedTokens: [...malformed],
  };
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
  /** Called when this field gains focus — lets a parent track the last-focused field. */
  onFocus?: () => void;
  'data-testid'?: string;
}

/** Imperative handle exposed via ref for programmatic caret insertion. */
export interface TokenHighlightFieldHandle {
  /**
   * Insert `text` at the current caret position (replacing any selection).
   * When `opts.append` is true the text is appended to the end of the field
   * instead, with a separating space added if the field is non-empty.
   */
  insertAtCaret: (text: string, opts?: { append?: boolean }) => void;
  /** Move keyboard focus to the field. */
  focus: () => void;
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
export const TokenHighlightField = React.forwardRef<
  TokenHighlightFieldHandle,
  TokenHighlightFieldProps
>(function TokenHighlightField({
  label,
  value,
  onChange,
  knownVariables,
  multiline = false,
  minRows = 1,
  required = false,
  helperText,
  onFocus,
  'data-testid': dataTestId,
}: TokenHighlightFieldProps, ref) {
  const reactId = useId();
  const inputId = `token-field-${reactId}`;
  const [focused, setFocused] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // Caret position to restore after a programmatic insert re-renders the field.
  const pendingCaretRef = useRef<number | null>(null);

  const knownSet = useMemo(() => new Set(knownVariables), [knownVariables]);
  const segments = useMemo(() => buildSegments(value, knownSet), [value, knownSet]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => textareaRef.current?.focus(),
      insertAtCaret: (text, opts) => {
        const el = textareaRef.current;
        if (!el) return;
        let start: number;
        let end: number;
        let insertText = text;
        if (opts?.append) {
          start = value.length;
          end = value.length;
          if (value.length > 0 && !/\s$/.test(value)) {
            insertText = ' ' + text;
          }
        } else {
          start = el.selectionStart ?? value.length;
          end = el.selectionEnd ?? value.length;
        }
        const newValue = value.slice(0, start) + insertText + value.slice(end);
        pendingCaretRef.current = start + insertText.length;
        // Set the DOM value so the synthetic change carries the new text, then
        // notify the parent (its handler only reads e.target.value).
        el.value = newValue;
        onChange({
          target: el,
          currentTarget: el,
        } as unknown as React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>);
      },
    }),
    [value, onChange],
  );

  // Auto-grow the textarea to fit its content (mirrors MUI's TextareaAutosize).
  useLayoutEffect(() => {
    if (!multiline) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value, multiline]);

  // Restore focus + caret after a programmatic insert updates the value.
  useLayoutEffect(() => {
    if (pendingCaretRef.current == null) return;
    const el = textareaRef.current;
    if (el) {
      const pos = pendingCaretRef.current;
      el.focus();
      el.setSelectionRange(pos, pos);
    }
    pendingCaretRef.current = null;
  }, [value]);

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
          onFocus={() => { setFocused(true); onFocus?.(); }}
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
});

export default TokenHighlightField;
