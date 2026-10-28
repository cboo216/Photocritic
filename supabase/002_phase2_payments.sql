-- ═══════════════════════════════════════════════════════════════════
-- Second Eye — Phase 2 migration: Stripe billing + Critique Pack credits
-- Run AFTER 001_phase1_accounts.sql. Paste the whole file into
-- Supabase → SQL Editor → Run. Run it once.
--
-- Safe to run before the new code is online: the old analyze function
-- keeps working (same consume_critique signature; refund_critique gets
-- an optional second argument).
-- ═══════════════════════════════════════════════════════════════════

-- ── PROFILES: new billing columns ──────────────────────────────────

alter table public.profiles
  add column if not exists pack_credits integer not null default 0 check (pack_credits >= 0),
  -- Pack credits are valid 12 months from the most recent pack purchase
  -- (each new pack extends the whole balance)
  add column if not exists pack_credits_expire_at timestamptz,
  add column if not exists billing_interval text check (billing_interval in ('month','year')),
  add column if not exists cancel_at_period_end boolean not null default false;

-- ── CREDIT LEDGER: every pack credit added or spent ────────────────
-- Gives an audit trail ("where did my credits go?") and makes pack
-- purchases idempotent: one Stripe Checkout session = credits added once.

create table if not exists public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  delta integer not null,
  reason text not null,
  stripe_session_id text unique,
  created_at timestamptz not null default now()
);
alter table public.credit_ledger drop constraint if exists credit_ledger_reason_check;
alter table public.credit_ledger add constraint credit_ledger_reason_check
  check (reason in ('pack_purchase','critique','refund','expiry','adjustment'));
create index if not exists credit_ledger_user_idx on public.credit_ledger (user_id, created_at desc);

alter table public.credit_ledger enable row level security;
drop policy if exists "credit_ledger: read own" on public.credit_ledger;
create policy "credit_ledger: read own" on public.credit_ledger
  for select to authenticated using (user_id = auth.uid());
revoke all on public.credit_ledger from anon, authenticated;
grant select on public.credit_ledger to authenticated;

-- ── EXPIRY: clears a lapsed pack balance (called with the profile row locked) ──
create or replace function public.expire_pack_credits(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credits integer;
  v_expire timestamptz;
begin
  select pack_credits, pack_credits_expire_at into v_credits, v_expire
    from public.profiles where id = p_user_id for update;
  if v_credits > 0 and v_expire is not null and now() >= v_expire then
    update public.profiles set pack_credits = 0 where id = p_user_id;
    insert into public.credit_ledger (user_id, delta, reason) values (p_user_id, -v_credits, 'expiry');
    return 0;
  end if;
  return coalesce(v_credits, 0);
end;
$$;

-- ── QUOTA: monthly allowance first, then pack credits ──────────────
-- Same signature as Phase 1. New fields in the result:
--   source       'quota' | 'pack'  (what this critique used)
--   pack_credits remaining pack credits after this critique

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
  v_period_end timestamptz;
begin
  select * into r from public.profiles where id = p_user_id for update;
  if not found then
    return jsonb_build_object('allowed', false, 'error', 'no_profile');
  end if;
  r.pack_credits := public.expire_pack_credits(p_user_id);

  -- Rolling monthly period
  if now() >= r.quota_period_start + interval '1 month' then
    r.critiques_used := 0;
    r.quota_period_start := now();
    update public.profiles
       set critiques_used = 0, quota_period_start = r.quota_period_start
     where id = p_user_id;
  end if;

  v_limit := case when r.plan = 'pro' then p_pro_limit else p_free_limit end;
  v_period_end := r.quota_period_start + interval '1 month';

  -- 1) Monthly allowance
  if r.critiques_used < v_limit then
    update public.profiles set critiques_used = critiques_used + 1 where id = p_user_id;
    return jsonb_build_object('allowed', true, 'source', 'quota', 'plan', r.plan,
      'used', r.critiques_used + 1, 'limit', v_limit, 'period_end', v_period_end,
      'pack_credits', r.pack_credits);
  end if;

  -- 2) Pack credits
  if r.pack_credits > 0 then
    update public.profiles set pack_credits = pack_credits - 1 where id = p_user_id;
    insert into public.credit_ledger (user_id, delta, reason) values (p_user_id, -1, 'critique');
    return jsonb_build_object('allowed', true, 'source', 'pack', 'plan', r.plan,
      'used', r.critiques_used, 'limit', v_limit, 'period_end', v_period_end,
      'pack_credits', r.pack_credits - 1);
  end if;

  -- 3) Nothing left
  return jsonb_build_object('allowed', false, 'plan', r.plan, 'used', r.critiques_used,
    'limit', v_limit, 'period_end', v_period_end, 'pack_credits', 0);
end;
$$;

-- Refund gives back what was consumed (called when the AI call fails)
drop function if exists public.refund_critique(uuid);
create or replace function public.refund_critique(p_user_id uuid, p_source text default 'quota')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_source = 'pack' then
    update public.profiles set pack_credits = pack_credits + 1 where id = p_user_id;
    insert into public.credit_ledger (user_id, delta, reason) values (p_user_id, 1, 'refund');
  else
    update public.profiles
       set critiques_used = greatest(critiques_used - 1, 0)
     where id = p_user_id;
  end if;
end;
$$;

-- Adds pack credits once per Stripe Checkout session (webhooks can be replayed)
create or replace function public.add_pack_credits(
  p_user_id uuid, p_credits integer, p_session_id text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
  v_balance integer;
begin
  if p_credits is null or p_credits <= 0 or p_session_id is null then
    return jsonb_build_object('added', false, 'error', 'invalid_args');
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    return jsonb_build_object('added', false, 'error', 'no_profile');
  end if;
  perform public.expire_pack_credits(p_user_id); -- a lapsed balance does not come back to life

  insert into public.credit_ledger (user_id, delta, reason, stripe_session_id)
  values (p_user_id, p_credits, 'pack_purchase', p_session_id)
  on conflict (stripe_session_id) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    select pack_credits into v_balance from public.profiles where id = p_user_id;
    return jsonb_build_object('added', false, 'duplicate', true, 'pack_credits', v_balance);
  end if;

  update public.profiles
     set pack_credits = pack_credits + p_credits,
         pack_credits_expire_at = now() + interval '12 months'
   where id = p_user_id
   returning pack_credits into v_balance;
  return jsonb_build_object('added', true, 'pack_credits', v_balance);
end;
$$;

-- Only the server (service role) may call these
revoke execute on function public.expire_pack_credits(uuid) from public, anon, authenticated;
revoke execute on function public.consume_critique(uuid, integer, integer) from public, anon, authenticated;
revoke execute on function public.refund_critique(uuid, text) from public, anon, authenticated;
revoke execute on function public.add_pack_credits(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.consume_critique(uuid, integer, integer) to service_role;
grant execute on function public.refund_critique(uuid, text) to service_role;
grant execute on function public.add_pack_credits(uuid, integer, text) to service_role;
