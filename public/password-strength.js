(function (global) {
  'use strict';

  const MIN_SCORE = 2;
  const MAX_LENGTH = 200;
  const STRENGTH_LABELS = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];

  const STYLE_ID = 'password-strength-styles';
  const STYLE_CSS = `
    .pw-meter { margin-top: 8px; }
    .pw-meter-bar { height: 6px; background: #e7e5e0; border-radius: 999px; overflow: hidden; }
    .pw-meter-fill { height: 100%; width: 0%; background: #e7e5e0; border-radius: 999px;
                     transition: width .15s ease, background .15s ease; }
    .pw-meter-label { display: flex; justify-content: space-between; font-size: .78rem;
                      margin-top: 6px; color: #57534e; }
    .pw-meter-label strong { color: #141413; font-weight: 600; }
    .pw-meter-feedback { font-size: .76rem; color: #a16207; margin-top: 4px; min-height: 1em; }
    .pw-s-0 { background: #dc2626; } .pw-t-0 { color: #dc2626; }
    .pw-s-1 { background: #ea580c; } .pw-t-1 { color: #ea580c; }
    .pw-s-2 { background: #ca8a04; } .pw-t-2 { color: #ca8a04; }
    .pw-s-3 { background: #16a34a; } .pw-t-3 { color: #16a34a; }
    .pw-s-4 { background: #15803d; } .pw-t-4 { color: #15803d; }
  `;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = STYLE_CSS;
    document.head.appendChild(s);
  }

  function renderMeter(container) {
    container.innerHTML = `
      <div class="pw-meter" aria-live="polite" hidden>
        <div class="pw-meter-bar"><div class="pw-meter-fill"></div></div>
        <div class="pw-meter-label">
          <span>Strength: <strong class="pw-meter-text">—</strong></span>
          <span class="pw-meter-crack"></span>
        </div>
        <div class="pw-meter-feedback"></div>
      </div>
    `;
    return {
      meter:    container.querySelector('.pw-meter'),
      fill:     container.querySelector('.pw-meter-fill'),
      text:     container.querySelector('.pw-meter-text'),
      crack:    container.querySelector('.pw-meter-crack'),
      feedback: container.querySelector('.pw-meter-feedback'),
    };
  }

  function scorePassword(pw, userInputs) {
    if (typeof global.zxcvbn === 'function') {
      const r = global.zxcvbn(pw.slice(0, MAX_LENGTH), userInputs || []);
      return {
        score: r.score,
        feedback: r.feedback || {},
        crackDisplay: (r.crack_times_display &&
          r.crack_times_display.offline_slow_hashing_1e4_per_second) || '',
      };
    }
    // Fallback when CDN is unreachable: rough heuristic by length + charset variety.
    const variety = (/[a-z]/.test(pw) + /[A-Z]/.test(pw) +
                     /[0-9]/.test(pw) + /[^A-Za-z0-9]/.test(pw));
    const score = Math.max(0, Math.min(4, Math.floor(pw.length / 4) + variety - 2));
    return { score, feedback: {}, crackDisplay: '' };
  }

  // Returns null if the password meets the policy; otherwise an error message.
  // Mirrors the server-side validatePasswordPolicy in auth.js.
  function checkPasswordPolicy(pw, userInputs) {
    if (typeof pw !== 'string' || pw.length === 0) return 'Password is required.';
    if (pw.length < 8) return 'Password must be at least 8 characters.';
    if (pw.length > MAX_LENGTH) return 'Password is too long.';
    if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) {
      return 'Password must contain both letters and numbers.';
    }
    if (typeof global.zxcvbn === 'function') {
      const r = global.zxcvbn(pw.slice(0, MAX_LENGTH), userInputs || []);
      if (r.score < MIN_SCORE) {
        const warning = r.feedback && r.feedback.warning;
        return warning
          ? 'Password is too easy to guess: ' + warning
          : 'Password is too easy to guess — please choose something less common.';
      }
    }
    return null;
  }

  // Mounts a live strength meter into `container`, driven by typing into `input`.
  //   input          — <input type="password">
  //   container      — element that will hold the meter markup
  //   getUserInputs  — () => string[] of context tokens (email, name, etc.)
  function mountStrengthMeter(input, container, getUserInputs) {
    ensureStyles();
    const els = renderMeter(container);
    const update = () => {
      const pw = input.value;
      if (!pw) { els.meter.hidden = true; return; }
      els.meter.hidden = false;
      const inputs = (typeof getUserInputs === 'function' ? getUserInputs() : [])
        .filter(v => typeof v === 'string' && v.length > 0);
      const { score, feedback, crackDisplay } = scorePassword(pw, inputs);
      els.fill.className = 'pw-meter-fill pw-s-' + score;
      els.fill.style.width = (((score + 1) / 5) * 100) + '%';
      els.text.className = 'pw-meter-text pw-t-' + score;
      els.text.textContent = STRENGTH_LABELS[score];
      els.crack.textContent = crackDisplay ? 'Crack time: ' + crackDisplay : '';
      els.feedback.textContent = (score < MIN_SCORE)
        ? (feedback.warning || 'Too easy to guess — try a longer or less common password.')
        : (feedback.suggestions && feedback.suggestions[0]) || '';
    };
    input.addEventListener('input', update);
    return { update };
  }

  global.PasswordStrength = {
    MIN_SCORE,
    MAX_LENGTH,
    STRENGTH_LABELS,
    checkPasswordPolicy,
    mountStrengthMeter,
  };
})(window);
