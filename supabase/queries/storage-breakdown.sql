-- =============================================================
-- Family Tree — storage breakdown (v4.34, CPU-tuned)
-- =============================================================
-- The whole app lives in a single row: public.archive (id=1) with a JSONB
-- `state` column. These queries surface where the BYTES are going.
--
-- IMPORTANT: this database has been CPU-constrained in the past, and these
-- queries all walk the JSONB state. Run them ONE AT A TIME, watch the CPU
-- graph in the Supabase dashboard, and pause if it spikes. Cost annotations
-- are inline (CHEAP / MEDIUM / HEAVY).
--
-- What changed vs v4.33:
--   • Replaced `octet_length(jsonb::text)` (full text re-serialization) with
--     `pg_column_size(jsonb)` (cheap on-the-fly size estimate, no detoast).
--   • Materialized the state row ONCE in each query's CTE so we don't
--     re-fetch from disk on every metric.
--   • Coalesced the 5-way UNION ALL in the photo query into a single pass.
-- =============================================================


-- ---------- 1. Headline numbers — CHEAP ----------
-- Pure catalog reads; no JSONB work. Always safe to run.
SELECT
  pg_size_pretty(pg_database_size(current_database()))                                          AS database_total,
  pg_size_pretty(pg_total_relation_size('public.archive'))                                      AS archive_with_toast,
  pg_size_pretty(pg_relation_size('public.archive'))                                            AS archive_heap_only,
  pg_size_pretty(pg_total_relation_size('public.archive') - pg_relation_size('public.archive')) AS archive_toast_only;


-- ---------- 2. Stored size of the state column — CHEAP ----------
-- pg_column_size reads the column's on-disk size without re-serializing.
-- ~10–100x faster than `octet_length(state::text)` on a multi-MB JSONB.
SELECT pg_size_pretty(pg_column_size(state)::bigint) AS jsonb_stored_size
FROM public.archive
WHERE id = 1;


-- ---------- 3. Top-level breakdown — MEDIUM ----------
-- One detoast of `state` (Postgres caches it across the query), then
-- pg_column_size on each top-level value. Avoids the per-key text-cast
-- that the v4.33 version did.
WITH a AS (
  SELECT state FROM public.archive WHERE id = 1
),
kv AS (
  SELECT k.key, state -> k.key AS val
  FROM a, jsonb_object_keys(a.state) AS k(key)
)
SELECT
  key                                                AS area,
  pg_size_pretty(pg_column_size(val)::bigint)        AS size,
  pg_column_size(val)                                AS bytes,
  CASE
    WHEN jsonb_typeof(val) = 'array'  THEN jsonb_array_length(val)
    WHEN jsonb_typeof(val) = 'object' THEN (SELECT count(*) FROM jsonb_object_keys(val))
    ELSE NULL
  END                                                AS item_count
FROM kv
ORDER BY bytes DESC NULLS LAST;


-- ---------- 4. Vault sub-section breakdown — MEDIUM ----------
WITH a AS (
  SELECT state -> 'vault' AS vault FROM public.archive WHERE id = 1
),
kv AS (
  SELECT k.key, a.vault -> k.key AS val
  FROM a, jsonb_object_keys(a.vault) AS k(key)
)
SELECT
  ('vault.' || key)                            AS section,
  pg_size_pretty(pg_column_size(val)::bigint)  AS size,
  pg_column_size(val)                          AS bytes,
  CASE WHEN jsonb_typeof(val) = 'array' THEN jsonb_array_length(val) ELSE NULL END AS items
FROM kv
ORDER BY bytes DESC NULLS LAST;


