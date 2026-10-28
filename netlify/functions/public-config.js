// GET /.netlify/functions/public-config
// Public, browser-safe settings only (the anon key is designed to be public).
// Keeps Supabase settings in Netlify env vars instead of hardcoding them in HTML.

export default async () => {
  const body = {
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    // true once Stripe is set up: pricing buttons open Checkout instead of the "opening soon" note
    paymentsEnabled: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_MONTHLY
      && process.env.STRIPE_PRICE_ANNUAL && process.env.STRIPE_PRICE_PACK),
  };
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  });
};
