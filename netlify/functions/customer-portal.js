// POST /.netlify/functions/customer-portal
// Auth required. Opens the Stripe Customer Portal (cancel, change card, monthly ↔ annual, invoices).
// Returns { url }.

import { json, configured, getUser, getProfile } from '../lib/supabase.js';
import { stripe, stripeConfigured, appUrl } from '../lib/stripe.js';

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!configured() || !stripeConfigured()) return json({ error: 'payments_not_configured' }, 503);

  const user = await getUser(request);
  if (!user) return json({ error: 'unauthorized' }, 401);

  const profile = await getProfile(user.id);
  if (!profile) return json({ error: 'no_profile' }, 404);
  if (!profile.stripe_customer_id) return json({ error: 'no_billing_account' }, 400);

  const s = await stripe('billing_portal/sessions', {
    params: { customer: profile.stripe_customer_id, return_url: `${appUrl()}/account` },
  });
  if (!s.ok || !s.data || !s.data.url) {
    console.error('customer-portal: session create failed', s.status, s.data && s.data.error && s.data.error.code);
    return json({ error: 'stripe_error' }, 502);
  }
  return json({ url: s.data.url });
};
