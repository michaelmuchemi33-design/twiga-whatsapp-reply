-- TWIGA WhatsApp Reply: per-business connections, message activity and opt-outs.
create table if not exists public.twiga_whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null unique references public.businesses(id) on delete cascade,
  session_id text not null unique,
  webhook_id text,
  status text not null default 'not_connected' check (status in ('not_connected','created','connecting','connected','disconnected','failed')),
  ai_enabled boolean not null default false,
  business_name text,
  system_prompt text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.twiga_whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  session_id text not null,
  message_id text not null,
  chat_id text not null,
  sender_id text,
  sender_name text,
  direction text not null check (direction in ('inbound','outbound')),
  body text not null default '',
  reply_body text,
  status text not null default 'received',
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(session_id, message_id)
);
create table if not exists public.twiga_whatsapp_optouts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  phone text not null,
  source text not null default 'whatsapp_keyword',
  created_at timestamptz not null default now(),
  unique(business_id, phone)
);
create index if not exists twiga_whatsapp_messages_business_created_idx on public.twiga_whatsapp_messages(business_id, created_at desc);
create index if not exists twiga_whatsapp_messages_session_message_idx on public.twiga_whatsapp_messages(session_id, message_id);
create index if not exists twiga_followups_whatsapp_due_idx on public.twiga_followups(due_at) where channel='whatsapp' and status='scheduled';
alter table public.twiga_whatsapp_connections enable row level security;
alter table public.twiga_whatsapp_messages enable row level security;
alter table public.twiga_whatsapp_optouts enable row level security;
revoke all on public.twiga_whatsapp_connections, public.twiga_whatsapp_messages, public.twiga_whatsapp_optouts from anon;
grant select, insert, update on public.twiga_whatsapp_connections to authenticated;
grant select on public.twiga_whatsapp_messages to authenticated;
grant select, insert, update, delete on public.twiga_whatsapp_optouts to authenticated;
create policy "business members read WhatsApp connection" on public.twiga_whatsapp_connections for select to authenticated using (exists (select 1 from public.business_members bm where bm.business_id = twiga_whatsapp_connections.business_id and bm.user_id = (select auth.uid())));
create policy "business members manage WhatsApp connection" on public.twiga_whatsapp_connections for all to authenticated using (exists (select 1 from public.business_members bm where bm.business_id = twiga_whatsapp_connections.business_id and bm.user_id = (select auth.uid()))) with check (exists (select 1 from public.business_members bm where bm.business_id = twiga_whatsapp_connections.business_id and bm.user_id = (select auth.uid())));
create policy "business members read WhatsApp messages" on public.twiga_whatsapp_messages for select to authenticated using (exists (select 1 from public.business_members bm where bm.business_id = twiga_whatsapp_messages.business_id and bm.user_id = (select auth.uid())));
create policy "business members read WhatsApp optouts" on public.twiga_whatsapp_optouts for select to authenticated using (exists (select 1 from public.business_members bm where bm.business_id = twiga_whatsapp_optouts.business_id and bm.user_id = (select auth.uid())));
create policy "business members manage WhatsApp optouts" on public.twiga_whatsapp_optouts for all to authenticated using (exists (select 1 from public.business_members bm where bm.business_id = twiga_whatsapp_optouts.business_id and bm.user_id = (select auth.uid()))) with check (exists (select 1 from public.business_members bm where bm.business_id = twiga_whatsapp_optouts.business_id and bm.user_id = (select auth.uid())));
