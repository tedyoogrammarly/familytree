# Memories + Albums — Design Spec

**Date:** 2026-06-22
**Status:** Approved (design); pending implementation plan
**Author:** Ted + Claude (brainstorming session)

## 1. Summary

Two related changes to the Family Archive app:

1. **Open up Memories** — make the existing Memories wall a fully open feed: any logged-in
   person can create posts, upload photos, react, and comment. Today only admins can post.
2. **New Albums tab** — a brand-new top-level feature: named photo collections shown in a
   gallery, owned by their creator. Anyone logged in can create albums and upload photos to
   their own albums; everyone can browse and comment.

Both features keep the app **behind login** — there is no public/anonymous access. Accounts
remain admin-created.

## 2. Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Audience | Everyone with a login (admin / family / user) can view **and** contribute. No public access. |
| Memories change | Everyone can post + react + comment (fully open feed). |
| Albums vs Memories | Separate & independent. Albums = organized collections; Memories = chronological feed. |
| Album ownership | **Owned albums** — only the creator (and admins) can add photos / edit / delete. Everyone can view & comment. |
| Album extras | **Comments** on albums and on individual photos. **No** reactions, **no** photo captions. |
| Gallery layout | **Layout B** — newest album as a wide hero banner, the rest in a cover-card grid below. |
| Album detail view | Photo grid + click-to-enlarge lightbox (reuse existing Memories/My Kids lightbox). |
| Data storage | **Dedicated Postgres tables** for albums/photos/comments + memories/reactions/comments. Not the shared blob. |
| Rollout | **Two phases (recommended): Albums first (no migration), then Memories migration.** Can be done in one pass if desired. |

## 3. Background: why this needs a backend change

