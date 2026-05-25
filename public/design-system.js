/* Admin Design System tab.
 *
 * Read-only, live-introspection panel rendered into #tab-designsystem. Reads
 * CSS custom properties from :root via getComputedStyle so it always reflects
 * the current token values without manual sync.
 *
 * Sections
 *   1. Colour tokens
 *   2. Typography
 *   3. Buttons
 *   4. Pills & badges
 *   5. Skeleton loaders
 *   6. Empty states
 *   7. Stage tab bar
 *   8. Cards & panels
 *   9. Form inputs
 *  10. Z-index ladder
 *  11. Migration roadmap (written content)
 */
(function () {
  const COLOUR_TOKENS = [
    '--paper', '--paper-deep', '--chalk', '--stone', '--stone-light', '--stone-soft', '--stone-deep',
    '--orchid', '--orchid-deep', '--orchid-soft', '--orchid-tint',
    '--plum', '--walnut',
    '--ink-1', '--ink-2', '--ink-3', '--ink-4',
    '--surface-card', '--surface-muted', '--surface-soft',
    '--border-soft', '--border-strong',
    '--status-danger', '--status-danger-bg', '--status-success', '--status-success-bg',
    '--status-warn-bg', '--brand-accent', '--brand-accent-hover',
  ];
  const STAGE_TOKENS = [
    'sales', 'designvisit', 'survey', 'order', 'workshop',
    'packing', 'delivery', 'installation', 'aftercare', 'customerservice',
  ];
  const Z_TOKENS = [
    ['--z-base',     'Default flow stacking context'],
    ['--z-raised',   'Slightly raised surface (cards on cards)'],
    ['--z-sticky',   'Sticky in-flow headers and filter rows'],
    ['--z-nav',      'Bottom navigation bar'],
    ['--z-header',   'Top app header'],
    ['--z-dropdown', 'Inline popovers / dropdowns'],
    ['--z-panel',    'Side panels, slide-overs'],
    ['--z-overlay',  'Page-level overlays (full-screen scrims)'],
    ['--z-modal',    'Modal dialogs'],
    ['--z-toast',    'Toast notifications'],
    ['--z-tooltip',  'Top-most ephemeral UI (tooltips, captures)'],
  ];

  function esc(s) {
    return (window.UI && window.UI._esc)
      ? window.UI._esc(s)
      : String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function colourSection() {
    const swatch = (name) => {
      const v = getVar(name) || '—';
      return `<div class="ds-swatch">
        <div class="ds-swatch-chip" style="background:var(${esc(name)})"></div>
        <div class="ds-swatch-meta">
          <div class="ds-swatch-name">${esc(name)}</div>
          <div class="ds-swatch-value">${esc(v)}</div>
        </div>
      </div>`;
    };
    const stageSwatch = (stage) => {
      const bg   = '--stage-' + stage + '-bg';
      const text = '--stage-' + stage + '-text';
      return `<div class="ds-swatch">
        <div class="ds-swatch-chip" style="background:var(${bg});color:var(--chalk);display:flex;align-items:center;justify-content:center;font-weight:700;">${esc(stage)}</div>
        <div class="ds-swatch-meta">
          <div class="ds-swatch-name">${esc(bg)}</div>
          <div class="ds-swatch-value">${esc(getVar(bg))}</div>
          <div class="ds-swatch-name" style="margin-top:4px;">${esc(text)}</div>
          <div class="ds-swatch-value">${esc(getVar(text))}</div>
        </div>
      </div>`;
    };
    return `
      <div class="ds-section">
        <h3>Colour Tokens</h3>
        <p class="ds-section-sub">Brand, surface, ink and status tokens read live from <code>:root</code>. Use these via <code>var(--token)</code> rather than literal hex.</p>
        <div class="ds-swatch-grid">${COLOUR_TOKENS.map(swatch).join('')}</div>
        <h3 style="margin-top:24px;">Stage Colours</h3>
        <p class="ds-section-sub">Every workflow stage has a canonical <code>-bg</code>, <code>-light</code>, and <code>-text</code> triplet.</p>
        <div class="ds-swatch-grid">${STAGE_TOKENS.map(stageSwatch).join('')}</div>
      </div>`;
  }

  function typographySection() {
    const samples = [
      ['Display',  '1.5rem',  '700', 'The quick brown fox jumps over the lazy dog'],
      ['Page title',  '1.25rem', '700', 'Admin Panel'],
      ['Section title',  '1rem', '700', 'Pending requests'],
      ['Body',  '0.92rem', '400', 'Standard body text used across forms and lists.'],
      ['Small', '0.82rem', '500', 'Captions, helper text, metadata.'],
      ['Micro',  '0.72rem', '700', 'UPPERCASE LABELS / BADGES'],
    ];
    const rows = samples.map(([label, size, weight, text]) =>
      `<div class="ds-type-row">
        <span class="ds-type-label">${esc(label)}<br>${esc(size)} / ${esc(weight)}</span>
        <span style="font-size:${esc(size)};font-weight:${esc(weight)};color:var(--ink-1);">${esc(text)}</span>
      </div>`
    ).join('');
    return `<div class="ds-section">
      <h3>Typography</h3>
      <p class="ds-section-sub">Stack: <code>'Open Sans', system-ui, sans-serif</code>. Sizes are <code>rem</code>-based.</p>
      ${rows}
    </div>`;
  }

  function buttonsSection() {
    return `<div class="ds-section">
      <h3>Buttons</h3>
      <p class="ds-section-sub">Existing button classes (rendered in their current style — not editable here).</p>
      <div class="ds-buttons-row">
        <button class="btn btn-primary" type="button">Primary</button>
        <button class="btn btn-ghost" type="button">Ghost</button>
        <button class="btn btn-approve" type="button">Approve</button>
        <button class="btn btn-primary" type="button" disabled>Disabled</button>
      </div>
    </div>`;
  }

  function pillsSection() {
    const UI = window.UI || {};
    const pill = (UI.renderPill) || ((l) => `<span class="ui-pill">${esc(l)}</span>`);
    return `<div class="ds-section">
      <h3>Pills &amp; Badges</h3>
      <p class="ds-section-sub">Built from <code>UI.renderPill(label, variant)</code>.</p>
      <div class="ds-pills-row">
        ${pill('Neutral', 'neutral')}
        ${pill('Success', 'success')}
        ${pill('Danger', 'danger')}
        ${pill('Warning', 'warn')}
        ${pill('Info', 'info')}
        <span class="lvl lvl-admin">Admin</span>
        <span class="lvl lvl-manager">Manager</span>
        <span class="lvl lvl-member">Member</span>
        <span class="lvl lvl-viewer">Viewer</span>
      </div>
    </div>`;
  }

  function skeletonSection() {
    const UI = window.UI || {};
    const line = UI.skeletonLine || ((w, h) => `<div class="skeleton-line" style="width:${w};height:${h || '10px'}"></div>`);
    return `<div class="ds-section">
      <h3>Skeleton Loaders</h3>
      <p class="ds-section-sub">Built from <code>UI.skeletonLine(width, height?)</code>. Same pulse animation across pages.</p>
      <div class="ds-skeleton-stack">
        ${line('60%', '14px')}
        ${line('100%', '10px')}
        ${line('80%', '10px')}
        ${line('40%', '10px')}
      </div>
    </div>`;
  }

  function emptyStatesSection() {
    const UI = window.UI || {};
    const empty = UI.renderEmptyState || ((m) => `<div class="ui-empty">${esc(m)}</div>`);
    return `<div class="ds-section">
      <h3>Empty States</h3>
      <p class="ds-section-sub">Built from <code>UI.renderEmptyState(message, compact?)</code>.</p>
      <div class="ds-empty-grid">
        ${empty('No customers match your filter.')}
        ${empty('Nothing here yet.', true)}
      </div>
    </div>`;
  }

  function tabBarSection() {
    const UI = window.UI || {};
    const bar = UI.renderTabBar
      ? UI.renderTabBar(
          [
            { key: 'sales', label: 'Sales', badge: 3 },
            { key: 'designvisit', label: 'Design visit' },
            { key: 'survey', label: 'Survey' },
            { key: 'order', label: 'Order' },
          ],
          'sales',
          '__dsTabBarNoop'
        )
      : '';
    return `<div class="ds-section">
      <h3>Stage Tab Bar</h3>
      <p class="ds-section-sub">Built from <code>UI.renderTabBar(tabs, activeKey, onSelectName)</code>. Tabs scroll horizontally on narrow viewports.</p>
      ${bar}
    </div>`;
  }

  function cardsSection() {
    return `<div class="ds-section">
      <h3>Cards &amp; Panels</h3>
      <p class="ds-section-sub">Surface tokens (<code>--surface-card</code>, <code>--shadow-sm</code>, <code>--radius-lg</code>).</p>
      <div class="card">
        <div class="card-title">Example card</div>
        <p style="font-size:.85rem;color:var(--ink-3);margin:0;">
          Cards use <code>var(--chalk)</code> background, <code>var(--stone)</code> border, <code>var(--shadow-sm)</code>, and <code>var(--radius-lg)</code>.
        </p>
      </div>
    </div>`;
  }

  function formsSection() {
    return `<div class="ds-section">
      <h3>Form Inputs</h3>
      <p class="ds-section-sub">Existing <code>.field</code> and <code>.field-full</code> classes — used by every admin form.</p>
      <div class="form-grid" style="max-width:560px;">
        <div class="form-field-wrap">
          <label>Sample text</label>
          <input class="field" type="text" placeholder="Placeholder" readonly>
        </div>
        <div class="form-field-wrap">
          <label>Sample select</label>
          <select class="field" disabled>
            <option>Option A</option>
          </select>
        </div>
        <div class="form-field-wrap form-field-full">
          <label>Full-width</label>
          <input class="field field-full" type="text" placeholder="Placeholder" readonly>
        </div>
      </div>
    </div>`;
  }

  function zindexSection() {
    const rows = Z_TOKENS.map(([name, desc]) =>
      `<tr><td>${esc(name)}</td><td>${esc(getVar(name) || '—')}</td><td style="font-family:inherit;">${esc(desc)}</td></tr>`
    ).join('');
    return `<div class="ds-section">
      <h3>Z-index Ladder</h3>
      <p class="ds-section-sub">Single source of truth for stacking layers. Reach for a token rather than a magic number — extend the ladder if nothing fits.</p>
      <table class="ds-z-table">
        <thead><tr><th>Token</th><th>Value</th><th>Use</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  function roadmapSection() {
    return `<div class="ds-section">
      <h3>Migration Roadmap</h3>
      <p class="ds-section-sub">Where this design system is heading, and how today's classes map onto the future component library.</p>
      <div class="ds-roadmap">
        <h4>Goal</h4>
        <p>Move the dashboard from hand-written vanilla JS + a Tailwind CDN onto a typed React component library, documented in Storybook, built with Tailwind JIT. The token layer above is the bridge: every component first migrates to consuming <code>var(--token)</code>, then becomes a React component that reads the same tokens via <code>theme()</code>.</p>

        <h4>Phase 1 — Foundation (this task)</h4>
        <ul>
          <li>Colour, shadow, radius, and z-index tokens defined on <code>:root</code>.</li>
          <li>Inline styles audited; shared helpers extracted into <code>components.js</code>.</li>
          <li>Page-level <code>&lt;style&gt;</code> blocks consolidated into <code>style.css</code> under labelled sections.</li>
          <li>This Design System tab introspects tokens live so drift is visible.</li>
        </ul>

        <h4>Phase 2 — Tailwind JIT + extracted CSS</h4>
        <ul>
          <li>Replace the Tailwind CDN with a JIT build that consumes the same tokens via <code>theme.extend</code>.</li>
          <li>Tree-shake unused CSS, eliminate exact-duplicate rule blocks remaining in <code>style.css</code>.</li>
          <li>Add a small Vite or esbuild step (still serving from <code>public/</code>) so the React components below can co-exist with the legacy pages during rollout.</li>
        </ul>

        <h4>Phase 3 — Storybook + React component library</h4>
        <ul>
          <li>Stand up Storybook against the token layer so every component lives in isolation. <span id="ds-storybook-link-slot"></span></li>
          <li>Wrap <code>components.js</code> helpers as React equivalents.</li>
          <li>Port pages one at a time (start with Admin → Design System tab → invoice / sales boards last).</li>
        </ul>

        <h4>Class → Component Mapping</h4>
        <table>
          <thead><tr><th>Today (vanilla)</th><th>Helper</th><th>Future React component</th></tr></thead>
          <tbody>
            <tr><td><code>.skeleton-line</code></td><td><code>UI.skeletonLine()</code></td><td><code>&lt;Skeleton/&gt;</code></td></tr>
            <tr><td><code>.ui-pill</code>, <code>.lvl</code></td><td><code>UI.renderPill()</code></td><td><code>&lt;Pill variant /&gt;</code></td></tr>
            <tr><td><code>.ui-empty</code>, <code>.qb-tab-empty</code></td><td><code>UI.renderEmptyState()</code></td><td><code>&lt;EmptyState/&gt;</code></td></tr>
            <tr><td><code>.tabs</code>, <code>.tab-btn</code>, <code>.room-tabs</code></td><td><code>UI.renderTabBar()</code></td><td><code>&lt;TabBar/&gt;</code></td></tr>
            <tr><td><code>.card</code>, <code>.card-title</code></td><td>—</td><td><code>&lt;Card/&gt;</code> with title slot</td></tr>
            <tr><td><code>.btn</code>, <code>.btn-primary</code>, <code>.btn-ghost</code>, <code>.btn-approve</code></td><td>—</td><td><code>&lt;Button variant /&gt;</code></td></tr>
            <tr><td><code>.field</code>, <code>.field-full</code>, <code>.form-grid</code></td><td>—</td><td><code>&lt;Field/&gt;</code>, <code>&lt;FormGrid/&gt;</code></td></tr>
            <tr><td><code>.modal-overlay</code>, <code>.js-modal-scrim</code></td><td>—</td><td><code>&lt;Modal/&gt;</code> driven by <code>--z-modal</code></td></tr>
            <tr><td><code>.toast</code></td><td>—</td><td><code>&lt;ToastHost/&gt;</code> at <code>--z-toast</code></td></tr>
          </tbody>
        </table>

        <h4>Definition of Done — per component port</h4>
        <ul>
          <li>Renders identical pixels to the current page on the same data.</li>
          <li>Reads colour, radius, shadow, and z-index from tokens — no literals.</li>
          <li>Has a Storybook story for at least: default, loading, empty, error.</li>
          <li>The vanilla helper / class it replaces is removed from <code>components.js</code> / <code>style.css</code> in the same PR.</li>
        </ul>
      </div>
    </div>`;
  }

  /**
   * If a Storybook build has been published to `/storybook/` (the output dir
   * of `npm run build:storybook`), surface a link in the Phase 3 roadmap
   * bullet. We probe with a HEAD request so missing Storybook builds stay
   * silent rather than rendering a broken link.
   */
  function wireStorybookLink() {
    const slot = document.getElementById('ds-storybook-link-slot');
    if (!slot) return;
    try {
      fetch('/storybook/index.html', { method: 'HEAD' })
        .then(function (r) {
          if (!r || !r.ok) return;
          slot.innerHTML = ' <a href="/storybook/" target="_blank" rel="noopener" '
            + 'style="font-weight:600;color:var(--orchid-deep);">Open Storybook →</a>';
        })
        .catch(function () { /* swallow — link stays hidden */ });
    } catch (_) { /* fetch unsupported, leave slot empty */ }
  }

  function render() {
    const mount = document.getElementById('tab-designsystem');
    if (!mount) return;
    if (mount.dataset.dsRendered === '1') return;
    mount.dataset.dsRendered = '1';
    mount.innerHTML = '<div class="card">'
      + colourSection()
      + typographySection()
      + buttonsSection()
      + pillsSection()
      + skeletonSection()
      + emptyStatesSection()
      + tabBarSection()
      + cardsSection()
      + formsSection()
      + zindexSection()
      + roadmapSection()
      + '</div>';
    wireStorybookLink();
  }

  // No-op handler used by the demo tab bar so its onclick has something to call.
  window.__dsTabBarNoop = function () {};
  window.renderDesignSystemTab = render;
})();
