import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MuiSkeleton from '@mui/material/Skeleton';

const DELAY_MS = 200;

function useVisible(forceVisible?: boolean) {
  const [visible, setVisible] = useState(!!forceVisible);
  useEffect(() => {
    if (forceVisible) return;
    const id = setTimeout(() => setVisible(true), DELAY_MS);
    return () => clearTimeout(id);
  }, [forceVisible]);
  return visible;
}

/**
 * Generic Suspense fallback — a few grey bars that work for any panel.
 * Used for admin tabs and other low-traffic pages.
 */
export function PageLoadingSkeleton({ forceVisible }: { forceVisible?: boolean } = {}) {
  const visible = useVisible(forceVisible);
  if (!visible) return null;

  return (
    <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <MuiSkeleton variant="text" width="45%" height={24} />
      <MuiSkeleton variant="text" width="80%" />
      <MuiSkeleton variant="text" width="65%" />
      <MuiSkeleton variant="text" width="72%" />
    </Box>
  );
}

/**
 * Shape-matched skeleton for CustomersPage.
 *
 * Mirrors the real page structure:
 *   • Stage filter tabs row
 *   • Search bar + filter dropdowns + sort
 *   • 4 CustomerCard outlines (name/status chip, stage pills, contact chips)
 *   • Pagination row
 */
export function CustomersPageSkeleton({ forceVisible }: { forceVisible?: boolean } = {}) {
  const visible = useVisible(forceVisible);
  if (!visible) return null;

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto', px: 2, pt: 2 }}>
      {/* Stage filter tabs */}
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        {[70, 50, 90, 80, 100, 80].map((w, i) => (
          <MuiSkeleton key={i} variant="rounded" width={w} height={32} />
        ))}
      </Stack>

      {/* Search bar + dropdowns */}
      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <MuiSkeleton variant="rounded" sx={{ flex: 1 }} height={40} />
        <MuiSkeleton variant="rounded" width={140} height={40} />
        <MuiSkeleton variant="rounded" width={130} height={40} />
        <MuiSkeleton variant="rounded" width={110} height={40} />
      </Stack>

      {/* 4 customer cards */}
      <Stack spacing={1.5}>
        {[0, 1, 2, 3].map((i) => (
          <Box
            key={i}
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 2,
              p: 1.5,
            }}
          >
            {/* Name + lead-status chip */}
            <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
              <MuiSkeleton variant="text" width="35%" height={20} />
              <MuiSkeleton variant="rounded" width={90} height={22} />
            </Stack>
            {/* Stage pills */}
            <Stack direction="row" spacing={0.75} sx={{ mb: 1 }}>
              {[80, 100, 75].map((w, j) => (
                <MuiSkeleton key={j} variant="rounded" width={w} height={24} />
              ))}
            </Stack>
            {/* Contact chips */}
            <Stack direction="row" spacing={0.75}>
              {[120, 100, 60].map((w, j) => (
                <MuiSkeleton key={j} variant="rounded" width={w} height={20} />
              ))}
            </Stack>
          </Box>
        ))}
      </Stack>

      {/* Pagination row */}
      <Stack direction="row" sx={{ mt: 2, justifyContent: 'space-between', alignItems: 'center' }}>
        <MuiSkeleton variant="text" width={120} />
        <MuiSkeleton variant="rounded" width={180} height={32} />
      </Stack>
    </Box>
  );
}

/**
 * Shape-matched skeleton for CalendarPage.
 *
 * Mirrors the real page structure:
 *   • Toolbar (prev/next/Today + date range + "New visit")
 *   • Two mini month-grid calendars side by side (header + 5-row × 7-col grid)
 *   • 3 agenda day rows (date label + 1–2 event cards)
 */
