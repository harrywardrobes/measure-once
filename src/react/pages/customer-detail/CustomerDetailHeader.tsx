import React, { useState } from 'react';
import Tooltip from '@mui/material/Tooltip';
import Box from '@mui/material/Box';
import { PROVIDER_COLORS } from '../../theme';
import { Contact, LeadStatus, contactName } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';
import { LeadStatusPicker } from '../../components/pickers/LeadStatusPicker';
import { PhotosReceivedBadge } from '../../components/PhotosReceivedBadge';
import { buildActivityTooltipContent, type LastAttempt } from '../../utils/activityTooltip';

interface Props {
  contact: Contact;
  leadStatuses: LeadStatus[];
  nullLeadStatusLabel: string;
  onEditContact?: () => void;
  onOpenWhatsApp?: () => void;
  whatsappEnabled?: boolean;
  activityCounter?: string;
  lastAttempt?: LastAttempt;
  depositInvoiceId?: string | null;
  depositInvoiceDocNum?: string | null;
}

export function CustomerDetailHeader({
  contact,
  leadStatuses,
  nullLeadStatusLabel,
  onEditContact,
  onOpenWhatsApp,
  whatsappEnabled,
  activityCounter,
  lastAttempt,
  depositInvoiceId,
  depositInvoiceDocNum,
}: Props) {
  const { isManager, isViewer } = usePrivilege();
  const canEdit = isManager;

  const [pickerAnchorEl, setPickerAnchorEl] = useState<HTMLElement | null>(null);
  const pickerOpen = Boolean(pickerAnchorEl);

  const props      = contact.properties;
  const name       = contactName(contact);
  const email      = props.email || '';
  const bestPhone  = props.phone || props.mobilephone || props.hs_whatsapp_phone_number || '';
  const phoneSource: 'phone' | 'mobile' | 'whatsapp' | null =
    props.phone            ? 'phone'
    : props.mobilephone    ? 'mobile'
    : props.hs_whatsapp_phone_number ? 'whatsapp'
    : null;
  const address    = props.address || '';
  const city       = props.city   || '';
  const zip        = props.zip    || '';
  const customerNum = props.customer_number || '';
  const cityLine   = [city, zip].filter(Boolean).join(' ');

  const rawStatus = props.hs_lead_status || '';

  const pillContent = (() => {
    if (!rawStatus) {
      const label = nullLeadStatusLabel || 'No status';
      return { label, subLabel: null, title: 'Set lead status', empty: true };
    }
    const opt = leadStatuses.find(o => o.value === rawStatus);
    const parentLabel = opt
      ? opt.label
      : rawStatus.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    return { label: parentLabel, subLabel: null, title: 'Change lead status', empty: false };
  })();

  function handlePillClick(e: React.MouseEvent<HTMLElement>) {
    if (!canEdit) return;
    setPickerAnchorEl(e.currentTarget);
  }

  const activityTooltipContent = buildActivityTooltipContent(lastAttempt ?? null, props.notes_last_contacted);

  return (
    <div
      id="workflow-header"
      className="border-b px-4 sm:px-6 py-4 sticky top-0 z-10 shadow-sm"
      style={{ backgroundColor: 'var(--paper)', borderBottomColor: 'var(--stone)' }}
    >
      <div className="customer-header-wrap" style={{ maxWidth: 1100, margin: '0 auto' }}>
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <h1 className="text-xl font-bold truncate" style={{ color: 'var(--ink-1)' }}>{name}</h1>
              {customerNum && (
                <span className="customer-num-badge">{customerNum}</span>
              )}
              {!isViewer && onEditContact && (
                <button
                  className="contact-edit-btn"
                  onClick={onEditContact}
                  title="Edit contact details"
                >
                  <svg width="13" height="13" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                      d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"
                    />
                  </svg>
                </button>
              )}
            </div>

            {(address || cityLine) && (
              <div className="mt-3 space-y-0.5">
                {address  && <div className="text-sm" style={{ color: 'var(--ink-4)' }}>{address}</div>}
                {cityLine && <div className="text-sm" style={{ color: 'var(--ink-4)' }}>{cityLine}</div>}
              </div>
            )}

            {(email || bestPhone) && (
              <div className="mt-3 space-y-1">
                {email && (
                  <div>
                    <a href={`mailto:${email}`} className="text-sm hover:underline" style={{ color: 'var(--orchid)' }}>
                      {email}
                    </a>
                  </div>
                )}
                {bestPhone && (
                  <div className="text-sm flex items-center gap-1.5" style={{ color: 'var(--ink-4)' }}>
                    <a href={`tel:${bestPhone}`} className="hover:underline" style={{ color: 'inherit' }}>{bestPhone}</a>
                    {phoneSource === 'mobile' && (
                      <span
                        title="Mobile number"
                        style={{
                          fontSize: '0.65rem', fontWeight: 600, lineHeight: 1,
                          padding: '2px 5px', borderRadius: 4,
                          background: 'var(--stone)', color: 'var(--ink-3)',
                          letterSpacing: '0.02em', flexShrink: 0,
                        }}
                      >
                        Mobile
                      </span>
                    )}
                    {phoneSource === 'whatsapp' && (
                      <span
                        title="WhatsApp number"
                        style={{
                          fontSize: '0.65rem', fontWeight: 600, lineHeight: 1,
                          padding: '2px 5px', borderRadius: 4,
                          background: PROVIDER_COLORS.whatsAppBadgeBg, color: PROVIDER_COLORS.whatsAppBadgeText,
                          letterSpacing: '0.02em', flexShrink: 0,
                        }}
                      >
                        WhatsApp
                      </span>
                    )}
                    {whatsappEnabled && !isViewer && onOpenWhatsApp && (
                      <button
                        onClick={onOpenWhatsApp}
                        title="Send WhatsApp message"
                        style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 22, height: 22, borderRadius: '50%', background: PROVIDER_COLORS.whatsApp,
                          border: 'none', cursor: 'pointer', flexShrink: 0, padding: 0,
                          verticalAlign: 'middle',
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="white">
                          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                        </svg>
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
            {depositInvoiceId && (
              <a
                href={`/invoices#inv-${encodeURIComponent(depositInvoiceId)}`}
                title="View deposit invoice"
                style={{
                  fontSize: '0.72rem', fontWeight: 600, lineHeight: 1,
                  padding: '3px 7px', borderRadius: 6,
                  background: 'var(--surface-muted)',
                  border: '1px solid var(--orchid)',
                  color: 'var(--orchid)',
                  letterSpacing: '0.02em', flexShrink: 0,
                  textDecoration: 'none',
                  cursor: 'pointer',
                }}
              >
                {depositInvoiceDocNum ? `Deposit inv. #${depositInvoiceDocNum}` : 'Deposit invoice'}
              </a>
            )}
            {activityCounter && (
              <Tooltip
                title={activityTooltipContent}
                arrow
                placement="bottom"
                enterDelay={200}
              >
                <span
                  style={{
                    fontSize: '0.72rem', fontWeight: 600, lineHeight: 1,
                    padding: '3px 7px', borderRadius: 6,
                    background: 'var(--stone)', color: 'var(--ink-3)',
                    letterSpacing: '0.02em', flexShrink: 0,
                    fontVariantNumeric: 'tabular-nums',
                    cursor: 'default',
                  }}
                >
                  {activityCounter}
                </span>
              </Tooltip>
            )}
            <PhotosReceivedBadge leadStatus={rawStatus} />
            <span
              className={`lead-status-badge${pillContent.empty ? ' lsb-empty' : ''}${canEdit ? ' lsb-clickable' : ''}`}
              title={pillContent.title}
              onClick={canEdit ? handlePillClick : undefined}
              style={{ cursor: canEdit ? 'pointer' : 'default' }}
            >
              {pillContent.label}
              {pillContent.subLabel && (
                <span className="ls-pill-parent">{pillContent.subLabel}</span>
              )}
            </span>
          </div>
        </div>
      </div>

      <LeadStatusPicker
        anchorEl={pickerAnchorEl}
        open={pickerOpen}
        onClose={() => setPickerAnchorEl(null)}
        contactId={contact.id}
        currentStatus={props.hs_lead_status || ''}
      />
    </div>
  );
}
