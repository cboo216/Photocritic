// netlify/functions/analyze.js
// Proxies the photo-critique request to the Anthropic API.
// The API key is read from the ANTHROPIC_API_KEY environment variable
// (set it in Netlify → Site settings → Environment variables — never hardcode it).

export async function handler(event) {
  // CORS / preflight (harmless if same-origin)
  const cors = {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: { message: 'Method Not Allowed' } }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Surfaces as a clear message in your Network tab instead of a silent failure.
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: { message: 'Server is missing ANTHROPIC_API_KEY. Set it in Netlify env vars and redeploy.' } }) };
  }

  try {
    const payload = JSON.parse(event.body || '{}');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: payload.model || 'claude-sonnet-4-6',
        // Raised from 1000: the full six-dimension JSON response needs room,
        // otherwise it gets truncated and JSON.parse fails on the client.
        max_tokens: 2048,
        system: payload.system,
        messages: payload.messages
      })
    });

    const data = await res.json();

    // Pass the real status + body straight through so client errors are visible.
    return { statusCode: res.status, headers: cors, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: { message: String(err && err.message ? err.message : err) } }) };
  }
}
