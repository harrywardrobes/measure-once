import './_group.css';

const STAGES = [
  { key: 'sales',       label: 'Sales' },
  { key: 'designvisit', label: 'Design Visit' },
  { key: 'Survey',      label: 'Survey' },
];

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
  { name: 'Tom Fletcher',   num: '#038', stageKey: 'designvisit', substageId: 'open_deal',         substageLabel: 'Open deal',         source: 'call',      timeAgo: '5d ago',   days: 5,  terminal: false },
  { name: 'Sarah Powell',   num: '#035', stageKey: 'survey',      substageId: 'design_accepted',   substageLabel: 'Design accepted',   source: 'whatsapp',  timeAgo: '9d ago',   days: 9,  terminal: false },
  { name: 'James Morrison', num: '#042', stageKey: 'sales',       substageId: 'form_submission',   substageLabel: 'Form submission',   source: 'website',   timeAgo: 'just now', days: 0,  terminal: false },
  { name: 'Kate Williams',  num: '#041', stageKey: 'sales',       substageId: 'attempted_contact', substageLabel: 'Attempted contact', source: 'instagram', timeAgo: '2d ago',   days: 2,  terminal: false },
  { name: 'Emma Thompson',  num: '#039', stageKey: 'sales',       substageId: 'open_deal',         substageLabel: 'Open deal',         source: 'email',     timeAgo: '3d ago',   days: 3,  terminal: false },
  { name: 'Chris Martin',   num: '#031', stageKey: 'sales',       substageId: 'not_suitable',      substageLabel: 'Not suitable',      source: 'facebook',  timeAgo: '3w ago',   days: 21, terminal: true  },
];

const STAGE_KEYS = ['sales', 'designvisit', 'survey'];

export function VariantC() {
  return (
    <div style={{ background: 'var(--mo-paper)', minHeight: '100vh', padding: '16px', fontFamily: "'Open Sans', system-ui, sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--mo-plum)' }}>Sales Pipeline</span>
        <span style={{ fontSize: 12, color: 'var(--mo-ink-4)' }}>6 enquiries</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
        {MOCK_CUSTOMERS.map((c) => {
          const stageIdx = STAGE_KEYS.indexOf(c.stageKey);
          const accent = c.terminal ? 'var(--mo-stone-deep)' : STAGE_COLOR[c.stageKey];
          const tint = c.terminal ? 'var(--mo-stone-soft)' : STAGE_TINT[c.stageKey];
          const textCol = c.terminal ? 'var(--mo-ink-4)' : STAGE_TEXT[c.stageKey];
          const next = nextAction(c.stageKey, c.substageId);

          return (
            <div
              key={c.num}
              style={{
                background: 'var(--mo-chalk)',
                borderRadius: 8,
                boxShadow: 'var(--mo-shadow-sm)',
                overflow: 'hidden',
                opacity: c.terminal ? 0.6 : 1,
              }}
            >
              <div style={{ display: 'flex', height: 4 }}>
                {STAGE_KEYS.map((sk, i) => (
                  <div
                    key={sk}
                    style={{
                      flex: 1,
                      background: i <= stageIdx ? STAGE_COLOR[sk] : 'var(--mo-stone)',
                      opacity: i < stageIdx ? 0.35 : 1,
                      marginRight: i < STAGE_KEYS.length - 1 ? 2 : 0,
                    }}
                  />
                ))}
              </div>

              <div style={{ padding: '10px 12px 11px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 7 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginBottom: 3 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--mo-ink-1)' }}>{c.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--mo-ink-4)' }}>{c.num}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                      <span style={{
                        fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 999,
                        background: tint, color: textCol,
                      }}>{c.substageLabel}</span>
                      {c.source && (
                        <span style={{ fontSize: 10, color: 'var(--mo-ink-4)', fontWeight: 500 }}>
                          via {SOURCE_LABELS[c.source] || c.source}
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: 8 }}>
                    {!c.terminal && c.days > 0 && (
                      <div style={{
                        fontSize: 18, fontWeight: 800, color: accent,
                        lineHeight: 1, marginBottom: 1,
                      }}>{c.days}</div>
                    )}
                    {!c.terminal && c.days > 0 && (
                      <div style={{ fontSize: 9, color: 'var(--mo-ink-4)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        days
                      </div>
                    )}
                    {c.days === 0 && (
                      <div style={{ fontSize: 10, color: accent, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>New</div>
                    )}
                  </div>
                </div>

                {next && !c.terminal && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 9px',
                    borderRadius: 6,
                    background: tint,
                    border: `1px solid ${accent}33`,
                  }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: textCol }}>
                      {next}
                    </span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={textCol} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 7 }}>
                  {STAGE_KEYS.map((sk, i) => (
                    <div key={sk} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <span style={{
                        fontSize: 9, fontWeight: i === stageIdx ? 700 : 500,
                        color: i <= stageIdx ? STAGE_COLOR[sk] : 'var(--mo-ink-4)',
                        opacity: i < stageIdx ? 0.5 : 1,
                      }}>
                        {['Sales', 'Design Visit', 'Survey'][i]}
                      </span>
                      {i < STAGE_KEYS.length - 1 && (
                        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--mo-stone-deep)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
