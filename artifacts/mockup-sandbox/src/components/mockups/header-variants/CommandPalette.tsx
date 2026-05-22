import { useState } from 'react';

const PLUM = '#200842';
const ORCHID = '#8B2BFF';
const PAPER = '#F6F1E7';
const STONE = '#D9D2C2';
const INK1 = '#141413';
const INK2 = '#3C3A34';
const INK3 = '#6B6860';
const INK4 = '#97927F';

const NAV_LABELS = ['Home', 'Sales', 'Projects', 'Calendar', 'Invoices'];

const RECENT = [
  { name: 'Alice Johnson',    meta: 'Sales · Open deal',          color: '#8B2BFF', bg: '#F3EAFF' },
  { name: 'Ben Carter',       meta: 'Design Visit · Scheduled',   color: '#0f766e', bg: '#ccfbf1' },
  { name: 'Clara Smith',      meta: 'Survey · In progress',       color: '#b45309', bg: '#fef3c7' },
];

const ACTIONS = [
  { label: 'New customer',        icon: 'M12 4v16m8-8H4', color: ORCHID },
  { label: 'Go to Sales board',   icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z', color: '#8B2BFF' },
  { label: 'Open calendar',       icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4', color: '#0891b2' },
];

const ALL_CUSTOMERS = ['Alice Johnson', 'Ben Carter', 'Clara Smith', 'David Kim', 'Emily Brown', 'Frank Lee'];

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeNav, setActiveNav] = useState('Home');

  const results = query.length > 1
    ? ALL_CUSTOMERS.filter(n => n.toLowerCase().includes(query.toLowerCase()))
    : [];

  return (
    <div style={{ fontFamily: "'Open Sans', sans-serif", background: PAPER, minHeight: '100vh', display: 'flex', flexDirection: 'column', position: 'relative' }}>

      {/* Minimal header */}
      <header style={{ background: PLUM, display: 'flex', alignItems: 'center', height: 50, padding: '0 14px', gap: 10 }}>
        <button style={{ border: 'none', background: 'rgba(255,255,255,0.1)', cursor: 'pointer', width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7"/>
          </svg>
        </button>

        {/* Page title — centre */}
        <div style={{ flex: 1, textAlign: 'center' }}>
          <span style={{ color: 'white', fontWeight: 700, fontSize: '0.92rem', letterSpacing: '0.01em' }}>Customers</span>
        </div>

        {/* Search trigger — tap to open palette */}
        <button
          onClick={() => { setOpen(true); setQuery(''); }}
          style={{ border: 'none', background: 'rgba(255,255,255,0.1)', cursor: 'pointer', width: 30, height: 30, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
          </svg>
        </button>

        {/* Avatar */}
        <div style={{ width: 30, height: 30, borderRadius: '50%', background: ORCHID, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 700, color: 'white' }}>JD</div>
      </header>

      {/* Hint bar */}
      <div
        onClick={() => { setOpen(true); setQuery(''); }}
        style={{ background: 'white', borderBottom: `1px solid ${STONE}`, padding: '9px 14px', display: 'flex', alignItems: 'center', gap: 8, cursor: 'text' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={INK4} strokeWidth="2.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
        </svg>
        <span style={{ fontSize: '0.82rem', color: INK4 }}>Search customers, actions…</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.68rem', background: PAPER, border: `1px solid ${STONE}`, borderRadius: 5, padding: '1px 6px', color: INK4, fontWeight: 600 }}>⌘K</span>
      </div>

      {/* Content */}
      <div style={{ flex: 1, padding: '16px 14px', paddingBottom: 60, overflowY: 'auto' }}>
        <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: INK4, marginBottom: 10 }}>Recent</p>
        {RECENT.map(c => (
          <div key={c.name} style={{ background: 'white', borderRadius: 10, padding: '12px 14px', marginBottom: 8, border: `1px solid ${STONE}`, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, background: c.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '0.72rem', fontWeight: 700, color: c.color }}>{c.name.split(' ').map(w=>w[0]).join('')}</div>
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.875rem', color: INK1 }}>{c.name}</div>
              <div style={{ fontSize: '0.72rem', color: INK3, marginTop: 1 }}>{c.meta}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom nav — text labels only, no icons */}
      <nav style={{ background: 'white', borderTop: `1px solid ${STONE}`, display: 'flex', height: 48 }}>
        {NAV_LABELS.map(label => (
          <button key={label} onClick={() => setActiveNav(label)} style={{ flex: 1, border: 'none', background: 'none', cursor: 'pointer', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: activeNav === label ? ORCHID : INK4, borderTop: activeNav === label ? `2.5px solid ${ORCHID}` : '2.5px solid transparent', fontFamily: 'inherit', transition: 'all 0.15s' }}>
            {label}
          </button>
        ))}
      </nav>

      {/* Command palette overlay */}
      {open && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(32,8,66,0.55)', zIndex: 100, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 60 }}
          onClick={e => { if (e.target === e.currentTarget) setOpen(false); }}
        >
          <div style={{ background: 'white', borderRadius: 16, width: 'calc(100% - 28px)', maxWidth: 400, overflow: 'hidden', boxShadow: '0 20px 60px rgba(32,8,66,0.35)' }}>
            {/* Search input */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: `1px solid ${STONE}` }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={INK4} strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
              </svg>
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search customers, go to page, run action…"
                style={{ flex: 1, border: 'none', outline: 'none', fontSize: '0.875rem', color: INK1, fontFamily: 'inherit', background: 'transparent' }}
              />
              <button onClick={() => setOpen(false)} style={{ border: 'none', background: PAPER, cursor: 'pointer', borderRadius: 5, padding: '3px 8px', fontSize: '0.68rem', color: INK3, fontFamily: 'inherit' }}>Esc</button>
            </div>

            {/* Results or default */}
            <div style={{ maxHeight: 340, overflowY: 'auto' }}>
              {results.length > 0 ? (
                <>
                  <p style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: INK4, padding: '10px 16px 4px' }}>Customers</p>
                  {results.map(name => (
                    <div key={name} style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', borderBottom: `1px solid ${PAPER}` }}>
                      <div style={{ width: 30, height: 30, borderRadius: 7, background: '#F3EAFF', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.68rem', fontWeight: 700, color: ORCHID }}>{name.split(' ').map(w=>w[0]).join('')}</div>
                      <span style={{ fontSize: '0.82rem', color: INK1, fontWeight: 500 }}>{name}</span>
                    </div>
                  ))}
                </>
              ) : (
                <>
                  <p style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: INK4, padding: '10px 16px 4px' }}>Quick actions</p>
                  {ACTIONS.map(a => (
                    <div key={a.label} style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', borderBottom: `1px solid ${PAPER}` }}>
                      <div style={{ width: 30, height: 30, borderRadius: 7, background: PAPER, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={a.color} strokeWidth="2.2"><path strokeLinecap="round" strokeLinejoin="round" d={a.icon}/></svg>
                      </div>
                      <span style={{ fontSize: '0.82rem', color: INK1, fontWeight: 500 }}>{a.label}</span>
                    </div>
                  ))}
                  <p style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: INK4, padding: '10px 16px 4px' }}>Recent</p>
                  {RECENT.map(c => (
                    <div key={c.name} style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', borderBottom: `1px solid ${PAPER}` }}>
                      <div style={{ width: 30, height: 30, borderRadius: 7, background: c.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.68rem', fontWeight: 700, color: c.color }}>{c.name.split(' ').map(w=>w[0]).join('')}</div>
                      <span style={{ fontSize: '0.82rem', color: INK1, fontWeight: 500 }}>{c.name}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
