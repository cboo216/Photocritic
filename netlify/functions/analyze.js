// POST /.netlify/functions/analyze — START a critique (returns in ~1 s)
// Auth required. Validates the request, consumes one critique from the quota,
// hands the photo to the background worker (analyze-background) and returns 202 { job_id }.
// The browser then polls its row in critique_jobs and reads the saved critique.
//
// Why: the Claude call alone takes ~26 s and Netlify cuts synchronous functions at 30 s.
// Background functions get 15 min but accept only 256 KB of input, so the photo travels
// through a private bucket, encrypted with a one-time key that is never stored, and is
// deleted as soon as the worker has read it.

import crypto from 'node:crypto';
import { json, configured, getUser, rpc, rest, quotaLimits, putObject, removeObjects, JOBS_BUCKET } from '../lib/supabase.js';
import { clip, seal, IMAGE_TYPES, MAX_IMAGE_B64 } from '../lib/critique.js';
import { sweepStuckJobs, sweepHandoffs } from '../lib/sweep.js';

// Safety net, also run every 5 min by sweep-jobs (see netlify/lib/sweep.js). Never blocks.

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!configured() || !process.env.ANTHROPIC_API_KEY) {
    console.error('analyze: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY');
    return json({ error: 'server_not_configured' }, 500);
  }

  const user = await getUser(request);
  if (!user) return json({ error: 'unauthorized' }, 401);
  await Promise.all([sweepStuckJobs(), sweepHandoffs()]);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }

  const image = body && body.image;
  if (!image || !IMAGE_TYPES.includes(image.media_type) || typeof image.data !== 'string'
      || !image.data.length || image.data.length > MAX_IMAGE_B64) {
    return json({ error: 'invalid_image' }, 400);
  }
  const photoType = clip(body.photoType, 60);
  if (!photoType) return json({ error: 'missing_photo_type' }, 400);

  // ── Quota (atomic) ──
  const limits = quotaLimits();
  const q = await rpc('consume_critique', { p_user_id: user.id, p_free_limit: limits.free, p_pro_limit: limits.pro });
  if (!q.ok || !q.data) {
    console.error('analyze: consume_critique failed', q.status);
    return json({ error: 'quota_check_failed' }, 500);
  }
  if (!q.data.allowed) {
    return json({ error: 'quota_exceeded', plan: q.data.plan, limit: q.data.limit, used: q.data.used, period_end: q.data.period_end, pack_credits: q.data.pack_credits || 0 }, 402);
  }
  const source = q.data.source === 'pack' ? 'pack' : 'quota';
  const refund = () => rpc('refund_critique', { p_user_id: user.id, p_source: source }).catch(() => {});

  // ── Hand-off to the background worker ──
  const jobId = crypto.randomUUID();
  const key = crypto.randomBytes(32);
  const fail = async (what, detail) => {
    console.error(`analyze: start failed at ${what}`, detail || '');
    await refund();
    await removeObjects(JOBS_BUCKET, [jobId]);
    await rest(`critique_jobs?id=eq.${jobId}`, { method: 'PATCH', prefer: 'return=minimal', body: { status: 'failed', error: 'internal', finished_at: new Date().toISOString() } }).catch(() => {});
    return json({ error: 'ai_error' }, 502);   // refunded: "not counted" is true
  };

  const job = await rest('critique_jobs', { method: 'POST', prefer: 'return=minimal', body: { id: jobId, user_id: user.id, status: 'pending', source } });
  if (!job.ok) return fail('job row', job.status);

  try {
    const sealed = seal({
      user_id: user.id,
      source,
      photoType,
      conditions: clip(body.conditions, 1000) || 'not specified',
      intent: clip(body.intent, 1000) || 'not specified',
      exif: clip(body.exif, 300) || 'not available',
      title: clip(body.title, 120) || null,
      image: { media_type: image.media_type, data: image.data },
      thumbnail: body.thumbnail || null,
    }, key);
    body = null; image.data = null;
    const up = await putObject(JOBS_BUCKET, jobId, sealed);
    if (!up.ok) return fail('photo hand-off', `${up.status} ${up.detail || ''}`);
  } catch (err) {
    return fail('photo hand-off', err.message);
  }

  try {
    const origin = new URL(request.url).origin || process.env.URL;
    const kick = await fetch(`${origin}/.netlify/functions/analyze-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, key: key.toString('base64') }),
      signal: AbortSignal.timeout(8000),
    });
    if (kick.status !== 202) return fail('background trigger', kick.status);
  } catch (err) {
    return fail('background trigger', err.message);
  }

  console.log(`analyze: job ${jobId} started (${source})`);
  return json({
    job_id: jobId,
    quota: {
      plan: q.data.plan,
      used: q.data.used,
      limit: q.data.limit,
      remaining: Math.max(q.data.limit - q.data.used, 0),
      period_end: q.data.period_end,
      source,
      pack_credits: q.data.pack_credits || 0,
    },
  }, 202);
};
