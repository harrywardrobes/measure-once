import React, { useState, useCallback, useEffect } from 'react';
import { WhatsAppMessage } from './types';
import { usePrivilege } from '../../hooks/usePrivilege';

interface Template {
  name: string;
  components?: Array<{ type: string; text?: string }>;
}

interface Props {
  contactId: string;
  phone: string;
  messages: WhatsAppMessage[];
  loading: boolean;
  error: string | null;
  enabled: boolean;
  open: boolean;
  onClose: () => void;
}

export function WhatsAppHistory({ contactId, phone, messages, loading, error, enabled }: Omit<Props, 'open' | 'onClose'>) {
  if (!enabled) return null;
  return (
    <div id="whatsapp-history-section" className="mb-5">
      <div className="notes-header">
        <span className="notes-header-label">WhatsApp history</span>
      </div>
      {loading && <p className="text-sm text-slate-400 italic px-1">Loading…</p>}
      {!loading && error && <p className="text-sm text-red-500 px-1">Could not load WhatsApp history.</p>}
      {!loading && !error && messages.length === 0 && (
        <p className="text-sm text-slate-400 italic px-1">No messages yet.</p>
      )}
      {!loading && !error && messages.length > 0 && (
        <div className="space-y-1.5">
          {messages.map((m, i) => (
            <div key={m.id || i} className={`comment-item wa-msg wa-msg-${m.direction}`}>
              <div className="comment-text">{m.body || ''}</div>
              <div className="comment-meta">
                <span className="comment-date">{m.direction === 'in' ? 'Received' : 'Sent'}</span>
                {m.timestamp && (
                  <>
                    <span className="comment-meta-sep">·</span>
                    <span className="comment-date">
                      {new Date(m.timestamp).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WhatsAppModal({ contactId, phone, open, onClose }: Pick<Props, 'contactId' | 'phone' | 'open' | 'onClose'>) {
  const [mode, setMode]         = useState<'template' | 'freeform'>('template');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [freeText, setFreeText] = useState('');
  const [sending, setSending]   = useState(false);
  const [sendError, setSendError] = useState('');
  const [sendSuccess, setSendSuccess] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTemplatesLoading(true);
    fetch('/api/whatsapp/templates')
      .then(r => r.ok ? r.json() : [])
      .then((ts: Template[]) => { setTemplates(ts); setTemplatesLoading(false); })
      .catch(() => setTemplatesLoading(false));
  }, [open]);

  const send = useCallback(async () => {
    setSending(true);
    setSendError('');
    setSendSuccess(false);
    try {
      const body = mode === 'template'
        ? { contactId, phone, templateName: selectedTemplate }
        : { contactId, phone, freeform: freeText };
      const r = await fetch('/api/whatsapp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      setSendSuccess(true);
      setTimeout(onClose, 1500);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'error';
      setSendError(`Failed to send: ${msg}`);
    } finally {
      setSending(false);
    }
  }, [contactId, freeText, mode, onClose, phone, selectedTemplate]);

  if (!open) return null;

  const previewText = (() => {
    if (!selectedTemplate) return '';
    const t = templates.find(t => t.name === selectedTemplate);
    if (!t) return '';
    const bodyComp = t.components?.find(c => c.type === 'BODY');
    return bodyComp?.text || '';
  })();

  return (
    <div id="whatsapp-modal" className="wa-modal" style={{ display: 'block' }}>
      <div
        style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }}
        onClick={onClose}
      />
      <div style={{ position: 'relative', background: '#fff', borderRadius: 14, width: '100%', maxWidth: 480, boxShadow: '0 20px 60px rgba(0,0,0,0.25)', overflow: 'hidden' }}>
        <div style={{ background: '#25D366', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
          </svg>
          <span style={{ color: '#fff', fontSize: '1rem', fontWeight: 700 }}>Send WhatsApp</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: '#fff', opacity: 0.8, fontSize: '1.25rem', lineHeight: 1, padding: '0 2px' }}>✕</button>
        </div>
        <div style={{ padding: '18px 20px' }}>
          <div id="whatsapp-to" style={{ fontSize: '0.82rem', color: '#6b7280', marginBottom: 14 }}>{phone}</div>
          <div style={{ display: 'flex', gap: 0, border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
            <button id="wa-tab-template" onClick={() => setMode('template')}
              style={{ flex: 1, padding: '8px 0', fontSize: '0.82rem', fontWeight: 600, border: 'none', cursor: 'pointer', transition: 'background 0.15s', background: mode === 'template' ? '#f0f9ff' : '#fff' }}>
              Template
            </button>
            <button id="wa-tab-freeform" onClick={() => setMode('freeform')}
              style={{ flex: 1, padding: '8px 0', fontSize: '0.82rem', fontWeight: 600, border: 'none', borderLeft: '1px solid #e2e8f0', cursor: 'pointer', transition: 'background 0.15s', background: mode === 'freeform' ? '#f0f9ff' : '#fff' }}>
              Free-form
            </button>
          </div>

          {mode === 'template' && (
            <div id="wa-panel-template">
              {templatesLoading && <div style={{ fontSize: '0.82rem', color: '#6b7280', padding: '8px 0' }}>Loading templates…</div>}
              {!templatesLoading && (
                <select id="wa-template-select" value={selectedTemplate} onChange={e => setSelectedTemplate(e.target.value)}
                  style={{ width: '100%', border: '1px solid #e2e8f0', borderRadius: 8, padding: '9px 12px', fontSize: '0.875rem', marginBottom: 10, background: '#fff', cursor: 'pointer' }}>
                  <option value="">— Select a template —</option>
                  {templates.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
              )}
              {previewText && (
                <div id="wa-template-preview" style={{ fontSize: '0.8rem', color: '#374151', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', marginBottom: 10, whiteSpace: 'pre-wrap' }}>
                  {previewText}
                </div>
              )}
            </div>
          )}

          {mode === 'freeform' && (
            <div id="wa-panel-freeform">
              <div style={{ fontSize: '0.78rem', background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', color: '#854d0e', marginBottom: 10, lineHeight: 1.5 }}>
                <strong>24-hour rule:</strong> Free-form messages can only be sent within 24 hours of the customer last messaging your business. Outside that window, use a template.
              </div>
              <textarea id="wa-freeform-text" rows={4} placeholder="Type your message…" value={freeText} onChange={e => setFreeText(e.target.value)}
                style={{ width: '100%', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', resize: 'vertical', fontFamily: 'inherit', fontSize: 16, boxSizing: 'border-box' }} />
            </div>
          )}

          {sendError && <div id="wa-send-error" style={{ fontSize: '0.82rem', color: '#b91c1c', marginTop: 8, padding: '6px 10px', background: '#fef2f2', borderRadius: 6 }}>{sendError}</div>}
          {sendSuccess && <div id="wa-send-success" style={{ fontSize: '0.82rem', color: '#15803d', marginTop: 8, padding: '6px 10px', background: '#f0fdf4', borderRadius: 6 }}>Message sent successfully!</div>}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button onClick={onClose} className="btn-cancel-note">Cancel</button>
            <button id="wa-send-btn" onClick={send} disabled={sending}
              style={{ background: '#25D366', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 22px', fontSize: '0.875rem', fontWeight: 600, cursor: 'pointer', transition: 'background 0.15s' }}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
