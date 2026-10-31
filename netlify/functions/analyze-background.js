// Background worker for a critique (Netlify background function: up to 15 min).
// Triggered only by analyze.js with { job_id, key }. Netlify replies 202 to the caller at once.
//
// 1. Claims the job (pending → running) so a Netlify retry can never run it twice.
// 2. Reads the encrypted photo from the private bucket and deletes it straight away.
// 3. Runs the critique, saves it under the job id, uploads the thumbnail.
// 4. Marks the job done — or failed, with the critique refunded.
// It never throws: Netlify would retry a crashed background function.

import { rest, rpc, getObject, removeObjects, uploadThumbnail, JOBS_BUCKET } from '../lib/supabase.js';
import { callAnthropic, validateResult, open } from '../lib/critique.js';
import { validateThumbnail } from '../lib/thumbnail.js';
import { CALIBRATION_VERSION, MODEL, DIMENSION_KEYS } from '../lib/prompt.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const finish = (jobId, patch) =>
  rest(`critique_jobs?id=eq.${jobId}`, { method: 'PATCH', prefer: 'return=minimal', body: { ...patch, finished_at: new Date().toISOString() } })
    .catch(() => {});

export default async (request) => {
  let args;
  try { args = await request.json(); } catch { return; }
  const jobId = args && args.job_id;
  if (!jobId || !UUID.test(jobId) || typeof args.key !== 'string') return;
  const key = Buffer.from(args.key, 'base64');
  if (key.length !== 32) return;

  // ── 1 · Claim (atomic): only a pending job can start ──
  const claim = await rest(`critique_jobs?id=eq.${jobId}&status=eq.pending`, {
    method: 'PATCH', prefer: 'return=representation', body: { status: 'running' },
  }).catch(() => null);
  const row = claim && claim.ok && Array.isArray(claim.data) ? claim.data[0] : null;
  if (!row) { console.warn(`analyze-bg: job ${jobId} not pending, skipped`); return; }

  const source = row.source === 'pack' ? 'pack' : 'quota';
  const refund = () => rpc('refund_critique', { p_user_id: row.user_id, p_source: source }).catch(() => {});
  const fail = async (error, detail) => {
    console.error(`analyze-bg: job ${jobId} failed (${error})`, detail || '');
    await refund();
    await finish(jobId, { status: 'failed', error });
  };

  // ── 2 · Read the photo, then delete it immediately ──
  let job;
  try {
    const sealed = await getObject(JOBS_BUCKET, jobId);
    await removeObjects(JOBS_BUCKET, [jobId]);
    if (!sealed) return fail('internal', 'photo hand-off missing');
    job = open(sealed, key);   // throws if the key is wrong or the data was altered
  } catch (err) {
    await removeObjects(JOBS_BUCKET, [jobId]);
    return fail('internal', `hand-off: ${err.message}`);
  }
  if (job.user_id !== row.user_id) return fail('internal', 'user mismatch');

  try {
    // ── 3 · Critique ──
    const userContent = [
      { type: 'text', text: `Photo Type: ${job.photoType}\nConditions: ${job.conditions}\nIntent: ${job.intent}\nEXIF: ${job.exif}\n\nPlease evaluate this photograph.` },
      { type: 'image', source: { type: 'base64', media_type: job.image.media_type, data: job.image.data } },
    ];
    const started = Date.now();
    let result = null;
    try {
      result = await callAnthropic(userContent);
      if (!validateResult(result)) {
        console.warn('analyze-bg: invalid model output, retrying once');
        result = await callAnthropic(userContent);
      }
    } catch (err) {
      const busy = err.status === 429 || err.status === 529 || err.status === 503;
      return fail(busy ? 'ai_busy' : 'ai_error', err.status || err.message);
    }
    if (!validateResult(result)) return fail('invalid_ai_output');
    // Drop the original photo from memory as early as possible
    job.image.data = null; userContent[1].source.data = null;
    console.log(`analyze-bg: critique ready at ${Date.now() - started} ms`);

    // ── Persist (critique id = job id) ──
    const dims = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, result.dimensions[k]]));
    const ins = await rest('critiques', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        id: jobId,
        user_id: row.user_id,
        genre: job.photoType,
        title: job.title,
        score_overall: result.overall_score,
        scores_dimensions: dims,
        calibration_version: CALIBRATION_VERSION,
        model: MODEL,
        critique_text: JSON.stringify(result),
      },
    });
    if (!ins.ok) return fail('internal', `critique insert ${ins.status}`);

    // ── Thumbnail: best effort, never breaks the critique ──
    let thumb = job.thumbnail ? 'pending' : 'missing';
    if (job.thumbnail) {
      const t = validateThumbnail(job.thumbnail);
      if (t.error) thumb = t.error;
      else {
        const path = `${row.user_id}/${jobId}.${t.ext}`;
        try {
          const up = await uploadThumbnail(path, t.bytes, t.contentType);
          if (up.ok) {
            const pr = await rest(`critiques?id=eq.${jobId}`, { method: 'PATCH', prefer: 'return=minimal', body: { thumbnail_path: path } });
            thumb = pr.ok ? 'ok' : 'db_update';
          } else thumb = 'upload';
        } catch { thumb = 'upload'; }
      }
    }

    // ── 4 · Done ──
    await finish(jobId, { status: 'done', error: null });
    console.log(`analyze-bg: job ${jobId} done · thumbnail ${thumb} · total ${Date.now() - started} ms`);
  } catch (err) {
    // Unexpected: refund only if the critique was not saved
    const saved = await rest(`critiques?id=eq.${jobId}&select=id`).catch(() => null);
    if (saved && saved.ok && Array.isArray(saved.data) && saved.data.length) {
      await finish(jobId, { status: 'done', error: null });
    } else {
      await fail('internal', err.message);
    }
  }
};