export function CalendarPageSkeleton({ forceVisible }: { forceVisible?: boolean } = {}) {
  const visible = useVisible(forceVisible);
  if (!visible) return null;

  const MiniMonth = () => (
    <Box sx={{ flex: 1 }}>
      {/* Month/year heading */}
      <MuiSkeleton variant="text" width="60%" height={20} sx={{ mb: 0.5 }} />
      {/* 7-column day-of-week header */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0.25, mb: 0.25 }}>
        {Array.from({ length: 7 }).map((_, i) => (
          <MuiSkeleton key={i} variant="text" height={14} />
        ))}
      </Box>
      {/* 5 weeks × 7 day cells */}
      {Array.from({ length: 5 }).map((_, week) => (
        <Box
          key={week}
          sx={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0.25, mb: 0.25 }}
        >
          {Array.from({ length: 7 }).map((_, day) => (
            <MuiSkeleton key={day} variant="rounded" height={26} />
          ))}
        </Box>
      ))}
    </Box>
  );

  return (
    <Box sx={{ maxWidth: 960, mx: 'auto', px: 2, pt: 2 }}>
      {/* Toolbar */}
      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'center' }}>
        <MuiSkeleton variant="circular" width={32} height={32} />
        <MuiSkeleton variant="circular" width={32} height={32} />
        <MuiSkeleton variant="rounded" width={72} height={32} />
        <MuiSkeleton variant="text" width={160} height={28} sx={{ ml: 1, flex: 1 }} />
        <MuiSkeleton variant="rounded" width={100} height={36} />
      </Stack>

      {/* Two mini month grids */}
      <Stack direction="row" spacing={3} sx={{ mb: 3 }}>
        <MiniMonth />
        <MiniMonth />
      </Stack>

      {/* 3 agenda day rows */}
      <Stack spacing={2}>
        {[1, 2, 3].map((day) => (
          <Stack key={day} direction="row" spacing={2}>
            {/* Sticky date label */}
            <Box sx={{ width: 48, pt: 0.5 }}>
              <MuiSkeleton variant="text" width={36} height={18} />
              <MuiSkeleton variant="text" width={28} height={14} />
            </Box>
            {/* Event cards */}
            <Stack spacing={1} sx={{ flex: 1 }}>
              {Array.from({ length: day === 2 ? 2 : 1 }).map((_, i) => (
                <Box
                  key={i}
                  sx={{
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 1.5,
                    p: 1.25,
                  }}
                >
                  <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                    <MuiSkeleton variant="rounded" width={4} height={40} />
                    <Box sx={{ flex: 1 }}>
                      <MuiSkeleton variant="text" width="55%" height={18} />
                      <MuiSkeleton variant="text" width="35%" height={14} />
                    </Box>
                    <MuiSkeleton variant="rounded" width={60} height={22} />
                  </Stack>
                </Box>
              ))}
            </Stack>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

/**
 * Shape-matched skeleton for ProfilePage.
 *
 * Mirrors the real page structure:
 *   • Back button
 *   • IdentityCard — avatar circle + name + email
 *   • RoleCard — overline label + one label/value row
 *   • ChangePasswordCard — card with a button row
 *   • AccountActionsCard — action-list rows
 */
export function ProfilePageSkeleton({ forceVisible }: { forceVisible?: boolean } = {}) {
  const visible = useVisible(forceVisible);
  if (!visible) return null;

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto', px: 2, py: 2 }}>
      {/* Back button */}
      <MuiSkeleton variant="rounded" width={72} height={28} sx={{ mb: 2 }} />

      {/* IdentityCard */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2, mb: 1.5 }}>
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
          <MuiSkeleton variant="circular" width={64} height={64} />
          <Box sx={{ flex: 1 }}>
            <MuiSkeleton variant="text" width="50%" height={28} />
            <MuiSkeleton variant="text" width="65%" height={18} />
          </Box>
        </Stack>
      </Box>

      {/* RoleCard */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2, mb: 1.5 }}>
        <MuiSkeleton variant="text" width={120} height={14} sx={{ mb: 1.5 }} />
        <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
          <MuiSkeleton variant="text" width={60} height={18} />
          <MuiSkeleton variant="text" width={80} height={18} />
        </Stack>
      </Box>

      {/* ChangePasswordCard */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2, mb: 1.5 }}>
        <MuiSkeleton variant="text" width={130} height={14} sx={{ mb: 1.5 }} />
        <MuiSkeleton variant="rounded" width={140} height={34} />
      </Box>

      {/* AccountActionsCard */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, overflow: 'hidden', mb: 1.5 }}>
        <Box sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
          <MuiSkeleton variant="text" width={100} height={20} />
        </Box>
        <Box sx={{ px: 2, py: 1.5 }}>
          <MuiSkeleton variant="text" width={80} height={20} />
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Shape-matched skeleton for AdminTeamPage.
 *
 * Mirrors the real page structure:
 *   • Team card — heading + chip + 4-row table skeleton
 *   • Add team member card — heading + subtitle + a few field outlines
 */
