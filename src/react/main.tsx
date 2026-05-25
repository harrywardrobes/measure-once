import React from 'react';
import { createRoot } from 'react-dom/client';
import { Pill } from './components/Pill';

function App() {
  return (
    <main style={{ padding: 24, fontFamily: 'Open Sans, system-ui, sans-serif' }}>
      <h1 style={{ marginTop: 0 }}>React island</h1>
      <p>
        This entry point exists so future React components have a place to
        live alongside the legacy <code>public/</code> pages. See Storybook
        for the component catalogue.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Pill label="neutral" />
        <Pill label="success" variant="success" />
        <Pill label="danger" variant="danger" />
        <Pill label="warn" variant="warn" />
        <Pill label="info" variant="info" />
      </div>
    </main>
  );
}

const mount = document.getElementById('root');
if (mount) {
  createRoot(mount).render(<App />);
}
