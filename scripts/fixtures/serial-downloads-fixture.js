// scripts/fixtures/serial-downloads-fixture.js
//
// Intentionally BAD fixture used by the `test:parallel-downloads` self-test.
// This file is NOT production code — it exists solely to verify that the
// auto-scan in `check-parallel-downloads.mjs` catches serial download loops.
//
// The function below downloads files one-by-one with `await` inside a
// `for…of` loop instead of using `Promise.all()`.  That pattern would cost
// N × RTT instead of ~1 × RTT in real code.

async function badBatchDownload(keys) {
  const results = [];
  for (const key of keys) {
    const bytes = await downloadAsBytes(key);
    results.push(bytes);
  }
  const extra = await downloadAsBytes('extra-key');
  results.push(extra);
  return results;
}
