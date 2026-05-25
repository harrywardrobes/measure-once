import React, { useState } from 'react';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Snackbar from '@mui/material/Snackbar';

/**
 * <ComponentShowcase/> — a single entry in the Design System docs page.
 *
 * Each entry renders a live demo of an MUI component plus a "Show code"
 * toggle revealing the JSX snippet (with a one-click copy button). The
 * snippet is plain text — keeping it as a hand-authored string means
 * what an admin sees is a recipe they can paste into a new page.
 */
export interface ComponentShowcaseProps {
  name: string;
  description?: React.ReactNode;
  demo: React.ReactNode;
  code: string;
}

export function ComponentShowcase({ name, description, demo, code }: ComponentShowcaseProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      /* swallow — clipboard may be unavailable in some contexts */
    }
  }

  return (
    <Paper variant="outlined" sx={{ p: 2.5, mb: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h6" component="h3" sx={{ fontWeight: 700 }}>
          {name}
        </Typography>
        <Button size="small" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide code' : 'Show code'}
        </Button>
      </Box>
      {description && (
        <Typography variant="body2" sx={{ color: 'text.secondary', mb: 1.5 }}>
          {description}
        </Typography>
      )}
      <Box
        sx={{
          p: 2,
          borderRadius: 1,
          bgcolor: 'grey.50',
          border: '1px dashed',
          borderColor: 'divider',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 1.5,
          minHeight: 56,
        }}
      >
        {demo}
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ mt: 1.5, position: 'relative' }}>
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 2,
              pr: 10,
              bgcolor: '#0f172a',
              color: '#e2e8f0',
              borderRadius: 1,
              overflow: 'auto',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12.5,
              lineHeight: 1.5,
            }}
          >
            <code>{code}</code>
          </Box>
          <Button
            size="small"
            variant="contained"
            onClick={handleCopy}
            sx={{ position: 'absolute', top: 8, right: 8 }}
          >
            Copy
          </Button>
        </Box>
      </Collapse>
      <Snackbar
        open={copied}
        autoHideDuration={1500}
        onClose={() => setCopied(false)}
        message="Copied to clipboard"
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      />
    </Paper>
  );
}

export default ComponentShowcase;
