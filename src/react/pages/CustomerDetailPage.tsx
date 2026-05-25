import React from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';

/**
 * <CustomerDetailPage/> — React + MUI port of the legacy `/customers/:id`
 * page (task #750).
 *
 * STATUS: scaffold only. The live page still renders via the legacy
 * `public/customer-detail.js` and its sibling scripts; this component is not
 * yet mounted into `public/customer-detail.html` and is not yet listed in
 * `main.tsx`'s `MOUNTS` table.
 *
 * Why scaffold-only: the legacy page is 2.4k lines plus ~4k lines of
 * dependencies and is covered by four E2E test suites whose harnesses are
 * tightly coupled to legacy DOM ids/classes and to global functions like
 * `renderWorkflowStages()` / `renderDesignVisits()` / `state.selectedContact`.
 * Porting it section-by-section while keeping those harnesses green is
 * planned across multiple sessions — see `.local/session_plan.md` for the
 * breakdown.
 *
 * Each `<SectionSlot/>` below is a placeholder for one of the focused child
 * components the eventual port will introduce (`CustomerDetailHeader`,
 * `LeadStatusRail`, `SubStatusPanel`, `DesignVisitsList`, `CommentsThread`,
 * `CardActionStrip`, …). They render nothing today.
 */
function SectionSlot({ name }: { name: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, color: 'text.disabled' }}>
      <Typography variant="caption">{name} (scaffold)</Typography>
    </Paper>
  );
}

export function CustomerDetailPage() {
  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto', p: { xs: 2, sm: 3 } }}>
      <Stack spacing={2}>
        <SectionSlot name="CustomerDetailHeader" />
        <SectionSlot name="CommentsThread" />
        <SectionSlot name="RoomsTabs" />
        <SectionSlot name="CustomerInvoices" />
        <SectionSlot name="UpcomingVisits" />
        <SectionSlot name="PastVisits" />
        <SectionSlot name="DesignVisitsList" />
        <SectionSlot name="TasksList" />
        <SectionSlot name="GoogleEmails" />
        <SectionSlot name="WhatsAppHistory" />
        <SectionSlot name="LeadStatusRail + SubStatusPanel" />
      </Stack>
    </Box>
  );
}

export default CustomerDetailPage;
