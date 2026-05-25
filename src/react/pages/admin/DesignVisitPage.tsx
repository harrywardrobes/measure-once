import React from 'react';
import { Box, Button, Card, CardContent, Stack, Typography } from '@mui/material';

/**
 * Admin → Design visit tab (#tab-designvisit).
 *
 * Four sub-cards. Legacy `loadDvCatalogue()` / `loadDvHandles()` /
 * `loadDvFurniture()` / `loadDvDoorStyles()` / `loadDvTerms()` write
 * into the four mount divs below; the `+ Add …` buttons and the
 * Publish editor read inputs from `#dv-terms-new-text` etc.
 */

function callGlobal(name: string, ...args: unknown[]): void {
  const fn = (window as unknown as Record<string, unknown>)[name];
  if (typeof fn === 'function') (fn as (...a: unknown[]) => unknown)(...args);
}

function SectionCard({
  title,
  description,
  buttonLabel,
  legacyOnclick,
  children,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  legacyOnclick: string;
  children: React.ReactNode;
}) {
  // The DV catalogue admin Puppeteer suites (test:dv-catalogue-admin /
  // test:dv-catalogue-image-upload) locate the add buttons by selectors like
  // `button[onclick="openDvHandleEditor()"]`. We must keep the raw `onclick`
  // attribute on the rendered DOM node so those selectors continue to match.
  // The attribute is also a working fallback handler (the editors are
  // attached to `window`).
  const buttonRef = (node: HTMLButtonElement | null) => {
    if (node) node.setAttribute('onclick', legacyOnclick);
  };
  return (
    <Card variant="outlined">
      <CardContent>
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            gap: 2,
            mb: 2,
          }}
        >
          <Box>
            <Typography variant="h6">{title}</Typography>
            <Typography variant="body2" color="text.secondary">{description}</Typography>
          </Box>
          <Button variant="contained" ref={buttonRef} sx={{ flexShrink: 0 }}>
            {buttonLabel}
          </Button>
        </Box>
        {children}
      </CardContent>
    </Card>
  );
}

export function DesignVisitPage() {
  return (
    <Stack spacing={2}>
      <SectionCard
        title="Design Visit — Handles"
        description="Handle options displayed in the design visit wizard for the customer to choose from."
        buttonLabel="+ Add handle"
        legacyOnclick="openDvHandleEditor()"
      >
        <div id="dv-handles-wrap">
          <p className="admin-msg admin-msg--muted">Loading…</p>
        </div>
      </SectionCard>

      <SectionCard
        title="Design Visit — Furniture Ranges"
        description="Furniture ranges displayed in the design visit wizard."
        buttonLabel="+ Add range"
        legacyOnclick="openDvFurnitureEditor()"
      >
        <div id="dv-furniture-wrap">
          <p className="admin-msg admin-msg--muted">Loading…</p>
        </div>
      </SectionCard>

      <SectionCard
        title="Design Visit — Door Styles"
        description="Door styles the designer can select per room in the wizard."
        buttonLabel="+ Add style"
        legacyOnclick="openDvDoorStyleEditor()"
      >
        <div id="dv-door-styles-wrap">
          <p className="admin-msg admin-msg--muted">Loading…</p>
        </div>
      </SectionCard>

      <Card variant="outlined" id="dv-terms-card">
        <CardContent>
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 2,
              mb: 2,
            }}
          >
            <Box>
              <Typography variant="h6">Design Visit — Terms &amp; Conditions</Typography>
              <Typography variant="body2" color="text.secondary">
                Each published revision is versioned and stamped on the visit at submission time.
                Customers always see the version that was active when their visit was submitted.
              </Typography>
            </Box>
            <Button
              variant="contained"
              onClick={() => callGlobal('openPublishTermsEditor')}
              sx={{ flexShrink: 0 }}
            >
              Publish new version
            </Button>
          </Box>

          <div id="dv-terms-current" className="adm-mb-14">
            <p className="admin-msg admin-msg--muted">Loading…</p>
          </div>

          {/* Inline publish editor (hidden by default; legacy code toggles .hidden). */}
          <div id="dv-terms-editor" className="hidden adm-terms-editor">
            <div className="adm-terms-editor-head">
              New terms text (will become the active version)
            </div>
            <textarea
              id="dv-terms-new-text"
              className="field adm-terms-textarea"
              rows={8}
              maxLength={4000}
              placeholder="Enter the full terms and conditions text…"
            />
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 1,
                mt: 1,
              }}
            >
              <Button variant="text" onClick={() => callGlobal('closeDvTermsEditor')}>
                Cancel
              </Button>
              <Button
                variant="contained"
                onClick={() => callGlobal('publishDvTermsVersion')}
              >
                Publish
              </Button>
            </Box>
            <div id="dv-terms-publish-err" className="hidden adm-terms-publish-err" />
          </div>

          <div id="dv-terms-history" className="adm-mt-8" />
        </CardContent>
      </Card>
    </Stack>
  );
}

export default DesignVisitPage;
