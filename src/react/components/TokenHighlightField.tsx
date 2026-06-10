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
import Tooltip from '@mui/material/Tooltip';
import { visuallyHidden } from '@mui/utils';

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

/**
 * Why a placeholder is malformed — lets callers give a precise, plain-language
 * explanation instead of one generic "check the braces" message:
 *   - `brace-count`  — wrong number of braces (`{word}`, `{{word}`, `{word}}`);
 *   - `invalid-name` — balanced `{{…}}` whose name has stray characters
 *                      (`{{first Name}}`, `{{first-name}}`, `{{first.name}}`);
 *   - `unclosed`     — a `{{` opener with no matching closing braces
 *                      (`{{firstName` followed by more text).
 */
export type MalformedReason = 'brace-count' | 'invalid-name' | 'unclosed';

// ── Malformed-placeholder messaging (shared) ──────────────────────────────────
// Each malformed cause gets its own precise, plain-language explanation so the
// fix is obvious (a missing closing `}}` is a different problem from the wrong
// number of braces or a name with stray characters). This is the single source
// of wording for both the inline hover hint (below) and the save-guard banner /
// confirm dialog in EmailTemplatesPage, so the two surfaces never disagree.

export interface MalformedReasonText {
  /** Short heading naming the cause, e.g. "Missing closing braces". */
  heading: string;
  /** One-line plain-language explanation of how to fix it. */
  explanation: string;
}

export const MALFORMED_REASON_TEXT: Record<MalformedReason, MalformedReasonText> = {
  unclosed: {
    heading: 'Missing closing braces',
    explanation:
      'this opens with {{ but is never closed — add the closing }} to finish it, e.g. {{firstName}}',
  },
  'brace-count': {
    heading: 'Wrong number of braces',
    explanation:
      'variables need exactly two curly braces on each side, e.g. {{firstName}}',
  },
  'invalid-name': {
    heading: 'Invalid characters in the name',
    explanation:
      'names can only contain letters, numbers and underscores — no spaces, hyphens or dots, e.g. {{firstName}}',
  },
};

// Fixed display order: surface unclosed openers first (most confusing), then
// brace-count typos, then stray-character names.
export const MALFORMED_REASON_ORDER: MalformedReason[] = [
  'unclosed',
  'brace-count',
  'invalid-name',
];

/**
 * Plain-language hint for the inline hover tooltip on a malformed token,
 * combining the same heading + explanation the save-guard banner uses.
 */
export function malformedReasonHint(reason: MalformedReason): string {
  const { heading, explanation } = MALFORMED_REASON_TEXT[reason];
  return `${heading}: ${explanation}`;
}

