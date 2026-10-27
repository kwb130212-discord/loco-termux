create extension if not exists pgcrypto;

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null check (discord_user_id ~ '^[0-9]{17,20}$'),
  product text not null check (product in ('allkick', 'macro_monthly', 'macro_lifetime')),
  remaining_uses integer,
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  created_by text not null check (created_by ~ '^[0-9]{17,20}$'),
  created_at timestamptz not null default now(),
  constraint licenses_remaining_nonnegative check (remaining_uses is null or remaining_uses >= 0),
  constraint allkick_uses check (
    (product = 'allkick' and remaining_uses is not null and remaining_uses between 0 and 2)
    or (product <> 'allkick' and remaining_uses is null)
  ),
  constraint macro_monthly_expiry check (
    product <> 'macro_monthly' or expires_at is not null
  ),
  constraint macro_lifetime_no_expiry check (
    product <> 'macro_lifetime' or expires_at is null
  )
);

create index if not exists licenses_discord_user_idx
  on public.licenses (discord_user_id, status, product);

create table if not exists public.control_audit (
  id bigint generated always as identity primary key,
  discord_user_id text not null check (discord_user_id ~ '^[0-9]{17,20}$'),
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists control_audit_user_time_idx
  on public.control_audit (discord_user_id, created_at desc);

alter table public.licenses enable row level security;
alter table public.control_audit enable row level security;

-- Intentionally no anon/authenticated policies. The server-side Discord bot
-- accesses these tables with the service-role key; keep that key private.
revoke all on public.licenses from anon, authenticated;
revoke all on public.control_audit from anon, authenticated;
