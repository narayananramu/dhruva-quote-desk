// Fetch wrapper: base URL, x-demo-user, errors as { status, error, code } (docs/DESIGN.md 10.1).
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

const USER_KEY = 'dhruva.user';

export class ApiError extends Error {
  constructor(public status: number, public error: string, public code?: string) {
    super(error);
  }
}

export function getUser(): string | null {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
}
export function setUser(user: string | null) {
  try {
    if (user) localStorage.setItem(USER_KEY, user);
    else localStorage.removeItem(USER_KEY);
  } catch {
    /* private mode: session lasts for this page only */
  }
}

// ---- demo clock: server `now` from the last response plus time since it arrived ----
let serverNow: number | null = null;
let receivedAt = 0;
const clockListeners = new Set<() => void>();
function noteNow(body: unknown) {
  if (body && typeof body === 'object' && typeof (body as { now?: unknown }).now === 'number') {
    serverNow = (body as { now: number }).now;
    receivedAt = performance.now();
    clockListeners.forEach((l) => l());
  }
}
export function clockNow(): number | null {
  return serverNow === null ? null : serverNow + (performance.now() - receivedAt);
}
export function onClock(l: () => void) {
  clockListeners.add(l);
  return () => clockListeners.delete(l);
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const user = getUser();
  let status: number;
  let data: unknown;
  if (import.meta.env.VITE_MOCK === '1') {
    const { mockRequest } = await import('../mock/server');
    ({ status, body: data } = mockRequest(method, path, body, user));
  } else {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (user) headers['x-demo-user'] = user;
    let res: Response;
    try {
      res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'Cannot reach the server.');
    }
    status = res.status;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { error: text };
    }
  }
  if (status >= 400) {
    const e = (data ?? {}) as { error?: string; code?: string };
    if (status === 401 && path !== '/session') onUnauthorized();
    throw new ApiError(status, e.error ?? `Error ${status}`, e.code);
  }
  noteNow(data);
  return data as T;
}

/** For the customer API screen: the raw status and body, never thrown. */
export async function rawPost(path: string, bodyText: string): Promise<{ status: number; text: string }> {
  const user = getUser();
  if (import.meta.env.VITE_MOCK === '1') {
    const { mockRequest } = await import('../mock/server');
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return { status: 400, text: JSON.stringify({ error: 'invalid JSON' }) };
    }
    const r = mockRequest('POST', path, parsed, user);
    return { status: r.status, text: JSON.stringify(r.body, null, 2) };
  }
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(user ? { 'x-demo-user': user } : {}) },
      body: bodyText,
    });
    const text = await res.text();
    let pretty = text;
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not JSON: show as is */
    }
    return { status: res.status, text: pretty };
  } catch {
    return { status: 0, text: 'Cannot reach the server.' };
  }
}
