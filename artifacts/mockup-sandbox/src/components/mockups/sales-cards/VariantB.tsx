import './_group.css';

const STAGES = [
  { key: 'sales',       label: 'Sales' },
  { key: 'designvisit', label: 'Design Visit' },
  { key: 'survey',      label: 'Survey' },
];

const STAGE_COLOR: Record<string, string> = {
  sales:       'var(--mo-stage-sales)',
  designvisit: 'var(--mo-stage-visit)',
  survey:      'var(--mo-stage-survey)',
};

const SOURCE_ICON: Record<string, string> = {
  website: '🌐', whatsapp: '💬', call: '📞', instagram: '📸', facebook: '👥', email: '✉️',
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
  { name: 'Tom Fletcher',   num: '#038', stageKey: 'designvisit', stageLabel: 'Design Visit', substageId: 'open_deal',         substageLabel: 'Open deal',         source: 'call',      timeAgo: '5d ago',   days: 5,  terminal: false },
  { name: 'Sarah Powell',   num: '#035', stageKey: 'survey',      stageLabel: 'Survey',        substageId: 'design_accepted',   substageLabel: 'Design accepted',   source: 'whatsapp',  timeAgo: '9d ago',   days: 9,  terminal: false },
  { name: 'James Morrison', num: '#042', stageKey: 'sales',       stageLabel: 'Sales',         substageId: 'form_submission',   substageLabel: 'Form submission',   source: 'website',   timeAgo: 'just now', days: 0,  terminal: false },
  { name: 'Kate Williams',  num: '#041', stageKey: 'sales',       stageLabel: 'Sales',         substageId: 'attempted_contact', substageLabel: 'Attempted contact', source: 'instagram', timeAgo: '2d ago',   days: 2,  terminal: false },
  { name: 'Emma Thompson',  num: '#039', stageKey: 'sales',       stageLabel: 'Sales',         substageId: 'open_deal',         substageLabel: 'Open deal',         source: 'email',     timeAgo: '3d ago',   days: 3,  terminal: false },
  { name: 'Chris Martin',   num: '#031', stageKey: 'sales',       stageLabel: 'Sales',         substageId: 'not_suitable',      substageLabel: 'Not suitable',      source: 'facebook',  timeAgo: '3w ago',   days: 21, terminal: true  },
];

export function VariantB() {
  return (
    <div style={{ background: 'var(--mo-paper)', minHeight: '100vh', padding: '16px', fontFamily: "'Open Sans', system-ui, sans-serif" }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--mo-plum)' }}>Sales Pipeline</span>
        <span style={{ fontSize: 12, color: 'var(--mo-ink-4)' }}>6 enquiries</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {MOCK_CUSTOMERS.map((c) => {
          const accent = c.terminal ? 'var(--mo-stone-deep)' : STAGE_COLOR[c.stageKey];
          const next = nextAction(c.stageKey, c.substageId);
          const stageIdx = STAGES.findIndex(s => s.key === c.stageKey);

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
              <div style={{ height: 3, background: accent }} />

              <div style={{ padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--mo-ink-1)' }}>{c.name}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                        background: 'var(--mo-stone-soft)', color: 'var(--mo-ink-3)',
                        border: '1px solid var(--mo-stone)',
                      }}>{c.num}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      {c.source && (
                        <span style={{ fontSize: 11, color: 'var(--mo-ink-4)' }}>
                          {SOURCE_ICON[c.source]} {SOURCE_LABELS[c.source] || c.source}
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: 'var(--mo-stone-deep)' }}>·</span>
                      <span style={{ fontSize: 11, color: 'var(--mo-ink-4)' }}>{c.timeAgo}</span>
                    </div>
                  </div>
                  <span style={{
                    fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 999,
                    background: 'var(--mo-stone-soft)', color: 'var(--mo-ink-3)',
                    border: '1px solid var(--mo-stone)',
                    whiteSpace: 'nowrap',
                  }}>{c.substageLabel}</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: next && !c.terminal ? 10 : 0 }}>
                  {STAGES.map((stage, i) => {
                    const done = i < stageIdx;
                    const active = i === stageIdx;
                    const dotColor = done || active ? STAGE_COLOR[stage.key] : 'var(--mo-stone)';
                    const isLast = i === STAGES.length - 1;
                    return (
                      <div key={stage.key} style={{ display: 'flex', alignItems: 'center', flex: isLast ? 'none' : 1 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                          <div style={{
                            width: active ? 10 : 8,
                            height: active ? 10 : 8,
                            borderRadius: '50%',
                            background: dotColor,
                            border: active ? `2px solid ${dotColor}` : '2px solid ' + (done ? dotColor : 'var(--mo-stone)'),
                            boxShadow: active ? `0 0 0 3px ${dotColor}22` : 'none',
                            flexShrink: 0,
                          }} />
                          <span style={{
                            fontSize: 9,
                            fontWeight: active ? 700 : 500,
                            color: active ? dotColor : done ? dotColor : 'var(--mo-ink-4)',
                            whiteSpace: 'nowrap',
                            letterSpacing: '0.01em',
                          }}>{stage.label}</span>
                        </div>
                        {!isLast && (
                          <div style={{
                            flex: 1,
                            height: 1.5,
                            background: done ? STAGE_COLOR[stage.key] : 'var(--mo-stone)',
                            margin: '0 3px',
                            marginBottom: 14,
                          }} />
                        )}
                      </div>
                    );
                  })}
                </div>

                {next && !c.terminal && (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '7px 10px',
                    borderRadius: 6,
                    background: 'var(--mo-plum)',
                    cursor: 'pointer',
                  }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', letterSpacing: '0.02em', textTransform: 'uppercase' }}>
                      {next}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