export function AdminTeamPageSkeleton({ forceVisible }: { forceVisible?: boolean } = {}) {
  const visible = useVisible(forceVisible);
  if (!visible) return null;

  return (
    <Stack spacing={3}>
      {/* Team table card */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}>
        {/* Heading row */}
        <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'center' }}>
          <MuiSkeleton variant="text" width={48} height={28} />
          <MuiSkeleton variant="rounded" width={28} height={22} />
        </Stack>

        {/* Table header */}
        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
          {[160, 100, 80, 90, 70, 60].map((w, i) => (
            <MuiSkeleton key={i} variant="text" width={w} height={14} />
          ))}
        </Stack>

        {/* 4 table rows */}
        <Stack spacing={1.25}>
          {[0, 1, 2, 3].map((i) => (
            <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              {/* Avatar + name/email */}
              <MuiSkeleton variant="circular" width={32} height={32} sx={{ flexShrink: 0 }} />
              <Box sx={{ width: 128 }}>
                <MuiSkeleton variant="text" width="80%" height={16} />
                <MuiSkeleton variant="text" width="100%" height={12} />
              </Box>
              {/* Job role */}
              <MuiSkeleton variant="text" width={80} height={16} />
              {/* Privilege chip */}
              <MuiSkeleton variant="rounded" width={64} height={22} />
              {/* Status chip */}
              <MuiSkeleton variant="rounded" width={60} height={22} />
              {/* Joined date */}
              <MuiSkeleton variant="text" width={52} height={16} />
              {/* Action button */}
              <MuiSkeleton variant="rounded" width={48} height={28} sx={{ ml: 'auto' }} />
            </Stack>
          ))}
        </Stack>
      </Box>

      {/* Add team member card */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}>
        <MuiSkeleton variant="text" width={160} height={28} sx={{ mb: 0.5 }} />
        <MuiSkeleton variant="text" width="70%" height={16} sx={{ mb: 2 }} />
        <MuiSkeleton variant="text" width={110} height={14} sx={{ mb: 1 }} />
        <Stack spacing={1.5}>
          <MuiSkeleton variant="rounded" height={48} />
          <Stack direction="row" spacing={1.5}>
            <MuiSkeleton variant="rounded" height={48} sx={{ flex: 1 }} />
            <MuiSkeleton variant="rounded" height={48} sx={{ flex: 1 }} />
          </Stack>
          <MuiSkeleton variant="rounded" width={120} height={36} />
        </Stack>
      </Box>
    </Stack>
  );
}

/**
 * Shape-matched skeleton for AdminPermissionsPage.
 *
 * Mirrors the real page structure:
 *   • "Manage job roles" card — heading + subtitle + add-role form row + 3 role rows
 *   • "Permissions matrix" card — heading + table (feature column + 3 privilege columns)
 *     + save button row
 */
