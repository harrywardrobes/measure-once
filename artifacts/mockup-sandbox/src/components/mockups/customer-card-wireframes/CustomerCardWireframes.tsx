import './_styles.css';

/* ─── Shared mock data ─────────────────────────────────────────────── */
const CARDS = [
  {
    name: 'Tom Fletcher', num: '#038', initials: 'TF',
    stage: 'Design Visit', stageKey: 'visit',
    substage: 'Open deal', source: 'Call',
    timeAgo: '5d ago', postcode: 'SW1A 2AA',
    nextAction: 'Confirm design visit date',
    terminal: false,
  },
  {
    name: 'Sarah Powell', num: '#035', initials: 'SP',
    stage: 'Survey', stageKey: 'survey',
    substage: 'Design accepted', source: 'WhatsApp',
    timeAgo: '9d ago', postcode: 'M1 1AE',
    nextAction: 'Await survey confirmation',
    terminal: false,
  },
  {
    name: 'James Morrison', num: '#042', initials: 'JM',
    stage: 'Sales', stageKey: 'sales',
    substage: 'Form submission', source: 'Web',
    timeAgo: 'just now', postcode: 'E1 6RF',
    nextAction: 'Attempt contact',
    terminal: false,
  },
];

const STAGE_COLOR: Record<string, string> = {
  sales: '#8B2BFF', visit: '#2563EB', survey: '#059669',
};
const STAGE_TINT: Record<string, string> = {
  sales: '#F3EAFF', visit: '#DBEAFE', survey: '#D1FAE5',
};
const STAGE_TEXT: Record<string, string> = {
  sales: '#6A12D9', visit: '#1D4ED8', survey: '#047857',
};
const PIPELINE = ['Sales', 'Design Visit', 'Survey'];
const PIPELINE_KEY = ['sales', 'visit', 'survey'];


