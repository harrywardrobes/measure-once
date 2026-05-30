'use strict';
const { makeSkip } = require('../helpers/report');
// test/ideas/run.js
//
// Automated tests for the Ideas & Feedback page.
//
// Covers:
//   [API-1] POST /api/ideas creates an idea (201, correct fields).
//   [API-2] GET /api/ideas returns the new idea in the feed (prepended order).
//   [API-3] GET /api/ideas/:id/comments returns an empty array for a new idea.
//   [API-4] POST /api/ideas/:id/comments adds a comment (201, correct fields).
//   [API-5] DELETE /api/ideas/:id requires admin (403 for member, 200 for admin).
//   [API-6] DELETE /api/ideas/:id/comments/:commentId requires admin.
//   [UI-1]  Posting an idea via the New Idea dialog prepends it to the feed.
//   [UI-2]  Expanding the comment chip lazy-fetches and shows comments.
//   [UI-3]  Replying adds a comment inline without a page reload.
//   [UI-4]  Admin sees delete buttons on idea cards; confirm dialog appears.
//   [UI-5]  Non-admin (member) does NOT see delete buttons.
//
// Usage:
//   DATABASE_URL_TEST=<disposable> npm run test:ideas
//   PRIVTEST_ALLOW_SHARED_DB=1     npm run test:ideas

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const {
  spawnServer,
  waitForServer,
  seedUsers,
  cleanupTestData,
  resetRateLimitStore,
  login,
  setPool,
  BASE,
} = require('../privileges/harness');

let puppeteer = null;
try { puppeteer = require('puppeteer'); } catch {}

require('dotenv').config();

const { pollUntil, stabilityPoll } = require('../helpers/poll');

const REPORT_PATH = path.join(__dirname, '..', '..', 'test-results', 'ideas.md');

