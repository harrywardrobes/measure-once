import { useState } from 'react';

const PLUM = '#200842';
const ORCHID = '#8B2BFF';
const PAPER = '#F6F1E7';
const STONE = '#D9D2C2';
const INK1 = '#141413';
const INK3 = '#6B6860';
const INK4 = '#97927F';

const NAV = [
  { key: 'home',     label: 'Home',      svg: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { key: 'sales',    label: 'Sales',     svg: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z' },
  { key: 'projects', label: 'Projects',  svg: 'M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2' },
  { key: 'calendar', label: 'Calendar',  svg: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4' },
  { key: 'invoices', label: 'Invoices',  svg: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
];

const CUSTOMERS = ['Alice Johnson', 'Ben Carter', 'Clara Smith', 'David Kim', 'Emily Brown'];

export default function SearchForward() {
  const [query, setQuery] = useState('');
  const [activeNav, setActiveNav] = useState('home');
  const filtered = query.length > 0
    ? CUSTOMERS.filter(c => c.toLowerCase().includes(query.toLowerCase()))
    : [];

  return (
    <div style={{ fontFamily: "'Open Sans', sans-serif", background: PAPER, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

      {/* Row 1: Brand + Profile — dark plum */}
      <div style={{ background: PLUM, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Logo mark placeholder */}
          <div style={{ width: 26, height: 26, borderRadius: 6, background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6"/>
            </svg>
          </div>
          <span style={{ color: 'white', fontWeight: 700, fontSize: '0.9rem', letterSpacing: '0.04em', textTransform: 'uppercase' }}>Measure Once</span>
        </div>
        {/* Avatar */}
        <div style={{ width: 30, height: 30, borderRadius: '50%', background: ORCHID, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
          </svg>
        </div>
      </div>

      {/* Row 2: Search — light, always visible */}
      <div style={{ background: 'white', borderBottom: `1px solid ${STONE}`, padding: '8px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: PAPER, border: `1.5px solid ${STONE}`, borderRadius: 999, padding: '7px 14px' }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={INK4} strokeWidth="2.5" style={{ flexShrink: 0 }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 105 11a6 6 0 0012 0z"/>
          </svg>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search customers, stages, actions…"
            style={{ border: 'none', background: 'transparent', outline: 'none', flex: 1, fontSize: '0.82rem', color: INK1, fontFamily: 'inherit' }}
          />
          {query && (
            <button onClick={() => setQuery('')} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: INK4, lineHeight: 1 }}>
              <svg width="12" height="12" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd"/></svg>
            </button>
          )}
        </div>
        {/* Inline search results */}
        {filtered.length > 0 && (
          <div style={{ marginTop: 6, borderRadius: 8, border: `1px solid ${STONE}`, background: 'white', overflow: 'hidden' }}>
            {filtered.map(name => (
              <div key={name} style={{ padding: '9px 14px', fontSize: '0.82rem', color: INK1, borderBottom: `1px solid ${STONE}`, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={ORCHID} strokeWidth="2.5"><path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/></svg>
                {name}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Page content area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 14px', paddingBottom: 72 }}>
        <p style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: INK4, marginBottom: 12 }}>Recent customers</p>
        {CUSTOMERS.map((name, i) => (
          <div key={name} style={{ background: 'white', borderRadius: 10, padding: '12px 14px', marginBottom: 8, border: `1px solid ${STONE}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.875rem', color: INK1 }}>{name}</div>
              <div style={{ fontSize: '0.72rem', color: INK3, marginTop: 2 }}>{['Sales', 'Design Visit', 'Survey', 'Order', 'Workshop'][i]}</div>
            </div>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={INK4} strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7"/></svg>
          </div>
        ))}
      </div>

      {/* Bottom nav — icon only, compact */}
      <nav style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: 'white', borderTop: `1px solid ${STONE}`, height: 58, display: 'flex', alignItems: 'center', justifyContent: 'space-around', paddingBottom: 'env(safe-area-inset-bottom)' }}>
        {NAV.map(n => (
          <button key={n.key} onClick={() => setActiveNav(n.key)} style={{ border: 'none', background: 'none', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, color: activeNav === n.key ? ORCHID : INK4, padding: '4px 8px' }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d={n.svg}/>
            </svg>
            <span style={{ fontSize: '0.55rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{n.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