interface Segment {
  text: string;
  kind: SegmentKind;
  /** Clean variable name, present only for `known` / `unknown` token segments. */
  name?: string;
  /** Present only for `malformed` segments — why the placeholder is malformed. */
  malformedReason?: MalformedReason;
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
        // A balanced `{{…}}` reaching here has stray characters in the name;
        // anything else is a mismatched brace count.
        segments.push({
          text: full,
          kind: 'malformed',
          malformedReason: balanced ? 'invalid-name' : 'brace-count',
        });
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
      segments.push({
        text: text.slice(openStart, tokenEnd),
        kind: 'malformed',
        malformedReason: 'unclosed',
      });
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

/** A malformed placeholder plus the specific reason it is malformed. */
export interface MalformedToken {
  /** Literal text of the malformed placeholder, e.g. `{firstName}`. */
  text: string;
  /** Why it is malformed — drives the precise save-guard explanation. */
  reason: MalformedReason;
}

export interface TemplateTokenAnalysis {
  /** Clean token names used anywhere (both known and unknown). */
  usedNames: string[];
  /** Token names not present in the known-variable set. */
  unknownNames: string[];
  /** Malformed placeholders (wrong braces, stray chars, or unclosed openers),
   *  each tagged with the specific reason it is malformed. */
  malformedTokens: MalformedToken[];
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
  // Dedupe malformed placeholders by their literal text; keep the first reason
  // seen for each (a given literal can only be classified one way anyway).
  const malformed = new Map<string, MalformedReason>();
  for (const text of texts) {
    for (const seg of buildSegments(text, known)) {
      if (seg.kind === 'malformed') {
        if (!malformed.has(seg.text)) {
          malformed.set(seg.text, seg.malformedReason ?? 'brace-count');
        }
      } else if (seg.name) {
        used.add(seg.name);
        if (seg.kind === 'unknown') unknown.add(seg.name);
      }
    }
  }
  return {
    usedNames: [...used],
    unknownNames: [...unknown],
    malformedTokens: [...malformed].map(([text, reason]) => ({ text, reason })),
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

  // ── Keyboard / screen-reader parity for malformed-token hints ─────────────
  // The highlighted backdrop is `aria-hidden`, so the hover hint is invisible to
  // assistive tech. We mirror the same `malformedReasonHint()` wording into a
  // visually-hidden description associated with the input via `aria-describedby`,
  // so a screen reader announces *why* the field's tokens are flagged on focus —
  // no mouse required. Reasons are deduped and surfaced in the canonical order.
  const malformedCount = useMemo(
    () => segments.filter((s) => s.kind === 'malformed').length,
    [segments],
  );
  const malformedDescription = useMemo(() => {
    if (malformedCount === 0) return '';
    const present = new Set(
      segments
        .filter((s) => s.kind === 'malformed' && s.malformedReason)
        .map((s) => s.malformedReason as MalformedReason),
    );
    const reasons = MALFORMED_REASON_ORDER.filter((r) => present.has(r));
    const lead =
      malformedCount === 1
        ? '1 placeholder in this field needs attention.'
        : `${malformedCount} placeholders in this field need attention.`;
    return [lead, ...reasons.map((r) => malformedReasonHint(r))].join(' ');
  }, [segments, malformedCount]);
  const malformedDescId = `${inputId}-malformed`;

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

  // ── Inline malformed-token hover hint ─────────────────────────────────────
  // The backdrop is non-interactive (pointer-events: none) so it never steals
  // clicks from the input. To still surface a per-reason hint on hover we watch
  // the *input's* pointer position and hit-test it against the malformed spans'
  // client rects, then show a controlled MUI Tooltip anchored to that span.
  const [hint, setHint] = useState<{ reason: MalformedReason; el: HTMLElement } | null>(null);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const backdrop = backdropRef.current;
      if (!backdrop) return;
      const { clientX: x, clientY: y } = e;
      const spans = backdrop.querySelectorAll<HTMLElement>('[data-malformed-reason]');
      let found: { reason: MalformedReason; el: HTMLElement } | null = null;
      for (const span of Array.from(spans)) {
        for (const r of Array.from(span.getClientRects())) {
          if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
            found = {
              reason: span.dataset.malformedReason as MalformedReason,
              el: span,
            };
            break;
          }
        }
        if (found) break;
      }
      setHint((prev) => {
        if (!found) return prev ? null : prev;
        if (prev && prev.el === found.el) return prev;
        return found;
      });
    },
    [],
  );

  const handleMouseLeave = useCallback(() => setHint(null), []);

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
            ...(!multiline && { overflow: 'hidden' }),
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
            // The backdrop stays fully non-interactive (pointer-events: none) so
            // it never steals clicks / caret placement from the input above it.
            // Malformed spans are tagged with `data-malformed-reason`; the hover
            // hint is driven from the input's mouse position (see handleMouseMove)
            // and pointed at the matching span — no interactive overlay needed.
            return (
              <Box
                key={i}
                component="span"
                data-malformed-reason={
                  isMalformed ? seg.malformedReason : undefined
                }
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
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          onFocus={() => { setFocused(true); onFocus?.(); }}
          onBlur={() => setFocused(false)}
          rows={multiline ? minRows : undefined}
          required={required}
          aria-required={required || undefined}
          aria-describedby={malformedDescription ? malformedDescId : undefined}
          spellCheck={false}
          sx={{
            ...sharedLayer,
            ...(!multiline && { overflow: 'hidden' }),
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

        {/* Inline malformed-token hint — a controlled tooltip anchored to the
            currently-hovered malformed span (its position is hit-tested from the
            input's pointer in handleMouseMove). The anchor child is a zero-size
            span; the real anchor is supplied via slotProps.popper.anchorEl. */}
        <Tooltip
          arrow
          open={hint != null}
          title={hint ? malformedReasonHint(hint.reason) : ''}
          slotProps={{
            popper: {
              anchorEl: hint
                ? { getBoundingClientRect: () => hint.el.getBoundingClientRect() }
                : undefined,
            },
          }}
        >
          <Box
            aria-hidden
            component="span"
            sx={{ position: 'absolute', top: 0, left: 0, width: 0, height: 0 }}
          />
        </Tooltip>

        {/* Screen-reader-only description of any malformed placeholders, tied to
            the input via aria-describedby. Mirrors the hover hint wording so
            keyboard / screen-reader users get the same explanation on focus. */}
        {malformedDescription && (
          <Box component="span" id={malformedDescId} sx={visuallyHidden}>
            {malformedDescription}
          </Box>
        )}
      </Box>

      {helperText != null && helperText !== '' && (
        <FormHelperText sx={{ mx: '14px' }}>{helperText}</FormHelperText>
      )}
    </Box>
  );
});

export default TokenHighlightField;
