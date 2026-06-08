// ── Admin-editable email templates ────────────────────────────────────────────
//
// Centralises every outgoing email's subject / body text / body HTML / footer
// into a single DB-backed, admin-editable store. Each send function loads its
// template via getEmailTemplate(key), substitutes {{variable}} placeholders,
// then sends through the existing nodemailer transports. If a DB row is missing
// (e.g. on a fresh upgrade before the seed runs) the hardcoded default in
// TEMPLATE_DEFS is used as a fallback so nothing ever breaks.
//
// Adding a new template: add an entry to TEMPLATE_DEFS (key, advertised
// variables, and seed subject/body_text/body_html/footer_text). The startup
// ensureEmailTemplatesTable() upserts seed rows with ON CONFLICT (key) DO
// NOTHING, so existing edited rows are never overwritten.

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── HTML helpers ──────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Convert a plain-text footer (possibly multi-line) into a single escaped <p>.
function footerTextToHtml(footerText) {
  if (!footerText) return '';
  return `<p>${footerText.split('\n').map(escapeHtml).join('<br>')}</p>`;
}

// ── Template definitions (seed + fallback) ────────────────────────────────────
// `variables` is the advertised list shown to admins in the editor. The seed
// strings are the verbatim current hardcoded content.
const TEMPLATE_DEFS = {
  customer_invite: {
    label: 'Customer invite',
    description: 'Sent to a customer inviting them to fill in the info form.',
    variables: ['maskedEmail', 'formLink'],
    subject: 'Tell us about your home...',
    body_text: [
      'Hi,',
      '',
      "We'd love to know a bit more about your home so we can put together the perfect quote for you.",
      '',
      'This link is just for you ({{maskedEmail}}) — please click it to fill in a short form:',
      '',
      '  {{formLink}}',
      '',
      'It only takes a few minutes and you can upload photos of the spaces you have in mind.',
      '',
      'If you have any questions, just reply to this email.',
    ].join('\n'),
    body_html: [
      '<p>Hi,</p>',
      "<p>We'd love to know a bit more about your home so we can put together the perfect quote for you.</p>",
      '<p>This link is just for you ({{maskedEmail}}) — please click the button below to fill in a short form:</p>',
      '<p style="margin:24px 0;">',
      '  <a href="{{formLink}}"',
      '     style="display:inline-block;padding:12px 24px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">',
      '    Tell us about your home',
      '  </a>',
      '</p>',
      '<p>It only takes a few minutes and you can upload photos of the spaces you have in mind.</p>',
      '<p>If you have any questions, just reply to this email.</p>',
    ].join('\n'),
    footer_text: 'Warm regards,\nThe Measure Once team',
  },

  admin_notification: {
    label: 'Admin notification',
    description: 'Sent to admins when a customer submits their info form.',
    variables: ['customerName', 'customerEmail', 'address', 'rooms', 'notes', 'photoSummary'],
    subject: 'New customer info submission – {{customerName}}',
    body_text: [
      'New customer info submission received.',
      '',
      'Customer:     {{customerName}}',
      'Email:        {{customerEmail}}',
      '',
      'Address:      {{address}}',
      'Rooms:        {{rooms}}',
      '',
      'Notes:',
      '{{notes}}',
      '',
      '{{photoSummary}}',
    ].join('\n'),
    body_html: [
      '<p><strong>New customer info submission received.</strong></p>',
      '<table cellpadding="4" cellspacing="0">',
      '  <tr><td><strong>Customer</strong></td><td>{{customerName}}</td></tr>',
      '  <tr><td><strong>Email</strong></td><td>{{customerEmail}}</td></tr>',
      '  <tr><td><strong>Address</strong></td><td>{{address}}</td></tr>',
      '  <tr><td><strong>Rooms</strong></td><td>{{rooms}}</td></tr>',
      '</table>',
      '<p><strong>Notes:</strong></p>',
      '<p style="white-space:pre-wrap">{{notes}}</p>',
      '{{photoSummary}}',
    ].join('\n'),
    footer_text: '',
  },

  customer_thank_you: {
    label: 'Customer thank-you',
    description: 'Sent to a customer after they submit their info form.',
    variables: ['firstName'],
    subject: 'Thanks for sharing!',
    body_text: [
      'Hi {{firstName}},',
      '',
      'Thank you for the extra info about your home, we will be in touch shortly.',
    ].join('\n'),
    body_html: [
      '<p>Hi {{firstName}},</p>',
      '<p>Thank you for the extra info about your home, we will be in touch shortly.</p>',
    ].join('\n'),
    footer_text: 'Warm regards,\nThe Measure Once team',
  },

  set_password_welcome: {
    label: 'Set password — welcome',
    description: 'Sent to a newly approved user with their first set-password link.',
    variables: ['link'],
    subject: 'Welcome to Measure Once — set your password',
    body_text: [
      "You've been granted access to Measure Once.",
      '',
      'Set your password by clicking the link below (valid for 24 hours):',
      '  {{link}}',
    ].join('\n'),
    body_html: [
      "<p>You've been granted access to <strong>Measure Once</strong>.</p>",
      '<p>Set your password by clicking the link below (valid for 24 hours):</p>',
      '<p><a href="{{link}}">{{link}}</a></p>',
    ].join('\n'),
    footer_text: "If you didn't request this, you can safely ignore this email.",
  },

  set_password_resend: {
    label: 'Set password — resend',
    description: 'Sent when a new set-password link is re-issued for a user.',
    variables: ['link'],
    subject: 'Set your Measure Once password (new link)',
    body_text: [
      'A new password setup link has been issued for your Measure Once account.',
      '',
      'Set your password by clicking the link below (valid for 24 hours):',
      '  {{link}}',
    ].join('\n'),
    body_html: [
      '<p>A new password setup link has been issued for your Measure Once account.</p>',
      '<p>Set your password by clicking the link below (valid for 24 hours):</p>',
      '<p><a href="{{link}}">{{link}}</a></p>',
    ].join('\n'),
    footer_text: "If you didn't request this, you can safely ignore this email.",
  },

  set_password_reset: {
    label: 'Set password — reset',
    description: 'Sent when a user requests a password reset.',
    variables: ['link'],
    subject: 'Reset your Measure Once password',
    body_text: [
      'A password reset was requested for your Measure Once account.',
      '',
      'Reset your password by clicking the link below (valid for 1 hour):',
      '  {{link}}',
    ].join('\n'),
    body_html: [
      '<p>A password reset was requested for your <strong>Measure Once</strong> account.</p>',
      '<p>Reset your password by clicking the link below (valid for 1 hour):</p>',
      '<p><a href="{{link}}">{{link}}</a></p>',
    ].join('\n'),
    footer_text: "If you didn't request this, you can safely ignore this email.",
  },

  photo_review_not_suitable: {
    label: 'Photo review — not suitable',
    description: 'Sent to a customer when their enquiry is reviewed as not suitable.',
    variables: ['firstName'],
    subject: 'Regarding your enquiry',
    body_text: [
      'Hi {{firstName}},',
      '',
      'Thank you so much for getting in touch with us and sharing details about your home.',
      '',
      "Unfortunately, after reviewing your enquiry, we don't think this is a project we'd be able to help with at this time.",
      '',
      "We're sorry we can't be of more help on this occasion, and we wish you all the best in finding the right team for your project.",
    ].join('\n'),
    body_html: '',
    footer_text: 'Warm regards,\nThe team',
  },

  photo_review_rough_estimate: {
    label: 'Photo review — rough estimate',
    description: 'Sent to a customer with a rough estimate after a photo review.',
    variables: ['firstName', 'priceRange'],
    subject: 'Your rough estimate',
    body_text: [
      'Hi {{firstName}},',
      '',
      'Thank you for sharing details about your home — we really appreciate it.',
      '',
      "Based on the information you've provided, our rough estimate for the work is:",
      '',
      '  {{priceRange}}',
      '',
      'Please note that this is a rough guide only and is subject to change once we have had a chance to see your space in person.',
      '',
      'One of our team will be in touch shortly to arrange a design visit, where we can discuss your project in detail, take accurate measurements, and give you a precise quote.',
      '',
      "We're looking forward to helping you create your dream space!",
    ].join('\n'),
    body_html: '',
    footer_text: 'Warm regards,\nThe team',
  },
};

