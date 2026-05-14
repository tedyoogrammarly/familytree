-- =============================================================
-- Family Tree — system storage + CPU diagnostic
-- =============================================================
-- The user discovered (2026-05-14) that the disk-quota crunch on Supabase
-- was driven by *system storage* (WAL, replication slots, dead tuples,
-- autovacuum overhead, catalog bloat) — not the archive row's own data.
-- And CPU was the real bottleneck.
--
-- This file diagnoses both. Every query has a cost annotation; lead with
-- the CHEAP ones and stop the moment you have your answer.
--
-- Order to run them:
--   1, 2, 3   — headline numbers (CHEAP, run first)
--   4, 5      — dead tuples + autovacuum lag (CHEAP)
--   6         — replication slot retention — the silent disk eater (CHEAP)
--   7         — top queries by total CPU time (MEDIUM, requires
--               pg_stat_statements which Supabase enables by default)
--   8         — long-running queries right now (CHEAP)
--   9         — cache-hit ratios (CHEAP)
--   10        — apply autovacuum tuning to public.archive (DDL — run once)
-- =============================================================


-- ---------- 1. Database size split — CHEAP ----------
-- "user_data" = everything in public/auth/storage/etc.
-- The rest is system storage: WAL, pg_catalog, indexes, replication slot
-- backlog, etc. If `user_data` is small but `total` is big, system storage
-- is your problem and queries 4–6 below will tell you which kind.
SELECT
  pg_size_pretty(pg_database_size(current_database()))                                    AS database_total,
  pg_size_pretty(
    (SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)
       FROM pg_class c
       JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname IN ('public','auth','storage','realtime')
        AND c.relkind IN ('r','t','m'))
  )                                                                                       AS user_relations_total;


-- ---------- 2. Top relations by size — CHEAP ----------
-- Sorted biggest-first; includes heap + indexes + TOAST. If `public.archive`
-- and its TOAST table dominate, the v4.32/v4.33 mitigations are doing the
-- right thing.
SELECT
  n.nspname || '.' || c.relname                                AS relation,
  pg_size_pretty(pg_total_relation_size(c.oid))                AS total_size,
  pg_size_pretty(pg_relation_size(c.oid))                      AS heap_size,
  pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS toast_plus_idx
FROM pg_class c
JOIN pg_namespace n ON c.relnamespace = n.oid
WHERE c.relkind IN ('r','m')
  AND n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')
ORDER BY pg_total_relation_size(c.oid) DESC
LIMIT 15;


-- ---------- 3. WAL footprint on this instance — CHEAP ----------
-- Supabase free tier has limited WAL retention. If the size is huge
-- relative to the database, you've got a stuck replication slot (query 6).
SELECT
  pg_size_pretty(
    pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::bigint
  )                                                          AS wal_total_emitted_since_start,
  pg_size_pretty(
    (SELECT COALESCE(SUM(size), 0) FROM pg_ls_waldir())
  )                                                          AS wal_on_disk_now;


-- ---------- 4. Dead tuples + autovacuum freshness — CHEAP ----------
-- For a rewrite-heavy workload, watch `n_dead_tup`. If it climbs without
-- `last_autovacuum` advancing, autovacuum is falling behind → tune.
-- Look first at `public.archive` and its TOAST partner.
SELECT
  schemaname || '.' || relname                                AS relation,
  n_live_tup,
  n_dead_tup,
  CASE WHEN n_live_tup > 0 THEN ROUND((n_dead_tup::numeric / NULLIF(n_live_tup,0)) * 100, 1) END
                                                              AS dead_pct,
  last_autovacuum,
  last_vacuum,
  last_autoanalyze
FROM pg_stat_user_tables
WHERE schemaname = 'public'
   OR relname LIKE '%archive%'
ORDER BY n_dead_tup DESC NULLS LAST;


-- ---------- 5. TOAST table dead tuples — CHEAP ----------
-- The archive's TOAST table is where the big JSONB lives. Heavy rewrites
-- bloat the TOAST faster than the main heap.
SELECT
  c.relname                                                  AS toast_relation,
  s.n_live_tup,
  s.n_dead_tup,
  s.last_autovacuum,
  pg_size_pretty(pg_total_relation_size(c.oid))              AS total_size
FROM pg_class a
JOIN pg_class c              ON a.reltoastrelid = c.oid
LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
WHERE a.relname = 'archive'
  AND a.relkind = 'r';


