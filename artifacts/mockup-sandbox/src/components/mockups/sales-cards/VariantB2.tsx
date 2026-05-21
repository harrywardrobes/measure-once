import './_group.css';

/* ── Open Priority Stack ────────────────────────────────────────────────────
   A more spacious, breathing variant of the same core concept:
   - More vertical padding, larger name (15 px)
   - Stage shown as a compact filled-segment bar (replaces dot trail)
   - "Days in stage" metric placed top-right — gives instant time-pressure read
   - Substage displayed with colour matched to stage, no plain grey pill
   - Source is plain text, no icon clutter
   - Action row: tinted card (stage colour) instead of solid plum
     — keeps the hierarchy but feels lighter and more scannable
   ─────────────────────────────────────────────────────────────────────────── */

const STAGE_KEYS  = ['sales', 'designvisit', 'survey'];
const STAGE_LABELS: Record<string, string> = {
  sales:       'Sales',
  designvisit: 'Design Visit',
  survey:      'Survey',
};

const STAGE_COLOR: Record<string, string> = {
  sales:       'var(--mo-stage-sales)',
  designvisit: 'var(--mo-stage-visit)',
  survey:      'var(--mo-stage-survey)',
};
const STAGE_TINT: Record<string, string> = {
  sales:       '#F3EAFF',
  designvisit: '#DBEAFE',
  survey:      '#D1FAE5',
};
const STAGE_TEXT: Record<string, string> = {
  sales:       '#6A12D9',
  designvisit: '#1D4ED8',
  survey:      '#047857',
};

const SOURCE_LABELS: Record<string, string> = {
  website: 'Web', whatsapp: 'WhatsApp', call: 'Call',
  instagram: 'IG', facebook: 'FB', email: 'Email',
};

function nextAction(stageKey: string, substageId: string): string {
  if (stageKey === 'sales') {
    if (substageId === 'form_submission')   return 'Attempt contact';
    if (substageId === 'attempted_contact') return 'Follow up call';
    if (substageId === 'open_deal')         return 'Schedule design visit';
  }
  if (stageKey === 'designvisit') return 'Confirm design visit date';
  if (stageKey === 'survey')      return 'Await survey confirmation';
  return '';
}

