-- =============================================================
-- Family Tree — storage breakdown / "what's eating my Supabase quota?"
-- =============================================================
-- The whole app lives in a single row: public.archive (id=1) with a JSONB
-- `state` column. These queries surface where the bytes are going so you
-- can decide what to delete in the UI before recompressing.
--
-- Paste each block into the Supabase SQL Editor and run independently.
-- They're all read-only except the final VACUUM FULL.
-- =============================================================


-- ---------- 1. Headline numbers ----------
-- Database total vs the archive table's heap + TOAST footprint. The TOAST
-- "side table" is where Postgres stores large JSONB / TEXT values, and it's
-- where rewrite-heavy workloads bloat fastest.
SELECT
  pg_size_pretty(pg_database_size(current_database()))                                              AS database_total,
  pg_size_pretty(pg_total_relation_size('public.archive'))                                          AS archive_with_toast,
  pg_size_pretty(pg_relation_size('public.archive'))                                                AS archive_heap_only,
  pg_size_pretty(pg_total_relation_size('public.archive') - pg_relation_size('public.archive'))     AS archive_toast_only;


-- ---------- 2. Logical JSON size of the state column ----------
-- "json_text_size" = bytes if you serialized the whole state to a string.
-- "jsonb_compressed_size" = what Postgres actually stores after dedupe.
-- If the gap between these two is small but archive_with_toast (query 1)
-- is much larger, that's bloat — run the VACUUM FULL at the end.
SELECT
  pg_size_pretty(octet_length(state::text)::bigint) AS json_text_size,
  pg_size_pretty(pg_column_size(state)::bigint)     AS jsonb_compressed_size
FROM public.archive
WHERE id = 1;


-- ---------- 3. Top-level breakdown: which "page" / area is biggest ----------
-- Ordered biggest-first. The `item_count` column tells you whether it's
-- the photos inside (objects/arrays of N items) or the structure itself.
WITH a AS (SELECT state FROM public.archive WHERE id = 1)
SELECT
  key                                                                                 AS area,
  pg_size_pretty(octet_length((state -> key)::text)::bigint)                          AS size,
  octet_length((state -> key)::text)                                                  AS bytes,
  CASE
    WHEN jsonb_typeof(state -> key) = 'array'  THEN jsonb_array_length(state -> key)
    WHEN jsonb_typeof(state -> key) = 'object' THEN (SELECT count(*) FROM jsonb_object_keys(state -> key))
    ELSE NULL
  END                                                                                 AS item_count
FROM a, jsonb_object_keys(state) AS key
ORDER BY bytes DESC;


-- ---------- 4. Vault sub-breakdown (banks / insurances / utilities / hoas / codeSets / neighbors) ----------
-- Insurance card photos and neighbor photos are the usual suspects.
WITH a AS (SELECT state FROM public.archive WHERE id = 1)
SELECT
  key                                                                       AS vault_section,
  pg_size_pretty(octet_length((state -> 'vault' -> key)::text)::bigint)    AS size,
  octet_length((state -> 'vault' -> key)::text)                            AS bytes,
  CASE
    WHEN jsonb_typeof(state -> 'vault' -> key) = 'array' THEN jsonb_array_length(state -> 'vault' -> key)
    ELSE NULL
  END                                                                       AS item_count
FROM a, jsonb_object_keys(state -> 'vault') AS key
ORDER BY bytes DESC;


