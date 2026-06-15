#!/usr/bin/env node
/**
 * Unit tests for the dedup / cooldown logic in ConnectionToastContext.tsx.
 *
 * Exercises _createDedupedCheck() and MOUNT_CHECK_COOLDOWN_MS:
 *   1. First call fires the check function
 *   2. Concurrent calls share the same in-flight promise (no extra invocations)
 *   3. Call within the cooldown window is skipped
 *   4. Call after the cooldown window fires again
 *   5. Cooldown resets per factory instance (state is not global)
 *   6. A second concurrent call that arrives while the first is still in-flight
 *      receives the same promise object
 *   7. After the in-flight promise settles a new call (outside cooldown) fires again
 *
 * Uses esbuild to compile the TypeScript source so no separate build step is needed.
 * Exits non-zero on any failure.
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC  = resolve(ROOT, 'src/react/context/ConnectionToastContext.tsx');
const TMP  = resolve(ROOT, 'node_modules/.cache/test-connection-toast-dedup.cjs');

mkdirSync(dirname(TMP), { recursive: true });

execSync(
  // bundle=true so intra-project imports (e.g. localStorageKeys) are inlined;
  // React / MUI / browser APIs are marked external so they don't resolve.
  `node_modules/.bin/esbuild "${SRC}" --bundle=true --platform=node --format=cjs ` +
  `--external:react --external:react-dom --external:"react/*" ` +
  `--external:"@mui/*" --external:"@mui/icons-material" ` +
  `--out-extension:.js=.cjs --outfile="${TMP}"`,
  { cwd: ROOT, stdio: 'pipe' },
);

const req = createRequire(import.meta.url);
const { _createDedupedCheck, MOUNT_CHECK_COOLDOWN_MS } = req(TMP);

try { unlinkSync(TMP); } catch { /* best-effort cleanup */ }

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(description, condition) {
  if (condition) {
    console.log(`  ✔  ${description}`);
    passed++;
  } else {
    console.error(`  ✖  ${description}`);
    failed++;
  }
}

function assertEqual(description, actual, expected) {
  if (actual === expected) {
    console.log(`  ✔  ${description}`);
    passed++;
  } else {
    console.error(`  ✖  ${description}  (expected ${expected}, got ${actual})`);
    failed++;
  }
}

function makeDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\nConnectionToastContext — dedup / cooldown unit tests\n');

console.log('  MOUNT_CHECK_COOLDOWN_MS');
assertEqual('  is 30 000 ms', MOUNT_CHECK_COOLDOWN_MS, 30_000);

console.log('\n  First call fires the check function');
{
  let calls = 0;
  const check = _createDedupedCheck(() => { calls++; return Promise.resolve(); });
  await check();
  assertEqual('  checkFn called once', calls, 1);
}

console.log('\n  Concurrent calls share the in-flight promise');
{
  let calls = 0;
  const deferred = makeDeferred();
  const check = _createDedupedCheck(() => { calls++; return deferred.promise; });

  const p1 = check();
  const p2 = check();
  const p3 = check();

  assert('  p1 and p2 are the same promise object', p1 === p2);
  assert('  p1 and p3 are the same promise object', p1 === p3);
  assertEqual('  checkFn invoked exactly once', calls, 1);

  deferred.resolve();
  await p1;
}

console.log('\n  Call within the cooldown window is skipped');
{
  let calls = 0;
  let now = 0;
  const check = _createDedupedCheck(
    () => { calls++; return Promise.resolve(); },
    () => now,
  );

  await check();                     // first call — fires (lastCheckAt = 0)
  now = MOUNT_CHECK_COOLDOWN_MS - 1; // still within cooldown
  await check();                     // should be skipped

  assertEqual('  checkFn called only once', calls, 1);
}

console.log('\n  Call at exactly the cooldown boundary fires (elapsed === cooldown)');
{
  let calls = 0;
  let now = 0;
  const check = _createDedupedCheck(
    () => { calls++; return Promise.resolve(); },
    () => now,
  );

  await check();
  now = MOUNT_CHECK_COOLDOWN_MS; // exactly at boundary: elapsed === cooldown → not < cooldown → fires
  await check();

  assertEqual('  checkFn called twice (boundary not suppressed)', calls, 2);
}

console.log('\n  Call after the cooldown window fires again');
{
  let calls = 0;
  let now = 0;
  const check = _createDedupedCheck(
    () => { calls++; return Promise.resolve(); },
    () => now,
  );

  await check();                     // fires
  now = MOUNT_CHECK_COOLDOWN_MS + 1; // past cooldown
  await check();                     // should fire again

  assertEqual('  checkFn called twice', calls, 2);
}

console.log('\n  State is per factory instance (not shared globally)');
{
  let callsA = 0;
  let callsB = 0;
  const checkA = _createDedupedCheck(() => { callsA++; return Promise.resolve(); });
  const checkB = _createDedupedCheck(() => { callsB++; return Promise.resolve(); });

  await checkA();
  await checkB();

  assertEqual('  factory A fired once', callsA, 1);
  assertEqual('  factory B fired once', callsB, 1);
}

console.log('\n  After in-flight settles, next call outside cooldown fires again');
{
  let calls = 0;
  let now = 0;
  const deferred = makeDeferred();
  const check = _createDedupedCheck(
    () => { calls++; return calls === 1 ? deferred.promise : Promise.resolve(); },
    () => now,
  );

  const p1 = check();  // fires, in-flight
  now = MOUNT_CHECK_COOLDOWN_MS + 1;
  const p2 = check();  // still in-flight → returns same promise
  assert('  p1 === p2 (still in-flight)', p1 === p2);

  deferred.resolve();
  await p1;

  // inFlight is now null; cooldown is COOLDOWN_MS+1 ahead, so it should fire
  const p3 = check();
  await p3;
  assertEqual('  checkFn called twice after settling', calls, 2);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n  ${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
