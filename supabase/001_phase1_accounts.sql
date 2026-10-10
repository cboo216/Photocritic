-- ═══════════════════════════════════════════════════════════════════
-- Second Eye — Phase 1 migration: accounts, critiques, quota, thumbnails
-- Paste the whole file into Supabase → SQL Editor → Run. Run it once.
-- ═══════════════════════════════════════════════════════════════════

-- ── TABLES ──────────────────────────────────────────────────────────

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  pseudo text unique check (char_length(pseudo) between 3 and 30),
  plan text not null default 'free' check (plan in ('free','pro')),
  stripe_customer_id text unique,
  stripe_subscription_id text,
  subscription_status text,           -- raw Stripe status (active, trialing, past_due, canceled...)
  current_period_end timestamptz,
  critiques_used integer not null default 0,
  quota_period_start timestamptz not null default now(),
  marketing_opt_in boolean not null default false,
  marketing_opt_in_at timestamptz,
  withdrawal_waiver_at timestamptz,   -- consent to immediate execution (Phase 2)
  created_at timestamptz not null default now()
);

-- Pseudos are unique regardless of case ("Ced" and "ced" are the same pseudo)
create unique index profiles_pseudo_lower_idx on public.profiles (lower(pseudo));

create table public.critiques (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  genre text,
  title text check (char_length(title) <= 120),
  -- Scale is 1–10, integers only (smallint rejects decimals)
  score_overall smallint not null check (score_overall between 1 and 10),
  scores_dimensions jsonb not null,               -- {"composition": 7, "light": 6, ...}
  calibration_version text not null,              -- e.g. "v2.8"
  model text not null,                            -- e.g. "claude-sonnet-4-6"
  critique_text text not null,                    -- full JSON returned by the model
  thumbnail_path text                             -- '{user_id}/{critique_id}.webp' in bucket 'thumbnails'
);
create index critiques_user_created_idx on public.critiques (user_id, created_at desc);

create table public.stripe_events (
  id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);

-- ── PROFILE CREATED AUTOMATICALLY AT SIGN-UP ───────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── ROW LEVEL SECURITY ─────────────────────────────────────────────

alter table public.profiles      enable row level security;
alter table public.critiques     enable row level security;
alter table public.stripe_events enable row level security;

-- profiles: read own row; update only pseudo + marketing columns
create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = auth.uid());
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (pseudo, marketing_opt_in, marketing_opt_in_at) on public.profiles to authenticated;

-- critiques: read own rows; writes only through server functions (service role)
create policy "critiques: read own" on public.critiques
  for select to authenticated using (user_id = auth.uid());

revoke all on public.critiques from anon, authenticated;
grant select on public.critiques to authenticated;

-- stripe_events: no client access at all (RLS on, no policy, no grant)
revoke all on public.stripe_events from anon, authenticated;

-- ── QUOTA: atomic consume / refund ─────────────────────────────────
-- Limits come from Netlify env vars (FREE_MONTHLY_QUOTA, PRO_MONTHLY_QUOTA)
-- and are passed in by the function, so they can change without a migration.

create or replace function public.consume_critique(
  p_user_id uuid, p_free_limit integer, p_pro_limit integer
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.profiles%rowtype;
  v_limit integer;
begin
  select * into r from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object('allowed', false, 'error', 'no_profile');
  end if;

  -- Rolling monthly period
  if now() >= r.quota_period_start + interval '1 month' then
    r.critiques_used := 0;
    r.quota_period_start := now();
    update public.profiles
       set critiques_used = 0, quota_period_start = r.quota_period_start
     where id = p_user_id;
  end if;

  v_limit := case when r.plan = 'pro' then p_pro_limit else p_free_limit end;

  if r.critiques_used >= v_limit then
    return jsonb_build_object('allowed', false, 'plan', r.plan, 'used', r.critiques_used,
      'limit', v_limit, 'period_end', r.quota_period_start + interval '1 month');
  end if;

  update public.profiles set critiques_used = critiques_used + 1 where id = p_user_id;

  return jsonb_build_object('allowed', true, 'plan', r.plan, 'used', r.critiques_used + 1,
    'limit', v_limit, 'period_end', r.quota_period_start + interval '1 month');
end;
$$;

create or replace function public.refund_critique(p_user_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles
     set critiques_used = greatest(critiques_used - 1, 0)
   where id = p_user_id;
$$;

-- Only the server (service role) may call these
revoke execute on function public.consume_critique(uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.refund_critique(uuid) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.consume_critique(uuid, integer, integer) to service_role;
grant execute on function public.refund_critique(uuid) to service_role;

-- ── THUMBNAILS: private storage bucket ─────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('thumbnails', 'thumbnails', false, 51200, array['image/webp','image/jpeg'])
on conflict (id) do nothing;

-- A user can read only files under their own '{user_id}/' folder.
-- No insert/update/delete policy: uploads and deletions go through the service role only.
create policy "thumbnails: read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'thumbnails' and (storage.foldername(name))[1] = auth.uid()::text);
