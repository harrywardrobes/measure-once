// Shared mail transport factory used by auth.js, customer-info.js, and design-visits.js.
//
// Transport selection order:
//   1. MAIL_TRANSPORT_THROW_OVERRIDE  — test only: always rejects (simulates send failure)
//   2. MAIL_TRANSPORT_FILE_OVERRIDE   — test only: appends JSON to a file instead of sending
//   3. LOG_EMAILS_TO_CONSOLE=true     — dev only: prints to/subject/body to the console
//   4. SMTP_HOST/USER/PASS present    — real nodemailer transport
//   5. (none of the above)            — returns null; callers log a "skipped" warning
//
// The console transport (#3) is unconditionally disabled in production
// (NODE_ENV=production) regardless of the env var value, so it cannot
// accidentally leak email content if the var were ever mis-set on a server.

const fs = require('fs');
const nodemailer = require('nodemailer');

function appBaseUrl() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT || 5000}`;
}

function buildFromHeader() {
  const raw = (process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
  if (!raw) return raw;
  if (/</.test(raw)) return raw;
  return `Harry Wardrobes <${raw}>`;
}

function buildReplyTo() {
  return (process.env.SMTP_REPLY_TO || process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
}

function createMailTransport() {
  if (process.env.MAIL_TRANSPORT_THROW_OVERRIDE) {
    return {
      sendMail() {
        return Promise.reject(new Error('MAIL_TRANSPORT_THROW_OVERRIDE: simulated send failure'));
      },
    };
  }

  if (process.env.MAIL_TRANSPORT_FILE_OVERRIDE) {
    const fpath = process.env.MAIL_TRANSPORT_FILE_OVERRIDE;
    return {
      sendMail(opts) {
        return new Promise((resolve, reject) => {
          try {
            fs.appendFileSync(fpath, JSON.stringify(opts) + '\n');
            resolve({ messageId: `override-${Date.now()}` });
          } catch (e) { reject(e); }
        });
      },
    };
  }

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    if (process.env.LOG_EMAILS_TO_CONSOLE === 'true' && process.env.NODE_ENV !== 'production') {
      const logger = require('./logger');
      return {
        sendMail(opts) {
          const border = '─'.repeat(60);
          logger.warn(
            `\n${border}\nDEV EMAIL (not sent)\nTo:      ${opts.to}\nSubject: ${opts.subject}\n\n${opts.text || '(no text body)'}\n${border}`
          );
          return Promise.resolve({ messageId: 'dev-console' });
        },
      };
    }
    return null;
  }

  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587', 10),
    secure: parseInt(process.env.SMTP_PORT || '587', 10) === 465,
    auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

module.exports = { createMailTransport, appBaseUrl, buildFromHeader, buildReplyTo };
