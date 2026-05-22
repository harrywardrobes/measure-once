import { useState } from 'react';

const PLUM = '#200842';
const ORCHID = '#8B2BFF';
const PAPER = '#F6F1E7';
const PAPER_DEEP = '#EDE5D4';
const STONE = '#D9D2C2';
const INK1 = '#141413';
const INK3 = '#6B6860';
const INK4 = '#97927F';

const STAGES = [
  { key: 'all',          label: 'All',          color: PLUM },
  { key: 'sales',        label: 'Sales',        color: '#8B2BFF' },
  { key: 'designvisit',  label: 'Design Visit', color: '#0d9488' },
  { key: 'survey',       label: 'Survey',       color: '#d97706' },
  { key: 'order',        label: 'Order',        color: '#2563eb' },
  { key: 'workshop',     label: 'Workshop',     color: '#dc2626' },
];

const CUSTOMERS = [
  { name: 'Alice Johnson', stage: 'Sales', stageColor: '#8B2BFF', stageLight: '#F3EAFF' },
  { name: 'Ben Carter',    stage: 'Design Visit', stageColor: '#0f766e', stageLight: '#ccfbf1' },
  { name: 'Clara Smith',   stage: 'Survey',  stageColor: '#b45309', stageLight: '#fef3c7' },
  { name: 'David Kim',     stage: 'Order',   stageColor: '#1d4ed8', stageLight: '#dbeafe' },
  { name: 'Emily Brown',   stage: 'Workshop', stageColor: '#b91c1c', stageLight: '#fee2e2' },
];

export default function FloatingCard() {
  const [activeStage, setActiveStage] = useState('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  return (
    <div style={{ fontFamily: "'Open Sans', sans-serif", background: PAPER, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

      {/* Status-bar-like top strip */}
      <div style={{ background: PLUM, height: 10 }} />

      {/* Floating header card */}
      <div style={{ background: PLUM, padding: '0 12px 16px' }}>
        <div style={{
          background: 'white',
          borderRadius: 16,
          boxShadow: '0 4px 20px rgba(32,8,66,0.18)',
          overflow: 'hidden',
        }}>
          {/* Header row */}
          <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Back */}
            <button style={{ border: 'none', background: PAPER, cursor: 'pointer', width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={PLUM} strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
              </svg>
            </button>

            {/* Title */}
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: '0.95rem', color: PLUM, lineHeight: 1.2 }}>Customers</div>
              <div style={{ fontSize: '0.7rem', color: INK4, marginTop: 1 }}>42 active</div>
            </div>

            {/* Search icon */}
            <button
              onClick={() => setSearchOpen(!searchOpen)}
              style={{ border: 'none', background: searchOpen ? ORCHID : PAPER, cursor: 'pointer', width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={searchOpen ? 'white' : PLUM} strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
              </svg>
            </button>

            {/* Avatar */}
            <div style={{ width: 32, height: 32, borderRadius: 8, background: PLUM, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontWeight: 700, fontSize: '0.75rem', color: 'white' }}>
              JD
            </div>
          </div>

          {/* Expandable search row */}
          {searchOpen && (
            <div style={{ padding: '0 12px 12px', borderTop: `1px solid ${PAPER}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: PAPER, borderRadius: 8, padding: '8px 12px' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={INK4} strokeWidth="2.5" style={{ flexShrink: 0 }}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
                </svg>
                <input
                  autoFocus
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search customers…"
                  style={{ border: 'none', background: 'transparent', outline: 'none', flex: 1, fontSize: '0.82rem', color: INK1, fontFamily: 'inherit' }}
                />
              </div>
            </div>
          )}

          {/* Stage filter tabs — horizontal scroll */}
          <div style={{ borderTop: `1px solid ${PAPER_DEEP}`, overflowX: 'auto', display: 'flex', gap: 0, scrollbarWidth: 'none' }}>
            {STAGES.map(s => (
              <button
                key={s.key}
                onClick={() => setActiveStage(s.key)}
                style={{
                  border: 'none',
                  background: 'none',
                  cursor: 'pointer',
                  padding: '10px 14px',
                  fontSize: '0.75rem',
                  fontWeight: 700,
                  color: activeStage === s.key ? s.color : INK4,
                  whiteSpace: 'nowrap',
                  borderBottom: activeStage === s.key ? `2.5px solid ${s.color}` : '2.5px solid transparent',
                  transition: 'all 0.15s',
                  fontFamily: 'inherit',
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content list */}
      <div style={{ flex: 1, padding: '12px 14px', paddingBottom: 20, overflowY: 'auto' }}>
        {CUSTOMERS.map(c => (
          <div key={c.name} style={{ background: 'white', borderRadius: 10, padding: '13px 14px', marginBottom: 8, border: `1px solid ${STONE}`, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: c.stageLight, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: c.stageColor }}>{c.name.split(' ').map(w => w[0]).join('')}</span>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: '0.875rem', color: INK1 }}>{c.name}</div>
              <div style={{ marginTop: 3 }}>
                <span style={{ fontSize: '0.65rem', fontWeight: 700, background: c.stageLight, color: c.stageColor, padding: '2px 7px', borderRadius: 999, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{c.stage}</span>
              </div>
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={INK4} strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>
          </div>
        ))}
      </div>
    </div>
  );
}
