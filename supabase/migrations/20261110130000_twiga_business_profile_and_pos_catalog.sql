-- Per-business AI knowledge and POS product catalogue.
create table if not exists public.twiga_business_profiles (
  business_id uuid primary key references public.businesses(id) on delete cascade,
  business_summary text not null default '',
  what_they_sell text not null default '',
  what_they_do text not null default '',
  products_and_services text not null default '',
  target_customers text not null default '',
  unique_selling_points text not null default '',
  service_area text not null default '',
  opening_hours text not null default '',
  delivery_and_payment text not null default '',
  returns_and_refunds text not null default '',
  frequently_asked_questions text not null default '',
  brand_voice text not null default 'warm, helpful and professional',
  reply_language text not null default 'match_customer',
  assistant_instructions text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.twiga_products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  sku text,
  name text not null,
  description text not null default '',
  category text not null default '',
  price numeric(12,2) not null default 0 check (price >= 0),
  cost_price numeric(12,2) check (cost_price is null or cost_price >= 0),
  currency text not null default 'KES',
  unit text not null default 'piece',
  stock_quantity numeric(12,3) not null default 0 check (stock_quantity >= 0),
  low_stock_threshold numeric(12,3) not null default 0 check (low_stock_threshold >= 0),
  image_key text,
  barcode text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists twiga_products_business_sku_unique
  on public.twiga_products(business_id, sku) where sku is not null and sku <> '';
create index if not exists twiga_products_business_name_idx
  on public.twiga_products(business_id, name);
create index if not exists twiga_products_business_active_idx
  on public.twiga_products(business_id, is_active);

alter table public.twiga_business_profiles enable row level security;
alter table public.twiga_products enable row level security;

revoke all on public.twiga_business_profiles, public.twiga_products from anon;
grant select, insert, update, delete on public.twiga_business_profiles, public.twiga_products to authenticated;

drop policy if exists "Business members read business profile" on public.twiga_business_profiles;
create policy "Business members read business profile"
on public.twiga_business_profiles for select to authenticated
using (exists (
  select 1 from public.business_members bm
  where bm.business_id = twiga_business_profiles.business_id
    and bm.user_id = (select auth.uid())
));

drop policy if exists "Business members manage business profile" on public.twiga_business_profiles;
create policy "Business members manage business profile"
on public.twiga_business_profiles for all to authenticated
using (exists (
  select 1 from public.business_members bm
  where bm.business_id = twiga_business_profiles.business_id
    and bm.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.business_members bm
  where bm.business_id = twiga_business_profiles.business_id
    and bm.user_id = (select auth.uid())
));

drop policy if exists "Business members read products" on public.twiga_products;
create policy "Business members read products"
on public.twiga_products for select to authenticated
using (exists (
  select 1 from public.business_members bm
  where bm.business_id = twiga_products.business_id
    and bm.user_id = (select auth.uid())
));

drop policy if exists "Business members manage products" on public.twiga_products;
create policy "Business members manage products"
on public.twiga_products for all to authenticated
using (exists (
  select 1 from public.business_members bm
  where bm.business_id = twiga_products.business_id
    and bm.user_id = (select auth.uid())
))
with check (exists (
  select 1 from public.business_members bm
  where bm.business_id = twiga_products.business_id
    and bm.user_id = (select auth.uid())
));
