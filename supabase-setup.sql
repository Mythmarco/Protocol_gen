-- ════════════════════════════════════════════════════════════════════════
-- Peptides4ALL Protocol Gen — Supabase schema (idempotent, run anytime)
-- ════════════════════════════════════════════════════════════════════════
--
-- This app does NOT use Supabase Auth. Authentication is custom (bcrypt
-- against the Stacklabs `User.password` column, JWT cookie). Therefore the
-- `protocolos` table is accessed via the service-role key only — no RLS
-- policies; the app enforces "owner only" filtering at the application layer.

-- ── 1. Drop legacy RLS policy that prevents altering creado_por type ──
-- (The old schema had an RLS policy referencing creado_por::uuid via auth.uid().
-- We don't use Supabase Auth anymore, so this policy is obsolete.)
drop policy if exists "Users see their own protocols" on public.protocolos;

-- ── 2. Drop legacy FK to auth.users (from old schema) ──
alter table if exists public.protocolos
  drop constraint if exists protocolos_creado_por_fkey;

-- ── 3. Create the table if it doesn't exist yet ──
create table if not exists public.protocolos (
  id              uuid        primary key default gen_random_uuid(),
  creado_por      text        not null,
  paciente_nombre text        not null,
  descripcion     text        not null,
  datos_json      jsonb       not null,
  fecha_creacion  timestamptz not null default now()
);

-- ── 4. Migrate creado_por from uuid → text if needed ──
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'protocolos'
      and column_name = 'creado_por'
      and data_type = 'uuid'
  ) then
    alter table public.protocolos
      alter column creado_por type text using creado_por::text;
  end if;
end $$;

-- ── 5. Add columns that may be missing in older tables ──
alter table public.protocolos add column if not exists drive_url text;
alter table public.protocolos add column if not exists folio     text;
-- Full chat/voice transcript used to create the protocol — so the doctor
-- can reopen a past protocol and keep talking to make changes.
-- Shape: [{ role: "user" | "assistant", content: string }]
alter table public.protocolos add column if not exists conversacion jsonb default '[]'::jsonb;
alter table public.protocolos add column if not exists conversacion_modo text default 'text';

-- Unique index on folio (only on non-null values, so old rows don't break it)
create unique index if not exists protocolos_folio_unique
  on public.protocolos (folio) where folio is not null;

-- ── 6. RLS: enable WITHOUT policies (blocks anon, allows service role) ──
alter table public.protocolos enable row level security;

-- ── 7. Folio sequence + RPC ──
create sequence if not exists public.protocolos_folio_seq
  start 1001 increment 1 minvalue 1001 no cycle;

-- Bump sequence to 1001 if it's still at default (only if no folios > 1001 exist)
do $$
declare
  current_val bigint;
  max_used bigint;
begin
  select last_value into current_val from public.protocolos_folio_seq;
  select coalesce(max(substring(folio from 'P4A-(\d+)')::bigint), 0)
    into max_used from public.protocolos where folio is not null;
  if current_val < 1001 and max_used < 1001 then
    perform setval('public.protocolos_folio_seq', 1000, true);
  end if;
end $$;

create or replace function public.next_protocol_folio()
returns text
language sql
security definer
set search_path = public
as $$
  select 'P4A-' || nextval('public.protocolos_folio_seq')::text;
$$;

-- Allow the service role + PostgREST to call the RPC
grant execute on function public.next_protocol_folio() to service_role, anon, authenticated;

-- ── 8. Indexes ──
create index if not exists protocolos_creado_por_fecha
  on public.protocolos (creado_por, fecha_creacion desc);

create index if not exists protocolos_paciente
  on public.protocolos (creado_por, paciente_nombre);

-- ── 9. Ask PostgREST to reload its schema cache (so it sees new column/RPC) ──
notify pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────────
-- Verification (run these manually after the above to confirm):
--
-- select column_name, data_type
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'protocolos'
-- order by ordinal_position;
--
-- select * from public.next_protocol_folio();   -- should return 'P4A-1001' (or next)
-- ────────────────────────────────────────────────────────────────────────
