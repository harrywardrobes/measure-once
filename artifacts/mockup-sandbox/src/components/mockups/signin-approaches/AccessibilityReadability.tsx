export default function AccessibilityReadability() {
  return (
    <div style={{
      background: '#f5f4f1', minHeight: '100vh', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      padding: '24px',
    }}>
      <div style={{
        background: '#fff', border: '2px solid #d6d3d1', borderRadius: '12px',
        maxWidth: '440px', width: '100%', padding: '36px',
        boxShadow: '0 2px 6px rgba(0,0,0,.06)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <img src="/harry-wardrobes-logo.png" alt="Harry Wardrobes"
            style={{ maxWidth: '160px', width: '100%', height: 'auto', display: 'inline-block' }} />
        </div>

        <h1 style={{
          fontSize: '1.4rem', fontWeight: 700, margin: '0 0 6px',
          color: '#0f0f0e',  /* near-black for max contrast */
        }}>
          Sign in
        </h1>
        <p style={{ color: '#44403c', fontSize: '.95rem', margin: '0 0 28px', lineHeight: 1.5 }}>
          Use your email and password to sign in to your Measure Once account.
        </p>

        {/* Success banner — icon + text, not colour-only */}
        <div role="status" style={{
          display: 'flex', alignItems: 'flex-start', gap: '10px',
          background: '#f0fdf4', border: '1.5px solid #86efac',
          borderRadius: '8px', padding: '10px 12px', marginBottom: '20px',
          fontSize: '.9rem', color: '#14532d',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5" style={{ flexShrink: 0, marginTop: '1px' }}>
            <polyline points="20 6 9 17 4 12"/>
          </svg>
          <span>You've been signed out successfully.</span>
        </div>

        {/* Email — large label, explicit required */}
        <div style={{ marginBottom: '18px' }}>
          <label htmlFor="a11y-email" style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            fontSize: '.9rem', fontWeight: 600, color: '#1c1917', marginBottom: '6px',
          }}>
            Email address
            <span style={{ fontSize: '.75rem', color: '#78716c', fontWeight: 400 }}>Required</span>
          </label>
          <input
            id="a11y-email" type="email" autoComplete="username"
            aria-required="true"
            placeholder="your@email.com"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '12px 14px',
              border: '2px solid #a8a29e', borderRadius: '8px',
              fontSize: '1rem', background: '#fff', color: '#1c1917',
              outline: 'none',
            }}
            readOnly
          />
        </div>

        {/* Password — large label, required, hint text */}
        <div style={{ marginBottom: '8px' }}>
          <label htmlFor="a11y-password" style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            fontSize: '.9rem', fontWeight: 600, color: '#1c1917', marginBottom: '6px',
          }}>
            Password
            <span style={{ fontSize: '.75rem', color: '#78716c', fontWeight: 400 }}>Required</span>
          </label>
          <input
            id="a11y-password" type="password"
            aria-required="true"
            placeholder="••••••••"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '12px 14px',
              border: '2px solid #3d0f7a', borderRadius: '8px',
              fontSize: '1rem', background: '#fff', color: '#1c1917',
              outline: 'none', boxShadow: '0 0 0 3px rgba(61,15,122,.12)',
            }}
            readOnly
          />
        </div>

        <div style={{ marginBottom: '26px' }}>
          <a href="#" style={{
            fontSize: '.875rem', color: '#3d0f7a', fontWeight: 600,
            textDecoration: 'underline',   /* underline always-on for non-colour-only cue */
          }} onClick={e => e.preventDefault()}>
            Forgot your password?
          </a>
        </div>

        {/* Large touch target — min 48px height */}
        <button style={{
          width: '100%', background: '#3d0f7a', color: '#fff',
          border: 'none', padding: '14px 18px', borderRadius: '8px',
          fontWeight: 700, fontSize: '1rem', cursor: 'pointer',
          minHeight: '48px',
          letterSpacing: '.02em',
        }}>
          Sign in to Measure Once
        </button>

        {/* Error example — icon + text, explicit role */}
        <div role="alert" style={{
          display: 'flex', alignItems: 'flex-start', gap: '10px',
          background: '#fef2f2', border: '1.5px solid #fca5a5',
          borderRadius: '8px', padding: '10px 12px', marginTop: '14px',
          fontSize: '.9rem', color: '#7f1d1d',
        }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5" style={{ flexShrink: 0, marginTop: '1px' }}>
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span>Incorrect email or password. Please try again.</span>
        </div>

        <div style={{
          marginTop: '22px', paddingTop: '18px',
          borderTop: '2px solid #f3f1ec',
          textAlign: 'center', fontSize: '.9rem', color: '#44403c', lineHeight: 1.6,
        }}>
          Don't have an account?{' '}
          <a href="#" style={{
            color: '#3d0f7a', fontWeight: 700,
            textDecoration: 'underline',
          }} onClick={e => e.preventDefault()}>
            Request access
          </a>
        </div>
      </div>
    </div>
  );
}
