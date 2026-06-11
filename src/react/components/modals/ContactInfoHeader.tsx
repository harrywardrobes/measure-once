import React from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import EmailIcon from '@mui/icons-material/Email';

interface Props {
  name?: string;
  phone?: string;
  mobile?: string;
  whatsapp?: string;
  email?: string;
  loading?: boolean;
}

function PhoneLine({ label, number }: { label: string; number: string }) {
  return (
    <Box>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Link
        href={`tel:${number.replace(/\s+/g, '')}`}
        underline="none"
        color="text.primary"
        variant="h6"
        sx={{ fontWeight: 600, lineHeight: 1.3, display: 'inline-block' }}
      >
        {number}
      </Link>
    </Box>
  );
}

/**
 * Shared contact-info block rendered at the top of card-action modals.
 * Phone numbers are tel: links (tap to dial); email is shown as plain text
 * with a mail icon. Renders a warning when no contact methods are present
 * and Skeleton placeholders while loading. Always ends with a Divider.
 */
export function ContactInfoHeader({ name, phone, mobile, whatsapp, email, loading }: Props) {
  if (loading) {
    return (
      <Box>
        <Stack spacing={0.75} sx={{ mb: 1.5 }}>
          <Skeleton variant="text" width="55%" height={28} />
          <Skeleton variant="text" width="40%" height={24} />
          <Skeleton variant="text" width="45%" height={24} />
        </Stack>
        <Divider />
      </Box>
    );
  }

  const hasAny = !!(phone || mobile || whatsapp || email);

  return (
    <Box>
      <Stack spacing={1} sx={{ mb: 1.5 }}>
        {name && (
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{name}</Typography>
        )}
        {hasAny ? (
          <Stack spacing={0.75}>
            {phone && <PhoneLine label="Phone" number={phone} />}
            {mobile && <PhoneLine label="Mobile" number={mobile} />}
            {whatsapp && <PhoneLine label="WhatsApp" number={whatsapp} />}
            {email && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <EmailIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                <Typography variant="body2" sx={{ color: 'text.primary' }}>{email}</Typography>
              </Box>
            )}
          </Stack>
        ) : (
          <Alert severity="warning" sx={{ py: 0 }}>
            No contact details on record for this contact.
          </Alert>
        )}
      </Stack>
      <Divider />
    </Box>
  );
}
