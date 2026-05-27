/**
 * Gallery-embedding convention for full-page components.
 *
 * Full-page components shown in the Design System gallery use a single
 * canonical prop name — `embedded` — to signal that they are running inside
 * the gallery rather than at their real URL.
 *
 * Two patterns exist:
 *
 *   1. **Simple boolean** — components that only need to suppress full-viewport
 *      layout accept `embedded?: boolean`. The component checks `if (embedded)`
 *      and adjusts padding/minHeight accordingly.
 *      Examples: `NotFoundPage`, `AccessRestrictedPage`.
 *
 *   2. **Rich preview object** — components with multiple UI states declare a
 *      component-specific interface that `extends GalleryEmbedded`, allowing
 *      the gallery to control which state is shown without a real token or API
 *      call.
 *      Examples: `DesignVisitSignOffPage` (`EmbeddedPreview`),
 *                `AccessRequestGate` (`AccessRequestGateEmbeddedPreview`).
 *
 * Convention rules:
 *  - Always name the prop `embedded` (not `preview`, `inGallery`, etc.).
 *  - For rich objects, extend `GalleryEmbedded` rather than declaring an
 *    independent interface with no shared ancestry.
 *  - Export the extended type from the component file so that
 *    `DesignSystemPage` can import it without a circular dependency.
 *
 * See also: `src/react/README.md` § "Gallery embedding convention".
 */

/**
 * Marker base interface for all gallery-preview objects.
 *
 * Extend this interface in your component file to declare a
 * component-specific preview shape, rather than defining an independent
 * interface with no connection to the gallery convention.
 *
 * @example
 * ```ts
 * import type { GalleryEmbedded } from '../types/gallery';
 *
 * export interface MyPageEmbeddedPreview extends GalleryEmbedded {
 *   state: 'loading' | 'success' | 'error';
 * }
 *
 * export function MyPage({ embedded }: { embedded?: MyPageEmbeddedPreview }) {
 *   // ...
 * }
 * ```
 */
export interface GalleryEmbedded {}