export function AdminPermissionsPageSkeleton() {
  const visible = useVisible();
  if (!visible) return null;

  return (
    <Stack spacing={3}>
      {/* Manage job roles card */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}>
        <MuiSkeleton variant="text" width={160} height={28} sx={{ mb: 0.5 }} />
        <MuiSkeleton variant="text" width="65%" height={16} sx={{ mb: 2 }} />

        {/* Add-role form row */}
        <Stack direction="row" spacing={1.5} sx={{ mb: 2 }}>
          <MuiSkeleton variant="rounded" height={40} sx={{ flex: 1 }} />
          <MuiSkeleton variant="rounded" width={140} height={40} />
          <MuiSkeleton variant="rounded" width={96} height={40} />
        </Stack>

        {/* 3 role list rows */}
        <Stack spacing={1}>
          {[0, 1, 2].map((i) => (
            <Stack key={i} direction="row" spacing={1.5}
              sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1, alignItems: 'center' }}>
              <MuiSkeleton variant="text" width="40%" height={18} sx={{ flex: 1 }} />
              <MuiSkeleton variant="rounded" width={140} height={36} />
              <MuiSkeleton variant="circular" width={28} height={28} />
            </Stack>
          ))}
        </Stack>
      </Box>

      {/* Permissions matrix card */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}>
        <MuiSkeleton variant="text" width={180} height={28} sx={{ mb: 2 }} />

        {/* Table header */}
        <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
          <MuiSkeleton variant="text" width="35%" height={16} />
          {[0, 1, 2].map((i) => (
            <MuiSkeleton key={i} variant="rounded" width={72} height={24} sx={{ ml: 'auto' }} />
          ))}
        </Stack>

        {/* Section group header */}
        <MuiSkeleton variant="text" width={100} height={14} sx={{ mb: 0.75 }} />

        {/* 5 feature rows */}
        <Stack spacing={0.75} sx={{ mb: 2 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Stack key={i} direction="row" spacing={1} sx={{ alignItems: 'center' }}>
              <Box sx={{ flex: 1 }}>
                <MuiSkeleton variant="text" width="45%" height={16} />
                <MuiSkeleton variant="text" width="60%" height={12} />
              </Box>
              {[0, 1, 2].map((j) => (
                <MuiSkeleton key={j} variant="circular" width={28} height={28} sx={{ flexShrink: 0 }} />
              ))}
            </Stack>
          ))}
        </Stack>

        {/* Save button row */}
        <MuiSkeleton variant="rounded" width={140} height={36} />
      </Box>
    </Stack>
  );
}

/**
 * Shape-matched skeleton for AdminRequestsPage.
 *
 * Mirrors the real page structure:
 *   • "Access requests" card — heading + count chip + table rows (name, email, date, buttons)
 *   • "Photo approvals" card — heading
 *   • "Trade submissions" card — heading
 */
export function AdminRequestsPageSkeleton() {
  const visible = useVisible();
  if (!visible) return null;

  return (
    <Stack spacing={3}>
      {/* Access requests card */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}>
        <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: 'center' }}>
          <MuiSkeleton variant="text" width={140} height={28} />
          <MuiSkeleton variant="rounded" width={28} height={22} />
        </Stack>

        {/* Table header */}
        <Stack direction="row" spacing={2} sx={{ mb: 1 }}>
          {[100, 160, 80].map((w, i) => (
            <MuiSkeleton key={i} variant="text" width={w} height={14} />
          ))}
        </Stack>

        {/* 3 request rows */}
        <Stack spacing={1.25}>
          {[0, 1, 2].map((i) => (
            <Stack key={i} direction="row" spacing={2} sx={{ alignItems: 'center' }}>
              <MuiSkeleton variant="text" width={110} height={18} />
              <MuiSkeleton variant="text" width={160} height={18} />
              <MuiSkeleton variant="text" width={80} height={18} />
              <Stack direction="row" spacing={1} sx={{ ml: 'auto' }}>
                <MuiSkeleton variant="rounded" width={72} height={28} />
                <MuiSkeleton variant="rounded" width={60} height={28} />
              </Stack>
            </Stack>
          ))}
        </Stack>
      </Box>

      {/* Photo approvals card */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}>
        <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
          <MuiSkeleton variant="text" width={140} height={28} />
        </Stack>
        <MuiSkeleton variant="text" width="50%" height={16} />
      </Box>

      {/* Trade submissions card */}
      <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}>
        <MuiSkeleton variant="text" width={160} height={28} sx={{ mb: 1 }} />
        <MuiSkeleton variant="text" width="45%" height={16} />
      </Box>
    </Stack>
  );
}

