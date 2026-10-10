// POST /.netlify/functions/delete-critique   body: { critique_id }
// Deletes one of the user's own critiques: thumbnail first, then the row.

import { json, configured, getUser, rest, deleteObjects, isUuid } from '../lib/supabase.js';

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!configured()) return json({ error: 'server_not_configured' }, 500);
  const user = await getUser(request);
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }
  const id = body && body.critique_id;
  if (!isUuid(id)) return json({ error: 'not_found' }, 404);

  const r = await rest(`critiques?id=eq.${id}&user_id=eq.${user.id}&select=id,thumbnail_path`);
  const row = r.ok && Array.isArray(r.data) ? r.data[0] : null;
  if (!row) return json({ error: 'not_found' }, 404);

  if (row.thumbnail_path && !(await deleteObjects([row.thumbnail_path]))) {
    console.error('delete-critique: storage delete failed');
    return json({ error: 'delete_failed' }, 500);
  }
  const d = await rest(`critiques?id=eq.${id}&user_id=eq.${user.id}`, { method: 'DELETE', prefer: 'return=minimal' });
  if (!d.ok) return json({ error: 'delete_failed' }, 500);
  return json({ ok: true });
};
