// POST /.netlify/functions/create-checkout
// Auth required. body: { product: "pro_monthly" | "pro_annual" | "pack", withdrawal_waiver: true }
// Creates a Stripe Checkout session and returns { url } for the browser to redirect to.

import { json, configured, getUser, getProfile, rest } from '../lib/supabase.js';
import { stripe, stripeConfigured, PRODUCTS, priceFor, appUrl, packCredits } from '../lib/stripe.js';

const ACTIVE = ['active', 'trialing', 'past_due'];

async function ensureCustomer(profile, user) {
  // Reuse the stored customer unless Stripe no longer knows it (e.g. test → live switch)
  if (profile.stripe_customer_id) {
    const c = await stripe(`customers/${profile.stripe_customer_id}`, { method: 'GET' });
    if (c.ok && c.data && !c.data.deleted) return profile.stripe_customer_id;
  }
  const created = await stripe('customers', {
    params: { email: profile.email || user.email, metadata: { user_id: user.id } },
    idempotencyKey: `customer-${user.id}-${profile.stripe_customer_id || 'new'}`,
  });
  if (!created.ok || !created.data || !created.data.id) {
    console.error('create-checkout: customer create failed', created.status, created.data && created.data.error && created.data.error.code);
    return null;
  }
  const id = created.data.id;
  const r = await rest(`profiles?id=eq.${user.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { stripe_customer_id: id } });
  if (!r.ok) console.error('create-checkout: saving stripe_customer_id failed', r.status);
  return id;
}

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!configured() || !stripeConfigured()) return json({ error: 'payments_not_configured' }, 503);

  const user = await getUser(request);
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const product = body && body.product;
  const spec = PRODUCTS[product];
  if (!spec) return json({ error: 'invalid_product' }, 400);
  const price = priceFor(product);
  if (!price) { console.error('create-checkout: missing env', spec.env); return json({ error: 'payments_not_configured' }, 503); }
  // EU law: immediate access to digital content requires an explicit waiver of the 14-day withdrawal right
  if (body.withdrawal_waiver !== true) return json({ error: 'withdrawal_waiver_required' }, 400);

  const profile = await getProfile(user.id);
  if (!profile) return json({ error: 'no_profile' }, 404);
  if (spec.mode === 'subscription' && profile.stripe_subscription_id && ACTIVE.includes(profile.subscription_status)) {
    // Already subscribed: switching monthly/annual or cancelling happens in the customer portal
    return json({ error: 'already_subscribed' }, 409);
  }

  const w = await rest(`profiles?id=eq.${user.id}`, { method: 'PATCH', prefer: 'return=minimal', body: { withdrawal_waiver_at: new Date().toISOString() } });
  if (!w.ok) { console.error('create-checkout: waiver save failed', w.status); return json({ error: 'server_error' }, 500); }

  const customer = await ensureCustomer(profile, user);
  if (!customer) return json({ error: 'stripe_error' }, 502);

  const base = appUrl();
  const metadata = { user_id: user.id, product };
  const params = {
    mode: spec.mode,
    customer,
    client_reference_id: user.id,
    line_items: [{ price, quantity: 1 }],
    metadata,
    allow_promotion_codes: 'true',
    locale: 'auto',
    // Stripe replaces {CHECKOUT_SESSION_ID}; the account page uses it to confirm the pack was credited
    success_url: `${base}/account?checkout=success&product=${product}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/pricing.html?checkout=cancel`,
  };
  if (spec.mode === 'subscription') {
    params.subscription_data = { metadata: { user_id: user.id } };
  } else {
    params.metadata.credits = String(packCredits());
    params.payment_intent_data = { metadata: { user_id: user.id, product } };
  }

  const s = await stripe('checkout/sessions', { params });
  if (!s.ok || !s.data || !s.data.url) {
    console.error('create-checkout: session create failed', s.status, s.data && s.data.error && s.data.error.code);
    return json({ error: 'stripe_error' }, 502);
  }
  return json({ url: s.data.url });
};
