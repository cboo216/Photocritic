// GET  /.netlify/functions/profile  → the signed-in user's profile + quota
// POST /.netlify/functions/profile  → update pseudo and/or marketing opt-in
//   body: { pseudo?: string, marketing_opt_in?: boolean }
// Opt-in changes are mirrored to Brevo (one-way sync).

import { json, configured, getUser, getProfile, rest, quotaLimits } from '../lib/supabase.js';
import { subscribe, unsubscribe } from '../lib/brevo.js';

const PSEUDO_RE = /^[A-Za-z0-9_.-]{3,30}$/;
const OPT_IN_TEXT = 'Send me photography tips and Second Eye news';

// Same rule as Postgres "+ interval '1 month'": Jan 31 → Feb 28/29
function addOneMonth(d) {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + 1);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

function view(p) {
  const limits = quotaLimits();
  const limit = p.plan === 'pro' ? limits.pro : limits.free;
  const periodEnd = addOneMonth(new Date(p.quota_period_start));
  const expired = Date.now() >= periodEnd.getTime();
  const used = expired ? 0 : p.critiques_used;
  return {
    email: p.email,
    pseudo: p.pseudo,
    plan: p.plan,
    marketing_opt_in: p.marketing_opt_in,
    subscription_status: p.subscription_status,
    current_period_end: p.current_period_end,
    billing_interval: p.billing_interval || null,
    cancel_at_period_end: !!p.cancel_at_period_end,
    has_billing_account: !!p.stripe_customer_id,
    // Lapsed credits show as 0 here; the database clears them at the next critique or purchase
    pack_credits: p.pack_credits_expire_at && Date.now() >= new Date(p.pack_credits_expire_at).getTime() ? 0 : (p.pack_credits || 0),
    pack_credits_expire_at: p.pack_credits_expire_at || null,
    created_at: p.created_at,
    quota: {
      used,
      limit,
      remaining: Math.max(limit - used, 0),
      period_end: expired ? null : periodEnd.toISOString(),
    },
  };
}

export default async (request) => {
  if (!configured()) return json({ error: 'server_not_configured' }, 500);
  const user = await getUser(request);
  if (!user) return json({ error: 'unauthorized' }, 401);

  if (request.method === 'GET') {
    const p = await getProfile(user.id);
    return p ? json(view(p)) : json({ error: 'no_profile' }, 404);
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }

  const patch = {};
  if (body.pseudo !== undefined) {
    const pseudo = typeof body.pseudo === 'string' ? body.pseudo.trim() : '';
    if (!PSEUDO_RE.test(pseudo)) return json({ error: 'invalid_pseudo' }, 400);
    patch.pseudo = pseudo;
  }
  if (body.marketing_opt_in !== undefined) {
    if (typeof body.marketing_opt_in !== 'boolean') return json({ error: 'invalid_opt_in' }, 400);
    patch.marketing_opt_in = body.marketing_opt_in;
    patch.marketing_opt_in_at = body.marketing_opt_in ? new Date().toISOString() : null;
  }
  if (!Object.keys(patch).length) return json({ error: 'nothing_to_update' }, 400);

  const before = await getProfile(user.id);
  if (!before) return json({ error: 'no_profile' }, 404);

  const r = await rest(`profiles?id=eq.${user.id}`, { method: 'PATCH', prefer: 'return=representation', body: patch });
  if (!r.ok) {
    // 23505 = unique violation → pseudo taken
    if (r.status === 409 || (r.data && r.data.code === '23505')) return json({ error: 'pseudo_taken' }, 409);
    console.error('profile: update failed', r.status);
    return json({ error: 'update_failed' }, 500);
  }
  const after = r.data[0];

  if ('marketing_opt_in' in patch && patch.marketing_opt_in !== before.marketing_opt_in) {
    if (patch.marketing_opt_in) await subscribe(after.email, { pseudo: after.pseudo, consentText: OPT_IN_TEXT });
    else await unsubscribe(after.email);
  }
  return json(view(after));
};
