/**
 * Returns a platform-aware keyboard shortcut string.
 * getShortcut('K') → '⌘K' on Mac / iOS, 'Ctrl K' everywhere else.
 */
export function getShortcut(key: string): string {
  // navigator.userAgentData is a newer API; the intersection cast keeps TS happy.
  const platform: string =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ?? navigator.platform ?? '';
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? '\u2318' + key : 'Ctrl ' + key;
}
