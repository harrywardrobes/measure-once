import './_group.css';

const STAGE_COLOR: Record<string, string> = {
  sales:       'var(--mo-stage-sales)',
  designvisit: 'var(--mo-stage-visit)',
  survey:      'var(--mo-stage-survey)',
};

const NEXT_BG: Record<string, string> = {
  sales:       'var(--mo-next-sales)',
  designvisit: 'var(--mo-next-visit)',
  survey:      'var(--mo-next-survey)',
};

const NEXT_TEXT: Record<string, string> = {
  sales:       'var(--mo-next-sales-text)',
  designvisit: 'var(--mo-next-visit-text)',
  survey:      'var(--mo-next-survey-text)',
};

const SOURCE_LABELS: Record<string, string> = {
  website: 'Web', whatsapp: 'WhatsApp', call: 'Call',
  instagram: 'IG', facebook: 'FB', email: 'Email',
};

function nextAction(stageKey: string, substageId: string): string {
  if (stageKey === 'sales') {
    if (substageId === 'form_submission') return 'Attempt contact';
    if (substageId === 'attempted_contact') return 'Follow up call';
    if (substageId === 'open_deal') return 'Schedule design visit';
  }
  if (stageKey === 'designvisit') return 'Confirm design visit date';
  if (stageKey === 'survey') return 'Await survey confirmation';
  return '';
}

const MOCK_CUSTOMERS = [
  { name: 'Tom Fletcher',   num: '#038', stageKey: 'designvisit', stageLabel: 'Design Visit', substageId: 'open_deal',         substageLabel: 'Open deal',         source: 'call',      timeAgo: '5d ago',   terminal: false },
  { name: 'Sarah Powell',   num: '#035', stageKey: 'survey',      stageLabel: 'Survey',        substageId: 'design_accepted',   substageLabel: 'Design accepted',   source: 'whatsapp',  timeAgo: '9d ago',   terminal: false },
  { name: 'James Morrison', num: '#042', stageKey: 'sales',       stageLabel: 'Sales',         substageId: 'form_submission',   substageLabel: 'Form submission',   source: 'website',   timeAgo: 'just now', terminal: false },
  { name: 'Kate Williams',  num: '#041', stageKey: 'sales',       stageLabel: 'Sales',         substageId: 'attempted_contact', substageLabel: 'Attempted contact', source: 'instagram', timeAgo: '2d ago',   terminal: false },
  { name: 'Emma Thompson',  num: '#039', stageKey: 'sales',       stageLabel: 'Sales',         substageId: 'open_deal',         substageLabel: 'Open deal',         source: 'email',     timeAgo: '3d ago',   terminal: false },
  { name: 'Chris Martin',   num: '#031', stageKey: 'sales',       stageLabel: 'Sales',         substageId: 'not_suitable',      substageLabel: 'Not suitable',      source: 'facebook',  timeAgo: '3w ago',   terminal: true  },
];

export function VariantA() {
  return (
    <div style={{ background: 'var(--mo-paper)', minHeight: '100vh', padding: '16px', fontFamily: "'Open Sans', system-ui, sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--mo-plum)' }}>Sales Pipeline</span>
        <span style={{ fontSize: 12, color: 'var(--mo-ink-4)' }}>6 enquiries</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {MOCK_CUSTOMERS.map((c) => {
          const accent = STAGE_COLOR[c.stageKey];
          const next = nextAction(c.stageKey, c.substageId);
          const nextBg = NEXT_BG[c.stageKey];
          const nextTxt = NEXT_TEXT[c.stageKey];
          return (
            <div
              key={c.num}
              style={{
                background: c.terminal ? 'var(--mo-stone-soft)' : 'var(--mo-chalk)',
                borderRadius: 8,
                boxShadow: 'var(--mo-shadow-sm)',
                overflow: 'hidden',
                opacity: c.terminal ? 0.65 : 1,
                borderLeft: `3px solid ${c.terminal ? 'var(--mo-stone-deep)' : accent}`,
              }}
            >
              <div style={{ padding: '10px 12px 8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--mo-ink-1)' }}>{c.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--mo-ink-4)', fontWeight: 500 }}>{c.num}</span>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--mo-ink-4)' }}>{c.timeAgo}</span>
                </div>

                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999,
                    background: c.terminal ? 'var(--mo-stone)' : accent,
                    color: c.terminal ? 'var(--mo-ink-3)' : '#fff',
                    letterSpacing: '0.01em',
                  }}>{c.stageLabel}</span>

                  <span style={{
                    fontSize: 11, fontWeight: 500, padding: '2px 7px', borderRadius: 999,
                    background: 'var(--mo-stone-soft)',
                    color: 'var(--mo-ink-3)',
                    border: '1px solid var(--mo-stone)',
                  }}>{c.substageLabel}</span>

                  {c.source && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 999,
                      background: 'transparent',
                      color: 'var(--mo-ink-4)',
                      border: '1px solid var(--mo-stone)',
                    }}>{SOURCE_LABELS[c.source] || c.source}</span>
                  )}
                </div>
              </div>

              {next && !c.terminal && (
                <div style={{
                  padding: '7px 12px',
                  background: nextBg,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  borderTop: '1px solid rgba(0,0,0,0.04)',
                }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={nextTxt} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                  <span style={{ fontSize: 11, fontWeight: 700, color: nextTxt, letterSpacing: '0.02em', textTransform: 'uppercase' }}>
                    {next}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
