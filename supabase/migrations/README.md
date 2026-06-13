# Deferred DB hardening — hand-off notes

These migrations close the **server-side** half of the security gaps the v4.56
audit found. They are deferred (not auto-applied) because the app currently
reads and writes *everything* through one JSONB blob, so each split needs a
matching app change. Run the SQL and ship the app change **together**, and test
on a clone first.

> Context: all authorization in `app.js` is client-side. The database only
> enforces "admins can write the one `archive` row; any authenticated user can
> read it." So today the Vault, gift amounts, and sealed time-capsule letters
> are all fetchable by any signed-in account, and non-admin writes (grocery,
> RSVP, reminders) are silently rejected by RLS. The v4.56 code release surfaces
> those rejected writes with an error toast — but the real fix is below.

## 1. `2026-06-13-private-vault-rls.sql` — split the Vault (highest value)

Moves `archive.state.vault` into a new admin-only table, `archive_private`, so
it is no longer in the world-readable blob.

**Required app change (in `app.js`), to do in the same deploy:**

1. **Load:** after the existing `fetchArchive()`, if `Auth.canAccessVault()`,
   also `select state from archive_private where id = 1` and merge its `vault`
   key into `Store.state.vault`. Non-authorized users never fetch it, so the
   data never reaches their browser.
2. **Save:** in `Backend.flushSaveArchive`, write `state.vault` to
   `archive_private` (not `archive`) and strip `vault` from the payload sent to
   `archive`. Only runs for vault-authorized users.
3. **Backfill:** run the (commented) backfill block in the SQL *after* the app
   deploy is live, then the strip + keep the `archive_backup_*` table a while.

Verification: sign in as a **non-admin** test account, open DevTools → Network,
reload, and confirm no Vault fields appear in any response body.

## 2. Collaborative data (grocery / RSVP / reminders) — phase 2

Non-admins are *allowed in the UI* to edit these, but RLS rejects the write.
Recommended: move high-churn collaborative data into its own table with an
authenticated-write policy, e.g.

```sql
create table if not exists public.shared_lists (
  key text primary key,            -- 'grocery', etc.
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.shared_lists enable row level security;
create policy "auth read shared"  on public.shared_lists for select using (auth.role() = 'authenticated');
create policy "auth write shared" on public.shared_lists for all    using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
```

App change: read/write those keys against `shared_lists` and subscribe to it on
its own realtime channel (also fixes the "a keystroke rebroadcasts the whole
archive" performance issue). Until then, the v4.56 error toast at least tells
the user their change didn't save.

## 3. Time-capsule letters — phase 2

Sealed letters live in the blob, so a recipient can read the JSON before the
unlock date. Proper fix: a `time_capsules` table with a policy that only
returns a letter body to its author, or to anyone once `unlock_date <= now()`:

```sql
create policy "capsule visibility" on public.time_capsules for select using (
  public.is_admin()
  or author_user_id = auth.uid()
  or unlock_date <= current_date
);
```

This is the largest of the three (per-row modeling + app rewrite of the Time
Capsule view) — schedule it on its own.

## General

- The committed Supabase anon key in `config.js` is fine to ship; security rests
  on RLS, which is exactly what these migrations strengthen.
- Always `create table ... as select * from ...` a backup before any blob strip,
  and test each migration on a Supabase branch/clone before production.
