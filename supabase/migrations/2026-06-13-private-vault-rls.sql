-- =============================================================
-- Family Archive — DEFERRED HARDENING (v4.56)
-- Split the private Vault out of the world-readable archive blob.
-- =============================================================
-- WHY: Today the ENTIRE app state lives in one row, public.archive, and the
-- read policy is `auth.role() = 'authenticated'`. That means the Vault
-- (bank accounts, insurance card photos), gift dollar amounts, and unopened
-- time-capsule letters — everything nested under archive.state — is readable
-- by ANY signed-in family member via the anon client, regardless of the
-- in-app "vault authorized" / admin gates. Those gates are cosmetic; the
-- network response already contains the data.
--
-- This migration introduces a SECOND blob table, public.archive_private,
-- whose RLS only lets admins (public.is_admin()) SELECT/INSERT/UPDATE it.
-- The Vault subtree moves there. The main archive blob keeps everything else.
--
-- ⚠️  This SQL is HALF of the change. It is inert until the app is updated to
--     read/write the Vault from the new table (see migrations/README.md). Run
--     them together, ideally during a quiet window, and TEST on a clone first.
-- =============================================================

-- 1) Private blob table (mirrors the shape of public.archive).
create table if not exists public.archive_private (
  id          int primary key default 1,
  state       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  constraint archive_private_single_row check (id = 1)
);

insert into public.archive_private (id, state) values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- 2) Row-level security: admins only, for BOTH read and write.
alter table public.archive_private enable row level security;

drop policy if exists "admin read private"   on public.archive_private;
drop policy if exists "admin insert private"  on public.archive_private;
drop policy if exists "admin write private"   on public.archive_private;

-- Unlike public.archive (any authenticated user can SELECT), the private blob
-- is admin-only on SELECT too — this is the whole point.
create policy "admin read private" on public.archive_private
  for select using (public.is_admin());
create policy "admin insert private" on public.archive_private
  for insert with check (public.is_admin());
create policy "admin write private" on public.archive_private
  for update using (public.is_admin()) with check (public.is_admin());

-- 3) BACKFILL — run ONLY after the app deploy that reads/writes the new table.
--    Copies the existing Vault subtree into the private blob, then strips it
--    from the public blob so it stops being world-readable.
--    Review the JSON path ('vault') against your actual state shape first.
--
--    update public.archive_private
--      set state = jsonb_build_object('vault', (select state->'vault' from public.archive where id = 1)),
--          updated_at = now()
--      where id = 1;
--
--    update public.archive
--      set state = state - 'vault',
--          updated_at = now()
--      where id = 1;
--
-- Keep a backup of public.archive.state before running the strip:
--    create table if not exists public.archive_backup_20260613 as
--      select * from public.archive;

-- =============================================================
-- ROLLBACK
-- =============================================================
-- If the app deploy is reverted, merge the Vault back and drop the table:
--    update public.archive
--      set state = state || jsonb_build_object('vault', (select state->'vault' from public.archive_private where id = 1))
--      where id = 1;
--    drop table if exists public.archive_private;