-- ---------- 5. Photo footprint by source (the biggest single space hog) ----------
WITH a AS (SELECT state FROM public.archive WHERE id = 1),
  member_photos AS (
    SELECT 'Member photos'           AS source,
           COUNT(*) FILTER (WHERE coalesce(value ->> 'photo', '') <> '') AS items_with_photo,
           pg_size_pretty(COALESCE(SUM(octet_length(value ->> 'photo')), 0)::bigint) AS total_bytes
    FROM a, jsonb_each(state -> 'members') AS m(key, value)
  ),
  friend_photos AS (
    SELECT 'Friend photos',
           COUNT(*) FILTER (WHERE coalesce(value ->> 'photo', '') <> ''),
           pg_size_pretty(COALESCE(SUM(octet_length(value ->> 'photo')), 0)::bigint)
    FROM a, jsonb_each(state -> 'friends') AS f(key, value)
  ),
  insurance_front AS (
    SELECT 'Insurance front photos',
           COUNT(*) FILTER (WHERE coalesce(value ->> 'frontPhoto', '') <> ''),
           pg_size_pretty(COALESCE(SUM(octet_length(value ->> 'frontPhoto')), 0)::bigint)
    FROM a, jsonb_array_elements(state -> 'vault' -> 'insurances') AS value
  ),
  insurance_back AS (
    SELECT 'Insurance back photos',
           COUNT(*) FILTER (WHERE coalesce(value ->> 'backPhoto', '') <> ''),
           pg_size_pretty(COALESCE(SUM(octet_length(value ->> 'backPhoto')), 0)::bigint)
    FROM a, jsonb_array_elements(state -> 'vault' -> 'insurances') AS value
  ),
  neighbor_photos AS (
    SELECT 'Neighbor photos',
           COUNT(*) FILTER (WHERE coalesce(value ->> 'photo', '') <> ''),
           pg_size_pretty(COALESCE(SUM(octet_length(value ->> 'photo')), 0)::bigint)
    FROM a, jsonb_array_elements(state -> 'vault' -> 'neighbors') AS value
  )
SELECT * FROM member_photos
UNION ALL SELECT * FROM friend_photos
UNION ALL SELECT * FROM insurance_front
UNION ALL SELECT * FROM insurance_back
UNION ALL SELECT * FROM neighbor_photos;


-- ---------- 6. Per-member photo sizes (find the biggest individual offenders) ----------
WITH a AS (SELECT state FROM public.archive WHERE id = 1)
SELECT
  value ->> 'firstName' || ' ' || COALESCE(value ->> 'lastName', '')      AS name,
  pg_size_pretty(octet_length(value ->> 'photo')::bigint)                  AS photo_size,
  octet_length(value ->> 'photo')                                          AS bytes
FROM a, jsonb_each(state -> 'members') AS m(key, value)
WHERE COALESCE(value ->> 'photo', '') <> ''
ORDER BY bytes DESC
LIMIT 25;


-- ---------- 7. Per-insurance-card photo sizes ----------
WITH a AS (SELECT state FROM public.archive WHERE id = 1)
SELECT
  COALESCE(value ->> 'insurer', '(unnamed)') AS insurer,
  value ->> 'kind'                            AS kind,
  pg_size_pretty(COALESCE(octet_length(value ->> 'frontPhoto'), 0)::bigint) AS front_size,
  pg_size_pretty(COALESCE(octet_length(value ->> 'backPhoto'),  0)::bigint) AS back_size,
  COALESCE(octet_length(value ->> 'frontPhoto'), 0) + COALESCE(octet_length(value ->> 'backPhoto'), 0) AS total_bytes
FROM a, jsonb_array_elements(state -> 'vault' -> 'insurances') AS value
ORDER BY total_bytes DESC;


-- ---------- 8. TOAST bloat check ----------
-- If `n_dead_tup` is much larger than `n_live_tup` for the archive's TOAST
-- table, run the VACUUM FULL at the bottom to physically reclaim the space.
SELECT
  c.relname,
  s.n_live_tup,
  s.n_dead_tup,
  s.last_autovacuum,
  s.last_autoanalyze
FROM pg_class c
JOIN pg_stat_all_tables s ON s.relid = c.oid
WHERE c.relname = 'archive'
   OR c.relname IN (
     SELECT t.relname FROM pg_class a
     JOIN pg_class t ON a.reltoastrelid = t.oid
     WHERE a.relname = 'archive'
   );


-- ---------- 9. Reclaim disk space after deleting / recompressing ----------
-- IMPORTANT: VACUUM FULL takes an ACCESS EXCLUSIVE lock on the table
-- (blocks reads + writes) for the duration. The archive table is tiny in
-- row count (1 row), so the lock should be brief. Still — pick a quiet
-- moment to run it.
--
-- This rewrites the heap + TOAST and reclaims the bloat that built up
-- from many archive upserts.
VACUUM FULL public.archive;
ANALYZE public.archive;


-- ---------- 10. Confirmation: re-run query 1 to see how much shrank ----------
SELECT
  pg_size_pretty(pg_database_size(current_database()))                                          AS database_total,
  pg_size_pretty(pg_total_relation_size('public.archive'))                                      AS archive_with_toast;
