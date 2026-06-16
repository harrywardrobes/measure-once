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

const logger = require('./logger');
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
  photo_review_invite: {
    label: 'Photo Review — Invite',
    description: 'Sent to a customer inviting them to fill in the info form (photo review flow).',
    audience: 'customer',
    variables: ['maskedEmail', 'formLink'],
    variableDescriptions: {
      maskedEmail: "Customer's partially masked email address, e.g. 'j***@example.com'. Shown in the email so they know the link is personalised for them.",
      formLink:    'The unique one-time URL for the customer to open and fill in their info form. Always present.',
    },
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
    audience: 'team',
    variables: ['customerName', 'customerEmail', 'address', 'rooms', 'notes', 'photoSummary', 'correctedMobile'],
    variableDescriptions: {
      customerName:     "Full name of the customer who submitted the form.",
      customerEmail:    "Email address of the customer.",
      address:          "Customer's home address as entered on the form. Empty if not provided.",
      rooms:            "Comma-separated list of rooms the customer selected on the form. Empty if none selected.",
      notes:            "Free-text notes entered by the customer. Empty if they left the field blank.",
      photoSummary:     "A short line describing how many photos were uploaded, e.g. '3 photos uploaded.' Empty if no photos were attached.",
      correctedMobile:  "Mobile number the customer entered on the form (international display format), when it differs from what was on file. Empty when no correction was made.",
    },
    subject: 'New customer info submission – {{customerName}}',
    body_text: [
      'New customer info submission received.',
      '',
      'Customer:     {{customerName}}',
      'Email:        {{customerEmail}}',
      '{{correctedMobile}}',
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
      '  {{correctedMobile}}',
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
    audience: 'customer',
    variables: ['firstName'],
    variableDescriptions: {
      firstName: "Customer's first name. Empty if no first name is recorded.",
    },
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
    audience: 'team',
    variables: ['link'],
    variableDescriptions: {
      link: 'The one-time URL for the recipient to set their password. Valid for 24 hours. Always present.',
    },
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
    audience: 'team',
    variables: ['link'],
    variableDescriptions: {
      link: 'The new one-time URL for the recipient to set their password. Valid for 24 hours. Always present.',
    },
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
    audience: 'team',
    variables: ['link'],
    variableDescriptions: {
      link: 'The one-time URL for the recipient to reset their password. Valid for 1 hour. Always present.',
    },
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
    audience: 'customer',
    variables: ['firstName'],
    variableDescriptions: {
      firstName: "Customer's first name. Empty if no first name is recorded.",
    },
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
    audience: 'customer',
    variables: ['firstName', 'priceRange'],
    variableDescriptions: {
      firstName:  "Customer's first name. Empty if no first name is recorded.",
      priceRange: "Rough price estimate entered by the admin, e.g. '£5,000 – £8,000'. Always present when this email is sent.",
    },
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

  arrange_visit_no_answer: {
    label: 'Arrange visit — no answer',
    description: 'Sent to a customer when we call to book a visit but get no answer, asking for their availability.',
    audience: 'customer',
    variables: ['firstName', 'visitLabel', 'proposedDateLine'],
    variableDescriptions: {
      firstName:        "Customer's first name. Empty if no first name is recorded.",
      visitLabel:       "Type of visit, e.g. 'design visit' or 'survey'.",
      proposedDateLine: "If a date and time were proposed, renders as a sentence like 'We were thinking Friday 13 June at 10:00 AM — let us know if that works for you.\\n\\n' (includes trailing newlines). Empty if no proposed date/time was selected. Include this in your body so proposed times reach the customer.",
    },
    subject: 'Booking your {{visitLabel}} — getting in touch',
    body_text: [
      'Hi {{firstName}},',
      '',
      'Thanks for your interest in booking a {{visitLabel}} with us. I tried to give you a call but wasn\'t able to reach you.',
      '',
      '{{proposedDateLine}}Could you let us know your availability over the next week? If you can share which days and evenings work best for you, we can either call you back at a convenient time or lock in a date for your {{visitLabel}}.',
      '',
      'Just reply to this email and we\'ll get it arranged.',
      '',
      'Best regards',
    ].join('\n'),
    body_html: '',
    footer_text: '',
  },

  open_deal_deposit_invoice_sent: {
    label: 'Open deal — deposit invoice sent',
    description: 'Sent to a customer after their deposit invoice has been issued via QuickBooks.',
    audience: 'customer',
    variables: ['firstName', 'depositPercent'],
    variableDescriptions: {
      firstName:      "Customer's first name. Empty if no first name is recorded.",
      depositPercent: "Deposit percentage as a number, e.g. '10'. Always present when this email is sent.",
    },
    subject: 'Your deposit invoice',
    body_text: [
      'Hi {{firstName}},',
      '',
      "I've sent over the {{depositPercent}}% deposit invoice — please let me know if you haven't received it.",
      '',
      'Once received, we can then book in a survey visit to confirm the final measurements and design choices.',
    ].join('\n'),
    body_html: [
      '<p>Hi {{firstName}},</p>',
      "<p>I've sent over the <strong>{{depositPercent}}% deposit invoice</strong> — please let me know if you haven't received it.</p>",
      '<p>Once received, we can then book in a survey visit to confirm the final measurements and design choices.</p>',
    ].join('\n'),
    footer_text: 'Warm regards,\nThe team',
  },

  open_deal_declined_thank_you: {
    label: 'Open deal — declined thank you',
    description: 'Sent optionally to a customer when a deal is declined.',
    audience: 'customer',
    variables: ['firstName'],
    variableDescriptions: {
      firstName: "Customer's first name. Empty if no first name is recorded.",
    },
    subject: 'Thank you',
    body_text: [
      'Hi {{firstName}},',
      '',
      'Thank you for your time — please feel free to get in touch if you have any questions regarding wardrobes.',
    ].join('\n'),
    body_html: [
      '<p>Hi {{firstName}},</p>',
      '<p>Thank you for your time — please feel free to get in touch if you have any questions regarding wardrobes.</p>',
    ].join('\n'),
    footer_text: 'Warm regards,\nThe team',
  },

  visit_invite: {
    label: 'Visit Invite',
    description: 'Sent to a customer to invite them to propose a time for a design visit.',
    audience: 'customer',
    variables: ['firstName', 'visitLabel', 'visitDuration', 'location', 'proposedDateLine'],
    variableDescriptions: {
      firstName:        "Customer's first name.",
      visitLabel:       "Type of visit, e.g. 'design visit' or 'survey'.",
      visitDuration:    'Expected duration of the visit in minutes.',
      location:         "Location phrase prepended with a space, e.g. ' at 14 Oak Street'. Empty if no address is set.",
      proposedDateLine: "If a date and time were proposed, renders as a sentence like 'We were thinking Friday 13 June at 10:00 AM — let us know if that works for you.\\n\\n' (includes trailing newlines). Empty if no proposed date/time was selected. Include this in your body so proposed times reach the customer.",
    },
    subject: 'Your {{visitLabel}} — getting in touch',
    body_text: [
      'Hi {{firstName}},',
      '',
      "Thank you for your interest in booking a {{visitLabel}} with us.",
      '',
      "We'd love to arrange a time that works for you. The visit usually takes around {{visitDuration}} minutes{{location}}.",
      '',
      '{{proposedDateLine}}Please reply to this email with your availability over the next week — let us know which days and times work best and we\'ll confirm a slot for you.',
      '',
      'Best regards',
    ].join('\n'),
    body_html: '',
    footer_text: 'Warm regards,\nThe Measure Once team',
  },

  deposit_invoice_payment_reminder: {
    label: 'Deposit invoice — payment reminder',
    description: 'Sent to a customer as a payment reminder for their deposit invoice.',
    audience: 'customer',
    variables: ['firstName', 'invoiceDocNum', 'depositAmount', 'balanceAmount', 'invoiceLink'],
    variableDescriptions: {
      firstName:     "Customer's first name. Empty if no first name is recorded.",
      invoiceDocNum: "QuickBooks invoice document number, e.g. '1023'. Empty if not available.",
      depositAmount: "Total amount of the deposit invoice, e.g. '£450.00'. Always present when this email is sent.",
      balanceAmount: "Outstanding balance remaining on the invoice, e.g. '£450.00'. Equal to depositAmount if unpaid.",
      // Note: QB does not expose a shareable estimate URL; invoiceLink is the invoice
      // online-payment link returned by the loader endpoint (Invoice.InvoiceLink field).
      invoiceLink:   "Online payment link for the invoice (if available from QuickBooks). Empty if QB is not connected or the link is not available.",
    },
    subject: 'Reminder: your deposit invoice',
    body_text: [
      'Hi {{firstName}},',
      '',
      'I just wanted to follow up regarding your deposit invoice{{invoiceDocNum}} — we haven\'t received payment yet.',
      '',
      'Outstanding balance: {{balanceAmount}}',
      '{{invoiceLink}}',
      '',
      'If you have any questions or would like to discuss payment, please don\'t hesitate to get in touch.',
    ].join('\n'),
    body_html: [
      '<p>Hi {{firstName}},</p>',
      "<p>I just wanted to follow up regarding your deposit invoice{{invoiceDocNum}} — we haven't received payment yet.</p>",
      '<p><strong>Outstanding balance: {{balanceAmount}}</strong></p>',
      '{{invoiceLink}}',
      '<p>If you have any questions or would like to discuss payment, please don\'t hesitate to get in touch.</p>',
    ].join('\n'),
    footer_text: 'Warm regards,\nThe team',
  },

  visit_confirmation: {
    label: 'Visit Confirmation',
    description: 'Sent to a customer to confirm the details of their upcoming visit.',
    audience: 'customer',
    variables: ['firstName', 'visitLabel', 'visitDate', 'visitTime', 'visitDuration', 'location'],
    variableDescriptions: {
      firstName:    "Customer's first name. Empty if no first name is recorded.",
      visitLabel:   "Type of visit, e.g. 'design visit' or 'survey'.",
      visitDate:    "Confirmed date of the visit as a readable string, e.g. '12 June 2026'. Always present when this email is sent.",
      visitTime:    "Confirmed start time of the visit, e.g. '10:00 AM'. Always present when this email is sent.",
      visitDuration:'Expected duration of the visit in minutes.',
      location:     "Address where the visit will take place. Empty if no address is set on the visit.",
    },
    subject: 'Your {{visitLabel}} is confirmed',
    body_text: [
      'Hi {{firstName}},',
      '',
      "Great news — your {{visitLabel}} is confirmed!",
      '',
      'Here are the details:',
      '',
      '  Date:     {{visitDate}}',
      '  Time:     {{visitTime}}',
      '  Duration: {{visitDuration}} minutes',
      '  Location: {{location}}',
      '',
      'If you need to reschedule or have any questions, please reply to this email.',
      '',
      'We look forward to seeing you.',
    ].join('\n'),
    body_html: '',
    footer_text: 'Warm regards,\nThe Measure Once team',
  },

  survey_refund_request: {
    label: 'Survey refund request (admin)',
    description: 'Sent to admins when a survey deposit refund is requested ("customer changed their mind"), so the refund can be processed manually in QuickBooks.',
    audience: 'team',
    variables: ['customerName', 'contactId', 'customerEmail', 'designVisitRef', 'depositInvoiceRef', 'refundAmount', 'reason', 'requestedBy', 'leadStatusNote', 'dashboardUrl'],
    variableDescriptions: {
      customerName:      'Full name of the customer requesting the refund. Empty if not recorded.',
      contactId:         'HubSpot contact id for the customer.',
      customerEmail:     "Customer's email address. Empty if not recorded.",
      designVisitRef:    'Reference to the originating design visit, e.g. "#42". Empty if none.',
      depositInvoiceRef: 'Reference to the deposit invoice to refund, if known. Empty otherwise.',
      refundAmount:      'Refund amount as a formatted string, e.g. "£450.00", or "(not specified)".',
      reason:            'Free-text reason the customer gave for the refund. "(none)" if blank.',
      requestedBy:       'Email of the staff member who recorded the refund request.',
      leadStatusNote:    'Note about the lead-status change outcome (set to DECLINED_DEAL or skipped).',
      dashboardUrl:      'Link to the customer record in the dashboard.',
    },
    subject: 'Survey refund requested – {{customerName}}',
    body_text: [
      'A survey refund has been requested (customer changed their mind).',
      'Please process the refund in QuickBooks manually.',
      '',
      'Customer:        {{customerName}} ({{contactId}})',
      'Email:           {{customerEmail}}',
      'Design visit:    {{designVisitRef}}',
      'Deposit invoice: {{depositInvoiceRef}}',
      'Refund amount:   {{refundAmount}}',
      '',
      'Reason:',
      '{{reason}}',
      '',
      'Requested by:    {{requestedBy}}',
      '{{leadStatusNote}}',
      '',
      'Dashboard: {{dashboardUrl}}',
    ].join('\n'),
    body_html: [
      '<p><strong>A survey refund has been requested</strong> (customer changed their mind).</p>',
      '<p>Please process the refund in QuickBooks manually.</p>',
      '<table cellpadding="4" cellspacing="0">',
      '  <tr><td><strong>Customer</strong></td><td>{{customerName}} ({{contactId}})</td></tr>',
      '  <tr><td><strong>Email</strong></td><td>{{customerEmail}}</td></tr>',
      '  <tr><td><strong>Design visit</strong></td><td>{{designVisitRef}}</td></tr>',
      '  <tr><td><strong>Deposit invoice</strong></td><td>{{depositInvoiceRef}}</td></tr>',
      '  <tr><td><strong>Refund amount</strong></td><td>{{refundAmount}}</td></tr>',
      '  <tr><td><strong>Requested by</strong></td><td>{{requestedBy}}</td></tr>',
      '</table>',
      '<p><strong>Reason:</strong></p>',
      '<p style="white-space:pre-wrap">{{reason}}</p>',
      '<p style="color:#6b7280;font-size:.85rem;">{{leadStatusNote}}</p>',
      '<p><a href="{{dashboardUrl}}">View in dashboard</a></p>',
    ].join('\n'),
    footer_text: '',
  },
};

const TEMPLATE_KEYS = Object.keys(TEMPLATE_DEFS);

// ── Schema + seed ─────────────────────────────────────────────────────────────
async function ensureEmailTemplatesTable() {
  // Schema created by migrations; this boot step seeds default template rows.
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
    logger.error({ err: err.message }, `[email-templates] Failed to load template "${key}":`);
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

// ── Sample variable values (used for admin preview) ───────────────────────────
// One realistic placeholder value per advertised variable, per template.
// These are only used by the preview endpoint — never sent to real customers.
const SAMPLE_VARS = {
  photo_review_invite: {
    maskedEmail: 'j***@example.com',
    formLink: 'https://example.com/form/abc123',
  },
  admin_notification: {
    customerName:    'Jane Smith',
    customerEmail:   'jane@example.com',
    address:         '123 High Street, London',
    rooms:           'Living room, Kitchen, Bedroom',
    notes:           'Would like light flooring throughout. Allergic to strong adhesives.',
    photoSummary:    '3 photos uploaded.',
    correctedMobile: 'Mobile:       +44 7700 900123',
  },
  customer_thank_you: {
    firstName: 'Jane',
  },
  set_password_welcome: {
    link: 'https://example.com/set-password?token=preview-token',
  },
  set_password_resend: {
    link: 'https://example.com/set-password?token=preview-token',
  },
  set_password_reset: {
    link: 'https://example.com/set-password?token=preview-token',
  },
  photo_review_not_suitable: {
    firstName: 'Jane',
  },
  photo_review_rough_estimate: {
    firstName: 'Jane',
    priceRange: '£5,000 – £8,000',
  },
  arrange_visit_no_answer: {
    firstName: 'Jane',
    visitLabel: 'design visit',
    proposedDate: '',
    proposedTime: '',
    proposedDateLine: '',
  },
  open_deal_deposit_invoice_sent: {
    firstName: 'Jane',
    depositPercent: '10',
  },
  open_deal_declined_thank_you: {
    firstName: 'Jane',
  },
  visit_invite: {
    firstName: 'Jane',
    visitLabel: 'design visit',
    visitDuration: '60',
    location: ' at 14 Oak Street, London',
    proposedDate: '',
    proposedTime: '',
    proposedDateLine: '',
  },
  deposit_invoice_payment_reminder: {
    firstName:     'Jane',
    invoiceDocNum: '#1023',
    depositAmount: '£450.00',
    balanceAmount: '£450.00',
    invoiceLink:   '',
  },
  visit_confirmation: {
    firstName: 'Jane',
    visitLabel: 'design visit',
    visitDate: '12 June 2026',
    visitTime: '10:00 AM',
    visitDuration: '60',
    location: '14 Oak Street, London',
  },
  survey_refund_request: {
    customerName:      'Jane Smith',
    contactId:         '12345',
    customerEmail:     'jane@example.com',
    designVisitRef:    '#42',
    depositInvoiceRef: '#1023',
    refundAmount:      '£450.00',
    reason:            'Customer decided to postpone the project.',
    requestedBy:       'surveyor@measureonce.example',
    leadStatusNote:    'Lead status set to DECLINED_DEAL.',
    dashboardUrl:      'https://example.com/customers/12345',
  },
};

module.exports = {
  pool,
  TEMPLATE_DEFS,
  TEMPLATE_KEYS,
  SAMPLE_VARS,
  ensureEmailTemplatesTable,
  getEmailTemplate,
  invalidateEmailTemplate,
  substituteVars,
  renderEmail,
  escapeHtml,
};
