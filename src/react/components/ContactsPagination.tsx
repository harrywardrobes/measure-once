import React from 'react';
import { Pagination, Stack, Typography } from '@mui/material';

export function buildPaginationLabel(
  page: number,
  pageLimit: number,
  visibleCount: number,
  total: number,
): string {
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
        {buildPaginationLabel(page, pageLimit, visibleCount, total)}
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
