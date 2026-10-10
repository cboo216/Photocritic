// Brevo sync (one-way: Supabase → Brevo). Failures are logged, never thrown:
// a Brevo outage must not break sign-up or account changes.

const API = 'https://api.brevo.com/v3';

function cfg() {
  const apiKey = process.env.BREVO_API_KEY;
  const listId = Number(process.env.BREVO_LIST_ID);
  return apiKey && listId ? { apiKey, listId } : null;
}

async function call(path, method, body) {
  const c = cfg();
  if (!c) { console.warn('Brevo sync skipped: BREVO_API_KEY / BREVO_LIST_ID missing'); return false; }
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'api-key': c.apiKey },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 404) console.error('Brevo', method, path.split('/')[2], res.status);
    return res.ok;
  } catch (err) {
    console.error('Brevo request failed:', err.message);
    return false;
  }
}

// Opt-in: add/update the contact and put it in the newsletter list
export function subscribe(email, { pseudo, consentText } = {}) {
  const c = cfg();
  return call('/contacts', 'POST', {
    email,
    attributes: {
      FIRSTNAME: pseudo || '',
      CONSENT_TS: new Date().toISOString(),
      SOURCE: 'account',
      CONSENT_TEXT: consentText || '',
    },
    listIds: c ? [c.listId] : [],
    updateEnabled: true,
  });
}

// Opt-out: remove from the newsletter list (contact kept for unsubscribe history)
export function unsubscribe(email) {
  const c = cfg();
  return call(`/contacts/lists/${c ? c.listId : 0}/contacts/remove`, 'POST', { emails: [email] });
}

// Account deletion: erase the contact entirely (GDPR right to erasure)
export function eraseContact(email) {
  return call(`/contacts/${encodeURIComponent(email)}`, 'DELETE');
}
