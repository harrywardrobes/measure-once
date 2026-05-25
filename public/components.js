/* Shared UI helper components.
 *
 * Loaded by chrome.js (so every page that includes chrome has access).
 * Exposes a small set of pure HTML-string / DOM helpers that pages can compose
 * into bigger views. Keeping these in one file makes the eventual React +
 * Storybook migration (see admin Design System tab) a mechanical move: each
 * helper here maps 1:1 to a future component.
 *
 * Helpers
 *   window.UI.skeletonLine(width, height?, opts?)
 *     opts: { className?: extra class names, style?: extra CSS declarations }
 *   window.UI.renderEmptyState(message, compact?)
 *   window.UI.renderTabBar(tabs, activeKey, onSelectName)
 *
 * All helpers return HTML strings (so they compose with template literals).
 * For DOM-attached events, renderTabBar takes the *name* of a globally
 * registered function rather than a closure — keeps the helpers usable from
 * innerHTML-built markup.
 */
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _size(v, fallback) {
    if (v == null || v === '') return fallback;
    return (typeof v === 'number') ? v + 'px' : String(v);
  }

  function skeletonLine(width, height, opts) {
    const o = opts || {};
    const cls = o.className ? ' ' + String(o.className) : '';
    // When width/height are both omitted and a className is supplied, defer
    // sizing to the CSS class (e.g. .skeleton-wf-name, .skeleton-pill) so the
    // inline style attribute doesn't override the class-driven dimensions.
    const sizeOmitted = (width == null || width === '') && (height == null || height === '');
    const parts = [];
    if (!sizeOmitted) {
      parts.push('width:' + _size(width, '100%'));
      parts.push('height:' + _size(height, '10px'));
    }
    if (o.style) parts.push(String(o.style));
    const styleAttr = parts.length ? ` style="${parts.join(';')}"` : '';
    return `<div class="skeleton-line${cls}"${styleAttr}></div>`;
  }

  function renderEmptyState(message, compact) {
    const cls = compact ? 'ui-empty ui-empty--compact' : 'ui-empty';
    return `<div class="${cls}">${esc(message)}</div>`;
  }

  /**
   * tabs: [{ key, label, badge? }]
   * activeKey: string
   * onSelectName: name of a globally-resolvable function — called with the tab key.
   *
   * Wires a delegated click handler on the tab bar root so the per-button
   * onclick attribute doesn't have to quote-escape arbitrary tab keys
   * (which would break HTML attribute parsing for keys containing quotes).
   */
  function renderTabBar(tabs, activeKey, onSelectName) {
    if (!Array.isArray(tabs)) return '';
    const handler = onSelectName ? esc(String(onSelectName)) : '';
    const onClick = handler
      ? ` onclick="(function(e){var b=e.target.closest('[data-tab-key]');`
        + `if(b&&typeof ${handler}==='function')${handler}(b.getAttribute('data-tab-key'));})(event)"`
      : '';
    return `<div class="ui-tabbar" role="tablist"${onClick}>` + tabs.map(t => {
      const isActive = t && t.key === activeKey;
      const badge = (t && t.badge != null && t.badge !== '')
        ? ` <span class="tab-badge">${esc(t.badge)}</span>` : '';
      return `<button type="button" role="tab" class="ui-tabbar-btn${isActive ? ' is-active' : ''}"`
        + ` data-tab-key="${esc(t.key)}" aria-selected="${isActive ? 'true' : 'false'}">`
        + esc(t.label) + badge
        + '</button>';
    }).join('') + '</div>';
  }

  window.UI = {
    skeletonLine: skeletonLine,
    renderEmptyState: renderEmptyState,
    renderTabBar: renderTabBar,
    _esc: esc,
  };
})();
