import React from 'react';

type Props = {
  islandId: string;
  children: React.ReactNode;
};

type State = { error: Error | null };

/**
 * Scoped error boundary for a single React island mount. If the island
 * throws during render, we surface a small inline error message inside
 * the mount node instead of leaving the user staring at an empty div.
 * The original error is logged so future regressions are loud, not silent.
 *
 * Each island gets its own boundary so one failing tab doesn't take down
 * the rest of the admin shell.
 */
export class IslandErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error(
      `[react-island] "${this.props.islandId}" failed to render:`,
      error,
      info.componentStack,
    );
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div
          role="alert"
          data-island-error={this.props.islandId}
          style={{
            margin: '12px 0',
            padding: '12px 16px',
            border: '1px solid #fecaca',
            background: '#fef2f2',
            color: '#991b1b',
            borderRadius: 6,
            fontFamily: 'system-ui, sans-serif',
            fontSize: 14,
            lineHeight: 1.4,
          }}
        >
          <strong style={{ display: 'block', marginBottom: 4 }}>
            This panel failed to load.
          </strong>
          <span style={{ color: '#7f1d1d' }}>
            {this.state.error.message || String(this.state.error)}
          </span>
          <div style={{ marginTop: 6, fontSize: 12, color: '#7f1d1d' }}>
            See the browser console for details. Other tabs should still work.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default IslandErrorBoundary;