/**
 * Shape-matched skeleton for AdminAuditLogPage.
 *
 * Mirrors the real page structure:
 *   • Single card — heading + "read-only" chip + subtitle
 *   • 6 audit entry rows (date label + action chip + label text + meta caption)
 */
export function AdminAuditLogPageSkeleton() {
  const visible = useVisible();
  if (!visible) return null;

  return (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 2 }}>
      {/* Heading row */}
      <Stack direction="row" spacing={1} sx={{ mb: 1, alignItems: 'center' }}>
        <MuiSkeleton variant="text" width={90} height={28} />
        <MuiSkeleton variant="rounded" width={74} height={22} />
      </Stack>
      <MuiSkeleton variant="text" width="65%" height={16} sx={{ mb: 2 }} />

      {/* 6 audit entry rows */}
      <Stack spacing={0}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Stack key={i} direction="row" spacing={2}
            sx={{ py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
            {/* Date label */}
            <MuiSkeleton variant="text" width={120} height={14} sx={{ flexShrink: 0 }} />
            {/* Action details */}
            <Box sx={{ flex: 1 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 0.5 }}>
                <MuiSkeleton variant="rounded" width={90} height={22} />
                <MuiSkeleton variant="text" width={i % 2 === 0 ? 160 : 130} height={16} />
              </Stack>
              <MuiSkeleton variant="text" width={i % 3 === 0 ? 200 : 150} height={12} />
            </Box>
          </Stack>
        ))}
      </Stack>
    </Box>
  );
}

/**
 * Shape-matched skeleton for HomePage.
 *
 * Mirrors the real page structure:
 *   • Big date header (day name + date)
 *   • "My Tasks" section + 3 task cards
 *   • "Upcoming" section + 2 event cards
 *   • "Active Projects" section + 3 project cards
 */
export function HomePageSkeleton({ forceVisible }: { forceVisible?: boolean } = {}) {
  const visible = useVisible(forceVisible);
  if (!visible) return null;

  const SectionHeader = ({ width }: { width: number }) => (
    <MuiSkeleton variant="text" width={width} height={14} sx={{ mb: 1 }} />
  );

  const HomeCardSkeleton = ({ hasChip }: { hasChip?: boolean }) => (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 2,
        p: 1.5,
      }}
    >
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <MuiSkeleton variant="text" width="50%" height={18} />
        {hasChip && <MuiSkeleton variant="rounded" width={64} height={22} />}
      </Stack>
      <MuiSkeleton variant="text" width="35%" height={14} sx={{ mt: 0.5 }} />
    </Box>
  );

  return (
    <Box sx={{ maxWidth: 640, mx: 'auto', px: 2, pt: 2 }}>
      {/* Date header */}
      <Box sx={{ mb: 3 }}>
        <MuiSkeleton variant="text" width="40%" height={52} />
        <MuiSkeleton variant="text" width="55%" height={18} />
      </Box>

      {/* My Tasks */}
      <Box sx={{ mb: 3 }}>
        <SectionHeader width={90} />
        <Stack spacing={1}>
          <HomeCardSkeleton />
          <HomeCardSkeleton />
          <HomeCardSkeleton />
        </Stack>
      </Box>

      {/* Upcoming */}
      <Box sx={{ mb: 3 }}>
        <SectionHeader width={80} />
        <Stack spacing={1}>
          <HomeCardSkeleton />
          <HomeCardSkeleton />
        </Stack>
      </Box>

      {/* Active Projects */}
      <Box sx={{ mb: 3 }}>
        <SectionHeader width={110} />
        <Stack spacing={1}>
          <HomeCardSkeleton hasChip />
          <HomeCardSkeleton hasChip />
          <HomeCardSkeleton hasChip />
        </Stack>
      </Box>
    </Box>
  );
}
