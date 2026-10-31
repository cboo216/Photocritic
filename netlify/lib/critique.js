// Shared critique logic for analyze (start) and analyze-background (worker).

import crypto from 'node:crypto';
import { SYSTEM_PROMPT, MODEL, DIMENSION_KEYS } from './prompt.js';

export const MAX_TOKENS = 1500;
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_IMAGE_B64 = 6.2 * 1024 * 1024;

export const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export function validateResult(r) {
  if (!r || typeof r !== 'object') return false;
  const ok = (s) => Number.isInteger(s) && s >= 1 && s <= 10;
  if (!ok(r.overall_score)) return false;
  if (!r.dimensions || typeof r.dimensions !== 'object') return false;
  if (!DIMENSION_KEYS.every((k) => ok(r.dimensions[k]))) return false;
  if (!Array.isArray(r.what_works) || !Array.isArray(r.what_to_improve)) return false;
  for (const f of ['overall_summary', 'one_thing_to_try']) if (typeof r[f] !== 'string') return false;
  return true;
}

export async function callAnthropic(userContent) {
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
      // Prompt caching: the ~2,400-token instructions are identical on every call,
      // so Anthropic serves them from cache (faster first token, ~90% cheaper on that part).
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const err = new Error(`anthropic_${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const u = data.usage || {};
  console.log(`analyze: anthropic ${Date.now() - t0} ms · in ${u.input_tokens} tok · cache read ${u.cache_read_input_tokens || 0} / write ${u.cache_creation_input_tokens || 0} · out ${u.output_tokens} tok · stop ${data.stop_reason}`);
  const text = (data.content || []).map((c) => c.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(clean); } catch { return null; }
}

// ── Photo hand-off encryption (AES-256-GCM) ──
// Layout: iv (12 bytes) · auth tag (16 bytes) · ciphertext.
// The key exists only in memory and in the private background-function trigger.
export function seal(obj, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function open(buf, key) {
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), ct = buf.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}
