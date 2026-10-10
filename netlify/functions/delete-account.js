// POST /.netlify/functions/delete-account   body: { confirm: "DELETE" }
// 1. deletes every thumbnail under thumbnails/{user_id}/
// 2. erases the Brevo contact
// 3. deletes the auth user → cascade removes profile and critiques

import { json, configured, getUser, getProfile, listUserObjects, deleteObjects, deleteAuthUser } from '../lib/supabase.js';
import { eraseContact } from '../lib/brevo.js';

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!configured()) return json({ error: 'server_not_configured' }, 500);
  const user = await getUser(request);
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  if (!body || body.confirm !== 'DELETE') return json({ error: 'confirmation_required' }, 400);

  // Phase 2 note: an active Stripe subscription must be cancelled first (handled then).

  try {
    const paths = await listUserObjects(user.id);
    for (let i = 0; i < paths.length; i += 500) {
      if (!(await deleteObjects(paths.slice(i, i + 500)))) throw new Error('storage delete failed');
    }
    // Belt and braces: nothing may remain
    if ((await listUserObjects(user.id)).length) throw new Error('thumbnails remain');
  } catch (err) {
    console.error('delete-account: thumbnails', err.message);
    return json({ error: 'delete_failed' }, 500);
  }

  const profile = await getProfile(user.id);
  if (profile && profile.email) await eraseContact(profile.email);

  if (!(await deleteAuthUser(user.id))) {
    console.error('delete-account: auth delete failed');
    return json({ error: 'delete_failed' }, 500);
  }
  return json({ ok: true });
};
