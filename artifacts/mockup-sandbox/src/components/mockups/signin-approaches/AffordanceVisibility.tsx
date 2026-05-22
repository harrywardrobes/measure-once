import { useState } from 'react';

export default function AffordanceVisibility() {
  const [showPw, setShowPw] = useState(false);
  const [emailFocused, setEmailFocused] = useState(false);
  const [pwFocused, setPwFocused] = useState(true);
  const [emailVal, setEmailVal] = useState('');

  return (
    <div style={{
      background: '#f8f7f4', minHeight: '100vh', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      padding: '24px',
    }}>
      <div style={{
        background: '#fff', border: '1px solid #e7e5e0', borderRadius: '12px',
        maxWidth: '420px', width: '100%', padding: '32px',
        boxShadow: '0 1px 3px rgba(0,0,0,.04)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <img src="/harry-wardrobes-logo.png" alt="Harry Wardrobes"
            style={{ maxWidth: '160px', width: '100%', height: 'auto', display: 'inline-block' }} />
        </div>

        <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 4px', color: '#141413' }}>
          Sign in
        </h1>
        <p style={{ color: '#78716c', fontSize: '.875rem', margin: '0 0 24px' }}>
          Use the email + password for your Measure Once account.
        </p>

        {/* Email — floating label affordance */}
        <div style={{ marginBottom: '16px', position: 'relative' }}>
          <div style={{
            position: 'relative',
            border: `1.5px solid ${emailFocused ? '#3d0f7a' : '#d6d3d1'}`,
            borderRadius: '8px',
            background: '#fff',
            boxShadow: emailFocused ? '0 0 0 3px rgba(61,15,122,.1)' : 'none',
            transition: 'border-color .15s, box-shadow .15s',
          }}>
            <label style={{
              position: 'absolute', left: '12px',
              top: emailFocused || emailVal ? '5px' : '12px',
              fontSize: emailFocused || emailVal ? '.68rem' : '.9rem',
              fontWeight: emailFocused || emailVal ? 600 : 400,
              color: emailFocused ? '#3d0f7a' : '#78716c',
              transition: 'all .15s ease',
              pointerEvents: 'none',
              letterSpacing: emailFocused || emailVal ? '.04em' : '0',
              textTransform: emailFocused || emailVal ? 'uppercase' : 'none',
            }}>
              Email
            </label>
            <input
              type="email"
              value={emailVal}
              onChange={e => setEmailVal(e.target.value)}
              onFocus={() => setEmailFocused(true)}
              onBlur={() => setEmailFocused(false)}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: emailFocused || emailVal ? '20px 12px 6px' : '12px 12px',
                border: 'none', borderRadius: '8px',
                fontSize: '.9rem', background: 'transparent',
                outline: 'none', transition: 'padding .15s',
              }}
            />
          </div>
        </div>

        {/* Password with show/hide toggle */}
        <div style={{ marginBottom: '6px' }}>
          <div style={{
            position: 'relative',
            border: `1.5px solid ${pwFocused ? '#3d0f7a' : '#d6d3d1'}`,
            borderRadius: '8px',
            background: '#fff',
            boxShadow: pwFocused ? '0 0 0 3px rgba(61,15,122,.1)' : 'none',
          }}>
            <label style={{
              position: 'absolute', left: '12px', top: '5px',
              fontSize: '.68rem', fontWeight: 600, color: '#3d0f7a',
              letterSpacing: '.04em', textTransform: 'uppercase',
            }}>
              Password
            </label>
            <input
              type={showPw ? 'text' : 'password'}
              defaultValue="hunter2"
              onFocus={() => setPwFocused(true)}
              onBlur={() => setPwFocused(false)}
              style={{
                width: '100%', boxSizing: 'border-box',
                padding: '20px 44px 6px 12px',
                border: 'none', borderRadius: '8px',
                fontSize: '.9rem', background: 'transparent',
                outline: 'none',
              }}
            />
            {/* Show/hide toggle — explicit affordance */}
            <button
              type="button"
              onClick={() => setShowPw(v => !v)}
              title={showPw ? 'Hide password' : 'Show password'}
              style={{
                position: 'absolute', right: '10px', top: '50%',
                transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '4px', color: '#78716c', lineHeight: 1,
              }}
            >
              {showPw ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                  <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Contextual forgot — right under password field */}
        <div style={{ textAlign: 'right', marginBottom: '22px' }}>
          <a href="#" style={{ fontSize: '.8rem', color: '#3d0f7a', textDecoration: 'none', fontWeight: 500 }}
            onClick={e => e.preventDefault()}>
            Forgot password?
          </a>
        </div>

        {/* Button with hover affordance cue */}
        <button
          style={{
            width: '100%', background: '#3d0f7a', color: '#fff',
            border: 'none', padding: '12px 18px', borderRadius: '8px',
            fontWeight: 600, fontSize: '.95rem', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            transition: 'background .15s, transform .1s',
            boxShadow: '0 2px 6px rgba(61,15,122,.25)',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/>
            <polyline points="10 17 15 12 10 7"/>
            <line x1="15" y1="12" x2="3" y2="12"/>
          </svg>
          Sign in
        </button>

        <div style={{
          marginTop: '20px', paddingTop: '16px',
          borderTop: '1px solid #f3f1ec',
          textAlign: 'center', fontSize: '.84rem', color: '#78716c',
        }}>
          Don't have an account?{' '}
          <a href="#" style={{ color: '#3d0f7a', fontWeight: 600, textDecoration: 'none' }}
            onClick={e => e.preventDefault()}>
            Request access
          </a>
        </div>
      </div>
    </div>
  );
}
