/* ─────────────────────────────────────────────────────────────
   Second Eye — shared account module (all pages)
   Requires supabase-js (UMD) loaded before this file.
   Exposes window.SE:
     SE.ready            Promise, resolves once the session is known
     SE.session          current Supabase session or null
     SE.profile          { email, pseudo, plan, marketing_opt_in, quota{...} } or null
     SE.api(path, opts)  fetch a Netlify function with the user's token
     SE.openSignIn(ctx)  show the magic-link modal ('header' | 'critique' | 'pdf')
     SE.requireAccount() resolves true when signed in AND pseudo set
     SE.refreshProfile() re-reads the profile from the server
     SE.signOut()
     SE.onChange(fn)     fn(SE) on any auth/profile change
   ───────────────────────────────────────────────────────────── */
(function () {
  const FN = '/.netlify/functions/';
  const listeners = [];
  const SE = { session: null, profile: null, client: null, configured: false };
  window.SE = SE;

  const track = (e, p) => { try { if (window.posthog) window.posthog.capture(e, p || {}); } catch (_) {} };
  const emit = () => {
    updateHeader();
    listeners.forEach((fn) => { try { fn(SE); } catch (e) { console.error(e); } });
  };
  SE.onChange = (fn) => { listeners.push(fn); };

  // ── Styles (scoped .se-*) ──
  const css = `
  [data-auth][hidden]{display:none!important}
  .se-ov{position:fixed;inset:0;background:rgba(26,30,46,.55);display:flex;align-items:center;justify-content:center;padding:20px;z-index:1000}
  .se-ov[hidden]{display:none}
  .se-card{background:#fff;border-radius:16px;padding:28px 26px;max-width:400px;width:100%;position:relative;font-family:'Montserrat',sans-serif;box-shadow:0 20px 50px rgba(26,30,46,.25);color:var(--ink,#1A1E2E)}
  .se-x{position:absolute;top:10px;right:14px;background:none;border:none;font-size:24px;line-height:1;color:var(--ink-light,#8892AA);cursor:pointer;padding:4px}
  .se-t{font-size:18px;font-weight:700;margin:0 0 8px}
  .se-s{font-size:13px;color:var(--ink-mid,#4A5168);margin:0 0 18px;line-height:1.55}
  .se-in{width:100%;box-sizing:border-box;padding:11px 13px;margin-bottom:10px;border:1px solid var(--border-mid,#C2CCDB);border-radius:10px;font:inherit;font-size:14px;color:var(--ink,#1A1E2E)}
  .se-in:focus{outline:none;border-color:var(--blue,#2B4F8A)}
  .se-hint{font-size:11.5px;color:var(--ink-light,#8892AA);margin:-4px 0 12px}
  .se-chk{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;color:var(--ink-mid,#4A5168);margin:4px 0 14px;line-height:1.45;cursor:pointer}
  .se-chk input{margin-top:2px;flex-shrink:0}
  .se-card a{color:var(--blue-mid,#3D6199)}
  .se-err{color:var(--red,#8A1F1F);font-size:12.5px;margin-bottom:10px}
  .se-err[hidden],.se-card [hidden]{display:none}
  .se-btn{width:100%;background:var(--blue,#2B4F8A);color:#fff;border:none;border-radius:10px;padding:12px;font:inherit;font-size:14px;font-weight:600;cursor:pointer;transition:background .15s}
  .se-btn:hover{background:var(--blue-dark,#1C3660)}
  .se-btn:disabled{opacity:.6;cursor:progress}
  .se-link{background:none;border:none;color:var(--blue-mid,#3D6199);font:inherit;font-size:12.5px;cursor:pointer;padding:0;margin-top:12px;text-decoration:underline}
  .se-fine{font-size:11.5px;color:var(--ink-light,#8892AA);margin-top:12px;line-height:1.5}
  @media (max-width:820px){.se-in{font-size:16px}}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Modals ──
  const COPY = {
    header:   { t: 'Sign in or create your account', s: 'Enter your email and we’ll send you a sign-in link. No password needed. New here? This creates your free account (3 critiques a month).' },
    critique: { t: 'Create your free account to get your critique', s: 'Enter your email and we’ll send you a sign-in link. Free accounts get 3 critiques a month. No password, no card.' },
    pdf:      { t: 'Sign in to download your critique', s: 'Enter your email and we’ll send you a sign-in link.' },
  };

  function mount() {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
    <div class="se-ov" id="se-signin" hidden role="dialog" aria-modal="true" aria-labelledby="se-signin-t">
      <div class="se-card">
        <button class="se-x" type="button" aria-label="Close" data-close>×</button>
        <div id="se-signin-form">
          <h3 class="se-t" id="se-signin-t"></h3>
          <p class="se-s" id="se-signin-s"></p>
          <input id="se-email" class="se-in" type="email" placeholder="you@email.com" autocomplete="email" inputmode="email">
          <div id="se-signin-err" class="se-err" role="alert" hidden></div>
          <button class="se-btn" id="se-signin-btn" type="button">Email me a sign-in link</button>
          <p class="se-fine">By continuing you accept our <a href="/privacy.html" target="_blank">privacy policy</a>.</p>
        </div>
        <div id="se-signin-sent" hidden>
          <h3 class="se-t">Check your inbox</h3>
          <p class="se-s">We sent a sign-in link to <strong id="se-sent-to"></strong>. Open it on this device to continue. It can take a minute, and may land in spam.</p>
          <button class="se-btn" type="button" data-close>OK</button>
          <button class="se-link" type="button" id="se-retry">Use a different email</button>
        </div>
      </div>
    </div>
    <div class="se-ov" id="se-onboard" hidden role="dialog" aria-modal="true" aria-labelledby="se-onboard-t">
      <div class="se-card">
        <button class="se-x" type="button" aria-label="Close" data-close>×</button>
        <h3 class="se-t" id="se-onboard-t">Welcome to Second Eye</h3>
        <p class="se-s">Pick a pseudo. It’s how your account is shown to you; nobody else sees it.</p>
        <input id="se-pseudo" class="se-in" type="text" maxlength="30" placeholder="Your pseudo" autocomplete="nickname" autocapitalize="off" spellcheck="false">
        <div class="se-hint">3–30 characters: letters, numbers, dot, dash or underscore.</div>
        <label class="se-chk"><input id="se-optin" type="checkbox"><span>Send me photography tips and Second Eye news</span></label>
        <div id="se-onboard-err" class="se-err" role="alert" hidden></div>
        <button class="se-btn" id="se-onboard-btn" type="button">Continue</button>
        <p class="se-fine">You can change this anytime in your account. See our <a href="/privacy.html" target="_blank">privacy policy</a>.</p>
      </div>
    </div>`;
    document.body.appendChild(wrap);

    wrap.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => {
      b.closest('.se-ov').hidden = true;
      if (b.closest('#se-onboard')) resolvePending(false);
    }));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      ['se-signin', 'se-onboard'].forEach((id) => { const el = document.getElementById(id); if (el && !el.hidden) { el.hidden = true; if (id === 'se-onboard') resolvePending(false); } });
    });
    document.getElementById('se-signin-btn').addEventListener('click', sendLink);
    document.getElementById('se-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendLink(); });
    document.getElementById('se-retry').addEventListener('click', () => showSignInStep('form'));
    document.getElementById('se-onboard-btn').addEventListener('click', saveOnboarding);
    document.getElementById('se-pseudo').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveOnboarding(); });
  }

  function showSignInStep(step) {
    document.getElementById('se-signin-form').hidden = step !== 'form';
    document.getElementById('se-signin-sent').hidden = step !== 'sent';
  }

  SE.openSignIn = function (ctx, errorText) {
    const c = COPY[ctx] || COPY.header;
    document.getElementById('se-signin-t').textContent = c.t;
    document.getElementById('se-signin-s').textContent = c.s;
    const err = document.getElementById('se-signin-err');
    err.textContent = errorText || ''; err.hidden = !errorText;
    document.getElementById('se-signin-btn').disabled = false;
    showSignInStep('form');
    document.getElementById('se-signin').hidden = false;
    if (window.matchMedia('(pointer: fine)').matches) document.getElementById('se-email').focus();
    track('signin_shown', { context: ctx || 'header' });
  };

  async function sendLink() {
    const email = document.getElementById('se-email').value.trim();
    const err = document.getElementById('se-signin-err');
    err.hidden = true;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'Please enter a valid email.'; err.hidden = false; return; }
    if (!SE.client) { err.textContent = 'Accounts are not available right now. Please try again later.'; err.hidden = false; return; }
    const btn = document.getElementById('se-signin-btn');
    btn.disabled = true;
    const { error } = await SE.client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: location.origin + location.pathname, shouldCreateUser: true },
    });
    btn.disabled = false;
    if (error) {
      err.textContent = /rate|seconds|too many/i.test(error.message)
        ? 'Too many requests. Please wait a minute before asking for another link.'
        : 'We couldn’t send the link. Please check the address and try again.';
      err.hidden = false;
      return;
    }
    document.getElementById('se-sent-to').textContent = email;
    showSignInStep('sent');
    track('signin_link_sent');
  }

  // ── Onboarding (first login: pseudo + opt-in) ──
  let pending = null;
  function resolvePending(v) { if (pending) { const p = pending; pending = null; p(v); } }

  function openOnboarding() {
    document.getElementById('se-pseudo').value = '';
    document.getElementById('se-optin').checked = false; // unchecked by default (GDPR)
    document.getElementById('se-onboard-err').hidden = true;
    document.getElementById('se-onboard').hidden = false;
    if (window.matchMedia('(pointer: fine)').matches) document.getElementById('se-pseudo').focus();
  }

  async function saveOnboarding() {
    const pseudo = document.getElementById('se-pseudo').value.trim();
    const optIn = document.getElementById('se-optin').checked;
    const err = document.getElementById('se-onboard-err');
    err.hidden = true;
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(pseudo)) { err.textContent = 'Use 3–30 letters, numbers, dot, dash or underscore.'; err.hidden = false; return; }
    const btn = document.getElementById('se-onboard-btn');
    btn.disabled = true;
    const r = await SE.api('profile', { method: 'POST', body: { pseudo, marketing_opt_in: optIn } });
    btn.disabled = false;
    if (!r.ok) {
      err.textContent = r.data && r.data.error === 'pseudo_taken' ? 'That pseudo is already taken. Try another.' : 'Something went wrong. Please try again.';
      err.hidden = false;
      return;
    }
    SE.profile = r.data;
    document.getElementById('se-onboard').hidden = true;
    track('onboarding_completed', { marketing_opt_in: optIn });
    emit();
    resolvePending(true);
  }

  // ── API helper ──
  SE.api = async function (path, { method = 'GET', body } = {}) {
    const headers = {};
    if (SE.session) headers.Authorization = 'Bearer ' + SE.session.access_token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const res = await fetch(FN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: { error: 'network' } };
    }
  };

  SE.refreshProfile = async function () {
    if (!SE.session) { SE.profile = null; emit(); return null; }
    const r = await SE.api('profile');
    SE.profile = r.ok ? r.data : null;
    emit();
    return SE.profile;
  };

  // Resolves true when the user is signed in and has a pseudo
  SE.requireAccount = async function (ctx) {
    await SE.ready;
    if (!SE.session) { SE.openSignIn(ctx || 'critique'); return false; }
    if (!SE.profile) await SE.refreshProfile();
    if (SE.profile && SE.profile.pseudo) return true;
    if (!SE.profile) return false;
    return new Promise((resolve) => { pending = resolve; openOnboarding(); });
  };

  SE.signOut = async function () {
    if (SE.client) await SE.client.auth.signOut();
    SE.session = null; SE.profile = null;
    emit();
  };

  // ── Header: [data-auth="out"] shown when signed out, [data-auth="in"] when signed in ──
  function updateHeader() {
    const signedIn = !!SE.session;
    document.querySelectorAll('[data-auth="out"]').forEach((el) => { el.hidden = signedIn; });
    document.querySelectorAll('[data-auth="in"]').forEach((el) => { el.hidden = !signedIn; });
  }

  // ── Boot ──
  let lastUserId = null;
  async function onSession(session) {
    SE.session = session;
    const uid = session ? session.user.id : null;
    if (uid && uid !== lastUserId) {
      lastUserId = uid;
      await SE.refreshProfile();
      if (SE.profile && !SE.profile.pseudo) openOnboarding();
    } else if (!uid) {
      lastUserId = null;
      SE.profile = null;
      emit();
    } else {
      emit();
    }
  }

  SE.ready = (async function boot() {
    if (document.readyState === 'loading') await new Promise((r) => document.addEventListener('DOMContentLoaded', r));
    mount();
    updateHeader();

    // Expired / invalid magic link comes back as #error=...
    const hash = new URLSearchParams(location.hash.slice(1));
    const linkError = hash.get('error_description');

    let cfg = null;
    try { cfg = await (await fetch(FN + 'public-config')).json(); } catch (_) {}
    if (!cfg || !cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) {
      console.warn('Second Eye: accounts not configured');
      return;
    }
    SE.configured = true;
    SE.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { flowType: 'implicit', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true },
    });

    const { data } = await SE.client.auth.getSession();
    await onSession(data.session);
    SE.client.auth.onAuthStateChange((event, session) => {
      // Defer: never await other Supabase calls inside this callback
      setTimeout(() => {
        if (event === 'SIGNED_IN' && session && session.user.id !== lastUserId) {
          track('signed_in');
          const so = document.getElementById('se-signin'); if (so) so.hidden = true;
        }
        if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') onSession(session);
      }, 0);
    });

    if (linkError) {
      history.replaceState(null, '', location.pathname + location.search);
      if (!SE.session) SE.openSignIn('header', 'That sign-in link has expired or was already used. Request a new one below.');
    }
    if (!SE.session && new URLSearchParams(location.search).get('join') === '1') SE.openSignIn('header');
  })();
})();
