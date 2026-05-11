-- =============================================================
-- Family Archive — Supabase schema (v1: JSON-blob storage)
-- =============================================================
-- Run this once in the Supabase SQL editor for a brand-new project.
-- The whole app state lives in a single row in `archive.state`. Every
-- authenticated user reads the same row; admins (tracked inside the JSON)
-- write through the app's existing UI.

-- Single-row table that holds the entire app state as JSON.
create table if not exists public.archive (
  id int primary key default 1,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint archive_single_row check (id = 1)
);

-- Seed the row so the first read never returns empty.
insert into public.archive (id, state) values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- =============================================================
-- Auth-to-member mapping
-- =============================================================
-- Links a Supabase Auth user (auth.users.id) to an in-app member id so
-- that "logged in as Hee" works after you switch to email/password auth.
create table if not exists public.member_accounts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  member_id  text not null,                          -- e.g. 'm_xxx', stored inside archive.state.members
  is_admin   boolean not null default false,
  created_at timestamptz default now()
);

-- =============================================================
-- Admin-check helper
-- =============================================================
-- SECURITY DEFINER so the function bypasses RLS when reading member_accounts.
-- If we instead embedded `exists (select … from member_accounts …)` directly
-- in a policy on member_accounts, every SELECT would re-trigger that policy
-- and Postgres bails out with "infinite recursion detected". Wrapping the
-- check in a definer function breaks the cycle.
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select is_admin from public.member_accounts where user_id = auth.uid()),
    false
  );
$$;
grant execute on function public.is_admin() to authenticated;

-- =============================================================
-- Row-level security
-- =============================================================
alter table public.archive         enable row level security;
alter table public.member_accounts enable row level security;

-- Any authenticated user can read the archive row.
drop policy if exists "auth read archive" on public.archive;
create policy "auth read archive" on public.archive
  for select using (auth.role() = 'authenticated');

-- Only admins can write the archive. Both INSERT and UPDATE are needed
-- because PostgREST .upsert() emits INSERT ... ON CONFLICT DO UPDATE and
-- the INSERT path is checked even when the row already exists.
drop policy if exists "admin insert archive" on public.archive;
drop policy if exists "admin write archive"  on public.archive;
create policy "admin insert archive" on public.archive
  for insert with check (public.is_admin());
create policy "admin write archive" on public.archive
  for update using (public.is_admin()) with check (public.is_admin());

-- Any authenticated user can read member_accounts (needed to map auth → member).
drop policy if exists "auth read accounts" on public.member_accounts;
create policy "auth read accounts" on public.member_accounts
  for select using (auth.role() = 'authenticated');

-- Admins can write member_accounts. Split per operation so SELECT is never
-- gated by an additional USING clause that would re-trigger the policy.
drop policy if exists "admin write accounts"  on public.member_accounts;
drop policy if exists "admin insert accounts" on public.member_accounts;
drop policy if exists "admin update accounts" on public.member_accounts;
drop policy if exists "admin delete accounts" on public.member_accounts;
create policy "admin insert accounts" on public.member_accounts
  for insert with check (public.is_admin());
create policy "admin update accounts" on public.member_accounts
  for update using (public.is_admin()) with check (public.is_admin());
create policy "admin delete accounts" on public.member_accounts
  for delete using (public.is_admin());

-- =============================================================
-- Bootstrap: first user becomes admin
-- =============================================================
-- When a brand-new project has zero accounts mapped, the first signed-in user
-- gets promoted to admin automatically. After that, admins invite others.
create or replace function public.claim_first_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.member_accounts where is_admin = true) then
    insert into public.member_accounts (user_id, member_id, is_admin)
    values (auth.uid(), 'admin-bootstrap', true)
    on conflict (user_id) do update set is_admin = true;
  end if;
end;
$$;

grant execute on function public.claim_first_admin() to authenticated;

-- =============================================================
-- Real-time
-- =============================================================
-- Enable real-time on the archive row so other devices see edits within ~1s.
alter publication supabase_realtime add table public.archive;
