import './_group.css';

/* ── Polished Priority Stack ────────────────────────────────────────────────
   Refinements over VariantB:
   - Emoji icons replaced with clean SVG source badges
   - Stage progress dots perfectly centred on a coloured connecting rail
   - Completed segments fill with the stage colour
   - Substage pill is lighter, placed below the name (not competing top-right)
   - Action row radius matches card, better type sizing
   - Consistent 12 px inner padding everywhere
   ─────────────────────────────────────────────────────────────────────────── */

const STAGE_COLOR: Record<string, string> = {
  sales:       'var(--mo-stage-sales)',
  designvisit: 'var(--mo-stage-visit)',
  survey:      'var(--mo-stage-survey)',
};

const SOURCE_LABELS: Record<string, string> = {
  website: 'Web', whatsapp: 'WhatsApp', call: 'Call',
  instagram: 'IG', facebook: 'FB', email: 'Email',
};

function SourceDot({ source }: { source: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: 'var(--mo-ink-4)', flexShrink: 0,
        display: 'inline-block',
      }} />
      <span style={{ fontSize: 11, color: 'var(--mo-ink-4)', fontWeight: 500 }}>
        {SOURCE_LABELS[source] || source}
      </span>
    </span>
  );
}

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

const STAGES = [
  { key: 'sales',       label: 'Sales' },
  { key: 'designvisit', label: 'Design Visit' },
  { key: 'survey',      label: 'Survey' },
];

const MOCK_CUSTOMERS = [
  { name: 'Tom Fletcher',   num: '#038', stageKey: 'designvisit', substageId: 'open_deal',         substageLabel: 'Open deal',         source: 'call',      timeAgo: '5d ago',   terminal: false },
  { name: 'Sarah Powell',   num: '#035', stageKey: 'survey',      substageId: 'design_accepted',   substageLabel: 'Design accepted',   source: 'whatsapp',  timeAgo: '9d ago',   terminal: false },
  { name: 'James Morrison', num: '#042', stageKey: 'sales',       substageId: 'form_submission',   substageLabel: 'Form submission',   source: 'website',   timeAgo: 'just now', terminal: false },
  { name: 'Kate Williams',  num: '#041', stageKey: 'sales',       substageId: 'attempted_contact', substageLabel: 'Attempted contact', source: 'instagram', timeAgo: '2d ago',   terminal: false },
  { name: 'Emma Thompson',  num: '#039', stageKey: 'sales',       substageId: 'open_deal',         substageLabel: 'Open deal',         source: 'email',     timeAgo: '3d ago',   terminal: false },
  { name: 'Chris Martin',   num: '#031', stageKey: 'sales',       substageId: 'not_suitable',      substageLabel: 'Not suitable',      source: 'facebook',  timeAgo: '3w ago',   terminal: true  },
];

function StageTrail({ stageKey, terminal }: { stageKey: string; terminal: boolean }) {
  const idx = STAGES.findIndex(s => s.key === stageKey);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      {STAGES.map((stage, i) => {
        const done   = i < idx;
        const active = i === idx;
        const color  = terminal ? 'var(--mo-stone-deep)' : STAGE_COLOR[stage.key];
        const dotColor = (done || active) ? color : 'var(--mo-stone)';
        const lineColor = done ? STAGE_COLOR[stage.key] : 'var(--mo-stone)';
        const isLast = i === STAGES.length - 1;
        return (
          <div key={stage.key} style={{ display: 'flex', alignItems: 'center', flex: isLast ? 'none' : 1, minWidth: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <div style={{
                width:  active ? 11 : 8,
                height: active ? 11 : 8,
                borderRadius: '50%',
                background: dotColor,
                outline: active ? `3px solid ${dotColor}28` : 'none',
                outlineOffset: 1,
                transition: 'all 0.15s',
              }} />
              <span style={{
                fontSize: 9, fontWeight: active ? 700 : 500,
                color: (done || active) ? dotColor : 'var(--mo-ink-4)',
                whiteSpace: 'nowrap',
                letterSpacing: '0.015em',
              }}>
                {stage.label}
              </span>
            </div>
            {!isLast && (
              <div style={{
                flex: 1,
                height: 2,
                background: lineColor,
                margin: '0 4px',
                marginBottom: 14,
                borderRadius: 1,
                opacity: done ? 0.7 : 0.4,
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function VariantB1() {
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
            const accent = c.terminal ? 'var(--mo-stone-deep)' : STAGE_COLOR[c.stageKey];
            const next   = nextAction(c.stageKey, c.substageId);
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--mo-ink-1)', lineHeight: 1.2 }}>
                        {c.name}
                      </span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4,
                        background: 'var(--mo-stone-soft)', color: 'var(--mo-ink-3)',
                        border: '1px solid var(--mo-stone)',
                        letterSpacing: '0.02em',
                      }}>{c.num}</span>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--mo-ink-4)', flexShrink: 0, marginLeft: 8, marginTop: 1 }}>
                      {c.timeAgo}
                    </span>
                  </div>

                  {/* Substage + source */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                    <span style={{
                      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999,
                      background: c.terminal ? 'var(--mo-stone-soft)' : `${accent}18`,
                      color: c.terminal ? 'var(--mo-ink-4)' : accent,
                      border: `1px solid ${c.terminal ? 'var(--mo-stone)' : accent + '38'}`,
                      letterSpacing: '0.01em',
                    }}>
                      {c.substageLabel}
                    </span>
                    <SourceDot source={c.source} />
                  </div>

                  {/* Stage trail */}
                  <StageTrail stageKey={c.stageKey} terminal={c.terminal} />
                </div>

                {/* Action row */}
                {next && !c.terminal && (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '9px 12px',
                    background: 'var(--mo-plum)',
                    cursor: 'pointer',
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                      {next}
                    </span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
