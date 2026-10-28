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

create table if not exists public.shop_orders (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null check (discord_user_id ~ '^[0-9]{17,20}$'),
  product text not null check (product in ('allkick', 'macro_monthly', 'macro_lifetime')),
  amount_krw integer not null check (amount_krw > 0),
  status text not null default 'pending' check (status in ('pending', 'paid', 'fulfilled', 'cancelled', 'refunded')),
  payment_provider text,
  provider_payment_id text unique,
  ticket_channel_id text,
  paid_at timestamptz,
  fulfilled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shop_orders_user_time_idx
  on public.shop_orders (discord_user_id, created_at desc);
create index if not exists shop_orders_status_time_idx
  on public.shop_orders (status, created_at desc);

alter table public.shop_orders enable row level security;
revoke all on public.shop_orders from anon, authenticated;

-- Manual payment confirmation and license fulfillment in one transaction.
-- The Discord worker checks DISCORD_ADMIN_IDS before calling this function.
create or replace function public.admin_fulfill_shop_order(
  p_order_id uuid,
  p_admin_discord_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.shop_orders%rowtype;
  v_expiry timestamptz;
begin
  select * into v_order
  from public.shop_orders
  where id = p_order_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'message', '주문을 찾을 수 없습니다.');
  end if;

  if v_order.status = 'fulfilled' then
    return jsonb_build_object('success', false, 'message', '이미 발급 완료된 주문입니다.');
  end if;

  if v_order.status <> 'pending' then
    return jsonb_build_object('success', false, 'message', '대기 상태인 주문만 처리할 수 있습니다.');
  end if;

  if p_admin_discord_id !~ '^[0-9]{17,20}$' then
    raise exception 'Invalid administrator ID';
  end if;

  if v_order.product = 'macro_monthly' then
    v_expiry := now() + interval '30 days';
  else
    v_expiry := null;
  end if;

  insert into public.licenses (
    discord_user_id, product, remaining_uses, expires_at, status, created_by
  ) values (
    v_order.discord_user_id,
    v_order.product,
    case when v_order.product = 'allkick' then 2 else null end,
    v_expiry,
    'active',
    p_admin_discord_id
  );

  update public.shop_orders
  set status = 'fulfilled',
      paid_at = now(),
      fulfilled_at = now(),
      updated_at = now()
  where id = v_order.id;

  return jsonb_build_object(
    'success', true,
    'message', '결제 확인 및 라이선스 발급 완료',
    'discord_user_id', v_order.discord_user_id,
    'product', v_order.product
  );
end;
$$;

revoke all on function public.admin_fulfill_shop_order(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_fulfill_shop_order(uuid, text) to service_role;
