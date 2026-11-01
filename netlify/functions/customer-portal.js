// POST /.netlify/functions/customer-portal   body (optional): { flow: "cancel" | "change" | "card" }
// Auth required. Opens the Stripe Customer Portal. Returns { url }.
//
// Without a flow: the portal home (invoices, card, resume a cancelled plan).
// With a flow: the portal opens directly on that screen, so "Cancel subscription"
// on My Account is one click to Stripe's confirmation page (French "3-click" cancellation rule).
//   cancel → cancel at end of period (portal setting) — Pro stays active until then
//   change → switch monthly ↔ annual
//   card   → update payment method (e.g. after a failed payment)
// If Stripe refuses the flow (feature off in portal settings, plan already cancelling…),
// we fall back to the portal home rather than failing.

import { json, configured, getUser, getProfile } from '../lib/supabase.js';
import { stripe, stripeConfigured, appUrl } from '../lib/stripe.js';

const FLOWS = {
  cancel: (sub) => ({ type: 'subscription_cancel', subscription_cancel: { subscription: sub } }),
  change: (sub) => ({ type: 'subscription_update', subscription_update: { subscription: sub } }),
  card:   () => ({ type: 'payment_method_update' }),
};

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!configured() || !stripeConfigured()) return json({ error: 'payments_not_configured' }, 503);

  const user = await getUser(request);
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body = {};
  try { body = (await request.json()) || {}; } catch { body = {}; }
  const flow = typeof body.flow === 'string' && FLOWS[body.flow] ? body.flow : null;

  const profile = await getProfile(user.id);
  if (!profile) return json({ error: 'no_profile' }, 404);
  if (!profile.stripe_customer_id) return json({ error: 'no_billing_account' }, 400);

  // ?billing=return makes My Account refresh the plan while the webhook lands
  const returnUrl = `${appUrl()}/account?billing=return`;
  const base = { customer: profile.stripe_customer_id, return_url: returnUrl };

  let s = null;
  const needsSub = flow === 'cancel' || flow === 'change';
  if (flow && (!needsSub || profile.stripe_subscription_id)) {
    s = await stripe('billing_portal/sessions', {
      params: {
        ...base,
        flow_data: {
          ...FLOWS[flow](profile.stripe_subscription_id),
          after_completion: { type: 'redirect', redirect: { return_url: returnUrl } },
        },
      },
    });
    if (!s.ok) {
      console.warn('customer-portal: flow refused, opening portal home', flow, s.status, s.data && s.data.error && s.data.error.code);
      s = null;
    }
  }
  if (!s) s = await stripe('billing_portal/sessions', { params: base });

  if (!s.ok || !s.data || !s.data.url) {
    console.error('customer-portal: session create failed', s.status, s.data && s.data.error && s.data.error.code);
    return json({ error: 'stripe_error' }, 502);
  }
  return json({ url: s.data.url });
};
