import React from 'react';
import { STATUS_COLORS } from '../theme';

type Props = {
  islandId: string;
  children: React.ReactNode;
};

type State = { error: Error | null };

function isChunkLoadError(error: Error): boolean {
  if (error.name === 'ChunkLoadError') return true;
  const msg = error.message || '';
  if (msg.includes('Failed to fetch dynamically imported module')) return true;
  if (msg.includes('Importing a module script failed')) return true;
  if (msg.includes('Loading chunk')) return true;
  if (msg.includes('Loading CSS chunk')) return true;
  return false;
}

/**
 * Scoped error boundary for a single React island mount. If the island
 * throws during render, we surface a small inline error message inside
 * the mount node instead of leaving the user staring at an empty div.
 * The original error is logged so future regressions are loud, not silent.
 *
 * Each island gets its own boundary so one failing tab doesn't take down
 * the rest of the admin shell.
 *
 * Chunk-load failures (missing build output) get a special "try refreshing"
 * message. In development a console warning also prompts the developer to
 * run `npm run build:react`.
 */
export class IslandErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    if (isChunkLoadError(error)) {
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.warn(
          `[react-island] "${this.props.islandId}" failed to load its chunk. ` +
          'Run \`npm run build:react\` to rebuild the bundle, then reload.',
          error,
        );
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `[react-island] "${this.props.islandId}" chunk failed to load:`,
          error,
        );
      }
    } else {
      // eslint-disable-next-line no-console
      console.error(
        `[react-island] "${this.props.islandId}" failed to render:`,
        error,
        info.componentStack,
      );
    }
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunkError = isChunkLoadError(error);

    return (
      <div
        role="alert"
        data-island-error={this.props.islandId}
        style={{
          margin: '12px 0',
          padding: '12px 16px',
          border: `1px solid ${chunkError ? '#fed7aa' : '#fecaca'}`, // hex-color-ok: status border colours awaiting CSS variable tokens
          background: chunkError ? STATUS_COLORS.chunkError.bg : STATUS_COLORS.errorLight.bg,
          color: chunkError ? STATUS_COLORS.chunkError.text : STATUS_COLORS.error.text,
          borderRadius: 6,
          fontFamily: 'system-ui, sans-serif',
          fontSize: 14,
          lineHeight: 1.4,
        }}
      >
        <strong style={{ display: 'block', marginBottom: 4 }}>
          {chunkError
            ? 'Page failed to load \u2014 try refreshing.'
            : 'This panel failed to load.'}
        </strong>
        {chunkError ? (
          <div style={{ fontSize: 12, color: STATUS_COLORS.chunkError.text, marginTop: 4 }}>
            {process.env.NODE_ENV !== 'production'
              ? 'A page chunk is missing. Run \u0060npm run build:react\u0060 and reload.'
              : 'If the problem persists, contact support.'}
          </div>
        ) : (
          <>
            <span style={{ color: STATUS_COLORS.error.text }}>
              {error.message || String(error)}
            </span>
            <div style={{ marginTop: 6, fontSize: 12, color: STATUS_COLORS.error.text }}>
              See the browser console for details. Other tabs should still work.
            </div>
          </>
        )}
      </div>
    );
  }
}

export default IslandErrorBoundary;
