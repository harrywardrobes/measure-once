import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import GlobalStyles from '@mui/material/GlobalStyles';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import { LoginPageSkeleton } from '../../components/PageLoadingSkeleton';

type View = 'login' | 'forgot' | 'request';

const LOGO_URL = '/harry-wardrobes-logo.png';

const bodyStyles = { 'html, body': { margin: 0, padding: 0, minHeight: '100vh', background: '#f8f7f4' } };

type TW = { render: (el: Element, opts: object) => string; getResponse: (id: string) => string; reset: (id: string) => void };

function useTurnstile() {
  const [siteKey, setSiteKey] = React.useState<string | null>(null);
  const [tokens, setTokens] = React.useState<Record<string, string>>({});
  const [errors, setErrors] = React.useState<Record<string, boolean>>({});
  const siteKeyRef = React.useRef<string | null>(null);
  const widgetIds = React.useRef<Record<string, string | null>>({});
  const attempted = React.useRef<Set<string>>(new Set());

  const PAIRS: Array<[string, string]> = [
    ['login', 'turnstile-login'], ['forgot', 'ts-forgot'], ['request', 'ts-request'],
  ];

  const renderWidgets = React.useCallback(() => {
    const tw = (window as unknown as { turnstile?: TW }).turnstile;
    const key = siteKeyRef.current;
    if (!key || !tw) return;
    PAIRS.forEach(([name, elId]) => {
      const el = document.getElementById(elId);
      if (!el || attempted.current.has(name)) return;
      attempted.current.add(name);
      const id = tw.render(el, {
        sitekey: key,
        theme: 'light',
        appearance: 'always',
        size: 'flexible',
        callback: () => {
          setTokens((p) => ({ ...p, [name]: tw.getResponse(id) || '' }));
          setErrors((p) => ({ ...p, [name]: false }));
        },
        'error-callback': () => setErrors((p) => ({ ...p, [name]: true })),
        'unsupported-callback': () => setErrors((p) => ({ ...p, [name]: true })),
      });
      widgetIds.current[name] = id;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    fetch('/api/turnstile-config').then(r => r.json()).then(cfg => {
      if (cfg?.enabled && cfg?.siteKey) {
        siteKeyRef.current = cfg.siteKey;
        setSiteKey(cfg.siteKey);
        const w = window as unknown as { _turnstileApiReady?: boolean; onTurnstileReady?: () => void };
        (window as unknown as { onTurnstileReady: () => void }).onTurnstileReady = () => {
          renderWidgets();
        };
        if (w._turnstileApiReady) {
          renderWidgets();
        } else {
          const script = document.createElement('script');
          script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileReady';
          script.async = true; script.defer = true;
          document.head.appendChild(script);
        }
      }
    }).catch(() => {});
  }, [renderWidgets]);

  const resetWidget = React.useCallback((name: string) => {
    const tw = (window as unknown as { turnstile?: TW }).turnstile;
    const id = widgetIds.current[name];
    setErrors((p) => ({ ...p, [name]: false }));
    if (id != null && tw) tw.reset(id);
  }, []);

  const getToken = (name: string) => tokens[name] || '';
  const hasError = (name: string) => errors[name] || false;

  const handlePageShow = React.useCallback((e: PageTransitionEvent) => {
    if (e.persisted) {
      attempted.current.clear();
      widgetIds.current = {};
      setTokens({});
      renderWidgets();
    }
  }, [renderWidgets]);

  React.useEffect(() => {
    window.addEventListener('pageshow', handlePageShow as EventListener);
    return () => window.removeEventListener('pageshow', handlePageShow as EventListener);
  }, [handlePageShow]);

  return { siteKey, getToken, hasError, resetWidget, renderWidgets };
}

function AuthCard({ children, maxWidth = 440, elevated = false }: {
  children: React.ReactNode;
  maxWidth?: number;
  elevated?: boolean;
}) {
  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
      <Paper
        elevation={0}
        sx={{
          width: '100%',
          maxWidth,
          p: elevated ? 4.5 : 4,
          border: elevated ? '2px solid' : '1px solid',
          borderColor: elevated ? 'divider' : 'grey.200',
          borderRadius: 3,
          boxShadow: elevated ? '0 2px 6px rgba(0,0,0,.06)' : '0 1px 3px rgba(0,0,0,.04)',
        }}
      >
        {children}
      </Paper>
    </Box>
  );
}

function Logo() {
  return (
    <Box sx={{ textAlign: 'center', mb: 3.5 }}>
      <Box component="img" src={LOGO_URL} alt="Harry Wardrobes" sx={{ maxWidth: 180, width: '100%', height: 'auto' }} />
    </Box>
  );
}

function AuthAlert({ msg, severity, id }: { msg: string; severity: 'success' | 'error'; id?: string }) {
  return (
    <Alert id={id} severity={severity} sx={{ mb: 2.5, fontSize: '0.875rem' }}>
      {msg}
    </Alert>
  );
}

function LoginPageInner() {
  const [view, setView] = React.useState<View>(() => {
    const h = window.location.hash;
    if (h === '#forgot') return 'forgot';
    if (h === '#request') return 'request';
    return 'login';
  });

  const [loginEmail, setLoginEmail] = React.useState('');
  const [loginPassword, setLoginPassword] = React.useState('');
  const [loginMsg, setLoginMsg] = React.useState<{ text: string; ok: boolean } | null>(() => {
    const p = new URLSearchParams(location.search);
    if (p.get('password_set') === '1') return { text: 'Password set successfully — you can now sign in.', ok: true };
    if (p.get('signed_out') === '1') return { text: "You've been signed out.", ok: true };
    return null;
  });
  const [loginBusy, setLoginBusy] = React.useState(false);

  const [forgotEmail, setForgotEmail] = React.useState('');
  const [forgotMsg, setForgotMsg] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [forgotConfirmed, setForgotConfirmed] = React.useState(false);
  const [forgotConfirmEmail, setForgotConfirmEmail] = React.useState('');
  const [forgotBusy, setForgotBusy] = React.useState(false);

  const [reqName, setReqName] = React.useState('');
  const [reqEmail, setReqEmail] = React.useState('');
  const [reqMsg, setReqMsg] = React.useState<{ text: string; ok: boolean } | null>(null);
  const [reqBusy, setReqBusy] = React.useState(false);

  const { siteKey, getToken, hasError, resetWidget, renderWidgets } = useTurnstile();

  React.useEffect(() => {
    renderWidgets();
  }, [view, renderWidgets]);

  function switchView(next: View) {
    if (next === 'login') {
      if (forgotEmail && !loginEmail) setLoginEmail(forgotEmail);
      if (reqEmail && !loginEmail) setLoginEmail(reqEmail);
      setForgotConfirmed(false);
      setForgotEmail('');
      setForgotMsg(null);
    } else if (next === 'forgot') {
      if (loginEmail && !forgotEmail) setForgotEmail(loginEmail);
    } else if (next === 'request') {
      if (loginEmail && !reqEmail) setReqEmail(loginEmail);
    }
    setView(next);
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    const captchaToken = getToken('login');
    if (siteKey && !captchaToken && !hasError('login')) {
      setLoginMsg({ text: 'Please complete the captcha challenge.', ok: false });
      return;
    }
    setLoginMsg(null);
    setLoginBusy(true);
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: loginEmail.trim(), password: loginPassword, captchaToken }),
      });
      const data = await r.json().catch(() => ({})) as { next?: string; error?: string };
      if (!r.ok) {
        setLoginMsg({ text: data.error || `Sign in failed (${r.status}) — please reload and try again.`, ok: false });
        resetWidget('login');
        return;
      }
      window.location.href = data.next || '/';
    } catch {
      setLoginMsg({ text: 'Network error — please try again.', ok: false });
      resetWidget('login');
    } finally {
      setLoginBusy(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    const captchaToken = getToken('forgot');
    if (siteKey && !captchaToken && !hasError('forgot')) {
      setForgotMsg({ text: 'Please complete the captcha challenge.', ok: false });
      return;
    }
    setForgotMsg(null);
    setForgotBusy(true);
    try {
      const r = await fetch('/api/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: forgotEmail.trim(), captchaToken }),
      });
      const data = await r.json().catch(() => ({})) as { error?: string };
      if (r.ok) {
        setForgotConfirmEmail(forgotEmail.trim());
        setForgotConfirmed(true);
      } else if (r.status === 429) {
        setForgotMsg({ text: 'Too many requests — please try again later.', ok: false });
      } else {
        setForgotMsg({ text: data.error || 'Could not send reset link.', ok: false });
      }
    } catch {
      setForgotMsg({ text: 'Network error — please try again.', ok: false });
    } finally {
      setForgotBusy(false);
      resetWidget('forgot');
    }
  }

  async function handleRequest(e: React.FormEvent) {
    e.preventDefault();
    const captchaToken = getToken('request');
    if (siteKey && !captchaToken && !hasError('request')) {
      setReqMsg({ text: 'Please complete the captcha challenge.', ok: false });
      return;
    }
    setReqMsg(null);
    setReqBusy(true);
    try {
      const r = await fetch('/api/request-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name: reqName.trim(), email: reqEmail.trim(), captchaToken }),
      });
      const data = await r.json().catch(() => ({})) as { error?: string; status?: string };
      if (r.ok) {
        setReqMsg({ text: "Request received. We'll email you once an admin approves it.", ok: true });
        setReqName(''); setReqEmail('');
      } else if (r.status === 409 && data.status === 'approved') {
        setReqMsg({ text: 'This email is already approved — check your inbox for a set-password link.', ok: true });
      } else if (r.status === 409 && data.status === 'pending') {
        setReqMsg({ text: 'This email already has a pending request.', ok: true });
      } else if (r.status === 429) {
        setReqMsg({ text: 'Too many requests — please try again later.', ok: false });
      } else {
        setReqMsg({ text: data.error || 'Could not submit request.', ok: false });
      }
    } catch {
      setReqMsg({ text: 'Network error — please try again.', ok: false });
    } finally {
      setReqBusy(false);
      resetWidget('request');
    }
  }

  if (view === 'forgot') {
    return (
      <AuthCard maxWidth={440} elevated>
        <GlobalStyles styles={bodyStyles} />
        <Logo />
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.75, letterSpacing: '-0.01em' }}>
          Reset your password
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3.5 }}>
          Enter your email and we&apos;ll send you a link to set a new password.
        </Typography>
        {forgotMsg && <AuthAlert msg={forgotMsg.text} severity={forgotMsg.ok ? 'success' : 'error'} />}
        {forgotConfirmed ? (
          <>
            <Alert severity="success" icon={<CheckCircleOutlinedIcon />} sx={{ mb: 2.5 }}>
              An email has been sent to <strong>{forgotConfirmEmail}</strong>. Please check your inbox and follow the link to reset your password.
            </Alert>
            <Button
              fullWidth variant="outlined"
              onClick={() => { setForgotConfirmed(false); setForgotEmail(''); setForgotMsg(null); resetWidget('forgot'); }}
            >
              Try a different email
            </Button>
          </>
        ) : (
          <Box component="form" onSubmit={handleForgot}>
            <Stack spacing={2.5}>
              <TextField
                label="Email address" type="email" fullWidth required
                autoComplete="username" slotProps={{ htmlInput: { maxLength: 254 } }}
                value={forgotEmail} onChange={e => setForgotEmail(e.target.value)}
                placeholder="your@email.com"
              />
              <div id="ts-forgot" style={{ margin: '4px 0 2px', minHeight: 65 }} />
              <Button type="submit" variant="contained" fullWidth size="large" disabled={forgotBusy}>
                {forgotBusy ? 'Sending…' : 'Send reset link'}
              </Button>
            </Stack>
          </Box>
        )}
        <Box sx={{ mt: 2.5, pt: 2.5, borderTop: '2px solid', borderColor: 'background.default', textAlign: 'center' }}>
          <Button variant="text" onClick={() => switchView('login')} sx={{ fontWeight: 700, textDecoration: 'underline' }}>
            Back to sign in
          </Button>
        </Box>
      </AuthCard>
    );
  }

  if (view === 'request') {
    return (
      <AuthCard maxWidth={440} elevated>
        <GlobalStyles styles={bodyStyles} />
        <Logo />
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.75, letterSpacing: '-0.01em' }}>
          Request access
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3.5 }}>
          An admin will review your request and email you a link to set your password.
        </Typography>
        {reqMsg && <AuthAlert msg={reqMsg.text} severity={reqMsg.ok ? 'success' : 'error'} />}
        <Box component="form" onSubmit={handleRequest}>
          <Stack spacing={2.5}>
            <TextField
              label="Full name" type="text" fullWidth required
              slotProps={{ htmlInput: { maxLength: 100 } }}
              value={reqName} onChange={e => setReqName(e.target.value)}
            />
            <TextField
              label="Work email" type="email" fullWidth required
              slotProps={{ htmlInput: { maxLength: 254 } }}
              value={reqEmail} onChange={e => setReqEmail(e.target.value)}
            />
            <div id="ts-request" style={{ margin: '4px 0 2px', minHeight: 65 }} />
            <Button type="submit" variant="contained" fullWidth size="large" disabled={reqBusy}>
              {reqBusy ? 'Submitting…' : 'Submit request'}
            </Button>
          </Stack>
        </Box>
        <Box sx={{ mt: 2.5, pt: 2.5, borderTop: '2px solid', borderColor: 'background.default', textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary" component="span">Already approved?{' '}</Typography>
          <Button variant="text" onClick={() => switchView('login')} sx={{ fontWeight: 700, textDecoration: 'underline', p: 0, minWidth: 0, verticalAlign: 'baseline' }}>
            Back to sign in
          </Button>
        </Box>
      </AuthCard>
    );
  }

  return (
    <AuthCard maxWidth={440} elevated>
      <GlobalStyles styles={bodyStyles} />
      <Logo />
      <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.75, letterSpacing: '-0.01em' }}>
        Sign in
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3.5 }}>
        Use your email and password to sign in to your Measure Once account.
      </Typography>
      {loginMsg && <AuthAlert id={loginMsg.ok ? 'login-ok' : 'login-err'} msg={loginMsg.text} severity={loginMsg.ok ? 'success' : 'error'} />}
      <Box component="form" onSubmit={handleLogin} autoComplete="on">
        <Stack spacing={2.5}>
          <TextField
            label="Email address" id="login-email" type="email" fullWidth required
            autoComplete="username" aria-required="true"
            placeholder="your@email.com"
            value={loginEmail} onChange={e => setLoginEmail(e.target.value)}
          />
          <Box>
            <TextField
              label="Password" id="login-password" type="password" fullWidth required
              autoComplete="current-password" aria-required="true"
              value={loginPassword} onChange={e => setLoginPassword(e.target.value)}
            />
            <Button
              variant="text" size="small"
              onClick={() => switchView('forgot')}
              sx={{ mt: 0.5, fontWeight: 600, fontSize: '0.875rem', textDecoration: 'underline', p: 0, minWidth: 0 }}
            >
              Forgot your password?
            </Button>
          </Box>
          <div id="turnstile-login" style={{ margin: '4px 0 2px', minHeight: 65 }} />
          <Button
            id="login-submit" type="submit" variant="contained" fullWidth size="large"
            disabled={loginBusy}
          >
            {loginBusy ? 'Signing in…' : 'Sign in to Measure Once'}
          </Button>
        </Stack>
      </Box>
      <Box sx={{ mt: 2.5, pt: 2.5, borderTop: '2px solid', borderColor: 'background.default', textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary" component="span">Don&apos;t have an account?{' '}</Typography>
        <Button variant="text" onClick={() => switchView('request')} sx={{ fontWeight: 700, textDecoration: 'underline', p: 0, minWidth: 0, verticalAlign: 'baseline' }}>
          Request access
        </Button>
      </Box>
    </AuthCard>
  );
}

export function LoginPage() {
  const [sessionChecked, setSessionChecked] = React.useState(false);

  React.useEffect(() => {
    fetch('/api/auth/user', { credentials: 'same-origin' })
      .then(r => {
        if (r.ok) {
          window.location.replace('/');
        } else {
          setSessionChecked(true);
        }
      })
      .catch(() => setSessionChecked(true));
  }, []);

  if (!sessionChecked) {
    return <LoginPageSkeleton forceVisible />;
  }

  return <LoginPageInner />;
}

export default LoginPage;
