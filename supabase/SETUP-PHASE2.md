# Phase 2 — Stripe : abonnement Pro + Critique Pack (≈ 30 min)

**Ordre important : Supabase → Stripe (mode test) → Netlify → GitHub (branche) → tests → passage en live.**
Tant que les variables Stripe ne sont pas dans Netlify, le site reste utilisable : les boutons « Go Pro » / « Buy a pack » affichent « Payments open very soon ».

---

## 1. Supabase — migration
1. SQL Editor → New query → coller tout `supabase/002_phase2_payments.sql` → **Run**.
   Doit finir par « Success. No rows returned ». Le script peut être relancé sans risque.
2. Vérifier dans Table Editor : `profiles` a les colonnes `pack_credits`, `billing_interval`, `cancel_at_period_end` ; nouvelle table `credit_ledger`.

> Compatible avec le code actuellement en ligne : tu peux lancer la migration avant l'upload GitHub.

## 2. Stripe — configuration (en **mode test** d'abord, bouton « Test mode » en haut à droite)
1. **Compte** : Settings → Business → nom public « Second Eye », e-mail support `hello@getsecondeye.com`, entité LOUJU SA.
2. **Produits** (Product catalog → Add product). Prix **TTC** : dans chaque prix, « Include tax in price » = Yes.
   - **Second Eye Pro** : prix récurrent **4,90 € / mois** + prix récurrent **49 € / an**.
   - **Critique Pack** : prix **unique (one-off) 7 €**. Description : « 12 critiques — credits valid for 12 months ».
   - Noter les 3 **Price ID** (`price_…`).
3. **Customer portal** (Settings → Billing → Customer portal) → activer :
   - Cancel subscriptions → **at end of billing period**
   - Update payment methods, View invoice history
   - Switch plans → ajouter les deux prix Pro (mensuel ↔ annuel)
   - Liens : Terms `https://getsecondeye.com/terms.html`, Privacy `https://getsecondeye.com/privacy.html`
4. **E-mails clients** (Settings → Customer emails) : activer « Successful payments » (reçu) et « Failed payments ».
5. **Webhook** (Developers → Webhooks → Add endpoint) :
   - URL : `https://getsecondeye.com/.netlify/functions/stripe-webhook`
   - Événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`
   - Noter le **Signing secret** (`whsec_…`).
6. **Clé API** : Developers → API keys → **Secret key** (`sk_test_…`). Ne jamais la partager ni la mettre dans le code.

## 3. Netlify → Site configuration → Environment variables
| Variable | Valeur | Secret ? |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` (puis `sk_live_…`) | **oui** |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | **oui** |
| `STRIPE_PRICE_MONTHLY` | price ID Pro 4,90 €/mois | non |
| `STRIPE_PRICE_ANNUAL` | price ID Pro 49 €/an | non |
| `STRIPE_PRICE_PACK` | price ID Pack 7 € | non |
| `PACK_CREDITS` | `12` | non |
| `APP_URL` | `https://getsecondeye.com` | non |

Scope : « All deploy contexts ». Pour tester sur une deploy preview, mets `APP_URL` = l'URL de la preview dans le contexte « Deploy previews » (sinon le retour de paiement renvoie vers la prod).

## 4. Mise en ligne via GitHub (par une branche)
Fichiers à uploader (nouveaux ★ ou modifiés) :
- `index.html`, `pricing.html`, `account.html`, `privacy.html`, ★ `terms.html`
- `js/auth.js`
- `netlify/lib/` : ★ `stripe.js`
- `netlify/functions/` : `analyze.js`, `profile.js`, `delete-account.js`, `public-config.js`, ★ `create-checkout.js`, ★ `customer-portal.js`, ★ `stripe-webhook.js`
- `supabase/` : ★ `002_phase2_payments.sql`, ★ `SETUP-PHASE2.md`

Branche `feat/stripe-payments` → pull request → deploy preview → tests ci-dessous → **Merge**.

## 5. Tests d'acceptation (mode test Stripe)
Carte qui marche : `4242 4242 4242 4242`, date future, CVC quelconque. Carte refusée : `4000 0000 0000 0341`.
- [ ] Déconnecté → « Go Pro » → e-mail de connexion → retour sur Pricing → la fenêtre de confirmation s'ouvre seule.
- [ ] Le bouton « Continue to secure payment » reste grisé tant que la case de renonciation n'est pas cochée.
- [ ] Paiement Pro mensuel réussi → retour sur Mon compte → bandeau « Welcome to Pro » → badge PRO, quota 50, date de renouvellement. Supabase : `plan = pro`, `withdrawal_waiver_at` rempli.
- [ ] « Manage subscription » ouvre le portail Stripe ; annuler → compte affiche « Cancelled · Pro until … » (reste Pro jusqu'à la fin de période).
- [ ] Fin de période simulée (Stripe → l'abonnement → « Cancel immediately ») → retour au plan Free.
- [ ] Carte refusée → message d'erreur Stripe, pas de crash, compte inchangé.
- [ ] Pack acheté → bandeau « Your Critique Pack is ready: 12 credits ». Supabase : `pack_credits = 12`, une ligne `pack_purchase` dans `credit_ledger`.
- [ ] Compte Free avec quota épuisé + crédits → la critique passe, `pack_credits` baisse de 1 ; la ligne de quota affiche « … pack credits left ».
- [ ] Rejouer un événement (Stripe → Webhooks → l'événement → « Resend ») → aucun crédit en double.
- [ ] Mauvaise signature : `curl -X POST https://…/.netlify/functions/stripe-webhook -d '{}'` → **400**.
- [ ] Supprimer un compte Pro → l'abonnement est annulé dans Stripe.

## 6. Passage en live
1. Compléter **`terms.html`** : les champs surlignés en jaune (capital, RCS, adresse, n° TVA, **médiateur de la consommation**, obligatoire pour vendre aux particuliers en France).
2. Stripe : activer le compte (infos LOUJU SA, IBAN), recréer les 3 prix et le webhook **en mode live** (les IDs test ne marchent pas en live).
3. Netlify : remplacer les variables par les valeurs live → **Trigger deploy** (les variables ne s'appliquent qu'au déploiement suivant).
4. Faire un vrai achat de Pack à 7 € avec ta carte, vérifier, puis te rembourser depuis Stripe.

## Points connus / limites
- Paiement refusé au renouvellement (`past_due`) → retour immédiat au plan Free (règle de la spec), Pro revient dès que Stripe réussit à prélever.
- Les crédits Pack sont perdus à la suppression du compte (écrit dans les CGV et sur la page compte).
- Les factures restent chez Stripe 10 ans (obligation légale), même après suppression du compte.
- TVA : prix TTC fixes, pas de Stripe Tax. À revoir avec ton comptable (régime TVA de LOUJU SA, ventes B2C hors France > 10 000 €/an → OSS).