The entire app state currently lives in **one shared JSONB row** (`public.archive`, id=1).
Its RLS allows **any authenticated user to read**, but **only admins to write**
(`supabase/schema.sql`). The `family-photos` storage bucket likewise only allows
**admins to upload** (`supabase/storage.sql`). That is the real reason only admins can post
today — it is a backend permission, not just a UI gate
([index.html:684](../../../index.html#L684) marks the "+ New post" button `data-admin-only`).

Letting everyone contribute therefore requires giving non-admins a **safe write path**.
Opening the shared blob to all writers was rejected (concurrent edits would clobber each
other and could endanger family-tree data). Instead, user-generated content moves to
**dedicated tables** with per-row ownership — consistent with the recent "Vault RLS
row-split" direction and avoiding further growth of the already-strained archive blob.

The `archive` blob RLS is **left untouched** (admin-only write) — family-tree data stays
fully protected.

## 4. Data model (new Supabase tables)

Delivered as a one-time SQL migration (e.g. `supabase/migrations/albums-memories.sql`), run
once in the Supabase SQL Editor like `storage.sql`/`schema.sql` before it.

```
albums
  id           uuid primary key default gen_random_uuid()
  title        text not null
  description  text
  event_date   date
  created_by   uuid not null references auth.users(id) default auth.uid()
  created_at   timestamptz not null default now()
  cover_photo_id uuid                      -- optional explicit cover; else newest/first photo

album_photos
  id           uuid primary key default gen_random_uuid()
  album_id     uuid not null references public.albums(id) on delete cascade
  bucket       text not null default 'family-photos'
  path         text not null
  uploaded_by  uuid not null references auth.users(id) default auth.uid()
  sort_order   int  not null default 0
  created_at   timestamptz not null default now()

album_comments
  id           uuid primary key default gen_random_uuid()
  album_id     uuid not null references public.albums(id) on delete cascade
  photo_id     uuid references public.album_photos(id) on delete cascade  -- null = album-level comment
  author       uuid not null references auth.users(id) default auth.uid()
  body         text not null
  created_at   timestamptz not null default now()

memories
  id           uuid primary key default gen_random_uuid()
  author       uuid not null references auth.users(id) default auth.uid()
  date         date not null
  body         text                         -- sanitized HTML (same sanitizer as today)
  tags         jsonb not null default '[]'  -- person refs, as today
  photos       jsonb not null default '[]'  -- [{bucket, path}], as today
  created_at   timestamptz not null default now()

memory_reactions
  memory_id    uuid not null references public.memories(id) on delete cascade
  user_id      uuid not null references auth.users(id) default auth.uid()
  emoji        text not null
  created_at   timestamptz not null default now()
  primary key (memory_id, user_id, emoji)    -- one row per reaction → concurrency-safe

memory_comments
  id           uuid primary key default gen_random_uuid()
  memory_id    uuid not null references public.memories(id) on delete cascade
  author       uuid not null references auth.users(id) default auth.uid()
  body         text not null
  created_at   timestamptz not null default now()
```

Notes:
- Reactions are one row per (memory, user, emoji) so simultaneous taps from different people
  never clobber each other — the core reason for choosing tables.
- `memories.photos` and `memories.tags` stay JSONB to match the existing in-memory shape and
  minimize UI rewrite; they are per-post and not concurrently edited, so JSONB is safe here.
- A display-name lookup (auth uid → member display name) is needed for "by Mom" labels and
  comment authorship. Reuse the existing `member_accounts` mapping + members in the blob.

## 5. Row-Level Security (the permission rules)

For every new table:
- **SELECT**: any authenticated user (`auth.role() = 'authenticated'`).
- **INSERT**: authenticated, with `created_by`/`author`/`uploaded_by` = `auth.uid()`
  (enforced via `with check`).
- **UPDATE / DELETE**, per table:
  - `albums`, `memories`, `memory_comments`: row owner (`created_by`/`author`) **or** admin.
  - `album_photos`: the **parent album's owner** (`albums.created_by = auth.uid()`) **or**
    admin. This enforces the "owned albums" rule — only the album's creator adds/removes its
    photos (and INSERT is gated the same way, not just `uploaded_by = auth.uid()`).
  - `album_comments`: the **comment author**, **or** the parent album's owner (so an album
    owner can moderate comments on their album), **or** admin.
- Admin check uses the existing `public.is_admin()` SECURITY DEFINER function.

## 6. Storage changes (`family-photos` bucket)

Update `supabase/storage.sql` policies:
- **INSERT**: change from admin-only to **authenticated** (`bucket_id='family-photos' and
  auth.role()='authenticated'`).
- **DELETE**: allow **owner or admin** (`owner = auth.uid() or public.is_admin()`) — Supabase
  stamps `storage.objects.owner` with the uploader's uid.
- **SELECT**: unchanged (authenticated download via signed URLs).

The existing upload pipeline is reused unchanged: `downscaleImageFile()`
([app.js:12396](../../../app.js#L12396)) → `Backend.uploadFile()`
([app.js:264](../../../app.js#L264)), referencing photos as `{bucket, path}` with in-session
signed-URL caching.

## 7. Front-end design (`app.js`, `index.html`, `styles.css`)

**New data-access layer.** Add methods on `Backend` (which already wraps the Supabase client)
for CRUD against the new tables: `listAlbums`, `getAlbum`, `createAlbum`, `updateAlbum`,
`deleteAlbum`, `addAlbumPhotos`, `removeAlbumPhoto`, `addAlbumComment`, `deleteAlbumComment`,
and the memories equivalents. RLS enforces permissions server-side; the UI also hides controls
the user can't use (owner/admin checks via `Auth`).

**Albums feature.**
- New nav tab in [index.html](../../../index.html#L108) (no gating attribute → visible to all
  logged-in users): `<button class="nav-tab" data-view="albums" role="tab">Albums</button>`.
- New `<main id="view-albums" class="view" hidden>` view, wired into `Views.show`
  ([app.js:3481](../../../app.js#L3481) toggle + [app.js:3515](../../../app.js#L3515) render call).
- New `AlbumsView` controller (gallery landing — Layout B) and album-detail render, plus
  `AlbumModal` (create/edit), mirroring the structure of `MemoriesView`/`MemoryModal`
  ([app.js:15506](../../../app.js#L15506)+). Comments reuse the existing Memories comment
  UI/markup, persisted to `album_comments`.
- Reuse the existing lightbox and signed-URL cache for the photo grid + detail view.

**Memories changes.**
- Remove `data-admin-only` from the "+ New post" / "+ Add the first memory" buttons
  ([index.html:684](../../../index.html#L684), [index.html:701](../../../index.html#L701)).
- Rewrite `MemoriesView`'s data layer to read/write the `memories` / `memory_reactions` /
  `memory_comments` tables instead of `Store.state.memories`. **All existing UI and behavior
  (feed, search, tags, reactions, comments, lightbox) is preserved** — only the persistence
  underneath changes. Edit/delete gated to author-or-admin in the UI (RLS enforces it).

**Styling.** Hand-written CSS in `styles.css` using existing tokens (forest-green/copper/cream,
Fraunces + Inter). No Tailwind — the Tailwind/CDN guidance in `CLAUDE.md` is stale boilerplate;
this project uses hand-written CSS.

## 8. Migrating existing Memories (the riskiest part)

- **Non-destructive, reversible.** A one-time migration copies the current
  `Store.state.memories` (including nested reactions/comments) into the new tables. The
  original `memories` array in the blob is **left in place** until the new feed is verified, so
  rollback is trivial.
- **Backup first** into the existing `backups/` folder before running.
- Author attribution: existing posts are admin-authored (only admins could post), so
  `author` maps to the admin uid; preserve original `createdAt`/`date`.
- This migration is the bulk of the Memories work and is why the **recommended rollout ships
  Albums first** (zero migration) and does the Memories migration as a separate, verified step.

## 9. Realtime / freshness

Out of scope for v1: the new tables are fetched on view entry and re-fetched after writes
(optimistic UI for the actor). Live cross-client updates (Supabase realtime subscriptions on
the new tables) are a possible later enhancement; not required for launch.

## 10. Testing & verification

Use the real project workflow (local server + Playwright screenshots — **not** the
puppeteer/Windows steps in `CLAUDE.md`, which are stale):
- Start `node serve.mjs`, screenshot via `node screenshot.mjs`.
- As a **non-admin** user: create a memory post, react, comment; create an album, upload
  photos, comment on album and on a photo.
- Permission checks: cannot edit/delete another person's post, album, or someone else's
  album photos (UI hidden **and** RLS rejects).
- Owner/admin: can edit/delete own; admin can moderate any.
- Regression: existing Memories render correctly after migration; existing features
  (tree, recipes, etc.) unaffected; `archive` blob still admin-only-write.

## 11. Out of scope (YAGNI)

- Reactions on albums/photos; photo captions (explicitly excluded).
- Public/anonymous access.
- Realtime cross-client sync.
- Reorganizing or moving any other blob-based feature.

## 12. Rollout plan

1. **Phase 1 — Albums (no migration):** SQL migration for `albums`/`album_photos`/
   `album_comments` + storage policy change; build the Albums tab end-to-end; verify.
2. **Phase 2 — Open Memories:** SQL migration for `memories`/`memory_reactions`/
   `memory_comments`; migrate existing data (non-destructive); rewrite `MemoriesView` data
   layer; drop the admin-only gate; verify; then retire the blob `memories` array once
   confirmed.
