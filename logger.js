'use strict';
// logger.js
//
// Shared structured logger (Pino) for all server-side modules. Replaces ad-hoc
// console.* calls in the critical server paths so log output is structured and
// level-filterable.
//
// - Production (NODE_ENV=production): one JSON object per line on stdout, ready
//   for log aggregation in the deployment console.
// - Development / tests: human-readable, colourised output via pino-pretty so
//   the Replit workflow console stays easy to scan. A synchronous pretty stream
//   is used (not a worker-thread transport) to avoid delaying process exit in
//   short-lived test scripts.
//
// Level can be overridden with LOG_LEVEL (e.g. LOG_LEVEL=warn). No external
// error-monitoring service (e.g. Sentry) is wired up — that is intentionally
// out of scope for this phase.

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';
const level = process.env.LOG_LEVEL || (isProd ? 'info' : 'debug');

const REDACT_PATHS = [
  'password', 'password_hash', 'token', 'access_token', 'refresh_token',
  'client_secret', 'tokenHash', 'rawToken',
];

let logger;
if (isProd) {
  logger = pino({ level, redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } });
} else {
  const pretty = require('pino-pretty');
  logger = pino(
    { level },
    pretty({
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
    }),
  );
}

module.exports = logger;
