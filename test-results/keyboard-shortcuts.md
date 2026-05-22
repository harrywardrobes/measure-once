# Keyboard Shortcuts — Smoke Test

- Date: 2026-05-22T15:02:50.238Z
- Command: `npm run test:keyboard-shortcuts`

## Summary

- Passed: 4 / 4
- Failed: 0 / 4

## Results

| Result | Probe | Expected | Observed |
|---|---|---|---|
| PASS | userAgentData path — macOS platform returns ⌘K | ⌘K | ⌘K |
| PASS | userAgentData path — Windows platform returns Ctrl K | Ctrl K | Ctrl K |
| PASS | legacy fallback — MacIntel navigator.platform returns ⌘K | ⌘K | ⌘K |
| PASS | legacy fallback — Win32 navigator.platform returns Ctrl K | Ctrl K | Ctrl K |

## Coverage

- **(1) userAgentData — macOS**: `navigator.userAgentData.platform = "macOS"` →
  `getShortcut("K")` must return `"⌘K"`. Exercises the modern API path.
- **(2) userAgentData — Windows**: `navigator.userAgentData.platform = "Windows"` →
  `getShortcut("K")` must return `"Ctrl K"`. Exercises the modern API path.
- **(3) legacy fallback — MacIntel**: `navigator.userAgentData` is absent;
  `navigator.platform = "MacIntel"` → `getShortcut("K")` must return `"⌘K"`.
  Exercises the `?? navigator.platform` fallback branch.
- **(4) legacy fallback — Win32**: `navigator.userAgentData` is absent;
  `navigator.platform = "Win32"` → `getShortcut("K")` must return `"Ctrl K"`.
  Exercises the `?? navigator.platform` fallback branch.

## Relevant file

- `public/chrome.js` — `window.getShortcut` (lines 8–11)