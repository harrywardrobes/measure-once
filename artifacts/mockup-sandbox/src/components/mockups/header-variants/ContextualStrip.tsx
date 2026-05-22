import { useState } from 'react';

const PLUM = '#200842';
const PAPER = '#F6F1E7';
const STONE = '#D9D2C2';
const INK1 = '#141413';
const INK3 = '#6B6860';
const INK4 = '#97927F';

const STAGE_COLORS: Record<string, { bg: string; light: string; text: string }> = {
  home:        { bg: PLUM,       light: '#ede0ff', text: PLUM },
  sales:       { bg: '#8B2BFF',  light: '#F3EAFF', text: '#6A12D9' },
  survey:      { bg: '#d97706',  light: '#fef3c7', text: '#b45309' },
  projects:    { bg: '#2563eb',  light: '#dbeafe', text: '#1d4ed8' },
  calendar:    { bg: '#0891b2',  light: '#cffafe', text: '#0e7490' },
  invoices:    { bg: '#059669',  light: '#d1fae5', text: '#047857' },
  trades:      { bg: '#8A5A3B',  light: '#fdf6ee', text: '#5c3820' },
  ideas:       { bg: '#dc2626',  light: '#fee2e2', text: '#b91c1c' },
};

const NAV = [
  { key: 'home',     label: 'Home',     svg: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6', badge: 0 },
  { key: 'sales',    label: 'Sales',    svg: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z', badge: 7 },
  { key: 'projects', label: 'Projects', svg: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2', badge: 12 },
  { key: 'calendar', label: 'Calendar', svg: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4', badge: 2 },
  { key: 'invoices', label: 'Invoices', svg: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z', badge: 3 },
];

const PAGE_TITLES: Record<string, string> = {
  home: 'Dashboard', sales: 'Sales', survey: 'Survey',
  projects: 'Projects', calendar: 'Calendar', invoices: 'Invoices',
  trades: 'Trades', ideas: 'Ideas',
};

const CONTEXT_SUBTITLES: Record<string, string> = {
  home: '3 tasks due today', sales: '7 open leads', survey: '4 awaiting confirmation',
  projects: '12 active projects', calendar: '2 events this week', invoices: '£4,200 outstanding',
  trades: '18 trade contacts', ideas: '6 saved ideas',
};

const CUSTOMERS = [
  { name: 'Alice Johnson', stage: 'Sales',        sk: 'sales' },
  { name: 'Ben Carter',    stage: 'Design Visit',  sk: 'sales' },
  { name: 'Clara Smith',   stage: 'Survey',        sk: 'survey' },
  { name: 'David Kim',     stage: 'Order',         sk: 'projects' },
  { name: 'Emily Brown',   stage: 'Workshop',      sk: 'projects' },
];

export default function ContextualStrip() {
  const [activeNav, setActiveNav] = useState('sales');
  const [fabOpen, setFabOpen] = useState(false);
  const [query, setQuery] = useState('');
  const palette = STAGE_COLORS[activeNav] || STAGE_COLORS.home;

  return (
    <div style={{ fontFamily: "'Open Sans', sans-serif", background: PAPER, minHeight: '100vh', display: 'flex', flexDirection: 'column', position: 'relative' }}>

      {/* Stage-coloured header */}
      <header style={{ background: palette.bg, padding: '12px 14px 14px' }}>
        {/* Top row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <button style={{ border: 'none', background: 'rgba(255,255,255,0.15)', cursor: 'pointer', width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
          <div style={{ flex: 1 }} />
          <div style={{ width: 30, height: 30, borderRadius: '50%', background: 'rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 700, color: 'white' }}>JD</div>
        </div>
        {/* Context title */}
        <div>
          <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'white', lineHeight: 1.1 }}>{PAGE_TITLES[activeNav]}</div>
          <div style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.7)', marginTop: 3 }}>{CONTEXT_SUBTITLES[activeNav]}</div>
        </div>
      </header>

      {/* Coloured accent bar below header */}
      <div style={{ height: 3, background: palette.bg, opacity: 0.3 }} />

      {/* Content */}
      <div style={{ flex: 1, padding: '14px', paddingBottom: 90, overflowY: 'auto' }}>
        {CUSTOMERS.map(c => {
          const cp = STAGE_COLORS[c.sk] || STAGE_COLORS.home;
          return (
            <div key={c.name} style={{ background: 'white', borderRadius: 10, padding: '12px 14px', marginBottom: 8, border: `1px solid ${STONE}`, borderLeft: `3px solid ${cp.bg}`, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: 9, background: cp.light, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '0.72rem', fontWeight: 700, color: cp.text }}>{c.name.split(' ').map(w=>w[0]).join('')}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '0.875rem', color: INK1 }}>{c.name}</div>
                <div style={{ fontSize: '0.72rem', color: INK3, marginTop: 2 }}>{c.stage}</div>
              </div>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={INK4} strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>
            </div>
          );
        })}
      </div>

      {/* Floating search overlay */}
      {fabOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(32,8,66,0.4)', zIndex: 50, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
          onClick={e => { if (e.target === e.currentTarget) setFabOpen(false); }}>
          <div style={{ background: 'white', borderRadius: '16px 16px 0 0', padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: PAPER, border: `1.5px solid ${STONE}`, borderRadius: 10, padding: '10px 14px', marginBottom: 12 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={INK4} strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
              </svg>
              <input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search customers…" style={{ flex: 1, border: 'none', background: 'transparent', outline: 'none', fontSize: '0.875rem', color: INK1, fontFamily: 'inherit' }} />
            </div>
            <p style={{ fontSize: '0.68rem', fontWeight: 700, color: INK4, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 8 }}>Recent</p>
            {['Alice Johnson', 'Ben Carter', 'Clara Smith'].map(n => (
              <div key={n} style={{ padding: '9px 4px', fontSize: '0.82rem', color: INK1, borderBottom: `1px solid ${STONE}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={palette.bg} strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                {n}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* FAB search button */}
      {!fabOpen && (
        <button
          onClick={() => setFabOpen(true)}
          style={{ position: 'fixed', bottom: 74, right: 16, width: 48, height: 48, borderRadius: '50%', background: palette.bg, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 16px rgba(0,0,0,0.25)', zIndex: 40 }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
          </svg>
        </button>
      )}

      {/* Bottom nav with badges */}
      <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'white', borderTop: `1px solid ${STONE}`, height: 62, display: 'flex', alignItems: 'center', zIndex: 30 }}>
        {NAV.map(n => {
          const isActive = n.key === activeNav;
          const nc = STAGE_COLORS[n.key] || STAGE_COLORS.home;
          return (
            <button key={n.key} onClick={() => setActiveNav(n.key)} style={{ flex: 1, border: 'none', background: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, color: isActive ? nc.bg : INK4, padding: '4px 0', position: 'relative', fontFamily: 'inherit' }}>
              {n.badge > 0 && (
                <span style={{ position: 'absolute', top: 2, right: '50%', marginRight: -18, width: 16, height: 16, borderRadius: '50%', background: nc.bg, color: 'white', fontSize: '0.55rem', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{n.badge}</span>
              )}
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d={n.svg}/>
              </svg>
              <span style={{ fontSize: '0.52rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{n.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
