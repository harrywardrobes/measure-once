/**
 * Shared helpers for the React admin tabs (Team / Permissions / Requests /
 * Audit log). Kept tiny on purpose — these mirror the inline `api()`,
 * `toast()`, `fmtDate()` helpers that used to live in `public/admin.html`.
 */

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(path, opts);
  if (r.status === 401) { window.location.href = '/'; return undefined as T; }
  if (r.status === 403) throw Object.assign(new Error('Forbidden'), { forbidden: true });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data && (data.error || data.message)) || 'HTTP ' + r.status);
  return data as T;
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

/**
 * Shared admin BroadcastChannel — emit after any mutation so the other admin
 * tabs (and the audit-log tab) refetch when the user clicks into them.
 */
const CHANNEL_NAME = 'admin_data_changed';

export type AdminChangeKind =
  | 'team'      // users + allowed
  | 'requests'  // access requests
  | 'photos'    // photo approvals
  | 'trades'    // trade submissions
  | 'roles'     // job roles
  | 'capabilities' // perm matrix
  | 'audit';    // anything that should invalidate the audit feed

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

export const PRIVILEGE_LEVELS = ['viewer', 'member', 'manager', 'admin'] as const;
export const PRIVILEGE_LABEL: Record<string, string> = {
  viewer: 'Viewer', member: 'Member', manager: 'Manager', admin: 'Admin',
};
