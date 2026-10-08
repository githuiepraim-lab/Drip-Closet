-- ═══════════════════════════════════════════════════════════════════
-- DRIP CLOSET — full production store schema
-- Adds: product variants, real orders + order items, payments,
--       newsletter subscribers, wishlists, reviews, journal posts,
--       campaign/lookbook content, notifications, delivery pricing,
--       atomic inventory RPCs and server-side checkout.
-- Idempotent: safe to run on the existing production database.
-- ═══════════════════════════════════════════════════════════════════

-- ── ENUMS ──────────────────────────────────────────────────────────
do $$ begin
  create type public.order_status as enum ('pending','confirmed','preparing','shipped','delivered','cancelled','refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_status as enum ('pending','paid','failed','cancelled','refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_method as enum ('mpesa','kcb_paybill','cash','card','bank');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.account_status as enum ('active','suspended','deleted');
exception when duplicate_object then null; end $$;

-- ── PROFILES (extends the existing table) ──────────────────────────
alter table public.profiles add column if not exists first_name     text;
alter table public.profiles add column if not exists last_name      text;
alter table public.profiles add column if not exists phone          text;
alter table public.profiles add column if not exists avatar         text default '🧥';
alter table public.profiles add column if not exists account_status public.account_status not null default 'active';
alter table public.profiles add column if not exists updated_at     timestamptz not null default now();
-- role values used by the app: customer | staff | manager | admin
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles add constraint profiles_role_check
  check (role in ('customer','staff','manager','admin'));

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_touch_updated on public.profiles;
create trigger profiles_touch_updated before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ── PRODUCTS (extend existing table) ───────────────────────────────
alter table public.products add column if not exists sku          text;
alter table public.products add column if not exists colors       text[] not null default '{}';
alter table public.products add column if not exists published    boolean not null default true;
alter table public.products add column if not exists updated_at   timestamptz not null default now();
-- keep legacy columns in sync with the canonical ones
update public.products set published = coalesce(active, true) where published is distinct from coalesce(active, true);

create or replace function public.products_sync_flags() returns trigger
language plpgsql as $$ begin
  new.active    := coalesce(new.published, true);
  new.published := coalesce(new.published, true);
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists products_sync_flags_trg on public.products;
create trigger products_sync_flags_trg before update on public.products
  for each row execute function public.products_sync_flags();

create unique index if not exists products_sku_unique on public.products (sku) where sku is not null and sku <> '';

-- ── PRODUCT VARIANTS ───────────────────────────────────────────────
create table if not exists public.product_variants (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references public.products(id) on delete cascade,
  size         text,
  color        text,
  sku          text,
  stock        integer not null default 0 check (stock >= 0),
  price        numeric(12,2),            -- optional per-variant price override
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (product_id, size, color)
);
create index if not exists product_variants_product_idx on public.product_variants (product_id);

-- ── CART ITEMS (server-persisted bag; enables merge + re-checkout) ─
create table if not exists public.cart_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  variant_id  uuid references public.product_variants(id) on delete set null,
  size        text,
  color       text,
  quantity    integer not null default 1 check (quantity > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, product_id, variant_id)
);
create index if not exists cart_items_user_idx on public.cart_items (user_id);

-- ── ORDERS ─────────────────────────────────────────────────────────
create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  order_number       text not null unique,
  user_id            uuid references auth.users(id) on delete set null,
  customer_name      text not null,
  customer_phone     text not null,
  customer_email     text,
  delivery_area      text not null,
  delivery_address   text,
  notes              text,
  subtotal           numeric(12,2) not null check (subtotal >= 0),
  delivery_fee       numeric(12,2) not null default 0 check (delivery_fee >= 0),
  total              numeric(12,2) not null check (total >= 0),
  payment_method     public.payment_method not null default 'kcb_paybill',
  payment_status     public.payment_status not null default 'pending',
  status             public.order_status not null default 'pending',
  tracking_code      text,
  channel            text not null default 'web',   -- web | whatsapp | pos
  stock_released     boolean not null default false,
  cancel_reason      text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists orders_user_idx on public.orders (user_id);
create index if not exists orders_status_idx on public.orders (status);

