// POST /.netlify/functions/analyze
// Auth required. Consumes one critique from the user's quota, runs the v2.8
// critique server-side, validates integer scores, stores the critique and its
// thumbnail. The original photo is only held in memory for the Anthropic call.

import { SYSTEM_PROMPT, CALIBRATION_VERSION, MODEL, DIMENSION_KEYS } from '../lib/prompt.js';
import { json, configured, getUser, rpc, rest, uploadThumbnail, quotaLimits } from '../lib/supabase.js';
import { validateThumbnail } from '../lib/thumbnail.js';

const MAX_TOKENS = 1500;
// Netlify cuts the function at ~30 s. A retry takes as long as the first call (~25 s today),
// so only retry when the first attempt was fast; a late retry guarantees a timeout.
const RETRY_BUDGET_MS = 10000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_B64 = 6.2 * 1024 * 1024;

const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

function validateResult(r) {
  if (!r || typeof r !== 'object') return false;
  const ok = (s) => Number.isInteger(s) && s >= 1 && s <= 10;
  if (!ok(r.overall_score)) return false;
  if (!r.dimensions || typeof r.dimensions !== 'object') return false;
  if (!DIMENSION_KEYS.every((k) => ok(r.dimensions[k]))) return false;
  if (!Array.isArray(r.what_works) || !Array.isArray(r.what_to_improve)) return false;
  for (const f of ['overall_summary', 'one_thing_to_try']) if (typeof r[f] !== 'string') return false;
  return true;
}

async function callAnthropic(userContent) {
  const t0 = Date.now();
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  if (!res.ok) {
    const err = new Error(`anthropic_${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  // Timing + size of every call, to see where the 30 s go (Netlify function log)
  const u = data.usage || {};
  console.log(`analyze: anthropic ${Date.now() - t0} ms · in ${u.input_tokens} tok · out ${u.output_tokens} tok · stop ${data.stop_reason}`);
  const text = (data.content || []).map((c) => c.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch { return null; }
}

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!configured() || !process.env.ANTHROPIC_API_KEY) {
    console.error('analyze: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / ANTHROPIC_API_KEY');
    return json({ error: 'server_not_configured' }, 500);
  }

  const user = await getUser(request);
  if (!user) return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid_body' }, 400); }

  const image = body && body.image;
  if (!image || !IMAGE_TYPES.includes(image.media_type) || typeof image.data !== 'string'
      || !image.data.length || image.data.length > MAX_IMAGE_B64) {
    return json({ error: 'invalid_image' }, 400);
  }
  const photoType = clip(body.photoType, 60);
  if (!photoType) return json({ error: 'missing_photo_type' }, 400);
  const conditions = clip(body.conditions, 1000) || 'not specified';
  const intent = clip(body.intent, 1000) || 'not specified';
  const exif = clip(body.exif, 300) || 'not available';
  const title = clip(body.title, 120) || null;
  const thumbInput = body.thumbnail || null;

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
  // Give back exactly what was consumed: a monthly critique or a pack credit
  const source = q.data.source === 'pack' ? 'pack' : 'quota';
  const refund = () => rpc('refund_critique', { p_user_id: user.id, p_source: source }).catch(() => {});

  // ── Critique ──
  const userContent = [
    { type: 'text', text: `Photo Type: ${photoType}\nConditions: ${conditions}\nIntent: ${intent}\nEXIF: ${exif}\n\nPlease evaluate this photograph.` },
    { type: 'image', source: { type: 'base64', media_type: image.media_type, data: image.data } },
  ];

  const started = Date.now();
  let result = null;
  try {
    result = await callAnthropic(userContent);
    if (!validateResult(result) && Date.now() - started < RETRY_BUDGET_MS) {
      console.warn('analyze: invalid model output, retrying once');
      result = await callAnthropic(userContent);
    }
  } catch (err) {
    await refund();
    console.error('analyze: Anthropic call failed', err.status || err.message);
    const busy = err.status === 429 || err.status === 529 || err.status === 503;
    return json({ error: busy ? 'ai_busy' : 'ai_error' }, busy ? 503 : 502);
  }
  if (!validateResult(result)) {
    await refund();
    console.error('analyze: invalid model output after retry');
    return json({ error: 'invalid_ai_output' }, 502);
  }
  // Drop the original image from memory as early as possible
  image.data = null; userContent[1].source.data = null; body = null;

  // ── Persist ──
  const tPersist = Date.now();
  console.log(`analyze: critique ready at ${tPersist - started} ms after the AI step started`);
  const critiqueId = crypto.randomUUID();
  const dims = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, result.dimensions[k]]));
  const ins = await rest('critiques', {
    method: 'POST',
    prefer: 'return=minimal',
    body: {
      id: critiqueId,
      user_id: user.id,
      genre: photoType,
      title,
      score_overall: result.overall_score,
      scores_dimensions: dims,
      calibration_version: CALIBRATION_VERSION,
      model: MODEL,
      critique_text: JSON.stringify(result),
    },
  });
  const saved = ins.ok;
  if (!saved) console.error('analyze: critique insert failed', ins.status);

  // Thumbnail: only after the critique succeeded; a failure never breaks the critique
  let thumbnailSaved = false;
  let thumbnailError = thumbInput ? null : 'missing';
  if (saved && thumbInput) {
    const t = validateThumbnail(thumbInput);
    if (t.error) {
      thumbnailError = t.error;
      console.warn('analyze: thumbnail rejected', t.error, thumbInput.type);
    } else {
      const path = `${user.id}/${critiqueId}.${t.ext}`;
      try {
        const up = await uploadThumbnail(path, t.bytes, t.contentType);
        if (up.ok) {
          const pr = await rest(`critiques?id=eq.${critiqueId}`, { method: 'PATCH', prefer: 'return=minimal', body: { thumbnail_path: path } });
          thumbnailSaved = pr.ok;
          if (!pr.ok) { thumbnailError = 'db_update'; console.warn('analyze: thumbnail_path update failed', pr.status); }
        } else {
          thumbnailError = 'upload';
          console.warn('analyze: thumbnail upload failed', up.status, up.detail);
        }
      } catch (err) {
        thumbnailError = 'upload';
        console.warn('analyze: thumbnail upload error', err.message);
      }
    }
  }

  console.log(`analyze: saved ${saved} · thumbnail ${thumbnailSaved ? 'ok' : thumbnailError} · persist+thumbnail ${Date.now() - tPersist} ms`);
  return json({
    result,
    critique_id: saved ? critiqueId : null,
    thumbnail_saved: thumbnailSaved,
    thumbnail_error: thumbnailError,
    calibration_version: CALIBRATION_VERSION,
    quota: {
      plan: q.data.plan,
      used: q.data.used,
      limit: q.data.limit,
      remaining: Math.max(q.data.limit - q.data.used, 0),
      period_end: q.data.period_end,
      source,
      pack_credits: q.data.pack_credits || 0,
    },
  });
};
