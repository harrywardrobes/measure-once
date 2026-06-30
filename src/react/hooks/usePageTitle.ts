import { useEffect } from 'react';

/**
 * Sets `document.title` whenever `title` changes, and restores the previous
 * title when the component unmounts.  The EJS-rendered `<title>` tag remains
 * the correct fallback on fresh page loads; this hook keeps the browser tab
 * in sync as the user navigates between React sub-views.
 *
 * Usage:
 *   usePageTitle('Customers · Harry Wardrobes');
 */
export function usePageTitle(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