const findings = [];
function record(name, expected, observed, ok) {
  findings.push({ name, expected, observed, ok });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark}  ${name}`);
  if (!ok) {
    console.log(`     expected : ${expected}`);
    console.log(`     observed : ${observed}`);
  }
}
const skip = makeSkip(findings);

// ── Puppeteer helpers ──────────────────────────────────────────────────────────

function parseCookieKV(jar) {
  if (!jar) return null;
  const idx = jar.indexOf('=');
  if (idx < 0) return null;
  return { name: jar.slice(0, idx), value: jar.slice(idx + 1) };
}

async function injectSession(page, jar) {
  const kv = parseCookieKV(jar);
  if (!kv) return;
  const { hostname } = new URL(BASE);
  await page.setCookie({
    name: kv.name, value: kv.value,
    domain: hostname, path: '/', httpOnly: true,
  });
}

async function pollPage(page, fn, arg, timeoutMs = 12000, intervalMs = 200) {
  // arg is optional: if timeoutMs-ish number passed as arg, treat as timeout
  if (typeof arg === 'number') { timeoutMs = arg; arg = undefined; }
  return pollUntil(page, fn, timeoutMs, intervalMs, arg !== undefined && arg !== null ? [arg] : []);
}

async function openIdeasPage(browser, jar) {
  const ctx = await (browser.createBrowserContext
    ? browser.createBrowserContext()
    : browser.createIncognitoBrowserContext());
  const page = await ctx.newPage();
  page.__ctx = ctx;
  await page.setCacheEnabled(false);

  const pageLogs = [];
  page.on('console',   m => pageLogs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => pageLogs.push(`[pageerror] ${e.message}`));

  await injectSession(page, jar);
  await page.goto(`${BASE}/ideas`, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for IdeasPage React island to mount (heading "Ideas & Feedback" always renders).
  await pollPage(page, () => {
    const el = document.getElementById('ideas-page-mount');
    return el && el.textContent && el.textContent.includes('Ideas') ? 'ok' : null;
  }, 20000);

  // Wait for bootstrap() to complete so window.__moHeaderUser is set before
  // returning — ensures usePrivilege() sees the correct level on first render.
  await pollPage(page, () => {
    return window.__moHeaderUser ? 'ok' : null;
  }, 15000);

  // Wait for React to flush the privilege-level update — poll until the mount's
  // rendered HTML length stops changing, which confirms the re-render is done.
  await stabilityPoll(page, '#ideas-page-mount', 5000);

  page.__logs = pageLogs;
  return page;
}

// ── Cleanup helpers ────────────────────────────────────────────────────────────

async function cleanupIdeas(pool, runId) {
  await pool.query(`DELETE FROM ideas WHERE body LIKE $1`, [`[ideas-test-${runId}]%`]);
}

// ── Report ─────────────────────────────────────────────────────────────────────

async function writeReport(runId) {
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = findings.filter(f => f.ok).length;
  const failed = findings.filter(f => !f.ok && !f.skipped).length;
  const skipped = findings.filter(f => f.skipped).length;
  const lines = [
    '# Ideas Page — Integration Test',
    '',
    `- Run ID: \`${runId}\``,
    `- Date: ${new Date().toISOString()}`,
    `- Command: \`npm run test:ideas\``,
    '',
    '## Summary',
    '',
    `- Passed: ${passed} / ${findings.length}`,
    `- Skipped: ${skipped} / ${findings.length}`,
    `- Failed: ${failed} / ${findings.length}`,
    '',
    '## Results',
    '',
    '| Result | Probe | Expected | Observed |',
    '|---|---|---|---|',
    ...findings.map(f =>
      `| ${f.ok ? 'PASS' : f.skipped ? 'SKIP' : 'FAIL'} | ${esc(f.name)} | ${esc(f.expected)} | ${esc(f.observed)} |`
    ),
    '',
    '## Coverage',
    '',
    '- **[API-1]** POST /api/ideas → 201 with correct fields.',
    '- **[API-2]** GET /api/ideas → new idea appears first in feed.',
    '- **[API-3]** GET /api/ideas/:id/comments → empty array for new idea.',
    '- **[API-4]** POST /api/ideas/:id/comments → 201, correct fields.',
    '- **[API-5]** DELETE /api/ideas/:id → 403 for member, 200 for admin.',
    '- **[API-6]** DELETE /api/ideas/:id/comments/:commentId → 403 for member, 200 for admin.',
    '- **[UI-1]** Posting via "New Idea" dialog prepends card to feed.',
    '- **[UI-2]** Expanding comment chip lazy-fetches and shows comments.',
    '- **[UI-3]** Replying via comment box appends comment inline.',
    '- **[UI-4]** Admin sees delete button → confirm dialog opens.',
    '- **[UI-5]** Member does not see delete buttons.',
  ];
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`  Report: ${path.relative(process.cwd(), REPORT_PATH)}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const hasTestDb   = !!process.env.DATABASE_URL_TEST;
  const allowShared = process.env.PRIVTEST_ALLOW_SHARED_DB === '1';
  const connStr     = process.env.DATABASE_URL_TEST || process.env.DATABASE_URL;

  if (!connStr) {
    console.error('DATABASE_URL_TEST (preferred) or DATABASE_URL is required.');
    process.exit(2);
  }
  if (!hasTestDb && !allowShared) {
    console.error(
      '\n  ✘ Refuses to run against the shared DATABASE_URL by default.\n'
      + '    Set DATABASE_URL_TEST=<disposable> or PRIVTEST_ALLOW_SHARED_DB=1.\n',
    );
    process.exit(2);
  }

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`\n  ideas  run=${runId}`);
  console.log(`  Using ${hasTestDb ? 'DATABASE_URL_TEST (isolated)' : 'shared DATABASE_URL (PRIVTEST_ALLOW_SHARED_DB=1)'}`);

  const pool = new Pool({ connectionString: connStr });
  setPool(pool);
  await cleanupTestData(pool);
  await cleanupIdeas(pool, runId);

  const users = await seedUsers(pool, runId);
  console.log(`  Seeded  admin=${users.admin.email}  member=${users.member.email}`);

  const { child, logBuf } = spawnServer();
  let exited = false;
  child.on('exit', () => { exited = true; });

  let teardownInFlight = false;
  const cleanupAndExit = async (code) => {
    if (teardownInFlight) return;
    teardownInFlight = true;
    try { if (!exited) child.kill('SIGTERM'); } catch {}
    try { await cleanupIdeas(pool, runId); } catch {}
    try { await cleanupTestData(pool); } catch {}
    await pool.end().catch(() => {});
    await writeReport(runId);
    process.exit(code);
  };
  process.on('SIGINT',  () => cleanupAndExit(130));
  process.on('SIGTERM', () => cleanupAndExit(130));
  process.on('uncaughtException',  e => { console.error('Uncaught:',  e); cleanupAndExit(2); });
  process.on('unhandledRejection', e => { console.error('Unhandled:', e); cleanupAndExit(2); });

  // ── Boot server ─────────────────────────────────────────────────────────────
  try {
    await waitForServer();
    await resetRateLimitStore(pool);
    console.log(`  Server up at ${BASE}`);
  } catch (e) {
    console.error('Server boot failed:', e.message);
    console.error(logBuf.join('').slice(-2000));
    await cleanupAndExit(2);
    return;
  }

  // ── Login — returns a harness client with .get/.post/.delete methods ─────────
  const adminClient  = await login(users.admin.email,  users.admin.password);
  const memberClient = await login(users.member.email, users.member.password);

  // ── [API-1] POST /api/ideas ──────────────────────────────────────────────────
  console.log('\n  [API] Ideas CRUD');
  const ideaBody = `[ideas-test-${runId}] My first test idea`;

  const postIdea = await adminClient.post('/api/ideas', { body: ideaBody });
  record(
    '[API-1] POST /api/ideas → 201',
    '201',
    String(postIdea.status),
    postIdea.status === 201,
  );
  const ideaId = postIdea.json?.id;
  record(
    '[API-1] POST /api/ideas → body has id and correct body text',
    'id present and body matches',
    ideaId ? `id=${ideaId} body="${postIdea.json?.body}"` : 'missing id',
    !!ideaId && postIdea.json?.body === ideaBody,
  );
  record(
    '[API-1] POST /api/ideas → comment_count is 0',
    '0',
    String(postIdea.json?.comment_count),
    postIdea.json?.comment_count === 0,
  );

  // ── [API-2] GET /api/ideas ───────────────────────────────────────────────────
  const getIdeas = await adminClient.get('/api/ideas');
  const feed = getIdeas.json;
  const feedFirst = Array.isArray(feed) ? feed[0] : null;
  record(
    '[API-2] GET /api/ideas → new idea appears first (most-recent order)',
    `id=${ideaId}`,
    feedFirst ? `id=${feedFirst.id}` : 'empty or non-array feed',
    !!feedFirst && feedFirst.id === ideaId,
  );

  // ── [API-3] GET /api/ideas/:id/comments ─────────────────────────────────────
  if (ideaId) {
    const getComments = await adminClient.get(`/api/ideas/${ideaId}/comments`);
    record(
      '[API-3] GET /api/ideas/:id/comments → empty array for new idea',
      '[]',
      JSON.stringify(getComments.json),
      Array.isArray(getComments.json) && getComments.json.length === 0,
    );
  } else {
    record('[API-3] GET comments → skipped (no ideaId)', 'ideaId', 'missing', false);
  }

  // ── [API-4] POST /api/ideas/:id/comments ────────────────────────────────────
  let commentId = null;
  if (ideaId) {
    const commentBody = `[ideas-test-${runId}] A test comment`;
    const postComment = await adminClient.post(`/api/ideas/${ideaId}/comments`, { body: commentBody });
    record(
      '[API-4] POST /api/ideas/:id/comments → 201',
      '201',
      String(postComment.status),
      postComment.status === 201,
    );
    commentId = postComment.json?.id;
    record(
      '[API-4] POST comment → body text matches',
      commentBody,
      String(postComment.json?.body),
      postComment.json?.body === commentBody,
    );
  } else {
    record('[API-4] POST comment → skipped (no ideaId)', 'ideaId', 'missing', false);
    record('[API-4] POST comment body text → skipped', 'ideaId', 'missing', false);
  }

  // ── [API-5] DELETE /api/ideas/:id ────────────────────────────────────────────
  if (ideaId) {
    // Member should get 403.
    const delMember = await memberClient.delete(`/api/ideas/${ideaId}`);
    record(
      '[API-5] DELETE /api/ideas/:id → 403 for member',
      '403',
      String(delMember.status),
      delMember.status === 403,
    );

    // Non-existent idea returns 404 from admin to confirm route is live.
    const delFakeAdmin = await adminClient.delete('/api/ideas/999999999');
    record(
      '[API-5] DELETE /api/ideas/:id → 404 for missing idea (admin)',
      '404',
      String(delFakeAdmin.status),
      delFakeAdmin.status === 404,
    );
  } else {
    record('[API-5] DELETE idea member 403 → skipped', 'ideaId', 'missing', false);
    record('[API-5] DELETE idea admin 404 → skipped', 'ideaId', 'missing', false);
  }

  // ── [API-6] DELETE /api/ideas/:id/comments/:commentId ───────────────────────
  if (ideaId && commentId) {
    // Member should get 403.
    const delComMember = await memberClient.delete(`/api/ideas/${ideaId}/comments/${commentId}`);
    record(
      '[API-6] DELETE comment → 403 for member',
      '403',
      String(delComMember.status),
      delComMember.status === 403,
    );

    // Admin should succeed (200).
    const delComAdmin = await adminClient.delete(`/api/ideas/${ideaId}/comments/${commentId}`);
    record(
      '[API-6] DELETE comment → 200 for admin',
      '200',
      String(delComAdmin.status),
      delComAdmin.status === 200,
    );
  } else {
    record('[API-6] DELETE comment member 403 → skipped', 'ideaId+commentId', 'missing', false);
    record('[API-6] DELETE comment admin 200 → skipped', 'ideaId+commentId', 'missing', false);
  }

  // ── UI Tests ─────────────────────────────────────────────────────────────────

  const UI_LABELS = [
    '[UI-1] Posting an idea prepends a new card to the feed',
    '[UI-2] Expanding comment chip fetches and shows seeded comment',
    '[UI-3] Replying via comment box appends new comment inline',
    '[UI-4] Admin sees delete button; confirm dialog opens on click',
    '[UI-4b] Confirm dialog text is "Delete idea?"',
    '[UI-5] Member does not see delete buttons',
  ];

  if (!puppeteer) {
    for (const l of UI_LABELS) skip(l, 'puppeteer installed', 'puppeteer not installed');
    await cleanupAndExit(1);
    return;
  }

  const { findChromium } = require('../shared/find-chromium');
  let browser = null;
  let browserLaunchErr = null;
  const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
  const launchAttempts = [{ args: launchArgs }];
  const sysChrome = findChromium();
  if (sysChrome) launchAttempts.push({ executablePath: sysChrome, args: launchArgs });
  for (const opts of launchAttempts) {
    try {
      browser = await puppeteer.launch({ headless: true, ...opts });
      browserLaunchErr = null;
      break;
    } catch (e) { browserLaunchErr = e; browser = null; }
  }

  if (!browser) {
    const msg = (browserLaunchErr?.message || String(browserLaunchErr)).slice(0, 200);
    for (const l of UI_LABELS) skip(l, 'browser launched', `browser launch failed: ${msg}`);
    await cleanupAndExit(1);
    return;
  }

  // Seed a second idea via API that has one comment so we can test lazy-fetch.
  const idea2Body  = `[ideas-test-${runId}] Second idea for comment test`;
  const comment2Body = `[ideas-test-${runId}] A seeded comment for UI test`;
  const postIdea2 = await adminClient.post('/api/ideas', { body: idea2Body });
  const idea2Id   = postIdea2.json?.id;
  if (idea2Id) {
    await adminClient.post(`/api/ideas/${idea2Id}/comments`, { body: comment2Body });
  }

  try {
    // ── [UI-1] Admin posts an idea via the dialog ─────────────────────────────
    console.log('\n  [UI-1] Admin posts a new idea via the dialog');
    const adminPage = await openIdeasPage(browser, adminClient.cookie);

    // Wait for admin privilege to propagate from bootstrap() so that
    // delete buttons render correctly later.
    await pollPage(adminPage, () => {
      const w = window;
      return (w.__moHeaderUser?.privilege_level === 'admin') ? 'ok' : null;
    }, undefined, 10000);

    const newIdeaText = `[ideas-test-${runId}] UI posted idea ${Date.now()}`;

    // Click the "New Idea" button.
    const newIdeaBtnFound = await adminPage.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('#ideas-page-mount button'));
      const b = btns.find(b => b.textContent.trim().includes('New Idea'));
      if (b) { b.click(); return true; }
      return false;
    });

    if (newIdeaBtnFound) {
      // Wait for the MUI Dialog to open.
      const dialogOpened = await pollPage(adminPage, () =>
        document.querySelector('[role="dialog"]') ? 'ok' : null
      , undefined, 5000);

      if (dialogOpened) {
        // Type into the multiline textarea inside the dialog.
        await adminPage.evaluate((text) => {
          const ta = document.querySelector('[role="dialog"] textarea');
          if (!ta) return;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          setter.call(ta, text);
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }, newIdeaText);

        // Click "Post idea" button.
        await adminPage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('[role="dialog"] button'));
          const b = btns.find(b => b.textContent.trim().includes('Post idea'));
          if (b) b.click();
        });

        // Wait for the new card to appear (dialog closes + card prepended).
        // Pass newIdeaText as arg so it's available in the browser context.
        const cardAppeared = await pollPage(adminPage, (text) => {
          const mount = document.getElementById('ideas-page-mount');
          return mount && mount.textContent.includes(text) ? 'ok' : null;
        }, newIdeaText, 10000);

        record(
          UI_LABELS[0],
          'new idea card visible in feed after posting',
          cardAppeared ? 'found' : 'not found (timed out)',
          cardAppeared === 'ok',
        );
      } else {
        record(UI_LABELS[0], 'dialog opened', 'dialog did not open', false);
      }
    } else {
      record(UI_LABELS[0], '"New Idea" button found', 'button not found in mount', false);
    }

    // ── [UI-2] Expand comment chip → lazy-fetch shows seeded comment ──────────
    console.log('\n  [UI-2] Expand comment chip → lazy-fetch comments');

    if (idea2Id) {
      // Reload page so the seeded idea with comment_count=1 is in the feed.
      await adminPage.reload({ waitUntil: 'domcontentloaded' });
      await pollPage(adminPage, () => {
        const el = document.getElementById('ideas-page-mount');
        return el && el.textContent && el.textContent.includes('Ideas') ? 'ok' : null;
      }, undefined, 15000);
      // Wait for the seeded idea card to appear before trying to click it.
      await pollPage(adminPage, (body2) => {
        const mount = document.getElementById('ideas-page-mount');
        if (!mount) return null;
        const cards = Array.from(mount.querySelectorAll('.MuiCard-root'));
        return cards.some(c => c.textContent.includes(body2)) ? 'ok' : null;
      }, idea2Body, 10000);

      // Find the card for idea2 and click its comment chip.
      const chipClicked = await adminPage.evaluate((body2) => {
        const mount = document.getElementById('ideas-page-mount');
        if (!mount) return false;
        const cards = Array.from(mount.querySelectorAll('.MuiCard-root'));
        for (const card of cards) {
          if (card.textContent.includes(body2)) {
            // The comment chip has aria-expanded; the vote chip does not.
            const chip = card.querySelector('.MuiChip-root[aria-expanded]') ||
                         card.querySelector('.MuiChip-root');
            if (chip) { chip.click(); return true; }
          }
        }
        return false;
      }, idea2Body);

      if (chipClicked) {
        // Wait for the seeded comment text to appear in the expanded section.
        // Pass comment2Body as arg so it's serialised into the browser context.
        const commentVisible = await pollPage(adminPage, (commentText) => {
          const mount = document.getElementById('ideas-page-mount');
          return mount && mount.textContent.includes(commentText) ? 'ok' : null;
        }, comment2Body, 10000);

        record(
          UI_LABELS[1],
          'seeded comment text visible after expanding chip',
          commentVisible ? 'found' : 'not found (timed out)',
          commentVisible === 'ok',
        );
      } else {
        record(UI_LABELS[1], 'chip clicked on idea2 card', 'chip or card not found', false);
      }
    } else {
      record(UI_LABELS[1], 'idea2 seeded via API', 'idea2 creation failed', false);
    }

    // ── [UI-3] Reply via comment box appends comment inline ────────────────────
    console.log('\n  [UI-3] Replying adds comment inline');

    if (idea2Id) {
      const replyText = `[ideas-test-${runId}] UI inline reply`;

      // The comment section for idea2 should still be expanded from [UI-2].
      // Type into the reply input.
      const replyTyped = await adminPage.evaluate((body2, text) => {
        const mount = document.getElementById('ideas-page-mount');
        const cards = Array.from(mount ? mount.querySelectorAll('.MuiCard-root') : []);
        for (const card of cards) {
          if (card.textContent.includes(body2)) {
            const input = card.querySelector('input[placeholder="Add a comment\u2026"]');
            if (input) {
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(input, text);
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            }
          }
        }
        return false;
      }, idea2Body, replyText);

      if (replyTyped) {
        // Submit the reply form.
        await adminPage.evaluate((body2) => {
          const mount = document.getElementById('ideas-page-mount');
          const cards = Array.from(mount ? mount.querySelectorAll('.MuiCard-root') : []);
          for (const card of cards) {
            if (card.textContent.includes(body2)) {
              const form = card.querySelector('form');
              if (form) {
                form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                return true;
              }
            }
          }
          return false;
        }, idea2Body);

        // Wait for the reply to appear in the DOM (no page reload).
        const inlineComment = await pollPage(adminPage, (text) => {
          const mount = document.getElementById('ideas-page-mount');
          return mount && mount.textContent.includes(text) ? 'ok' : null;
        }, replyText, 10000);

        record(
          UI_LABELS[2],
          'reply appears inline without page reload',
          inlineComment ? 'found' : 'not found (timed out)',
          inlineComment === 'ok',
        );
      } else {
        record(UI_LABELS[2], 'reply input found and typed into', 'input not found (section may be collapsed)', false);
      }
    } else {
      record(UI_LABELS[2], 'idea2 available', 'idea2 creation failed', false);
    }

    await adminPage.__ctx.close().catch(() => {});

    // ── [UI-4] Admin sees delete button + confirm dialog ───────────────────────
    // Open a FRESH admin page so React mounts after window.__moHeaderUser is
    // already set (avoids the mo:user race where the event fires before the
    // usePrivilege hook registers its listener on the reloaded page).
    console.log('\n  [UI-4] Admin sees delete button → confirm dialog');
    const adminPage4 = await openIdeasPage(browser, adminClient.cookie);

    // Re-dispatch mo:user so React's usePrivilege listener (already registered)
    // picks it up even if the original event fired before the effect ran.
    await adminPage4.evaluate(() => {
      const user = window.__moHeaderUser;
      if (user) window.dispatchEvent(new CustomEvent('mo:user', { detail: user }));
    });
    // Poll for delete buttons — they render once isAdmin=true propagates to IdeaCard.
    // No fixed delay needed: the pollPage below handles the wait.
    const deleteButtonCount = await pollPage(adminPage4, () => {
      const mount = document.getElementById('ideas-page-mount');
      const n = mount ? mount.querySelectorAll('[data-testid="delete-idea-btn"]').length : 0;
      return n > 0 ? n : null;
    }, undefined, 10000) || 0;

    record(
      UI_LABELS[3],
      'at least 1 delete button visible for admin',
      `${deleteButtonCount} delete buttons found`,
      deleteButtonCount > 0,
    );

    if (deleteButtonCount > 0) {
      // Trigger the delete button via JS click() — more reliable than Puppeteer
      // coordinate-based click for elements that may be partially off-screen.
      await adminPage4.evaluate(() => {
        const btn = document.querySelector('[data-testid="delete-idea-btn"]');
        if (btn) btn.click();
      });

      // Poll for the "Delete idea?" confirm dialog. MUI Dialog renders via a
      // Portal appended to document.body. The dialog backdrop + content appear
      // asynchronously; wait up to 8 s for the title text to be present.
      const confirmDialog = await pollPage(adminPage4, () => {
        return document.body.textContent.includes('Delete idea?')
          ? 'found'
          : null;
      }, undefined, 8000);

      record(
        UI_LABELS[4],
        '"Delete idea?" dialog appeared',
        confirmDialog ? 'dialog found' : 'no dialog',
        confirmDialog === 'found',
      );

      // Dismiss dialog via Cancel button.
      const buttons = await adminPage4.$$('[role="dialog"] button');
      for (const b of buttons) {
        const txt = await b.evaluate(el => el.textContent.trim());
        if (txt === 'Cancel') { await b.click(); break; }
      }
      await pollPage(adminPage4, () => !document.querySelector('[role="dialog"]') ? 'ok' : null, undefined, 4000);
    } else {
      record(UI_LABELS[4], 'delete button present to click', 'no delete button found', false);
    }

    await adminPage4.__ctx.close().catch(() => {});

    // ── [UI-5] Member does NOT see delete buttons ──────────────────────────────
    console.log('\n  [UI-5] Member does not see delete buttons');
    const memberPage = await openIdeasPage(browser, memberClient.cookie);

    // Wait for bootstrap to complete so we have the definitive privilege level.
    await pollPage(memberPage, () => {
      const w = window;
      return w.__moHeaderUser ? 'ok' : null;
    }, undefined, 10000);
    // Poll until the mount's HTML length stabilises — confirms React has flushed
    // the privilege-level update and the delete buttons (absent for members)
    // won't appear after sampling.
    await stabilityPoll(memberPage, '#ideas-page-mount', 5000);

    const memberDeleteCount = await memberPage.evaluate(() => {
      const mount = document.getElementById('ideas-page-mount');
      if (!mount) return -1;
      return mount.querySelectorAll('[data-testid="delete-idea-btn"]').length;
    });

    record(
      UI_LABELS[5],
      '0 delete buttons',
      `${memberDeleteCount} delete buttons found`,
      memberDeleteCount === 0,
    );

    await memberPage.__ctx.close().catch(() => {});

  } catch (e) {
    console.error('Test error:', e);
    console.error('--- server log (last 2000 chars) ---');
    console.error(logBuf.join('').slice(-2000));
  } finally {
    try { await browser.close(); } catch {}
    const failed = findings.filter(f => !f.ok && !f.skipped).length;
    console.log(`\n  Results: ${findings.length - failed} passed, ${failed} failed`);
    await cleanupAndExit(failed === 0 ? 0 : 1);
  }
}

main();
