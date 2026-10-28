// POST /.netlify/functions/stripe-webhook   (called by Stripe, not by the browser)
// 1. verifies the Stripe signature on the raw body (invalid → 400)
// 2. skips events already processed (stripe_events table → replay-safe)
// 3. updates the profile: Pro status from subscriptions, credits from pack purchases
// A processing error returns 500 so Stripe retries the event later.

import { json, configured, rest, rpc, isUuid } from '../lib/supabase.js';
import { stripe, stripeConfigured, verifyStripeSignature, subscriptionSummary, packCredits } from '../lib/stripe.js';

const HANDLED = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
]);

async function profileBy(field, value) {
  if (!value) return null;
  const r = await rest(`profiles?${field}=eq.${encodeURIComponent(value)}&select=id,stripe_customer_id,stripe_subscription_id,subscription_status`);
  return r.ok && Array.isArray(r.data) ? r.data[0] || null : null;
}

async function patchProfile(id, body) {
  const r = await rest(`profiles?id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal', body });
  if (!r.ok) throw new Error(`profile update failed (${r.status})`);
}

// Applies the subscription's current state to its owner.
// The plan changes immediately; the monthly counter is NOT reset (new limit applies at once).
async function applySubscription(sub, fallbackUserId) {
  const s = subscriptionSummary(sub);
  const profile = (await profileBy('stripe_customer_id', s.customer))
    || (isUuid(s.user_id) && await profileBy('id', s.user_id))
    || (isUuid(fallbackUserId) && await profileBy('id', fallbackUserId));
  if (!profile) { console.warn('webhook: no profile for subscription', s.id); return; }

  // A stale event about an old, inactive subscription must not downgrade a user
  // who has since started a new one.
  const current = profile.stripe_subscription_id;
  if (current && current !== s.id && s.plan !== 'pro') {
    console.log('webhook: ignoring inactive non-current subscription', s.id);
    return;
  }

  await patchProfile(profile.id, {
    plan: s.plan,
    stripe_customer_id: profile.stripe_customer_id || s.customer,
    stripe_subscription_id: s.id,
    subscription_status: s.status,
    current_period_end: s.current_period_end,
    billing_interval: s.billing_interval,
    cancel_at_period_end: s.plan === 'pro' ? s.cancel_at_period_end : false,
  });
}

// Re-read the subscription so out-of-order events always end in the latest state
async function fetchSubscription(id) {
  const r = await stripe(`subscriptions/${id}`, { method: 'GET' });
  if (!r.ok || !r.data) throw new Error(`subscription fetch failed (${r.status})`);
  return r.data;
}

async function handlePackPaid(session) {
  if (session.mode !== 'payment' || session.payment_status !== 'paid') return;
  if (!session.metadata || session.metadata.product !== 'pack') return;
  const userId = session.client_reference_id || session.metadata.user_id;
  if (!isUuid(userId)) { console.warn('webhook: pack session without user', session.id); return; }
  const credits = parseInt(session.metadata.credits, 10) || packCredits();
  const r = await rpc('add_pack_credits', { p_user_id: userId, p_credits: credits, p_session_id: session.id });
  if (!r.ok || !r.data) throw new Error(`add_pack_credits failed (${r.status})`);
  if (r.data.error) console.warn('webhook: add_pack_credits', r.data.error, session.id);
}

async function handle(event) {
  const obj = event.data && event.data.object;
  switch (event.type) {
    case 'checkout.session.completed': {
      const userId = obj.client_reference_id || (obj.metadata && obj.metadata.user_id);
      const customer = typeof obj.customer === 'string' ? obj.customer : obj.customer && obj.customer.id;
      if (isUuid(userId) && customer) {
        const p = await profileBy('id', userId);
        if (p && !p.stripe_customer_id) await patchProfile(userId, { stripe_customer_id: customer });
      }
      if (obj.mode === 'subscription' && obj.subscription) {
        const subId = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id;
        await applySubscription(await fetchSubscription(subId), userId);
      }
      await handlePackPaid(obj);
      return;
    }
    case 'checkout.session.async_payment_succeeded':
      await handlePackPaid(obj);
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await applySubscription(await fetchSubscription(obj.id));
      return;
    case 'customer.subscription.deleted':
      await applySubscription(obj); // final state, no need to re-fetch
      return;
    case 'invoice.payment_failed': {
      const subId = obj.subscription
        || (obj.parent && obj.parent.subscription_details && obj.parent.subscription_details.subscription);
      if (subId) await applySubscription(await fetchSubscription(typeof subId === 'string' ? subId : subId.id));
      return;
    }
    default:
      return;
  }
}

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!configured() || !stripeConfigured() || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('webhook: missing configuration');
    return json({ error: 'not_configured' }, 500);
  }

  const raw = Buffer.from(await request.arrayBuffer());
  const sig = request.headers.get('stripe-signature');
  if (!verifyStripeSignature(raw, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    return json({ error: 'invalid_signature' }, 400);
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!event || !event.id || !event.type) return json({ error: 'invalid_event' }, 400);
  if (!HANDLED.has(event.type)) return json({ received: true, ignored: true });

  const seen = await rest(`stripe_events?id=eq.${encodeURIComponent(event.id)}&select=id`);
  if (seen.ok && Array.isArray(seen.data) && seen.data.length) return json({ received: true, duplicate: true });

  try {
    await handle(event);
  } catch (err) {
    console.error('webhook: processing failed', event.type, event.id, err.message);
    return json({ error: 'processing_failed' }, 500);
  }

  const mark = await rest('stripe_events', {
    method: 'POST',
    prefer: 'return=minimal,resolution=ignore-duplicates',
    body: { id: event.id, type: event.type },
  });
  if (!mark.ok) console.warn('webhook: could not record event', event.id, mark.status);
  return json({ received: true });
};
