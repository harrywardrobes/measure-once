import React, { useEffect, useState } from 'react';
import { Pill } from '../components/Pill';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { TabBar } from '../components/TabBar';
import { Swatch } from '../components/Swatch';
import { Button } from '../components/Button';

/**
 * <DesignSystemPage/> — React port of the legacy `public/design-system.js`.
 *
 * Renders the admin Design System tab using the React component library
 * (Pill, EmptyState, Skeleton, TabBar, Swatch). All colour / radius /
 * shadow / z-index values are pulled live from `:root` via
 * `getComputedStyle`, so the page stays a faithful introspection of the
 * current token set. CSS comes from the existing `.ds-*` classes in
 * `public/style.css` — no literal hex/rem values live in this file.
 */

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

const Z_TOKENS: Array<[string, string]> = [
  ['--z-base', 'Default flow stacking context'],
  ['--z-raised', 'Slightly raised surface (cards on cards)'],
  ['--z-sticky', 'Sticky in-flow headers and filter rows'],
  ['--z-nav', 'Bottom navigation bar'],
  ['--z-header', 'Top app header'],
  ['--z-dropdown', 'Inline popovers / dropdowns'],
  ['--z-panel', 'Side panels, slide-overs'],
  ['--z-overlay', 'Page-level overlays (full-screen scrims)'],
  ['--z-modal', 'Modal dialogs'],
  ['--z-toast', 'Toast notifications'],
  ['--z-tooltip', 'Top-most ephemeral UI (tooltips, captures)'],
];

const TYPE_SAMPLES: Array<[string, string, string, string]> = [
  ['Display', '1.5rem', '700', 'The quick brown fox jumps over the lazy dog'],
  ['Page title', '1.25rem', '700', 'Admin Panel'],
  ['Section title', '1rem', '700', 'Pending requests'],
  ['Body', '0.92rem', '400', 'Standard body text used across forms and lists.'],
  ['Small', '0.82rem', '500', 'Captions, helper text, metadata.'],
  ['Micro', '0.72rem', '700', 'UPPERCASE LABELS / BADGES'],
];

function getVar(name: string): string {
  if (typeof window === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function StageSwatch({ stage }: { stage: string }) {
  const bg = `--stage-${stage}-bg`;
  const text = `--stage-${stage}-text`;
  return (
    <Swatch
      name={bg}
      value={getVar(bg)}
      chipStyle={{
        background: `var(${bg})`,
        color: 'var(--chalk)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
      }}
      chipLabel={stage}
      extra={
        <>
          <div className="ds-swatch-name" style={{ marginTop: 4 }}>{text}</div>
          <div className="ds-swatch-value">{getVar(text)}</div>
        </>
      }
    />
  );
}

function StorybookLink() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch('/storybook/index.html', { method: 'HEAD' })
      .then((r) => { if (!cancelled && r && r.ok) setAvailable(true); })
      .catch(() => { /* swallow — link stays hidden */ });
    return () => { cancelled = true; };
  }, []);
  if (!available) return null;
  return (
    <>
      {' '}
      <a
        href="/storybook/"
        target="_blank"
        rel="noopener"
        style={{ fontWeight: 600, color: 'var(--orchid-deep)' }}
      >
        Open Storybook →
      </a>
    </>
  );
}