-- ---------- 6. Replication slot lag — CHEAP, often the smoking gun ----------
-- Supabase Realtime + the supabase_realtime publication keep logical
-- replication slots. If a slot's `confirmed_flush_lsn` falls way behind
-- `pg_current_wal_lsn()`, Postgres retains every WAL segment newer than
-- the slot's position — which can balloon disk usage indefinitely.
--
-- If `retained_wal` is more than a few hundred MB, that's almost
-- certainly the system-storage problem. Inactive slots can be dropped
-- (carefully — only if nothing relies on them):
--   SELECT pg_drop_replication_slot('<slot_name>');
SELECT
  slot_name,
  plugin,
  slot_type,
  active,
  pg_size_pretty(
    pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)
  )                                              AS retained_wal,
  confirmed_flush_lsn,
  pg_current_wal_lsn()                           AS current_wal_lsn
FROM pg_replication_slots
ORDER BY pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) DESC NULLS LAST;


-- ---------- 7. Top CPU consumers from pg_stat_statements — MEDIUM ----------
-- Requires pg_stat_statements (Supabase enables it). Shows the queries that
-- burned the most total time since stats were last reset. The archive
-- upsert is the prime suspect.
SELECT
  ROUND((100 * total_exec_time / SUM(total_exec_time) OVER ())::numeric, 1) AS pct_of_total,
  ROUND(total_exec_time::numeric / 1000, 1)                                  AS total_seconds,
  calls,
  ROUND(mean_exec_time::numeric, 2)                                          AS mean_ms,
  ROUND(max_exec_time::numeric,  2)                                          AS max_ms,
  LEFT(query, 120)                                                           AS query_preview
FROM pg_stat_statements
WHERE total_exec_time > 0
ORDER BY total_exec_time DESC
LIMIT 15;


-- ---------- 8. Long-running queries right now — CHEAP ----------
-- Anything >500ms still running. Empty result = healthy.
SELECT
  pid,
  state,
  NOW() - query_start                       AS running_for,
  wait_event_type,
  wait_event,
  LEFT(query, 200)                          AS query
FROM pg_stat_activity
WHERE state != 'idle'
  AND query_start IS NOT NULL
  AND NOW() - query_start > INTERVAL '500 milliseconds'
ORDER BY query_start;


-- ---------- 9. Cache hit ratios — CHEAP ----------
-- Both should be > 99% on a healthy instance. < 95% means the working set
-- doesn't fit in `shared_buffers` (under-provisioned compute or oversized
-- data).
SELECT
  'index'                                                                                    AS scope,
  ROUND(SUM(idx_blks_hit)::numeric / NULLIF(SUM(idx_blks_hit + idx_blks_read), 0) * 100, 2) AS hit_ratio_pct
FROM pg_statio_user_indexes
UNION ALL
SELECT
  'heap',
  ROUND(SUM(heap_blks_hit)::numeric / NULLIF(SUM(heap_blks_hit + heap_blks_read), 0) * 100, 2)
FROM pg_statio_user_tables;


-- ---------- 10. Tune autovacuum on public.archive — DDL, run once ----------
--
-- Aggressive per-table autovacuum settings for a hot single-row table.
-- Without these, the default `autovacuum_vacuum_scale_factor = 0.2` waits
-- until 20% of the rows are dead → on a 1-row table, autovacuum almost
-- never runs, and the TOAST table bloats forever.
--
-- The settings below tell autovacuum to vacuum after just 5 dead tuples
-- (which is one or two rewrites of the row) and to keep TOAST equally
-- fresh. fillfactor=70 leaves headroom for HOT updates in-place.

ALTER TABLE public.archive SET (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold    = 5,
  autovacuum_analyze_scale_factor = 0.0,
  autovacuum_analyze_threshold   = 5,
  fillfactor                     = 70
);

-- Apply the same on the TOAST partner (where the JSONB body lives):
DO $$
DECLARE
  toast_name text;
BEGIN
  SELECT t.relname INTO toast_name
  FROM pg_class a
  JOIN pg_class t ON a.reltoastrelid = t.oid
  WHERE a.relname = 'archive' AND a.relkind = 'r';

  IF toast_name IS NOT NULL THEN
    EXECUTE format(
      'ALTER TABLE pg_toast.%I SET (autovacuum_vacuum_scale_factor = 0.0, autovacuum_vacuum_threshold = 5)',
      toast_name
    );
  END IF;
END $$;

-- One-shot vacuum to clear out the existing backlog:
VACUUM (VERBOSE, ANALYZE) public.archive;
