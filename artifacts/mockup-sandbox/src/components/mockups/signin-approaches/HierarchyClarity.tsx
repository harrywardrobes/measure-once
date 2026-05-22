export default function HierarchyClarity() {
  return (
    <div style={{
      background: '#f8f7f4', minHeight: '100vh', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      padding: '24px',
    }}>
      <div style={{
        background: '#fff', border: '1px solid #e7e5e0', borderRadius: '14px',
        maxWidth: '420px', width: '100%',
        boxShadow: '0 2px 8px rgba(0,0,0,.06)',
        overflow: 'hidden',
      }}>
        {/* Brand header band — clear top-of-hierarchy anchor */}
        <div style={{
          background: '#3d0f7a', padding: '28px 32px 24px',
          textAlign: 'center',
        }}>
          <img src="/harry-wardrobes-logo.png" alt="Harry Wardrobes"
            style={{ maxWidth: '160px', width: '100%', height: 'auto', display: 'inline-block', filter: 'brightness(0) invert(1)' }} />
        </div>

        {/* Form body */}
        <div style={{ padding: '32px' }}>
          {/* Level-1 heading */}
          <h1 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '0 0 4px', color: '#141413', letterSpacing: '-.01em' }}>
            Sign in
          </h1>
          <p style={{ color: '#78716c', fontSize: '.875rem', margin: '0 0 28px' }}>
            Measure Once — team workspace
          </p>

          {/* Divider label — section identity */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
            <div style={{ flex: 1, height: '1px', background: '#e7e5e0' }} />
            <span style={{ fontSize: '.72rem', fontWeight: 600, color: '#a8a29e', textTransform: 'uppercase', letterSpacing: '.06em', whiteSpace: 'nowrap' }}>
              Your credentials
            </span>
            <div style={{ flex: 1, height: '1px', background: '#e7e5e0' }} />
          </div>

          {/* Email */}
          <div style={{ marginBottom: '14px' }}>
            <label style={{ display: 'block', fontSize: '.8rem', fontWeight: 600, color: '#374151', marginBottom: '5px' }}>
              Email address
            </label>
            <input type="email" placeholder="you@example.com"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '10px 12px',
                border: '1.5px solid #d6d3d1', borderRadius: '8px',
                fontSize: '.9rem', background: '#fafaf9', color: '#141413',
                outline: 'none',
              }} readOnly />
          </div>

          {/* Password */}
          <div style={{ marginBottom: '6px' }}>
            <label style={{ display: 'block', fontSize: '.8rem', fontWeight: 600, color: '#374151', marginBottom: '5px' }}>
              Password
            </label>
            <input type="password" placeholder="••••••••"
              style={{
                width: '100%', boxSizing: 'border-box', padding: '10px 12px',
                border: '1.5px solid #3d0f7a', borderRadius: '8px',
                fontSize: '.9rem', background: '#fff',
                boxShadow: '0 0 0 3px rgba(61,15,122,.1)',
                outline: 'none',
              }} readOnly />
          </div>

          {/* Forgot — subordinate, right-aligned under field */}
          <div style={{ textAlign: 'right', marginBottom: '24px' }}>
            <a href="#" style={{ fontSize: '.8rem', color: '#3d0f7a', textDecoration: 'none', fontWeight: 500 }}
              onClick={e => e.preventDefault()}>
              Forgot password?
            </a>
          </div>

          {/* PRIMARY action — dominant */}
          <button style={{
            width: '100%', background: '#3d0f7a', color: '#fff',
            border: 'none', padding: '12px 18px',
            borderRadius: '8px', fontWeight: 700, fontSize: '1rem',
            cursor: 'pointer', letterSpacing: '.01em',
          }}>
            Sign in
          </button>

          {/* Hierarchy rule: secondary actions visually subordinate */}
          <div style={{
            marginTop: '20px', paddingTop: '16px',
            borderTop: '1px solid #f3f1ec',
            textAlign: 'center', fontSize: '.84rem', color: '#78716c',
          }}>
            New to Measure Once?{' '}
            <a href="#" style={{ color: '#3d0f7a', fontWeight: 600, textDecoration: 'none' }}
              onClick={e => e.preventDefault()}>
              Request access
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
