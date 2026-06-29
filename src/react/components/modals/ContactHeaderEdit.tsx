import React, { lazy, Suspense, useState } from 'react';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { GET } from '../../utils/api';
import { formatAddress } from '../../../../shared/address';
import { contactName, type Contact } from '../../pages/customer-detail/types';

// Itself lazy-loaded by ModalContactHeader, so the contact-edit form and its
// address-autocomplete deps never reach the always-loaded bundle.
const ContactEditModal = lazy(() =>
  import('../../pages/customer-detail/ContactEditModal').then((m) => ({ default: m.ContactEditModal })),
);

/** Pre-formatted contact values for the header to display after an edit. */
export interface ContactHeaderDisplay {
  name: string;
  email: string;
  phone: string;
  mobile: string;
  address: string;
}

interface Props {
  contactId: string;
  /** Receives the new display values (for in-place header update) and the full contact. */
  onSaved: (display: ContactHeaderDisplay, updated: Contact) => void;
  /** Surfaces a load error in the header (cleared on the next attempt). */
  onError: (message: string) => void;
}

/**
 * The pencil button + contact-edit flow for ModalContactHeader. Fetches the
 * full contact on click (the header only carries display fields) and opens the
 * shared ContactEditModal. Kept in its own chunk so the heavier imports load
 * only when an operator actually edits.
 */
export function ContactHeaderEdit({ contactId, onSaved, onError }: Props) {
  const [fullContact, setFullContact] = useState<Contact | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [fetching, setFetching] = useState(false);

  async function handleClick() {
    onError('');
    if (fullContact) { setEditOpen(true); return; }
    setFetching(true);
    try {
      const c = await GET<Contact & { structuredAddress?: Contact['properties']['structuredAddress'] }>(
        `/api/contacts/${encodeURIComponent(contactId)}`,
      );
      // The endpoint returns the structured address alongside the raw HubSpot
      // props; fold it into properties so ContactEditModal reads it canonically.
      if (c.structuredAddress && !c.properties.structuredAddress) {
        c.properties.structuredAddress = c.structuredAddress;
      }
      setFullContact(c);
      setEditOpen(true);
    } catch (e) {
      onError((e as Error).message || 'Could not load contact details.');
    } finally {
      setFetching(false);
    }
  }

  function handleSaved(updated: Contact) {
    const p = updated.properties;
    onSaved(
      {
        name:    contactName(updated),
        email:   p.email || '',
        phone:   p.phone || '',
        mobile:  p.mobilephone || '',
        address: p.structuredAddress ? formatAddress(p.structuredAddress) : '',
      },
      updated,
    );
    setFullContact(updated);
  }

  return (
    <>
      <Tooltip title="Edit contact details">
        <span>
          <IconButton
            size="small"
            onClick={handleClick}
            disabled={fetching}
            data-testid="modal-contact-edit-btn"
            aria-label="Edit contact details"
            sx={{ color: 'text.secondary', p: 0.25 }}
          >
            {fetching ? <CircularProgress size={14} /> : <EditOutlinedIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </span>
      </Tooltip>
      {fullContact && (
        <Suspense fallback={null}>
          <ContactEditModal
            contact={fullContact}
            open={editOpen}
            onClose={() => setEditOpen(false)}
            onSaved={handleSaved}
          />
        </Suspense>
      )}
    </>
  );
}