function SegmentBar({ stageKey, terminal }: { stageKey: string; terminal: boolean }) {
  const idx = STAGE_KEYS.indexOf(stageKey);
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'stretch' }}>
      {STAGE_KEYS.map((sk, i) => {
        const active = i === idx;
        const done   = i < idx;
        const color  = terminal ? 'var(--mo-stone-deep)' : STAGE_COLOR[sk];
        return (
          <div key={sk} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{
              height: 3,
              borderRadius: 2,
              background: (done || active) ? color : 'var(--mo-stone)',
              opacity: done ? 0.38 : 1,
            }} />
            <span style={{
              fontSize: 9,
              fontWeight: active ? 700 : 400,
              color: active ? color : 'var(--mo-ink-4)',
              letterSpacing: '0.01em',
              opacity: done ? 0.5 : 1,
            }}>
              {STAGE_LABELS[sk]}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const MOCK_CUSTOMERS = [
  { name: 'Tom Fletcher',   num: '#038', stageKey: 'designvisit', substageId: 'open_deal',         substageLabel: 'Open deal',         source: 'call',      timeAgo: '5d ago',   days: 5,  terminal: false },
  { name: 'Sarah Powell',   num: '#035', stageKey: 'survey',      substageId: 'design_accepted',   substageLabel: 'Design accepted',   source: 'whatsapp',  timeAgo: '9d ago',   days: 9,  terminal: false },
  { name: 'James Morrison', num: '#042', stageKey: 'sales',       substageId: 'form_submission',   substageLabel: 'Form submission',   source: 'website',   timeAgo: 'just now', days: 0,  terminal: false },
  { name: 'Kate Williams',  num: '#041', stageKey: 'sales',       substageId: 'attempted_contact', substageLabel: 'Attempted contact', source: 'instagram', timeAgo: '2d ago',   days: 2,  terminal: false },
  { name: 'Emma Thompson',  num: '#039', stageKey: 'sales',       substageId: 'open_deal',         substageLabel: 'Open deal',         source: 'email',     timeAgo: '3d ago',   days: 3,  terminal: false },
  { name: 'Chris Martin',   num: '#031', stageKey: 'sales',       substageId: 'not_suitable',      substageLabel: 'Not suitable',      source: 'facebook',  timeAgo: '3w ago',   days: 21, terminal: true  },
];

export function VariantB2() {
  return (
    <div style={{
      background: 'var(--mo-paper)',
      minHeight: '100vh',
      padding: '20px 16px',
      fontFamily: "'Open Sans', system-ui, sans-serif",
    }}>
      <div style={{ maxWidth: 480, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
          <span style={{ fontWeight: 800, fontSize: 16, color: 'var(--mo-plum)', letterSpacing: '-0.01em' }}>
            Sales Pipeline
          </span>
          <span style={{ fontSize: 12, color: 'var(--mo-ink-4)' }}>6 enquiries</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          {MOCK_CUSTOMERS.map((c) => {
            const accent   = c.terminal ? 'var(--mo-stone-deep)' : STAGE_COLOR[c.stageKey];
            const tint     = c.terminal ? 'var(--mo-stone-soft)' : STAGE_TINT[c.stageKey];
            const textCol  = c.terminal ? 'var(--mo-ink-4)'      : STAGE_TEXT[c.stageKey];
            const next     = nextAction(c.stageKey, c.substageId);

            return (
              <div
                key={c.num}
                style={{
                  background: 'var(--mo-chalk)',
                  borderRadius: 8,
                  boxShadow: 'var(--mo-shadow-sm)',
                  overflow: 'hidden',
                  opacity: c.terminal ? 0.58 : 1,
                }}
              >
                <div style={{ height: 3, background: accent }} />

                <div style={{ padding: '11px 12px 12px' }}>
                  {/* Name row */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 5 }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--mo-ink-1)', lineHeight: 1.2 }}>
                          {c.name}
                        </span>
                        <span style={{
                          fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                          background: 'var(--mo-stone-soft)', color: 'var(--mo-ink-3)',
                          border: '1px solid var(--mo-stone)',
                        }}>{c.num}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{
                          fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                          background: tint, color: textCol,
                        }}>
                          {c.substageLabel}
                        </span>
                        {c.source && (
                          <span style={{ fontSize: 11, color: 'var(--mo-ink-4)' }}>
                            via {SOURCE_LABELS[c.source] || c.source}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Days metric */}
                    <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 10 }}>
                      {c.days > 0 ? (
                        <>
                          <div style={{
                            fontSize: 22, fontWeight: 800, color: accent,
                            lineHeight: 1, letterSpacing: '-0.03em',
                          }}>{c.days}</div>
                          <div style={{ fontSize: 9, color: 'var(--mo-ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            days
                          </div>
                        </>
                      ) : (
                        <div style={{
                          fontSize: 10, fontWeight: 800, color: accent,
                          textTransform: 'uppercase', letterSpacing: '0.06em',
                          background: tint, padding: '3px 7px', borderRadius: 4,
                        }}>New</div>
                      )}
                    </div>
                  </div>

                  {/* Segment bar */}
                  <div style={{ marginBottom: next && !c.terminal ? 10 : 0 }}>
                    <SegmentBar stageKey={c.stageKey} terminal={c.terminal} />
                  </div>

                  {/* Action row */}
                  {next && !c.terminal && (
                    <div style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '8px 10px',
                      background: tint,
                      borderRadius: 6,
                      border: `1px solid ${accent}28`,
                      cursor: 'pointer',
                    }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: textCol, letterSpacing: '0.03em' }}>
                        {next}
                      </span>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={textCol} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="9 18 15 12 9 6" />
                      </svg>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
