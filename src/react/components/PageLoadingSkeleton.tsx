import React, { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import MuiSkeleton from '@mui/material/Skeleton';

const DELAY_MS = 200;

function useVisible() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setVisible(true), DELAY_MS);
    return () => clearTimeout(id);
  }, []);
  return visible;
}

/**
 * Generic Suspense fallback — a few grey bars that work for any panel.
 * Used for admin tabs and other low-traffic pages.
 */
export function PageLoadingSkeleton() {
  const visible = useVisible();
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
export function CustomersPageSkeleton() {
  const visible = useVisible();
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
export function CalendarPageSkeleton() {
  const visible = useVisible();
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
 * Shape-matched skeleton for HomePage.
 *
 * Mirrors the real page structure:
 *   • Big date header (day name + date)
 *   • "My Tasks" section + 3 task cards
 *   • "Upcoming" section + 2 event cards
 *   • "Active Projects" section + 3 project cards
 */
export function HomePageSkeleton() {
  const visible = useVisible();
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
