-- =============================================================
-- Family Archive — open family-photos uploads to authenticated users
-- =============================================================
-- Before: only admins could INSERT/DELETE into family-photos (storage.sql).
-- After:  any authenticated user can upload; a user can delete their OWN
--         uploads (storage.objects.owner = their uid); admins delete any.
-- SELECT (download via signed URL) is unchanged (authenticated).
--
-- Required by both the Albums tab and the open-Memories feed (everyone
-- uploads photos). Ship with the app change; test on a clone first.
-- =============================================================

drop policy if exists "family-photos admin insert" on storage.objects;
drop policy if exists "family-photos auth insert"  on storage.objects;
drop policy if exists "family-photos admin delete" on storage.objects;
drop policy if exists "family-photos owner delete" on storage.objects;

create policy "family-photos auth insert" on storage.objects
  for insert with check (bucket_id = 'family-photos' and auth.role() = 'authenticated');

create policy "family-photos owner delete" on storage.objects
  for delete using (bucket_id = 'family-photos' and (owner = auth.uid() or public.is_admin()));

-- (SELECT policy "family-photos auth select" from storage.sql is unchanged.)

-- =============================================================
-- ROLLBACK: re-run the family-photos block of supabase/storage.sql to
-- restore admin-only insert/delete.
-- =============================================================
