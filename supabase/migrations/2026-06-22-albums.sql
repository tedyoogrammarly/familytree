-- =============================================================
-- Family Archive — Albums (collaborative-data, phase: Albums)
-- =============================================================
-- New, owned photo collections that ANY authenticated user can create.
-- Unlike the archive blob (admin-only write), these tables allow
-- per-row authenticated writes with owner/admin update/delete — the
-- "collaborative data" direction noted in migrations/README.md.
--
-- Photos live in the family-photos Storage bucket (see
-- 2026-06-22-storage-authenticated-upload.sql). Rows store only
-- { bucket, path } pointers, same as Memories/My Kids.
--
-- ⚠️  Ship together with the app change that reads/writes these tables.
--     Test on a Supabase clone/branch before production.
-- =============================================================

-- 1) Tables ----------------------------------------------------
create table if not exists public.albums (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  description   text,
  event_date    date,
  cover_photo_id uuid,                         -- optional; else newest photo
  created_by    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.album_photos (
  id           uuid primary key default gen_random_uuid(),
  album_id     uuid not null references public.albums(id) on delete cascade,
  bucket       text not null default 'family-photos',
  path         text not null,
  uploaded_by  uuid not null references auth.users(id) on delete cascade default auth.uid(),
  sort_order   int  not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists public.album_comments (
  id           uuid primary key default gen_random_uuid(),
  album_id     uuid not null references public.albums(id) on delete cascade,
  photo_id     uuid references public.album_photos(id) on delete cascade, -- null = album-level
  author       uuid not null references auth.users(id) on delete cascade default auth.uid(),
  body         text not null,
  created_at   timestamptz not null default now()
);

create index if not exists album_photos_album_idx   on public.album_photos(album_id);
create index if not exists album_comments_album_idx  on public.album_comments(album_id);

-- 2) Helper: does the current user own the parent album? --------
-- SECURITY DEFINER so the album_photos/album_comments policies can read
-- albums without recursing through albums' own RLS.
create or replace function public.owns_album(a_id uuid)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (select 1 from public.albums where id = a_id and created_by = auth.uid());
$$;
grant execute on function public.owns_album(uuid) to authenticated;

-- 3) RLS -------------------------------------------------------
alter table public.albums         enable row level security;
alter table public.album_photos   enable row level security;
alter table public.album_comments enable row level security;

-- albums: anyone signed in reads; anyone signed in creates (as themselves);
-- owner or admin updates/deletes.
drop policy if exists "albums read"   on public.albums;
drop policy if exists "albums insert" on public.albums;
drop policy if exists "albums update" on public.albums;
drop policy if exists "albums delete" on public.albums;
create policy "albums read"   on public.albums for select using (auth.role() = 'authenticated');
create policy "albums insert" on public.albums for insert with check (created_by = auth.uid());
create policy "albums update" on public.albums for update using  (created_by = auth.uid() or public.is_admin())
                                                      with check  (created_by = auth.uid() or public.is_admin());
create policy "albums delete" on public.albums for delete using  (created_by = auth.uid() or public.is_admin());

-- album_photos: anyone reads; only the parent album's owner (or admin)
-- inserts/updates/deletes — enforces the "owned albums" rule.
drop policy if exists "album_photos read"   on public.album_photos;
drop policy if exists "album_photos insert" on public.album_photos;
drop policy if exists "album_photos update" on public.album_photos;
drop policy if exists "album_photos delete" on public.album_photos;
create policy "album_photos read"   on public.album_photos for select using (auth.role() = 'authenticated');
create policy "album_photos insert" on public.album_photos for insert with check (public.owns_album(album_id) or public.is_admin());
create policy "album_photos update" on public.album_photos for update using  (public.owns_album(album_id) or public.is_admin());
create policy "album_photos delete" on public.album_photos for delete using  (public.owns_album(album_id) or public.is_admin());

-- album_comments: anyone reads & comments; the comment author, the parent
-- album's owner, or an admin can delete/update.
drop policy if exists "album_comments read"   on public.album_comments;
drop policy if exists "album_comments insert" on public.album_comments;
drop policy if exists "album_comments update" on public.album_comments;
drop policy if exists "album_comments delete" on public.album_comments;
create policy "album_comments read"   on public.album_comments for select using (auth.role() = 'authenticated');
create policy "album_comments insert" on public.album_comments for insert with check (author = auth.uid());
create policy "album_comments update" on public.album_comments for update using  (author = auth.uid() or public.owns_album(album_id) or public.is_admin());
create policy "album_comments delete" on public.album_comments for delete using  (author = auth.uid() or public.owns_album(album_id) or public.is_admin());

-- =============================================================
-- ROLLBACK
--   drop function if exists public.owns_album(uuid);
--   drop table if exists public.album_comments;
--   drop table if exists public.album_photos;
--   drop table if exists public.albums;
-- =============================================================
