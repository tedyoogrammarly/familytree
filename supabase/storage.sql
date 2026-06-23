-- =============================================================
-- Supabase Storage — buckets + RLS for media-heavy v4.39+ features
-- =============================================================
-- Run this AFTER schema.sql. Idempotent — re-running is safe.
--
-- Why separate from schema.sql: schema.sql is the row-level archive
-- (single JSONB blob). Storage holds binary media (photos, audio,
-- video, documents) that can't live in JSONB without blowing the row
-- size + Postgres CPU. Each new feature that uploads media writes to
-- one of these buckets, stores only the bucket+path string back in
-- the JSONB archive, and resolves it to a signed URL on display.
--
-- Buckets:
--   family-photos     Photos for Memories Wall, My Kids, Recipes, etc.
--   family-audio      Voice stories (microphone recordings)
--   family-video      Direct-uploaded video clips (≤5 min cap, app-side)
--   family-documents  PDFs / scans tied to a member (admin-only view)
--
-- Access model:
--   * Admin can INSERT / DELETE into every bucket.
--   * Authenticated users can SELECT (download) photos / audio / video
--     so the family-side roles can see the memory wall, hear stories, etc.
--   * Documents bucket is admin-only end-to-end (private records).
-- =============================================================

-- -------------------------------------------------------------
-- Create the buckets (private — all access goes through signed URLs)
-- -------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values
  -- 10 MB per photo. Photos are already client-side cropped to 480px JPEG,
  -- so anything above 10 MB is suspect input.
  ('family-photos',    'family-photos',    false, 10485760),
  -- 20 MB per audio clip. 5-minute mp3 at 256 kbps ≈ 9 MB; gives headroom.
  ('family-audio',     'family-audio',     false, 20971520),
  -- 100 MB per video clip. 5-minute H.264 at ~1080p ≈ 50–80 MB.
  ('family-video',     'family-video',     false, 104857600),
  -- 25 MB per document. PDFs / ID scans / certificates fit comfortably.
  ('family-documents', 'family-documents', false, 26214400)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  public          = excluded.public;

-- -------------------------------------------------------------
-- RLS policies on storage.objects
-- -------------------------------------------------------------
-- Drop-then-create so re-running this migration is idempotent.

-- ---- family-photos ----
-- v4.58: uploads opened to all authenticated users (Albums + open Memories
-- feed). A user can delete their OWN uploads (storage.objects.owner); admins
-- delete any. See migrations/2026-06-22-storage-authenticated-upload.sql.
drop policy if exists "family-photos admin insert" on storage.objects;
drop policy if exists "family-photos auth insert"  on storage.objects;
drop policy if exists "family-photos auth select"  on storage.objects;
drop policy if exists "family-photos admin delete" on storage.objects;
drop policy if exists "family-photos owner delete" on storage.objects;
create policy "family-photos auth insert" on storage.objects
  for insert with check (bucket_id = 'family-photos' and auth.role() = 'authenticated');
create policy "family-photos auth select"  on storage.objects
  for select using (bucket_id = 'family-photos' and auth.role() = 'authenticated');
create policy "family-photos owner delete" on storage.objects
  for delete using (bucket_id = 'family-photos' and (owner = auth.uid() or public.is_admin()));

-- ---- family-audio ----
drop policy if exists "family-audio admin insert" on storage.objects;
drop policy if exists "family-audio auth select"  on storage.objects;
drop policy if exists "family-audio admin delete" on storage.objects;
create policy "family-audio admin insert" on storage.objects
  for insert with check (bucket_id = 'family-audio' and public.is_admin());
create policy "family-audio auth select"  on storage.objects
  for select using (bucket_id = 'family-audio' and auth.role() = 'authenticated');
create policy "family-audio admin delete" on storage.objects
  for delete using (bucket_id = 'family-audio' and public.is_admin());

-- ---- family-video ----
drop policy if exists "family-video admin insert" on storage.objects;
drop policy if exists "family-video auth select"  on storage.objects;
drop policy if exists "family-video admin delete" on storage.objects;
create policy "family-video admin insert" on storage.objects
  for insert with check (bucket_id = 'family-video' and public.is_admin());
create policy "family-video auth select"  on storage.objects
  for select using (bucket_id = 'family-video' and auth.role() = 'authenticated');
create policy "family-video admin delete" on storage.objects
  for delete using (bucket_id = 'family-video' and public.is_admin());

-- ---- family-documents (admin-only end-to-end) ----
drop policy if exists "family-documents admin insert" on storage.objects;
drop policy if exists "family-documents admin select" on storage.objects;
drop policy if exists "family-documents admin delete" on storage.objects;
create policy "family-documents admin insert" on storage.objects
  for insert with check (bucket_id = 'family-documents' and public.is_admin());
create policy "family-documents admin select" on storage.objects
  for select using (bucket_id = 'family-documents' and public.is_admin());
create policy "family-documents admin delete" on storage.objects
  for delete using (bucket_id = 'family-documents' and public.is_admin());