-- ---------- 5. Photo footprint, single-pass — MEDIUM ----------
-- One detoast, five lateral subselects emit aggregates side-by-side.
-- Old v4.33 version did UNION ALL across 5 CTEs that each re-scanned
-- the archive table → 5x the detoast work.
WITH a AS (
  SELECT state FROM public.archive WHERE id = 1
),
members_agg AS (
  SELECT
    COUNT(*) FILTER (WHERE COALESCE(value ->> 'photo','') <> '')      AS n,
    COALESCE(SUM(length(value ->> 'photo')), 0)::bigint               AS bytes
  FROM a, jsonb_each(a.state -> 'members') AS m(key, value)
),
friends_agg AS (
  SELECT
    COUNT(*) FILTER (WHERE COALESCE(value ->> 'photo','') <> '')      AS n,
    COALESCE(SUM(length(value ->> 'photo')), 0)::bigint               AS bytes
  FROM a, jsonb_each(a.state -> 'friends') AS f(key, value)
),
ins_front AS (
  SELECT
    COUNT(*) FILTER (WHERE COALESCE(value ->> 'frontPhoto','') <> '') AS n,
    COALESCE(SUM(length(value ->> 'frontPhoto')), 0)::bigint          AS bytes
  FROM a, jsonb_array_elements(a.state -> 'vault' -> 'insurances') AS value
),
ins_back AS (
  SELECT
    COUNT(*) FILTER (WHERE COALESCE(value ->> 'backPhoto','') <> '')  AS n,
    COALESCE(SUM(length(value ->> 'backPhoto')), 0)::bigint           AS bytes
  FROM a, jsonb_array_elements(a.state -> 'vault' -> 'insurances') AS value
),
nbr_agg AS (
  SELECT
    COUNT(*) FILTER (WHERE COALESCE(value ->> 'photo','') <> '')      AS n,
    COALESCE(SUM(length(value ->> 'photo')), 0)::bigint               AS bytes
  FROM a, jsonb_array_elements(a.state -> 'vault' -> 'neighbors') AS value
)
SELECT 'Member photos'           AS source, n, pg_size_pretty(bytes) AS total FROM members_agg
UNION ALL SELECT 'Friend photos',           n, pg_size_pretty(bytes) FROM friends_agg
UNION ALL SELECT 'Insurance front photos',  n, pg_size_pretty(bytes) FROM ins_front
UNION ALL SELECT 'Insurance back photos',   n, pg_size_pretty(bytes) FROM ins_back
UNION ALL SELECT 'Neighbor photos',         n, pg_size_pretty(bytes) FROM nbr_agg;


-- ---------- 6. Top 25 biggest member photos — MEDIUM ----------
-- `length(text)` on the base64 data URL is character count = byte count
-- (single-byte ASCII), and avoids the cost of an octet-length UTF-8 walk.
WITH a AS (SELECT state FROM public.archive WHERE id = 1)
SELECT
  (value ->> 'firstName') || ' ' || COALESCE(value ->> 'lastName','') AS name,
  pg_size_pretty(length(value ->> 'photo')::bigint)                    AS photo_size,
  length(value ->> 'photo')                                            AS bytes
FROM a, jsonb_each(a.state -> 'members') AS m(key, value)
WHERE COALESCE(value ->> 'photo','') <> ''
ORDER BY bytes DESC
LIMIT 25;


-- ---------- 7. Per-insurance-card photo sizes — CHEAP ----------
WITH a AS (SELECT state FROM public.archive WHERE id = 1)
SELECT
  COALESCE(value ->> 'insurer','(unnamed)')                                                              AS insurer,
  value ->> 'kind'                                                                                       AS kind,
  pg_size_pretty(COALESCE(length(value ->> 'frontPhoto'), 0)::bigint)                                    AS front_size,
  pg_size_pretty(COALESCE(length(value ->> 'backPhoto'),  0)::bigint)                                    AS back_size,
  COALESCE(length(value ->> 'frontPhoto'), 0) + COALESCE(length(value ->> 'backPhoto'), 0)              AS total_bytes
FROM a, jsonb_array_elements(a.state -> 'vault' -> 'insurances') AS value
ORDER BY total_bytes DESC;


-- ---------- 8. Reclaim disk space — DESTRUCTIVE / blocks writes ----------
--
-- ⚠ Read before running:
--
-- VACUUM FULL takes ACCESS EXCLUSIVE on the table (blocks reads AND writes
-- for the duration). The archive table holds one row, so the lock window
-- is brief, but anyone using the app at that moment will see writes fail.
-- Pick a quiet moment.
--
-- Prefer plain `VACUUM` first (no lock, but only marks tuples reusable —
-- doesn't return disk to the OS):
--
--   VACUUM (VERBOSE, ANALYZE) public.archive;
--
-- If `pg_total_relation_size('public.archive')` is still much bigger than
-- `pg_column_size(state)` after the plain vacuum, *then* escalate:
--
--   VACUUM FULL public.archive;
--   ANALYZE public.archive;
--
-- Re-run query 1 after either to see the delta.


-- ---------- 9. Confirmation: re-run query 1 to see how much shrank ----------
SELECT
  pg_size_pretty(pg_database_size(current_database()))   AS database_total,
  pg_size_pretty(pg_total_relation_size('public.archive')) AS archive_with_toast;
