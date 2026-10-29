// Server-side Supabase helpers — plain REST calls, no npm dependency.
// Uses the SERVICE ROLE key: never import this file from browser code.

const URL_ = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const BUCKET = 'thumbnails';

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function configured() {
  return Boolean(URL_() && SERVICE_KEY());
}

function serviceHeaders(extra = {}) {
  return { apikey: SERVICE_KEY(), Authorization: `Bearer ${SERVICE_KEY()}`, ...extra };
}

// Verifies the user's access token with Supabase Auth. Returns the user or null.
export async function getUser(request) {
  const auth = request.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const res = await fetch(`${URL_()}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY(), Authorization: `Bearer ${m[1]}` },
  });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user && user.id ? user : null;
}

// PostgREST call with the service role
export async function rest(path, { method = 'GET', body, prefer } = {}) {
  const headers = serviceHeaders({ 'Content-Type': 'application/json' });
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${URL_()}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

export const rpc = (fn, args) => rest(`rpc/${fn}`, { method: 'POST', body: args });

export async function getProfile(userId) {
  const r = await rest(`profiles?id=eq.${userId}&select=*`);
  return r.ok && Array.isArray(r.data) ? r.data[0] || null : null;
}

// ── Storage ──
export async function uploadThumbnail(path, bytes, contentType) {
  const res = await fetch(`${URL_()}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: serviceHeaders({ 'Content-Type': contentType, 'x-upsert': 'true' }),
    body: bytes,
    // A thumbnail is never worth losing the critique: give up after 5 s
    signal: AbortSignal.timeout(5000),
  });
  if (res.ok) return { ok: true };
  const detail = (await res.text().catch(() => '')).slice(0, 200);
  return { ok: false, status: res.status, detail };
}

export async function deleteObjects(paths) {
  if (!paths.length) return true;
  const res = await fetch(`${URL_()}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: serviceHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefixes: paths }),
  });
  return res.ok;
}

// All object paths under '{userId}/' (paged)
export async function listUserObjects(userId) {
  const paths = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${URL_()}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: serviceHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ prefix: userId, limit: 1000, offset }),
    });
    if (!res.ok) throw new Error(`storage list failed (${res.status})`);
    const items = await res.json();
    for (const it of items) if (it && it.name && it.id) paths.push(`${userId}/${it.name}`);
    if (items.length < 1000) break;
  }
  return paths;
}

export async function deleteAuthUser(userId) {
  const res = await fetch(`${URL_()}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: serviceHeaders(),
  });
  return res.ok;
}

// Quota limits (env-configurable)
export function quotaLimits() {
  const n = (v, d) => { const x = parseInt(v, 10); return Number.isFinite(x) && x >= 0 ? x : d; };
  return { free: n(process.env.FREE_MONTHLY_QUOTA, 3), pro: n(process.env.PRO_MONTHLY_QUOTA, 50) };
}

export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
