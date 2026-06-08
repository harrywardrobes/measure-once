/**
 * Typed async API helpers for React components.
 *
 * Matches the behaviour of the vanilla-JS `api()` helper in `public/core.js`:
 *  - Redirects to /login on 401 (unless the error code is GOOGLE_AUTH /
 *    GOOGLE_ERROR, in which case a typed error is thrown so the caller can
 *    prompt re-auth).
 *  - Throws an `Error` with `.code` set from the server JSON `code` field.
 *
 * Vanilla-JS pages still use the helpers defined in core.js during the
 * migration. New React components should import from here instead.
 */

export class ApiError extends Error {
  code?: string;
  status?: number;

  constructor(message: string, code?: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

async function apiFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const r = await fetch(path, opts);

  if (r.status === 401) {
    const data = await r.json().catch(() => ({} as Record<string, string>));
    if (data.code === 'GOOGLE_AUTH' || data.code === 'GOOGLE_ERROR') {
      throw new ApiError(data.error || 'Google authentication required', data.code, 401);
    }
    window.location.href = '/login';
    throw new ApiError('Unauthorized', 'UNAUTHORIZED', 401);
  }

  const data = await r.json().catch(() => ({} as Record<string, unknown>));
  if (!r.ok) {
    const msg = (data as { error?: string; message?: string }).error
      || (data as { message?: string }).message
      || `HTTP ${r.status}`;
    throw new ApiError(msg, (data as { code?: string }).code, r.status);
  }

  return data as T;
}

export function GET<T = unknown>(path: string): Promise<T> {
  return apiFetch<T>('GET', path);
}

export function POST<T = unknown>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>('POST', path, body);
}

export function PATCH<T = unknown>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>('PATCH', path, body);
}

export function DELETE<T = unknown>(path: string): Promise<T> {
  return apiFetch<T>('DELETE', path);
}

export function PUT<T = unknown>(path: string, body?: unknown): Promise<T> {
  return apiFetch<T>('PUT', path, body);
}

export function isGoogleAuthError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === 'GOOGLE_AUTH' || code === 'GOOGLE_ERROR';
}
