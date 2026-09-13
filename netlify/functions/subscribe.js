const VALID_SOURCES = ['header', 'pdf_gate', 'post_critique'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Invalid request body', 400);
  }

  const { email, firstName, source, consent, consentText } = body || {};

  if (typeof email !== 'string' || !EMAIL_RE.test(email) || consent !== true || !VALID_SOURCES.includes(source)) {
    return jsonError('Invalid request', 400);
  }

  const apiKey = process.env.BREVO_API_KEY;
  const listId = process.env.BREVO_LIST_ID;
  if (!apiKey || !listId) {
    console.error('Subscribe function missing BREVO_API_KEY or BREVO_LIST_ID');
    return jsonError('Signup is not available right now', 500);
  }

  try {
    const brevoResponse = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        email,
        attributes: {
          FIRSTNAME: firstName || '',
          CONSENT_TS: new Date().toISOString(),
          SOURCE: source,
          CONSENT_TEXT: consentText || '',
        },
        listIds: [Number(listId)],
        updateEnabled: true,
      }),
    });

    if (brevoResponse.ok) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const errBody = await brevoResponse.json().catch(() => ({}));
    console.error('Brevo error:', brevoResponse.status, errBody);
    return jsonError('Could not complete signup', 502);
  } catch (err) {
    console.error('Subscribe function error:', err);
    return jsonError('Could not complete signup', 500);
  }
};
