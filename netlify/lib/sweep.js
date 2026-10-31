// Safety net for the asynchronous critique flow. Two jobs, both idempotent:
//
// 1. sweepHandoffs: delete every encrypted photo hand-off older than 5 minutes.
//    A healthy worker deletes its photo within seconds; Netlify's last retry of a
//    background function comes ~3 min after the first attempt. Anything older is an
//    orphan (worker never ran, crashed, or the job row was never written).
//    This is what makes "deleted within seconds, and in every case within 15 minutes" true.
//
// 2. sweepStuckJobs: a job still pending/running after 20 min will never finish
//    (background functions stop at 15 min). Mark it failed and refund it.
//
// Called every 5 minutes by sweep-jobs (scheduled) and on each new critique by analyze.

import { rest, rpc, removeObjects, JOBS_BUCKET } from './supabase.js';

const URL_ = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;
export const JOB_MAX_AGE_MS = 20 * 60 * 1000;

export async function sweepHandoffs(now = Date.now()) {
  let deleted = 0;
  try {
    const cutoff = now - HANDOFF_MAX_AGE_MS;
    const res = await fetch(`${URL_()}/storage/v1/object/list/${JOBS_BUCKET}`, {
      method: 'POST',
      headers: { apikey: KEY(), Authorization: `Bearer ${KEY()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 1000, offset: 0, sortBy: { column: 'created_at', order: 'asc' } }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) { console.warn(`sweep: hand-off list failed (${res.status})`); return deleted; }
    const items = await res.json();
    const old = (Array.isArray(items) ? items : [])
      .filter((it) => it && it.id && it.name && Date.parse(it.created_at) < cutoff)
      .map((it) => it.name);
    if (old.length && await removeObjects(JOBS_BUCKET, old)) deleted = old.length;
    if (deleted) console.warn(`sweep: deleted ${deleted} orphaned photo hand-off(s)`);
  } catch (err) { console.warn('sweep: hand-offs skipped', err.message); }
  return deleted;
}

export async function sweepStuckJobs(now = Date.now()) {
  let swept = 0;
  try {
    const cutoff = new Date(now - JOB_MAX_AGE_MS).toISOString();
    const r = await rest(`critique_jobs?status=in.(pending,running)&created_at=lt.${cutoff}&select=id&limit=50`);
    if (!r.ok || !Array.isArray(r.data) || !r.data.length) return swept;
    for (const { id } of r.data) {
      await removeObjects(JOBS_BUCKET, [id]);
      // Conditional update: if the worker finished in the meantime, nothing changes
      const upd = await rest(`critique_jobs?id=eq.${id}&status=in.(pending,running)`, {
        method: 'PATCH', prefer: 'return=representation',
        body: { status: 'failed', error: 'timeout', finished_at: new Date().toISOString() },
      });
      const row = upd.ok && Array.isArray(upd.data) ? upd.data[0] : null;
      if (row) {
        await rpc('refund_critique', { p_user_id: row.user_id, p_source: row.source === 'pack' ? 'pack' : 'quota' }).catch(() => {});
        console.warn(`sweep: stuck job ${id} failed and refunded`);
        swept++;
      }
    }
  } catch (err) { console.warn('sweep: stuck jobs skipped', err.message); }
  return swept;
}
