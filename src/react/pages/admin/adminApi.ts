/**
 * Shared helpers for the React admin tabs (Team / Permissions / Requests /
 * Audit log). Kept tiny on purpose — these mirror the inline `api()`,
 * `toast()`, `fmtDate()` helpers that used to live in `public/admin.html`.
 */

import { GET, POST, PATCH, PUT, DELETE } from '../../utils/api';

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const m = method.toUpperCase();
  if (m === 'GET') return GET<T>(path);
  if (m === 'DELETE') return DELETE<T>(path);
  if (m === 'PATCH') return PATCH<T>(path, body);
  if (m === 'PUT') return PUT<T>(path, body);
  if (m === 'POST') return POST<T>(path, body);
  throw new Error(`Unsupported HTTP method: ${method}`);
}

export function toast(msg: string, isErr = false): void {
  const w = window as unknown as { showToast?: (m: string, e?: boolean) => void; toast?: (m: string, e?: boolean) => void };
  if (typeof w.toast === 'function') w.toast(msg, isErr);
  else if (typeof w.showToast === 'function') w.showToast(msg, isErr);
  else if (isErr) console.error(msg);
}

export function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDateShort(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtRelativeAge(iso?: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

/**
 * Shared admin BroadcastChannel — emit after any mutation so the other admin
 * tabs (and the audit-log tab) refetch when the user clicks into them.
 */
const CHANNEL_NAME = 'admin_data_changed';

export type AdminChangeKind =
  | 'team'           // users + allowed
  | 'requests'       // access requests
  | 'photos'         // photo approved
  | 'photos_rejected' // photo rejected
  | 'trades'         // trade submissions
  | 'roles'          // job roles
  | 'capabilities'   // perm matrix
  | 'audit';         // anything that should invalidate the audit feed

let _bc: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (_bc) return _bc;
  try { _bc = new BroadcastChannel(CHANNEL_NAME); } catch { _bc = null; }
  return _bc;
}

export function emitAdminChange(kind: AdminChangeKind): void {
  // Audit is invalidated by every mutation.
  try { getChannel()?.postMessage({ kind }); } catch { /* ignore */ }
  if (kind !== 'audit') {
    try { getChannel()?.postMessage({ kind: 'audit' }); } catch { /* ignore */ }
  }
  // Same-tab dispatch (BroadcastChannel doesn't deliver to its sender).
  try { window.dispatchEvent(new CustomEvent('admin:change', { detail: { kind } })); } catch { /* ignore */ }
  if (kind !== 'audit') {
    try { window.dispatchEvent(new CustomEvent('admin:change', { detail: { kind: 'audit' } })); } catch { /* ignore */ }
  }
}

export function onAdminChange(handler: (kind: AdminChangeKind) => void): () => void {
  const bc = getChannel();
  const bcHandler = (ev: MessageEvent) => {
    const k = ev?.data?.kind as AdminChangeKind | undefined;
    if (k) handler(k);
  };
  const winHandler = (ev: Event) => {
    const k = (ev as CustomEvent).detail?.kind as AdminChangeKind | undefined;
    if (k) handler(k);
  };
  bc?.addEventListener('message', bcHandler);
  window.addEventListener('admin:change', winHandler);
  return () => {
    bc?.removeEventListener('message', bcHandler);
    window.removeEventListener('admin:change', winHandler);
  };
}

/**
 * Set the legacy `#req-tab-badge` count so `AdminTabsBar`'s MutationObserver
 * picks up the change and updates the MUI tab badge.
 */
export function setRequestsBadge(total: number): void {
  const badge = document.getElementById('req-tab-badge');
  if (badge) badge.innerHTML = total > 0 ? `<span class="tab-badge">${total}</span>` : '';
}

export function setTeamCount(n: number): void {
  const el = document.getElementById('team-count');
  if (el) el.textContent = String(n);
}

export function setConflictBadge(n: number): void {
  const el = document.getElementById('team-conflict-badge');
  if (!el) return;
  el.innerHTML = n > 0
    ? `<span class="tab-badge tab-badge--warn" title="${n} unresolved onboarding conflict${n === 1 ? '' : 's'}">${n}</span>`
    : '';
}

export const PRIVILEGE_LEVELS = ['viewer', 'member', 'manager', 'admin'] as const;
export const PRIVILEGE_LABEL: Record<string, string> = {
  viewer: 'Viewer', member: 'Member', manager: 'Manager', admin: 'Admin',
};
