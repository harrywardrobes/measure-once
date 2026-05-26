import React from 'react';
import { Pagination, Stack, Typography } from '@mui/material';

export function buildPaginationLabel(
  page: number,
  pageLimit: number,
  visibleCount: number,
  total: number,
  totalPages?: number,
): string {
  if (visibleCount === 0) {
    // Client-side filter removed every item on this page; show page position so
    // the user knows they can navigate to other pages that may have visible items.
    const pageCount = totalPages ?? Math.max(1, Math.ceil(total / pageLimit));
    return `Page ${page} of ${pageCount}`;
  }
  const from = Math.min(total, (page - 1) * pageLimit + 1);
  const to = Math.min(total, (page - 1) * pageLimit + visibleCount);
  return `Showing ${from}\u2013${to} of ${total}`;
}

type ContactsPaginationProps = {
  page: number;
  totalPages: number;
  total: number;
  visibleCount: number;
  pageLimit: number;
  onPageChange: (page: number) => void;
};

export function ContactsPagination({
  page,
  totalPages,
  total,
  visibleCount,
  pageLimit,
  onPageChange,
}: ContactsPaginationProps): React.ReactElement | null {
  if (total === 0) return null;
  return (
    <Stack direction="row" sx={{ pt: 1, alignItems: 'center', justifyContent: 'space-between' }}>
      <Typography variant="body2" color="text.secondary">
        {buildPaginationLabel(page, pageLimit, visibleCount, total, totalPages)}
      </Typography>
      {totalPages > 1 ? (
        <Pagination
          count={totalPages}
          page={page}
          onChange={(_, p) => onPageChange(p)}
          size="small"
          color="primary"
        />
      ) : null}
    </Stack>
  );
}
