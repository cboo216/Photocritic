// Server-side Stripe helpers — plain REST calls, no npm dependency
// (same approach as lib/supabase.js). Uses the SECRET key: never import from browser code.

import crypto from 'node:crypto';

const API = 'https://api.stripe.com/v1/';

export function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

// What the browser may buy. Price IDs come from env vars only:
// the client sends a product name, never a price ID.
export const PRODUCTS = {
  pro_monthly: { mode: 'subscription', env: 'STRIPE_PRICE_MONTHLY' },
  pro_annual:  { mode: 'subscription', env: 'STRIPE_PRICE_ANNUAL' },
  pack:        { mode: 'payment',      env: 'STRIPE_PRICE_PACK' },
};

export function priceFor(product) {
  const p = PRODUCTS[product];
  return p ? process.env[p.env] || null : null;
}

export function packCredits() {
  const n = parseInt(process.env.PACK_CREDITS, 10);
  return Number.isFinite(n) && n > 0 ? n : 12;
}

export function appUrl() {
  return (process.env.APP_URL || process.env.URL || 'https://getsecondeye.com').replace(/\/$/, '');
}

// Stripe expects application/x-www-form-urlencoded with bracket notation:
// { line_items: [{ price: 'x', quantity: 1 }] } → line_items[0][price]=x&line_items[0][quantity]=1
export function encodeForm(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') encodeForm(item, `${key}[${i}]`, out);
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === 'object') {
      encodeForm(v, key, out);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return out.join('&');
}

// Returns { ok, status, data }. data.error holds Stripe's error object on failure.
export async function stripe(path, { method = 'POST', params, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` };
  let url = API + path;
  let body;
  if (params && method === 'GET') {
    url += '?' + encodeForm(params);
  } else if (params) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = encodeForm(params);
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(url, { method, headers, body });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// Webhook signature check (Stripe scheme v1):
// header "t=TIMESTAMP,v1=HEX[,v1=HEX...]", HEX = HMAC-SHA256(secret, `${t}.${rawBody}`)
export function verifyStripeSignature(rawBody, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!rawBody || !header || !secret) return false;
  let t = null;
  const sigs = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;

  const payload = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8')]);
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(payload).digest('hex'), 'utf8');
  return sigs.some((s) => {
    const got = Buffer.from(s, 'utf8');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

// Stripe moved current_period_end from the subscription to its items (API 2025-03-31+).
// Read whichever is present so the code works on any account API version.
export function subscriptionSummary(sub) {
  const item = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const periodEnd = (sub && sub.current_period_end) || (item && item.current_period_end) || null;
  const interval = item && item.price && item.price.recurring ? item.price.recurring.interval : null;
  return {
    id: sub.id,
    customer: typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id,
    status: sub.status,
    plan: sub.status === 'active' || sub.status === 'trialing' ? 'pro' : 'free',
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    billing_interval: interval === 'month' || interval === 'year' ? interval : null,
    cancel_at_period_end: Boolean(sub.cancel_at_period_end || sub.cancel_at),
    user_id: sub.metadata && sub.metadata.user_id ? sub.metadata.user_id : null,
  };
}
