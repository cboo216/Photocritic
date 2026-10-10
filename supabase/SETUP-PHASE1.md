# Phase 1 — Mise en route (≈ 15 min)

Ordre important : **Supabase et Netlify d'abord, upload GitHub ensuite.** Une fois le code en ligne, la critique exige un compte : sans les variables d'environnement, l'analyse renvoie une erreur.

## 1. Supabase (projet)
1. supabase.com → New project. Nom `second-eye`, **région EU (Paris `eu-west-3` ou Frankfurt)**, mot de passe DB fort (à garder dans ton gestionnaire).
2. **SQL Editor** → New query → coller tout `supabase/001_phase1_accounts.sql` → **Run**. Doit finir par « Success. No rows returned ».
3. **Authentication → Sign In / Providers → Email** : activé. Laisse « Confirm email » activé (le magic link sert de confirmation).
4. **Authentication → URL Configuration**
   - Site URL : `https://getsecondeye.com`
   - Redirect URLs : `https://getsecondeye.com/**` et `https://*--NOM-DU-SITE.netlify.app/**` (remplace NOM-DU-SITE par le nom Netlify du site, pour tester sur les deploy previews).
5. **Project Settings → API Keys** : note la **Project URL**, la clé **anon / publishable** (publique) et la clé **service_role / secret** (**ne jamais la partager, ni la mettre dans le code**).

## 2. Brevo comme serveur d'envoi des magic links
1. Brevo → **Senders, Domains** : vérifie que `getsecondeye.com` est authentifié (SPF + DKIM), sinon les liens finiront en spam.
2. Brevo → **SMTP & API → SMTP** : note le *login* SMTP et génère une *clé SMTP*.
3. Supabase → **Authentication → Emails → SMTP Settings** → Enable custom SMTP :
   - Sender email `hello@getsecondeye.com`, Sender name `Second Eye`
   - Host `smtp-relay.brevo.com`, Port `587`, Username = login SMTP Brevo, Password = clé SMTP Brevo
4. Supabase → **Authentication → Rate Limits** : passe « emails per hour » à ~100.
5. Supabase → **Authentication → Emails → Templates → Magic Link** (facultatif mais recommandé) :
   - Subject : `Your Second Eye sign-in link`
   - Body :
     ```html
     <h2>Sign in to Second Eye</h2>
     <p>Click the link below to sign in. It expires in 1 hour and works once.</p>
     <p><a href="{{ .ConfirmationURL }}">Sign in to Second Eye</a></p>
     <p>If you didn't ask for this, you can ignore this email.</p>
     ```
   - Fais pareil pour le template **Confirm signup** (1ʳᵉ connexion d'un nouvel utilisateur).

## 3. Netlify → Site configuration → Environment variables
| Variable | Valeur | Secret ? |
|---|---|---|
| `SUPABASE_URL` | Project URL | non |
| `SUPABASE_ANON_KEY` | clé anon / publishable | non |
| `SUPABASE_SERVICE_ROLE_KEY` | clé service_role / secret | **oui** |
| `FREE_MONTHLY_QUOTA` | `3` | non |
| `PRO_MONTHLY_QUOTA` | `50` | non |
| `ANTHROPIC_API_KEY`, `BREVO_API_KEY`, `BREVO_LIST_ID` | déjà en place | — |

Scope : « All deploy contexts », pour que les deploy previews fonctionnent aussi.

## 4. Mise en ligne via GitHub (recommandé : par une branche)
1. GitHub → ton repo → **Add file → Upload files** → glisse les fichiers/dossiers modifiés (liste dans le récap).
2. En bas : choisis **« Create a new branch for this commit and start a pull request »**, nom `feat/accounts-payments`.
3. Netlify construit une **deploy preview** (lien dans la PR). Teste dessus (section 5).
4. Si tout est bon : **Merge pull request** → production.

## 5. Tests d'acceptation (sur la deploy preview)
- [ ] Sign up → e-mail reçu → clic → retour sur le site connecté → fenêtre pseudo → profil créé (Supabase → Table Editor → `profiles`).
- [ ] Critique → une ligne dans `critiques` (scores entiers, `calibration_version = v2.8`) + un fichier dans Storage → `thumbnails/{id}/…`.
- [ ] Télécharge cette miniature et vérifie : ≤ 256 px, aucune donnée EXIF/GPS (teste avec une photo iPhone géolocalisée).
- [ ] 4ᵉ critique du mois en Free → écran « You've used your 3 critiques ».
- [ ] Deux comptes (2 e-mails) : chacun ne voit que ses données (page compte).
- [ ] Opt-in coché → contact ajouté dans la liste Brevo ; décoché → retiré.
- [ ] « Delete my account » → plus rien dans `profiles`, `critiques`, Storage, ni dans Brevo.
- [ ] `https://…/netlify/lib/prompt.js` renvoie 404 (le prompt n'est pas public).
- [ ] Appel direct sans connexion : `curl -X POST https://…/.netlify/functions/analyze` → 401.
