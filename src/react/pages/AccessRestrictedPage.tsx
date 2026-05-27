import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import { BRAND_COLORS } from '../theme';

interface AccessRestrictedPageProps {
  /**
   * Gallery-embedding flag. Pass `true` to suppress full-viewport layout when
   * rendering inside the Design System gallery.
   * This page uses the simple boolean variant of the convention.
   * See `src/react/types/gallery.ts` for the full embedding convention.
   */
  embedded?: boolean;
}

export function AccessRestrictedPage({ embedded }: AccessRestrictedPageProps = {}) {
  return (
    <Box
      sx={{
        display: 'flex',
        flex: 1,
        ...(embedded ? { py: 4 } : { minHeight: '100vh' }),
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: BRAND_COLORS.paper,
        p: 3,
      }}
    >
      <Box
        sx={{
          bgcolor: 'background.paper',
          border: `2px solid ${BRAND_COLORS.stone}`,
          borderRadius: '12px',
          boxShadow: '0 2px 6px rgba(0,0,0,.06)',
          maxWidth: 440,
          width: '100%',
          p: '36px',
          textAlign: 'center',
        }}
      >
        <Box sx={{ mb: '28px' }}>
          <Box
            component="img"
            src="/harry-wardrobes-logo.png"
            alt="Harry Wardrobes"
            sx={{ maxWidth: 180, width: '100%', height: 'auto', display: 'inline-block' }}
          />
        </Box>

        <Typography
          variant="h3"
          component="h1"
          sx={{ mb: '10px', color: BRAND_COLORS.ink1, letterSpacing: '-0.01em' }}
        >
          Access restricted
        </Typography>

        <Typography
          variant="body1"
          sx={{ color: BRAND_COLORS.ink2, mb: '28px' }}
        >
          This page is only available to managers and admins.
          <br />
          Contact your admin if you think you should have access.
        </Typography>

        <Button
          variant="contained"
          href="/"
          disableElevation
          sx={{
            bgcolor: BRAND_COLORS.plum,
            color: '#fff',
            px: '28px',
            py: '14px',
            borderRadius: '8px',
            fontWeight: 700,
            fontSize: '1rem',
            letterSpacing: '0.02em',
            '&:hover': { bgcolor: BRAND_COLORS.orchidDeep },
          }}
        >
          Back to home
        </Button>
      </Box>
    </Box>
  );
}
