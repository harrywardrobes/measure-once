import React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import { BRAND_COLORS } from '../theme';

export function NotFoundPage() {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
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
          component="p"
          sx={{
            fontSize: '3.25rem',
            fontWeight: 800,
            color: BRAND_COLORS.plum,
            lineHeight: 1,
            mb: '14px',
            letterSpacing: '-0.02em',
          }}
        >
          404
        </Typography>

        <Typography
          variant="h3"
          component="h1"
          sx={{ mb: '8px', color: BRAND_COLORS.ink1, letterSpacing: '-0.01em' }}
        >
          We measured twice&hellip; this page still isn&rsquo;t here.
        </Typography>

        <Typography
          variant="body1"
          sx={{ color: BRAND_COLORS.ink2, mb: '28px' }}
        >
          Looks like this one&rsquo;s been fitted elsewhere.
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