const TEMPLATE_KEYS = Object.keys(TEMPLATE_DEFS);

// ── Schema + seed ─────────────────────────────────────────────────────────────
async function ensureEmailTemplatesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_templates (
      id          SERIAL PRIMARY KEY,
      key         TEXT UNIQUE NOT NULL,
      subject     TEXT NOT NULL DEFAULT '',
      body_text   TEXT NOT NULL DEFAULT '',
      body_html   TEXT NOT NULL DEFAULT '',
      footer_text TEXT NOT NULL DEFAULT '',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by  TEXT
    )
  `);
  for (const [key, def] of Object.entries(TEMPLATE_DEFS)) {
    await pool.query(
      `INSERT INTO email_templates (key, subject, body_text, body_html, footer_text)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (key) DO NOTHING`,
      [key, def.subject, def.body_text, def.body_html, def.footer_text]
    );
  }
}

// ── In-memory cache (TTL + explicit invalidation on PATCH) ────────────────────
const CACHE_TTL_MS = 60 * 1000;
const _cache = new Map(); // key -> { value, expires }

function _fallback(key) {
  const def = TEMPLATE_DEFS[key];
  if (!def) return null;
  return {
    subject:     def.subject,
    body_text:   def.body_text,
    body_html:   def.body_html,
    footer_text: def.footer_text,
  };
}

// Load a template by key. Returns { subject, body_text, body_html, footer_text }.
// Falls back to the hardcoded default if the DB row is missing or unreadable.
async function getEmailTemplate(key) {
  const now = Date.now();
  const cached = _cache.get(key);
  if (cached && cached.expires > now) return cached.value;

  let row = null;
  try {
    const r = await pool.query(
      `SELECT subject, body_text, body_html, footer_text FROM email_templates WHERE key = $1 LIMIT 1`,
      [key]
    );
    row = r.rows[0] || null;
  } catch (err) {
    console.error(`[email-templates] Failed to load template "${key}":`, err.message);
  }

  const value = row || _fallback(key);
  if (value) _cache.set(key, { value, expires: now + CACHE_TTL_MS });
  return value;
}

function invalidateEmailTemplate(key) {
  if (key) _cache.delete(key);
  else _cache.clear();
}

// ── Variable substitution + rendering ─────────────────────────────────────────
// Replaces {{name}} tokens with values from `vars`. Unknown tokens are left
// intact so a typo in a template never silently blanks content.
function substituteVars(str, vars) {
  if (str == null) return '';
  return String(str).replace(/\{\{(\w+)\}\}/g, (match, name) =>
    vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] ?? '') : match
  );
}

// Render a loaded template into { subject, text, html }.
//   textVars — raw values substituted into subject / body_text / footer_text.
//   htmlVars — values substituted into body_html. Callers must pre-escape any
//              user-controlled values here (already-HTML values like a rendered
//              photo summary are passed raw). The footer is always escaped.
function renderEmail(template, { textVars = {}, htmlVars = {} } = {}) {
  const t = template || {};
  const subject = substituteVars(t.subject || '', textVars);

  let text = substituteVars(t.body_text || '', textVars);
  const footerText = substituteVars(t.footer_text || '', textVars);
  if (footerText) text += '\n\n' + footerText;

  let html = substituteVars(t.body_html || '', htmlVars);
  if (footerText) html += (html ? '\n' : '') + footerTextToHtml(footerText);

  return { subject, text, html };
}

module.exports = {
  pool,
  TEMPLATE_DEFS,
  TEMPLATE_KEYS,
  ensureEmailTemplatesTable,
  getEmailTemplate,
  invalidateEmailTemplate,
  substituteVars,
  renderEmail,
  escapeHtml,
};