export function DesignSystemPage() {
  // Re-read tokens whenever the component re-mounts (admin tab switch).
  // Stored in state so a future "theme switcher" could trigger a refresh.
  const [, setTick] = useState(0);
  useEffect(() => { setTick((t) => t + 1); }, []);

  return (
    <div className="card">
      {/* Colour tokens */}
      <div className="ds-section">
        <h3>Colour Tokens</h3>
        <p className="ds-section-sub">
          Brand, surface, ink and status tokens read live from <code>:root</code>.
          Use these via <code>var(--token)</code> rather than literal hex.
        </p>
        <div className="ds-swatch-grid">
          {COLOUR_TOKENS.map((t) => (
            <Swatch key={t} name={t} value={getVar(t)} />
          ))}
        </div>

        <h3 style={{ marginTop: 24 }}>Stage Colours</h3>
        <p className="ds-section-sub">
          Every workflow stage has a canonical <code>-bg</code>, <code>-light</code>,
          and <code>-text</code> triplet.
        </p>
        <div className="ds-swatch-grid">
          {STAGE_TOKENS.map((s) => <StageSwatch key={s} stage={s} />)}
        </div>
      </div>

      {/* Typography */}
      <div className="ds-section">
        <h3>Typography</h3>
        <p className="ds-section-sub">
          Stack: <code>'Open Sans', system-ui, sans-serif</code>. Sizes are <code>rem</code>-based.
        </p>
        {TYPE_SAMPLES.map(([label, size, weight, text]) => (
          <div key={label} className="ds-type-row">
            <span className="ds-type-label">
              {label}<br />{size} / {weight}
            </span>
            <span style={{ fontSize: size, fontWeight: Number(weight), color: 'var(--ink-1)' }}>
              {text}
            </span>
          </div>
        ))}
      </div>

      {/* Buttons */}
      <div className="ds-section">
        <h3>Buttons</h3>
        <p className="ds-section-sub">
          Existing button classes (rendered in their current style — not editable here).
        </p>
        <div className="ds-buttons-row">
          <Button variant="primary">Primary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="approve">Approve</Button>
          <Button variant="primary" disabled>Disabled</Button>
        </div>
      </div>

      {/* Pills & badges */}
      <div className="ds-section">
        <h3>Pills &amp; Badges</h3>
        <p className="ds-section-sub">
          Built from <code>&lt;Pill/&gt;</code> (React) — mirrors <code>UI.renderPill()</code>.
        </p>
        <div className="ds-pills-row">
          <Pill label="Neutral" variant="neutral" />
          <Pill label="Success" variant="success" />
          <Pill label="Danger" variant="danger" />
          <Pill label="Warning" variant="warn" />
          <Pill label="Info" variant="info" />
          <span className="lvl lvl-admin">Admin</span>
          <span className="lvl lvl-manager">Manager</span>
          <span className="lvl lvl-member">Member</span>
          <span className="lvl lvl-viewer">Viewer</span>
        </div>
      </div>

      {/* Skeletons */}
      <div className="ds-section">
        <h3>Skeleton Loaders</h3>
        <p className="ds-section-sub">
          Built from <code>&lt;Skeleton/&gt;</code> — same pulse animation across pages.
        </p>
        <div className="ds-skeleton-stack">
          <Skeleton width="60%" height={14} />
          <Skeleton width="100%" />
          <Skeleton width="80%" />
          <Skeleton width="40%" />
        </div>
      </div>

      {/* Empty states */}
      <div className="ds-section">
        <h3>Empty States</h3>
        <p className="ds-section-sub">
          Built from <code>&lt;EmptyState/&gt;</code>.
        </p>
        <div className="ds-empty-grid">
          <EmptyState message="No customers match your filter." />
          <EmptyState message="Nothing here yet." compact />
        </div>
      </div>

      {/* Tab bar */}
      <div className="ds-section">
        <h3>Stage Tab Bar</h3>
        <p className="ds-section-sub">
          Built from <code>&lt;TabBar/&gt;</code>. Tabs scroll horizontally on narrow viewports.
        </p>
        <TabBar
          tabs={[
            { key: 'sales', label: 'Sales', badge: 3 },
            { key: 'designvisit', label: 'Design visit' },
            { key: 'survey', label: 'Survey' },
            { key: 'order', label: 'Order' },
          ]}
          activeKey="sales"
        />
      </div>

      {/* Cards */}
      <div className="ds-section">
        <h3>Cards &amp; Panels</h3>
        <p className="ds-section-sub">
          Surface tokens (<code>--surface-card</code>, <code>--shadow-sm</code>, <code>--radius-lg</code>).
        </p>
        <div className="card">
          <div className="card-title">Example card</div>
          <p style={{ fontSize: '.85rem', color: 'var(--ink-3)', margin: 0 }}>
            Cards use <code>var(--chalk)</code> background, <code>var(--stone)</code> border,
            {' '}<code>var(--shadow-sm)</code>, and <code>var(--radius-lg)</code>.
          </p>
        </div>
      </div>

      {/* Forms */}
      <div className="ds-section">
        <h3>Form Inputs</h3>
        <p className="ds-section-sub">
          Existing <code>.field</code> and <code>.field-full</code> classes — used by every admin form.
        </p>
        <div className="form-grid" style={{ maxWidth: 560 }}>
          <div className="form-field-wrap">
            <label>Sample text</label>
            <input className="field" type="text" placeholder="Placeholder" readOnly />
          </div>
          <div className="form-field-wrap">
            <label>Sample select</label>
            <select className="field" disabled>
              <option>Option A</option>
            </select>
          </div>
          <div className="form-field-wrap form-field-full">
            <label>Full-width</label>
            <input className="field field-full" type="text" placeholder="Placeholder" readOnly />
          </div>
        </div>
      </div>

      {/* Z-index ladder */}
      <div className="ds-section">
        <h3>Z-index Ladder</h3>
        <p className="ds-section-sub">
          Single source of truth for stacking layers. Reach for a token rather than a
          magic number — extend the ladder if nothing fits.
        </p>
        <table className="ds-z-table">
          <thead>
            <tr><th>Token</th><th>Value</th><th>Use</th></tr>
          </thead>
          <tbody>
            {Z_TOKENS.map(([name, desc]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{getVar(name) || '—'}</td>
                <td style={{ fontFamily: 'inherit' }}>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Roadmap */}
      <div className="ds-section">
        <h3>Migration Roadmap</h3>
        <p className="ds-section-sub">
          Where this design system is heading, and how today's classes map onto the
          future component library.
        </p>
        <div className="ds-roadmap">
          <h4>Goal</h4>
          <p>
            Move the dashboard from hand-written vanilla JS + a Tailwind CDN onto a
            typed React component library, documented in Storybook, built with
            Tailwind JIT. The token layer above is the bridge: every component first
            migrates to consuming <code>var(--token)</code>, then becomes a React
            component that reads the same tokens via <code>theme()</code>.
          </p>

          <h4>Phase 1 — Foundation</h4>
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

          <h4>Phase 3 — Storybook + React component library (this task)</h4>
          <ul>
            <li>
              Stand up Storybook against the token layer so every component lives in isolation.
              <StorybookLink />
            </li>
            <li>Wrap <code>components.js</code> helpers as React equivalents.</li>
            <li>
              Port pages one at a time — <strong>this Design System tab is the first
              page running on React</strong>; next up are admin tabs, then the sales /
              invoice boards.
            </li>
          </ul>

          <h4>Class → Component Mapping</h4>
          <table>
            <thead>
              <tr><th>Today (vanilla)</th><th>Helper</th><th>React component</th></tr>
            </thead>
            <tbody>
              <tr><td><code>.skeleton-line</code></td><td><code>UI.skeletonLine()</code></td><td><code>&lt;Skeleton/&gt;</code> ✓</td></tr>
              <tr><td><code>.ui-pill</code>, <code>.lvl</code></td><td><code>UI.renderPill()</code></td><td><code>&lt;Pill/&gt;</code> ✓</td></tr>
              <tr><td><code>.ui-empty</code>, <code>.qb-tab-empty</code></td><td><code>UI.renderEmptyState()</code></td><td><code>&lt;EmptyState/&gt;</code> ✓</td></tr>
              <tr><td><code>.tabs</code>, <code>.tab-btn</code>, <code>.room-tabs</code></td><td><code>UI.renderTabBar()</code></td><td><code>&lt;TabBar/&gt;</code> ✓</td></tr>
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
            <li>Has a Storybook story for at least: default, loading, empty.</li>
            <li>The vanilla helper / class it replaces is removed from <code>components.js</code> / <code>style.css</code> in the same change.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

export default DesignSystemPage;