/* ─── V1: Minimal ──────────────────────────────────────────────────── */
function V1() {
  return (
    <div className="wf-col">
      <div className="wf-label">
        <span className="wf-num">1</span> Minimal
        <p>Name + stage + one clear next action. Nothing else competes.</p>
      </div>
      <div className="wf-stack">
        {CARDS.map(c => (
          <div key={c.num} className="wf-card" style={{
            borderLeft: `3px solid ${STAGE_COLOR[c.stageKey]}`,
          }}>
            <div style={{ padding: '11px 13px 9px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 7 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#141413' }}>{c.name}</span>
                <span style={{ fontSize: 11, color: '#97927F' }}>{c.timeAgo}</span>
              </div>
              <span style={{
                display: 'inline-block', fontSize: 11, fontWeight: 600,
                padding: '2px 8px', borderRadius: 999,
                background: STAGE_COLOR[c.stageKey], color: '#fff',
              }}>{c.stage}</span>
            </div>
            <div style={{
              padding: '7px 13px', background: STAGE_TINT[c.stageKey],
              borderTop: '1px solid rgba(0,0,0,0.05)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
                stroke={STAGE_TEXT[c.stageKey]} strokeWidth="3" strokeLinecap="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
              <span style={{ fontSize: 11, fontWeight: 700, color: STAGE_TEXT[c.stageKey], textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {c.nextAction}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── V2: Dense ────────────────────────────────────────────────────── */
function V2() {
  return (
    <div className="wf-col">
      <div className="wf-label">
        <span className="wf-num">2</span> Dense
        <p>Every available field. Explores information cost vs. scannability.</p>
      </div>
      <div className="wf-stack">
        {CARDS.map(c => (
          <div key={c.num} className="wf-card" style={{ border: '1px solid #DDD8CC' }}>
            <div style={{ padding: '10px 12px 8px' }}>
              {/* Row 1 — name + postcode */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: '#141413' }}>{c.name}</span>
                  <span style={{ fontSize: 11, color: '#97927F', fontWeight: 500 }}>{c.num}</span>
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#6B6860', letterSpacing: '0.03em' }}>{c.postcode}</span>
              </div>
              {/* Row 2 — pills */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 999,
                  background: STAGE_COLOR[c.stageKey], color: '#fff',
                }}>{c.stage}</span>
                <span style={{
                  fontSize: 10, fontWeight: 500, padding: '2px 6px', borderRadius: 999,
                  background: '#F5F2EB', color: '#6B6860', border: '1px solid #D9D2C2',
                }}>{c.substage}</span>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 999,
                  background: 'transparent', color: '#97927F', border: '1px solid #D9D2C2',
                }}>{c.source}</span>
              </div>
              {/* Row 3 — timestamp */}
              <div style={{ fontSize: 11, color: '#97927F' }}>{c.timeAgo}</div>
            </div>
            <div style={{
              padding: '6px 12px', background: STAGE_TINT[c.stageKey],
              borderTop: '1px solid rgba(0,0,0,0.05)',
              display: 'flex', alignItems: 'center', gap: 5,
            }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
                stroke={STAGE_TEXT[c.stageKey]} strokeWidth="3" strokeLinecap="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
              <span style={{ fontSize: 11, fontWeight: 700, color: STAGE_TEXT[c.stageKey], textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                {c.nextAction}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── V3: Color header band ────────────────────────────────────────── */
function V3() {
  return (
    <div className="wf-col">
      <div className="wf-label">
        <span className="wf-num">3</span> Stage Header Band
        <p>Stage colour owns the top — name reads white on colour. No left stripe.</p>
      </div>
      <div className="wf-stack">
        {CARDS.map(c => (
          <div key={c.num} className="wf-card" style={{ overflow: 'hidden', border: 'none' }}>
            {/* Colour header */}
            <div style={{
              background: STAGE_COLOR[c.stageKey], padding: '9px 13px',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontWeight: 700, fontSize: 13, color: '#fff', letterSpacing: '-.01em' }}>
                {c.name}
              </span>
              <span style={{
                fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.7)',
                background: 'rgba(255,255,255,0.15)', padding: '2px 7px', borderRadius: 999,
              }}>{c.stage}</span>
            </div>
            {/* Body */}
            <div style={{ padding: '9px 13px 10px', background: '#fff' }}>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center', marginBottom: 6 }}>
                <span style={{
                  fontSize: 11, color: '#6B6860',
                  background: '#F5F2EB', border: '1px solid #D9D2C2',
                  padding: '1px 7px', borderRadius: 999,
                }}>{c.substage}</span>
                <span style={{ fontSize: 11, color: '#97927F' }}>· {c.source}</span>
              </div>
              <div style={{ fontSize: 11, color: '#97927F' }}>{c.num} · {c.timeAgo} · {c.postcode}</div>
            </div>
            {/* Next action */}
            <div style={{
              padding: '7px 13px', background: STAGE_TINT[c.stageKey],
              borderTop: `1px solid ${STAGE_COLOR[c.stageKey]}22`,
              fontSize: 11, fontWeight: 600, color: STAGE_TEXT[c.stageKey],
            }}>
              → {c.nextAction}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── V4: Pipeline progress dots ───────────────────────────────────── */
function V4() {
  return (
    <div className="wf-col">
      <div className="wf-label">
        <span className="wf-num">4</span> Pipeline Progress
        <p>Horizontal stage track shows journey position at a glance. Very compact.</p>
      </div>
      <div className="wf-stack">
        {CARDS.map(c => {
          const idx = PIPELINE_KEY.indexOf(c.stageKey);
          return (
            <div key={c.num} className="wf-card" style={{ border: '1px solid #DDD8CC', padding: '10px 13px' }}>
              {/* Name row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: '#141413' }}>{c.name}</span>
                <span style={{ fontSize: 11, color: '#97927F' }}>{c.timeAgo}</span>
              </div>

              {/* Pipeline track */}
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 9, gap: 0 }}>
                {PIPELINE.map((label, i) => {
                  const active = i === idx;
                  const done   = i < idx;
                  const color  = done || active ? STAGE_COLOR[PIPELINE_KEY[i]] : '#D9D2C2';
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', flex: i < PIPELINE.length - 1 ? 1 : 'none' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
                        <div style={{
                          width: active ? 12 : 9, height: active ? 12 : 9,
                          borderRadius: '50%', background: color,
                          boxShadow: active ? `0 0 0 3px ${STAGE_TINT[c.stageKey]}` : 'none',
                          flexShrink: 0,
                        }}/>
                        <span style={{
                          fontSize: 9, fontWeight: active ? 700 : 400,
                          color: active ? STAGE_COLOR[c.stageKey] : '#97927F',
                          whiteSpace: 'nowrap',
                        }}>{label}</span>
                      </div>
                      {i < PIPELINE.length - 1 && (
                        <div style={{
                          flex: 1, height: 2, marginBottom: 12,
                          background: done ? STAGE_COLOR[PIPELINE_KEY[i]] : '#D9D2C2',
                          margin: '0 4px 12px',
                        }}/>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Next action */}
              <div style={{
                padding: '5px 9px', borderRadius: 6,
                background: STAGE_TINT[c.stageKey],
                fontSize: 11, fontWeight: 600, color: STAGE_TEXT[c.stageKey],
              }}>
                → {c.nextAction}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── V5: Avatar + two-column ──────────────────────────────────────── */
function V5() {
  return (
    <div className="wf-col">
      <div className="wf-label">
        <span className="wf-num">5</span> Avatar Focus
        <p>Initials bubble carries stage colour. Name and action dominate the right column.</p>
      </div>
      <div className="wf-stack">
        {CARDS.map(c => (
          <div key={c.num} className="wf-card"
            style={{ border: '1px solid #DDD8CC', padding: '12px 13px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {/* Avatar */}
            <div style={{
              width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
              background: STAGE_COLOR[c.stageKey],
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 800, fontSize: 14, color: '#fff', letterSpacing: '0.04em',
            }}>
              {c.initials}
            </div>
            {/* Right column */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 2 }}>
                <span style={{ fontWeight: 700, fontSize: 13, color: '#141413', lineHeight: 1.2 }}>{c.name}</span>
                <span style={{ fontSize: 10, color: '#97927F', flexShrink: 0, marginLeft: 6 }}>{c.timeAgo}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7 }}>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '1px 6px', borderRadius: 999,
                  background: STAGE_TINT[c.stageKey], color: STAGE_TEXT[c.stageKey],
                  border: `1px solid ${STAGE_COLOR[c.stageKey]}44`,
                }}>{c.stage}</span>
                <span style={{ fontSize: 10, color: '#97927F' }}>{c.substage}</span>
              </div>
              <div style={{
                fontSize: 11, fontWeight: 700, color: STAGE_TEXT[c.stageKey],
                background: STAGE_TINT[c.stageKey], padding: '4px 8px', borderRadius: 5,
              }}>
                → {c.nextAction}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Page layout ──────────────────────────────────────────────────── */
export default function CustomerCardWireframes() {
  return (
    <div style={{
      background: '#EDEAE3', minHeight: '100vh',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      padding: '28px 24px',
    }}>
      <div style={{ marginBottom: 20 }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: '#200842', letterSpacing: '-.01em' }}>
          Customer Card — 5 wireframe explorations
        </span>
        <span style={{ marginLeft: 10, fontSize: 12, color: '#97927F' }}>
          Sales &amp; Survey page · same 3 contacts shown across each variant
        </span>
      </div>

      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', overflowX: 'auto' }}>
        <V1/>
        <V2/>
        <V3/>
        <V4/>
        <V5/>
      </div>
    </div>
  );
}
