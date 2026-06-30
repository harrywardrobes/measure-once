import React, { lazy, Suspense, useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import EmailIcon from '@mui/icons-material/Email';
import LocationOnIcon from '@mui/icons-material/LocationOn';
import { AddressMapPreview } from '../AddressMapPreview';
import { samePhoneNumber } from '../../utils/formatters';
import { usePrivilege } from '../../hooks/usePrivilege';
import type { Contact } from '../../pages/customer-detail/types';
import type { ContactHeaderDisplay } from './ContactHeaderEdit';

// The edit affordance (pencil button, contact fetch, edit modal) lives in its
// own chunk so its imports stay out of the always-loaded bundle. Only loaded
// when a contactId is supplied and the viewer can edit.
const ContactHeaderEdit = lazy(() =>
  import('./ContactHeaderEdit').then((m) => ({ default: m.ContactHeaderEdit })),
);

interface Props {
  name?: string;
  phone?: string;
  mobile?: string;
  email?: string;
  address?: string;
  loading?: boolean;
  /**
   * When provided (and the viewer has edit rights), a pencil button appears next
   * to the name that opens the shared ContactEditModal. The full contact is
   * fetched on click. Omit to render a read-only header (the original behaviour).
   */
  contactId?: string;
  /**
   * Called after a successful in-modal edit with the updated contact, so a host
   * that tracks its own contact state can stay in sync. The header already
   * updates its own displayed values in place regardless.
   */
  onContactSaved?: (updated: Contact) => void;
}

function PhoneLine({ label, number }: { label: string; number: string }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Link
        href={`tel:${number.replace(/\s+/g, '')}`}
        underline="none"
        color="text.primary"
        variant="h6"
        sx={{ fontWeight: 600, lineHeight: 1.3, display: 'block', wordBreak: 'break-all' }}
      >
        {number}
      </Link>
    </Box>
  );
}

/**
 * Shared contact-info block rendered at the top of card-action modals.
 * Phone numbers are tel: links; email shown with mail icon; optional address
 * shown with a location pin. Renders skeleton placeholders while loading
 * and a warning when no contact methods are present. Always ends with a Divider.
 *
 * When `contactId` is supplied and the viewer is not a read-only viewer, a
 * pencil button next to the name opens the shared ContactEditModal for quick
 * edits without leaving the host modal.
 *
 * Use this in all modals that show a contact header block.
 */
export function ModalContactHeader({ name, phone, mobile, email, address, loading, contactId, onContactSaved }: Props) {
  const { isViewer } = usePrivilege();
  const canEdit = !!contactId && !isViewer;

  // In-place display override applied after a successful edit, so the header
  // reflects the new details immediately without the host having to re-fetch.
  const [override, setOverride] = useState<ContactHeaderDisplay | null>(null);
  const [editError, setEditError] = useState('');

  // Reset edit state whenever the header is pointed at a new contact.
  useEffect(() => {
    setOverride(null);
    setEditError('');
  }, [contactId]);

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

  const dName    = override?.name    ?? name;
  const dPhone   = override?.phone   ?? phone;
  const dMobile  = override?.mobile  ?? mobile;
  const dEmail   = override?.email   ?? email;
  const dAddress = override?.address ?? address;

  const hasAny = !!(dPhone || dMobile || dEmail);

  return (
    <Box>
      <Stack spacing={1} sx={{ mb: 1.5 }}>
        {(dName || canEdit) && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
            {dName && (
              <Typography variant="subtitle1" sx={{ fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {dName}
              </Typography>
            )}
            {canEdit && (
              <Suspense fallback={null}>
                <ContactHeaderEdit
                  contactId={contactId!}
                  onSaved={(display, updated) => { setOverride(display); onContactSaved?.(updated); }}
                  onError={setEditError}
                />
              </Suspense>
            )}
          </Box>
        )}
        {editError && (
          <Alert severity="error" sx={{ py: 0 }}>{editError}</Alert>
        )}
        {hasAny ? (
          <Stack spacing={0.75}>
            {dEmail && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
                <EmailIcon fontSize="small" sx={{ color: 'text.secondary', flexShrink: 0 }} />
                <Typography
                  variant="body2"
                  sx={{ color: 'text.primary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
                >
                  {dEmail}
                </Typography>
              </Box>
            )}
            {/* Mobile is the primary number. The landline is shown beneath it
                only when it's a genuinely different number — if the same number
                was entered in both fields we show it once. */}
            {dMobile && <PhoneLine label="Mobile" number={dMobile} />}
            {dPhone && !(dMobile && samePhoneNumber(dPhone, dMobile)) && (
              <PhoneLine label={dMobile ? 'Phone (home)' : 'Phone'} number={dPhone} />
            )}
            {dAddress && (
              <Box>
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75 }}>
                  <LocationOnIcon fontSize="small" sx={{ color: 'text.secondary', mt: '2px' }} />
                  <Typography variant="body2" color="text.secondary">{dAddress}</Typography>
                </Box>
                <AddressMapPreview address={dAddress} surface="contactEdit" height={140} />
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