-- ── ORDER ITEMS ────────────────────────────────────────────────────
create table if not exists public.order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references public.orders(id) on delete cascade,
  product_id    uuid references public.products(id) on delete set null,
  variant_id    uuid references public.product_variants(id) on delete set null,
  product_name  text not null,          -- snapshot at purchase time
  sku           text,
  size          text,
  color         text,
  unit_price    numeric(12,2) not null check (unit_price >= 0),
  quantity      integer not null check (quantity > 0),
  line_total    numeric(12,2) not null check (line_total >= 0),
  image_url     text,
  created_at    timestamptz not null default now()
);
create index if not exists order_items_order_idx on public.order_items (order_id);
create index if not exists order_items_product_idx on public.order_items (product_id);

-- ── PAYMENTS ───────────────────────────────────────────────────────
create table if not exists public.payments (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references public.orders(id) on delete cascade,
  amount           numeric(12,2) not null check (amount >= 0),
  method           public.payment_method not null,
  status           public.payment_status not null default 'pending',
  transaction_id   text,                -- customer-supplied M-Pesa code or provider reference
  provider         text not null default 'manual',
  provider_ref     text,                -- Daraja checkout request id / webhook reference
  provider_payload jsonb,
  verified_by      uuid references auth.users(id) on delete set null,
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists payments_order_idx on public.payments (order_id);
create unique index if not exists payments_provider_ref_unique on public.payments (provider_ref) where provider_ref is not null;

-- ── NEWSLETTER SUBSCRIBERS ─────────────────────────────────────────
create table if not exists public.newsletter_subscribers (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  source      text not null default 'website',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- An account signup with marketing consent also creates a subscriber.
create or replace function public.profile_to_subscriber() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null and coalesce(to_jsonb(new)->>'newsletter_opt_in','false') = 'true' then
    insert into public.newsletter_subscribers (email, source)
    values (lower(new.email), 'signup')
    on conflict (email) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists profiles_newsletter_trg on public.profiles;
create trigger profiles_newsletter_trg after insert on public.profiles
  for each row execute function public.profile_to_subscriber();

-- ── WISHLISTS ──────────────────────────────────────────────────────
create table if not exists public.wishlist_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (user_id, product_id)
);
create index if not exists wishlist_user_idx on public.wishlist_items (user_id);

-- ── REVIEWS ────────────────────────────────────────────────────────
create table if not exists public.reviews (
  id          uuid primary key default gen_random_uuid(),
  product_id  uuid not null references public.products(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  author_name text not null default 'Drip Closet customer',
  rating      integer not null check (rating between 1 and 5),
  title       text,
  body        text,
  status      text not null default 'published',   -- pending | published | rejected
  created_at  timestamptz not null default now()
);
create index if not exists reviews_product_idx on public.reviews (product_id);

-- ── JOURNAL / BLOG POSTS ───────────────────────────────────────────
create table if not exists public.journal_posts (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  title        text not null,
  excerpt      text,
  body         text not null default '',
  cover_image  text,
  tags         text[] not null default '{}',
  published    boolean not null default false,
  author_id    uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ── CAMPAIGN / LOOKBOOK CONTENT ────────────────────────────────────
create table if not exists public.campaigns (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  title       text not null,
  subtitle    text,
  season      text,
  image_url   text,
  accent      text default '#ff8c00',
  background  text default '#0d0c12',
  shape       text default 'hoodie',
  link_url    text,
  sort_order  integer not null default 0,
  published   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ── NOTIFICATIONS ──────────────────────────────────────────────────
create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  audience    text not null default 'customer',     -- customer | staff
  title       text not null,
  body        text,
  kind        text not null default 'info',         -- order_created | payment_verified | low_stock | info
  link        text,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
create index if not exists notifications_staff_idx on public.notifications (audience, created_at desc);

-- ── DELIVERY AREAS (server-authoritative pricing) ──────────────────
create table if not exists public.delivery_areas (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  fee         numeric(12,2) not null default 0 check (fee >= 0),
  free_over   numeric(12,2),
  active      boolean not null default true,
  sort_order  integer not null default 0
);

insert into public.delivery_areas (name, fee, free_over, sort_order) values
  ('Machakos University (Free)', 0,   null, 1),
  ('Machakos Town',              100, null, 2),
  ('Nairobi CBD',                350, 5000, 3),
  ('Westlands / Kilimani',       400, 5000, 4),
  ('Karen / Langata',            450, 5000, 5),
  ('Eastlands',                  400, 5000, 6),
  ('Thika',                      350, 5000, 7),
  ('Kitui',                      350, 5000, 8),
  ('Naivasha',                   500, 5000, 9),
  ('Nakuru',                     550, 5000, 10),
  ('Mombasa',                    600, 5000, 11),
  ('Kisumu',                     650, 5000, 12),
  ('Eldoret',                    650, 5000, 13),
  ('Rest of Kenya',              700, 5000, 14)
on conflict (name) do nothing;

-- ── SETTINGS (payment instructions etc., server-controlled) ────────
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value) values
  ('payment_instructions', '{
     "methods": [
       {"id":"kcb_paybill","label":"KCB Pay Bill","paybill":"522522","account":"1355793491","note":"Lipa na Paybill → Business No 522522 → Account No = your Order Number"},
       {"id":"mpesa","label":"M-Pesa","phone":"0112960896","note":"Send the exact total to 0112 960 896 and enter your Order Number as the reference."}
     ],
     "whatsapp":"254112960896",
     "currency":"KES"
   }'::jsonb)
on conflict (key) do nothing;

-- ── HELPERS: role checks ───────────────────────────────────────────
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    join auth.users u on u.id = p.id
    where p.id = auth.uid() and p.role in ('admin','manager','staff')
      and p.account_status = 'active'
  );
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin' and p.account_status = 'active'
  );
$$;

-- ── NEXT ORDER NUMBER ──────────────────────────────────────────────
create sequence if not exists public.order_number_seq start 1001;

create or replace function public.next_order_number() returns text
language sql volatile as $$
  select 'DC-' || to_char(now(), 'YYMMDD') || '-' || lpad(nextval('public.order_number_seq')::text, 5, '0');
$$;

-- ── ATOMIC STOCK DEDUCTION ─────────────────────────────────────────
-- Returns true when every requested line had enough stock; all deductions
-- happen inside one statement so concurrent checkouts cannot oversell.
create or replace function public.reserve_stock(lines jsonb) returns boolean
language sql volatile security definer set search_path = public as $$
  with req as (
    select
      (l->>'product_id')::uuid                                   as product_id,
      nullif(l->>'variant_id','')::uuid                          as variant_id,
      greatest(1, (l->>'quantity')::int)                         as qty
    from jsonb_array_elements(lines) l
  ),
  avail as (
    select r.product_id, r.variant_id, r.qty,
      case when r.variant_id is not null
        then coalesce(v.stock, -1)
        else coalesce(p.stock, -1)
      end as stock_now
    from req r
    left join public.product_variants v on v.id = r.variant_id and v.product_id = r.product_id
    join public.products p on p.id = r.product_id
    where coalesce(p.published, p.active, true) = true
  ),
  ok as (select bool_and(stock_now >= qty) as all_ok from avail),
  upd_prod as (
    update public.products p
       set stock = p.stock - a.qty
      from (select product_id, sum(qty)::int as qty from avail group by product_id) a
     where a.product_id = p.id
       and (select all_ok from ok)
       and p.stock >= a.qty
  ),
  upd_var as (
    update public.product_variants v
       set stock = v.stock - a.qty
      from (
        select variant_id, sum(qty)::int as qty
        from avail where variant_id is not null group by variant_id
      ) a
     where a.variant_id = v.id
       and (select all_ok from ok)
       and v.stock >= a.qty
  )
  select coalesce((select all_ok from ok), false);
$$;

create or replace function public.release_stock(lines jsonb) returns void
language sql volatile security definer set search_path = public as $$
  with req as (
    select
      (l->>'product_id')::uuid            as product_id,
      nullif(l->>'variant_id','')::uuid   as variant_id,
      greatest(1, (l->>'quantity')::int)  as qty
    from jsonb_array_elements(lines) l
  )
  update public.products p
     set stock = p.stock + s.qty
    from (select product_id, sum(qty)::int as qty from req group by product_id) s
   where s.product_id = p.id;
$$;

-- ── SERVER-SIDE CHECKOUT ───────────────────────────────────────────
-- The browser sends ONLY {product_id, variant_id, quantity}. Prices,
-- availability, delivery fee and totals are computed here.
create or replace function public.create_web_order(
  p_customer_name   text,
  p_customer_phone  text,
  p_customer_email  text,
  p_delivery_area   text,
  p_delivery_address text default null,
  p_notes            text default null,
  p_payment_method   text default 'kcb_paybill',
  p_lines            jsonb default '[]'::jsonb
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_ref  text;
  v_name text; v_phone text; v_email text;
  v_subtotal numeric(12,2) := 0;
  v_fee numeric(12,2) := 0;
  v_free_over numeric(12,2);
  v_area_exists boolean;
  v_count int := 0;
  o public.orders%rowtype;
  item jsonb;
  pid uuid; vid uuid; qty int;
  prod public.products%rowtype;
  var public.product_variants%rowtype;
  unit numeric(12,2); line numeric(12,2);
  v_number text; v_tracking text;
  lines_norm jsonb := '[]'::jsonb;
begin
  if p_customer_name is null or length(trim(p_customer_name)) < 2 then
    raise exception 'VALIDATION: full name is required';
  end if;
  if p_customer_phone is null or p_customer_phone !~ '^\+?[0-9 ()-]{9,20}$' then
    raise exception 'VALIDATION: a valid phone number is required';
  end if;
  if coalesce(p_payment_method,'kcb_paybill') not in ('mpesa','kcb_paybill','cash','card','bank') then
    raise exception 'VALIDATION: unsupported payment method';
  end if;

  select coalesce(max(length(name)),0) into v_count from public.delivery_areas where name = trim(p_delivery_area) and active;
  if v_count = 0 then raise exception 'VALIDATION: unknown delivery area'; end if;
  select fee, free_over into v_fee, v_free_over from public.delivery_areas where name = trim(p_delivery_area) and active limit 1;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'VALIDATION: your bag is empty';
  end if;

  -- Aggregate duplicate lines and resolve authoritative prices
  for item in select * from jsonb_array_elements(p_lines) loop
    pid  := nullif(item->>'product_id','')::uuid;
    vid  := nullif(item->>'variant_id','')::uuid;
    qty  := greatest(1, least(50, coalesce((item->>'quantity')::int, 1)));
    if pid is null then continue; end if;
    lines_norm := lines_norm || jsonb_build_object(
      'product_id', pid::text,
      'variant_id', coalesce(vid::text,''),
      'quantity', qty);
  end loop;
  -- collapse duplicates
  select coalesce(jsonb_agg(x), '[]'::jsonb) into lines_norm from (
    select l->>'product_id' as product_id, l->>'variant_id' as variant_id,
           sum((l->>'quantity')::int)::int as quantity
    from jsonb_array_elements(lines_norm) l
    group by 1,2
  ) x;

  if jsonb_array_length(lines_norm) = 0 then raise exception 'VALIDATION: your bag is empty'; end if;

  -- Validate every line against the database BEFORE touching stock
  for item in select * from jsonb_array_elements(lines_norm) loop
    pid := (item->>'product_id')::uuid;
    vid := nullif(item->>'variant_id','')::uuid;
    qty := (item->>'quantity')::int;

    select * into prod from public.products where id = pid;
    if not found then raise exception 'UNAVAILABLE: % no longer exists', pid; end if;
    if coalesce(prod.published, prod.active, true) = false then
      raise exception 'UNAVAILABLE: "%" is not on sale right now', prod.name;
    end if;

    if vid is not null then
      select * into var from public.product_variants where id = vid and product_id = pid;
      if not found then raise exception 'UNAVAILABLE: selected option for "%"', prod.name; end if;
      if var.stock < qty then
        raise exception 'STOCK: only % left of "%"', var.stock, prod.name;
      end if;
      unit := coalesce(var.price, prod.sale_price, prod.price);
    else
      if coalesce(prod.stock, 0) < qty then
        raise exception 'STOCK: only % left of "%"', coalesce(prod.stock,0), prod.name;
      end if;
      unit := coalesce(prod.sale_price, prod.price);
    end if;
    v_subtotal := v_subtotal + round(unit * qty, 2);
  end loop;

  if v_free_over is not null and v_subtotal >= v_free_over then v_fee := 0; end if;

  -- Atomic reservation
  if not reserve_stock(lines_norm) then
    raise exception 'STOCK: some items sold out while checking out — please review your bag';
  end if;

  v_number   := next_order_number();
  v_tracking := upper(substr(md5(random()::text), 1, 6));

  insert into public.orders (
    order_number, user_id, customer_name, customer_phone, customer_email,
    delivery_area, delivery_address, notes, subtotal, delivery_fee, total,
    payment_method, payment_status, status, tracking_code, channel
  ) values (
    v_number, v_user, trim(p_customer_name), trim(p_customer_phone),
    lower(trim(coalesce(p_customer_email,''))),
    trim(p_delivery_area), nullif(trim(coalesce(p_delivery_address,'')),''),
    nullif(trim(coalesce(p_notes,'')),''),
    v_subtotal, v_fee, v_subtotal + v_fee,
    p_payment_method::public.payment_method, 'pending', 'pending', v_tracking, 'web'
  ) returning * into o;

  for item in select * from jsonb_array_elements(lines_norm) loop
    pid := (item->>'product_id')::uuid;
    vid := nullif(item->>'variant_id','')::uuid;
    qty := (item->>'quantity')::int;
    select * into prod from public.products where id = pid;
    if vid is not null then
      select * into var from public.product_variants where id = vid;
      unit := coalesce(var.price, prod.sale_price, prod.price);
    else
      unit := coalesce(prod.sale_price, prod.price);
    end if;
    line := round(unit * qty, 2);
    insert into public.order_items (order_id, product_id, variant_id, product_name, sku, size, color, unit_price, quantity, line_total, image_url)
    values (
      o.id, pid, vid, prod.name,
      coalesce(var.sku, prod.sku),
      coalesce(var.size, nullif(item->>'size','')),
      coalesce(var.color, nullif(item->>'color','')),
      unit, qty, line,
      case when prod.images is not null and jsonb_typeof(prod.images)='array' and jsonb_array_length(prod.images)>0
           then prod.images->>0 else null end
    );
  end loop;

  insert into public.payments (order_id, amount, method, status, provider)
  values (o.id, o.total, o.payment_method, 'pending', 'manual_verification');

  -- Clear the purchased items from the saved online bag
  delete from public.cart_items ci
    where ci.user_id = v_user
      and exists (select 1 from jsonb_array_elements(lines_norm) l
                  where (l->>'product_id')::uuid = ci.product_id);

  insert into public.notifications (audience, title, body, kind, link)
  values ('staff', 'New order ' || o.order_number,
          o.customer_name || ' • ' || o.customer_phone || ' • KES ' || o.total || ' • ' || o.delivery_area,
          'order_created', 'orders');

  return jsonb_build_object(
    'order_id',      o.id,
    'order_number',  o.order_number,
    'tracking_code', o.tracking_code,
    'subtotal',      o.subtotal,
    'delivery_fee',  o.delivery_fee,
    'total',         o.total,
    'status',        o.status,
    'payment_status',o.payment_status,
    'created_at',    o.created_at
  );
end $$;

-- ── CUSTOMER SELF-SERVICE ──────────────────────────────────────────
create or replace function public.update_my_profile(
  p_first_name text default null, p_last_name text default null,
  p_phone text default null, p_avatar text default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  update public.profiles set
    first_name = coalesce(nullif(trim(p_first_name),''), first_name),
    last_name  = coalesce(nullif(trim(p_last_name),''),  last_name),
    phone      = coalesce(nullif(trim(p_phone),''),       phone),
    avatar     = coalesce(nullif(trim(p_avatar),''),      avatar)
  where id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;

-- Admin-only staff management (never exposed via direct table writes)
create or replace function public.admin_set_user_role(p_user_id uuid, p_role text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'FORBIDDEN: admin role required'; end if;
  if p_role not in ('customer','staff','manager','admin') then raise exception 'VALIDATION: bad role'; end if;
  update public.profiles set role = p_role where id = p_user_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_set_account_status(p_user_id uuid, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'FORBIDDEN: staff role required'; end if;
  if p_status not in ('active','suspended','deleted') then raise exception 'VALIDATION: bad status'; end if;
  update public.profiles set account_status = p_status::public.account_status where id = p_user_id;
  return jsonb_build_object('ok', true);
end $$;

-- Staff verifies a manual payment (Paybill / M-Pesa bank confirmation)
create or replace function public.verify_payment(
  p_payment_id uuid, p_status text, p_transaction_id text default null
) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare v_payment public.payments%rowtype; v_order public.orders%rowtype;
begin
  if not is_staff() then raise exception 'FORBIDDEN: staff role required'; end if;
  if p_status not in ('paid','failed','cancelled','refunded') then raise exception 'VALIDATION: bad payment status'; end if;
  select * into v_payment from public.payments where id = p_payment_id;
  if not found then raise exception 'VALIDATION: payment not found'; end if;
  select * into v_order from public.orders where id = v_payment.order_id;

  update public.payments set
    status = p_status::public.payment_status,
    transaction_id = coalesce(nullif(trim(p_transaction_id),''), transaction_id),
    verified_by = auth.uid(), verified_at = now()
  where id = p_payment_id;

  update public.orders set payment_status = p_status::public.payment_status,
    status = case
      when p_status = 'paid'     and status in ('pending','confirmed') then 'confirmed'
      when p_status = 'refunded' then 'refunded'
      when p_status = 'cancelled' then 'cancelled'
      else status end
  where id = v_order.id;

  if p_status = 'refunded' and v_order.stock_released = false then
    perform release_stock((select jsonb_agg(jsonb_build_object(
        'product_id', oi.product_id, 'variant_id', oi.variant_id, 'quantity', oi.quantity))
      from public.order_items oi where oi.order_id = v_order.id and oi.product_id is not null));
    update public.orders set stock_released = true where id = v_order.id;
  end if;

  insert into public.notifications (user_id, audience, title, body, kind, link)
  values (v_order.user_id, 'customer',
    case when p_status='paid' then 'Payment received 🎉' else 'Order update' end,
    'Order ' || v_order.order_number || ' payment marked ' || p_status || '.',
    'payment_verified', 'orders');

  return jsonb_build_object('ok', true, 'order_number', v_order.order_number);
end $$;

-- Customer cancels own pending order → stock returned automatically
create or replace function public.cancel_my_order(p_order_id uuid, p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_order public.orders%rowtype;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select * into v_order from public.orders where id = p_order_id and user_id = auth.uid();
  if not found then raise exception 'VALIDATION: order not found'; end if;
  if v_order.status not in ('pending','confirmed') then
    raise exception 'CONFLICT: this order can no longer be cancelled';
  end if;
  if v_order.stock_released = false then
    perform release_stock((select jsonb_agg(jsonb_build_object(
        'product_id', oi.product_id, 'variant_id', oi.variant_id, 'quantity', oi.quantity))
      from public.order_items oi where oi.order_id = v_order.id and oi.product_id is not null));
  end if;
  update public.orders set status='cancelled', payment_status='cancelled',
    stock_released = true, cancel_reason = nullif(trim(coalesce(p_reason,'')),'')
  where id = v_order.id;
  update public.payments set status='cancelled' where order_id = v_order.id and status in ('pending','paid');
  insert into public.notifications (audience, title, body, kind, link)
  values ('staff','Order cancelled', v_order.order_number || ' was cancelled by the customer.', 'info', 'orders');
  return jsonb_build_object('ok', true);
end $$;

-- Staff order status updates
create or replace function public.admin_update_order(p_order_id uuid, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_order public.orders%rowtype;
begin
  if not is_staff() then raise exception 'FORBIDDEN: staff role required'; end if;
  if p_status not in ('pending','confirmed','preparing','shipped','delivered','cancelled','refunded') then
    raise exception 'VALIDATION: bad status';
  end if;
  select * into v_order from public.orders where id = p_order_id;
  if not found then raise exception 'VALIDATION: order not found'; end if;

  if p_status in ('cancelled','refunded') and v_order.stock_released = false then
    perform release_stock((select jsonb_agg(jsonb_build_object(
        'product_id', oi.product_id, 'variant_id', oi.variant_id, 'quantity', oi.quantity))
      from public.order_items oi where oi.order_id = v_order.id and oi.product_id is not null));
    update public.orders set stock_released = true where id = v_order.id;
  end if;

  update public.orders set status = p_status::public.order_status where id = p_order_id;

  insert into public.notifications (user_id, audience, title, body, kind, link)
  values (v_order.user_id, 'customer', 'Order ' || replace(initcap(p_status),'_',' '),
          'Your order ' || v_order.order_number || ' is now ' || replace(p_status,'_',' ') || '.',
          'info', 'orders');
  return jsonb_build_object('ok', true);
end $$;

-- Real analytics for the admin dashboard
create or replace function public.admin_dashboard_stats() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'revenue_all',        coalesce((select sum(total) from public.orders where payment_status='paid'),0),
    'revenue_pending',    coalesce((select sum(total) from public.orders where payment_status='pending' and status not in ('cancelled','refunded')),0),
    'revenue_30d',        coalesce((select sum(total) from public.orders where payment_status='paid' and created_at > now()-interval '30 days'),0),
    'orders_total',       (select count(*) from public.orders),
    'orders_pending',     (select count(*) from public.orders where status='pending'),
    'products_active',    (select count(*) from public.products where coalesce(published,active,true)=true),
    'low_stock',          (select count(*) from public.products where coalesce(published,active,true)=true and stock <= 3),
    'subscribers',        (select count(*) from public.newsletter_subscribers where active),
    'customers',          (select count(*) from public.profiles where role='customer')
  );
$$;

-- ── ROW LEVEL SECURITY ─────────────────────────────────────────────
alter table public.product_variants      enable row level security;
alter table public.cart_items            enable row level security;
alter table public.orders                enable row level security;
alter table public.order_items           enable row level security;
alter table public.payments              enable row level security;
alter table public.newsletter_subscribers enable row level security;
alter table public.wishlist_items        enable row level security;
alter table public.reviews               enable row level security;
alter table public.journal_posts         enable row level security;
alter table public.campaigns             enable row level security;
alter table public.notifications         enable row level security;
alter table public.delivery_areas        enable row level security;
alter table public.app_settings          enable row level security;

-- Products: public read of published rows, staff write
drop policy if exists products_public_read on public.products;
create policy products_public_read on public.products for select
  using (coalesce(published, active, true) = true or public.is_staff());
drop policy if exists products_staff_write on public.products;
create policy products_staff_write on public.products for all
  using (public.is_staff()) with check (public.is_staff());

-- Variants: public read, staff write
drop policy if exists variants_public_read on public.product_variants;
create policy variants_public_read on public.product_variants for select using (true);
drop policy if exists variants_staff_write on public.product_variants;
create policy variants_staff_write on public.product_variants for all
  using (public.is_staff()) with check (public.is_staff());

-- Cart: owner only
drop policy if exists cart_owner on public.cart_items;
create policy cart_owner on public.cart_items for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Orders: customers see their own; staff sees all; inserts ONLY via RPC
drop policy if exists orders_own_read on public.orders;
create policy orders_own_read on public.orders for select
  using (auth.uid() = user_id or public.is_staff());
drop policy if exists orders_staff_update on public.orders;
create policy orders_staff_update on public.orders for update
  using (public.is_staff());

drop policy if exists orderitems_own_read on public.order_items;
create policy orderitems_own_read on public.order_items for select
  using (exists (select 1 from public.orders o
                 where o.id = order_id and (o.user_id = auth.uid() or public.is_staff())));

-- Payments: staff manage; customers read their own orders' payments
drop policy if exists payments_staff on public.payments;
create policy payments_staff on public.payments for all
  using (public.is_staff()) with check (public.is_staff());
drop policy if exists payments_own_read on public.payments;
create policy payments_own_read on public.payments for select
  using (exists (select 1 from public.orders o
                 where o.id = order_id and o.user_id = auth.uid()));

-- Newsletter: anyone may subscribe (anon + authenticated), staff read/update
drop policy if exists newsletter_insert on public.newsletter_subscribers;
create policy newsletter_insert on public.newsletter_subscribers for insert
  with check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');
drop policy if exists newsletter_staff on public.newsletter_subscribers;
create policy newsletter_staff on public.newsletter_subscribers for all
  using (public.is_staff()) with check (public.is_staff());

-- Wishlists: owner only
drop policy if exists wishlist_owner on public.wishlist_items;
create policy wishlist_owner on public.wishlist_items for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Reviews: public read published; signed-in customers may submit; staff moderate
drop policy if exists reviews_public_read on public.reviews;
create policy reviews_public_read on public.reviews for select using (status = 'published');
drop policy if exists reviews_insert_own on public.reviews;
create policy reviews_insert_own on public.reviews for insert
  with check (auth.uid() = user_id and rating between 1 and 5);
drop policy if exists reviews_staff on public.reviews;
create policy reviews_staff on public.reviews for all
  using (public.is_staff()) with check (public.is_staff());

-- Journal & campaigns: public read published, staff write
drop policy if exists journal_public_read on public.journal_posts;
create policy journal_public_read on public.journal_posts for select using (published = true or public.is_staff());
drop policy if exists journal_staff on public.journal_posts;
create policy journal_staff on public.journal_posts for all
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists campaigns_public_read on public.campaigns;
create policy campaigns_public_read on public.campaigns for select using (published = true or public.is_staff());
drop policy if exists campaigns_staff on public.campaigns;
create policy campaigns_staff on public.campaigns for all
  using (public.is_staff()) with check (public.is_staff());

-- Notifications: own rows or staff audience
drop policy if exists notif_own_read on public.notifications;
create policy notif_own_read on public.notifications for select
  using (auth.uid() = user_id or (audience = 'staff' and public.is_staff()));
drop policy if exists notif_own_update on public.notifications;
create policy notif_own_update on public.notifications for update
  using (auth.uid() = user_id);

-- Delivery areas & settings: public read, staff write
drop policy if exists delivery_public_read on public.delivery_areas;
create policy delivery_public_read on public.delivery_areas for select using (active = true or public.is_staff());
drop policy if exists delivery_staff on public.delivery_areas;
create policy delivery_staff on public.delivery_areas for all
  using (public.is_staff()) with check (public.is_staff());

drop policy if exists settings_public_read on public.app_settings;
create policy settings_public_read on public.app_settings for select using (key in ('payment_instructions','store_info'));
drop policy if exists settings_staff on public.app_settings;
create policy settings_staff on public.app_settings for all
  using (public.is_staff()) with check (public.is_staff());

-- Profiles: lock down reads (no enumeration), self-update only.
-- Role escalation is impossible because role changes go through the
-- admin_set_user_role() RPC, which checks is_admin() server-side.
drop policy if exists profiles_select_policy on public.profiles;
create policy profiles_select_policy on public.profiles for select
  using (auth.uid() = id or public.is_staff());
drop policy if exists profiles_insert_policy on public.profiles;
create policy profiles_insert_policy on public.profiles for insert
  with check (auth.uid() = id and role in ('customer','staff','manager','admin'));
drop policy if exists profiles_update_policy on public.profiles;
create policy profiles_update_policy on public.profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);

-- Lock the checkout RPCs down
revoke execute on function public.create_web_order(text,text,text,text,text,text,text,jsonb) from anon;
grant execute on function public.create_web_order(text,text,text,text,text,text,text,jsonb) to authenticated;
grant execute on function public.update_my_profile(text,text,text,text) to authenticated;
grant execute on function public.cancel_my_order(uuid,text) to authenticated;
grant execute on function public.verify_payment(uuid,text,text) to authenticated;
grant execute on function public.admin_update_order(uuid,text) to authenticated;
grant execute on function public.admin_set_user_role(uuid,text) to authenticated;
grant execute on function public.admin_set_account_status(uuid,text) to authenticated;
grant execute on function public.admin_dashboard_stats() to authenticated;
grant execute on function public.reserve_stock(jsonb) to service_role;
grant execute on function public.release_stock(jsonb) to service_role;
