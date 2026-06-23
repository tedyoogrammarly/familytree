# Memories + Albums Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the Memories feed to all logged-in users and add a new Albums tab (owned photo collections, gallery layout B), with user-generated content stored in dedicated Supabase tables.

**Architecture:** New Postgres tables (`albums`, `album_photos`, `album_comments`, `memories`, `memory_reactions`, `memory_comments`) with per-row RLS replace the admin-only `archive` blob as the write path for contributions. The `family-photos` storage bucket is opened to authenticated uploads. A new `AlbumsView`/`AlbumModal` mirror the existing `MemoriesView`/`MemoryModal`; the Memories data layer is rewritten from `Store.state.memories` to the new tables (non-destructive migration). Family-tree `archive` blob RLS is untouched.

**Tech Stack:** Vanilla JS SPA (single `app.js` ~827KB), hand-written `styles.css`, `index.html`; Supabase (Postgres + RLS + Storage + supabase-js UMD client); Node built-in test runner (`node --test`) for pure logic; `serve.mjs` + `screenshot.mjs` (Playwright) for UI verification.

**Spec:** `docs/superpowers/specs/2026-06-22-memories-albums-design.md`

---

## Conventions & ground rules (read first)

- **No Tailwind / no CDN.** `CLAUDE.md` in this repo is stale boilerplate. This project uses **hand-written CSS** in `styles.css` with existing design tokens (`--brand-500` etc.), Fraunces + Inter fonts, on **macOS**, verified with **Playwright** via `screenshot.mjs` (not puppeteer).
- **Existing helpers to reuse (do not reinvent):** `Backend.uploadMedia(file, {bucket, folder, maxBytes})`, `Backend.getMediaUrl(bucket, path, expiry)`, `Backend.deleteMedia(bucket, path)`, `downscaleImageToBlob(file, maxDim, q)`, `MyKidsLightbox.open(photosArray, idx)`, `uid(prefix)`, `escape(str)`, `cssUrl(url)`, `toast(msg, level)`, `displayName(member)`, `formatDate(iso)`, `relativeTime(ms)`, `$`, `$$`, `on(el, evt, fn)`, `Store.byId(id)`.
- **Supabase query style** (mirror `Backend.loadMyAccount` at [app.js:162](../../../app.js#L162)): `await Backend.client.from('table').select(...).eq(...)` etc. The client is `Backend.client`; current user is `Backend.user`; admin check is `Auth.isAdmin()`.
- **Migration idiom:** mirror [supabase/migrations/2026-06-13-private-vault-rls.sql](../../../supabase/migrations/2026-06-13-private-vault-rls.sql) — numbered sections, `drop policy if exists` before `create policy`, commented backfill + ROLLBACK. Note the hand-off discipline in [supabase/migrations/README.md](../../../supabase/migrations/README.md): "Run the SQL and ship the app change together; back up before any blob strip; test on a clone first."
- **Photo references** are `{ bucket, path }` objects; render via the signed-URL cache pattern in `MemoriesView.resolvePhotoSrc` ([app.js:15817](../../../app.js#L15817)).
- **Graceful degradation:** every data-access call that hits a new table must catch the "relation does not exist" / 404 error and return an empty result + render an empty state, so the front-end is safe to ship before/independent of the SQL being applied.
- **Commit after every task.** Branch: `albums-memories-design` (already created off the v4.57 line). Do NOT merge to `main` until the deploy runbook (Task D) — merging auto-publishes via GitHub Pages.

---

# PHASE 1 — Albums (independently shippable, no data migration)

## Task 1: Albums SQL migration (tables + RLS)

**Files:**
- Create: `supabase/migrations/2026-06-22-albums.sql`

- [ ] **Step 1: Write the migration file**

```sql
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
```

- [ ] **Step 2: Verify SQL parses (syntax only, locally)**

This SQL is applied by the user in Supabase (Task D). For a local syntax sanity check, ensure balanced `$$` and matching `create/drop policy` names by eye. No DB is available locally.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-06-22-albums.sql
git commit -m "feat(albums): SQL migration — albums/album_photos/album_comments + RLS"
```

## Task 2: Storage policy — allow authenticated uploads to family-photos

**Files:**
- Create: `supabase/migrations/2026-06-22-storage-authenticated-upload.sql`

This is required for **both** phases (everyone can upload photos). It replaces the admin-only INSERT policy on `family-photos` with an authenticated-INSERT + owner/admin-DELETE policy.

- [ ] **Step 1: Write the migration**

```sql
-- =============================================================
-- Family Archive — open family-photos uploads to authenticated users
-- =============================================================
-- Before: only admins could INSERT/DELETE into family-photos (storage.sql).
-- After:  any authenticated user can upload; a user can delete their OWN
--         uploads (storage.objects.owner = their uid); admins delete any.
-- SELECT (download via signed URL) is unchanged (authenticated).
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

-- ROLLBACK: re-run the family-photos block of supabase/storage.sql to
-- restore admin-only insert/delete.
```

- [ ] **Step 2: Update `supabase/storage.sql` to match (so the canonical file stays correct)**

In [supabase/storage.sql](../../../supabase/storage.sql) replace the three `family-photos` policy statements (admin insert / auth select / admin delete) with the auth-insert + owner-delete versions above, keeping the existing `auth select` policy. This keeps the source-of-truth file consistent for any future fresh setup.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-06-22-storage-authenticated-upload.sql supabase/storage.sql
git commit -m "feat(storage): allow authenticated uploads + owner delete on family-photos"
```

## Task 3: Albums data-access layer (`AlbumsApi`)

**Files:**
- Modify: `app.js` — add a new `const AlbumsApi = {...}` object immediately after the `Backend` object (after [app.js:329](../../../app.js#L329)).

This isolates all Supabase calls for albums in one place. Every method catches errors and returns a safe default (graceful degradation if tables are missing).

- [ ] **Step 1: Add the `AlbumsApi` object**

```javascript
// -------------------- ALBUMS DATA ACCESS (v4.58) --------------------
// CRUD against the dedicated albums/* tables. RLS enforces permissions
// server-side; callers also gate UI on ownership. Every method degrades
// gracefully (returns empty/null) if the tables aren't there yet, so the
// front-end is safe to ship before the SQL migration is applied.
const AlbumsApi = {
  _warn(where, error) { if (error) console.warn(`AlbumsApi.${where}:`, error.message); },

  async listAlbums() {
    if (!Backend.client) return [];
    const { data, error } = await Backend.client
      .from('albums')
      .select('id, title, description, event_date, cover_photo_id, created_by, created_at')
      .order('created_at', { ascending: false });
    if (error) { this._warn('listAlbums', error); return []; }
    return data || [];
  },

  // One album with its photos + comments. Returns { album, photos, comments } or null.
  async getAlbum(id) {
    if (!Backend.client || !id) return null;
    const a = await Backend.client.from('albums').select('*').eq('id', id).maybeSingle();
    if (a.error || !a.data) { this._warn('getAlbum', a.error); return null; }
    const p = await Backend.client.from('album_photos')
      .select('id, bucket, path, uploaded_by, sort_order, created_at')
      .eq('album_id', id).order('sort_order', { ascending: true }).order('created_at', { ascending: true });
    const c = await Backend.client.from('album_comments')
      .select('id, photo_id, author, body, created_at')
      .eq('album_id', id).order('created_at', { ascending: true });
    return { album: a.data, photos: p.data || [], comments: c.data || [] };
  },

  async createAlbum({ title, description, event_date }) {
    if (!Backend.client) return { ok: false, reason: 'Backend unavailable.' };
    const { data, error } = await Backend.client.from('albums')
      .insert({ title, description: description || null, event_date: event_date || null })
      .select('id').single();
    if (error) { this._warn('createAlbum', error); return { ok: false, reason: error.message }; }
    return { ok: true, id: data.id };
  },

  async updateAlbum(id, { title, description, event_date, cover_photo_id }) {
    if (!Backend.client) return { ok: false, reason: 'Backend unavailable.' };
    const patch = { updated_at: new Date().toISOString() };
    if (title !== undefined)         patch.title = title;
    if (description !== undefined)   patch.description = description || null;
    if (event_date !== undefined)    patch.event_date = event_date || null;
    if (cover_photo_id !== undefined) patch.cover_photo_id = cover_photo_id;
    const { error } = await Backend.client.from('albums').update(patch).eq('id', id);
    if (error) { this._warn('updateAlbum', error); return { ok: false, reason: error.message }; }
    return { ok: true };
  },

  async deleteAlbum(id) {
    if (!Backend.client) return { ok: false };
    const { error } = await Backend.client.from('albums').delete().eq('id', id);
    if (error) { this._warn('deleteAlbum', error); return { ok: false, reason: error.message }; }
    return { ok: true };
  },

  // photos: array of { bucket, path }. Returns { ok }.
  async addPhotos(albumId, photos) {
    if (!Backend.client || !photos.length) return { ok: true };
    const rows = photos.map((p, i) => ({ album_id: albumId, bucket: p.bucket, path: p.path, sort_order: i }));
    const { error } = await Backend.client.from('album_photos').insert(rows);
    if (error) { this._warn('addPhotos', error); return { ok: false, reason: error.message }; }
    return { ok: true };
  },

  async removePhoto(photoId) {
    if (!Backend.client) return { ok: false };
    const { error } = await Backend.client.from('album_photos').delete().eq('id', photoId);
    if (error) { this._warn('removePhoto', error); return { ok: false, reason: error.message }; }
    return { ok: true };
  },

  async addComment(albumId, photoId, body) {
    if (!Backend.client) return { ok: false };
    const { data, error } = await Backend.client.from('album_comments')
      .insert({ album_id: albumId, photo_id: photoId || null, body })
      .select('id, photo_id, author, body, created_at').single();
    if (error) { this._warn('addComment', error); return { ok: false, reason: error.message }; }
    return { ok: true, comment: data };
  },

  async deleteComment(commentId) {
    if (!Backend.client) return { ok: false };
    const { error } = await Backend.client.from('album_comments').delete().eq('id', commentId);
    if (error) { this._warn('deleteComment', error); return { ok: false, reason: error.message }; }
    return { ok: true };
  },
};
```

- [ ] **Step 2: Add a display-name resolver for auth-user ids**

The album cards show "by Mom" and comments show author names. We have `member_accounts` (user_id → member_id) and members in the blob. Add this helper near `resolvePersonRefLabel` ([app.js:15859](../../../app.js#L15859)):

```javascript
// Resolve an auth user id to a display name via member_accounts → members.
// Cached in-session. Falls back to "Family member". Async warm-up: call
// AuthorNames.warm() once on login so the synchronous nameFor() has data.
const AuthorNames = {
  _byUser: new Map(),   // user_id -> displayName
  async warm() {
    if (!Backend.client) return;
    const { data } = await Backend.client.from('member_accounts').select('user_id, member_id');
    for (const row of (data || [])) {
      const m = Store.byId(row.member_id);
      if (m) this._byUser.set(row.user_id, displayName(m));
    }
    // include myself even if my member record is the bootstrap admin
    if (Backend.user?.id && !this._byUser.has(Backend.user.id)) {
      this._byUser.set(Backend.user.id, MemoriesView.currentAuthorName?.() || 'Admin');
    }
  },
  nameFor(userId) {
    if (!userId) return 'Family member';
    return this._byUser.get(userId) || 'Family member';
  },
};
```

- [ ] **Step 3: Warm the name cache after sign-in**

Find where the app finishes loading after auth (search for `AdminView.render()` post-login, or the `subscribeArchive()` call). Add `AuthorNames.warm();` right after the archive loads and `Store` is populated. (In `executing-plans`, grep `subscribeArchive(` and add the call in that post-login block.)

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat(albums): AlbumsApi data-access layer + author-name resolver"
```

## Task 4: Nav tab + view shell + routing

**Files:**
- Modify: `index.html` — nav tab (after [index.html:108](../../../index.html#L108)) and a new `<main id="view-albums">` (after the memories `</main>` at [index.html:706](../../../index.html#L706)).
- Modify: `app.js` — `Views.show` ([app.js:3481](../../../app.js#L3481) and [app.js:3515](../../../app.js#L3515)) and the init block ([app.js:9427](../../../app.js#L9427)).

- [ ] **Step 1: Add the nav tab** (no gating attribute → visible to every logged-in user). After the Memories tab:

```html
          <button class="nav-tab" data-view="albums" role="tab">Albums</button>
```

- [ ] **Step 2: Add the view shell** after the Memories `</main>`:

```html
    <main id="view-albums" class="view" hidden>
      <div class="container">
        <div class="page-head">
          <div>
            <h2><span class="page-emoji" data-page-emoji="albums"></span>Albums</h2>
            <p>Photo collections — trips, birthdays, everyday moments. Make an album, add your photos.</p>
          </div>
          <div class="page-head-actions">
            <button class="btn btn-primary btn-sm" id="btn-album-add">+ New album</button>
          </div>
        </div>
        <!-- Gallery (list of albums) -->
        <section id="albums-gallery" class="albums-gallery"></section>
        <div id="albums-empty" class="tree-empty" hidden>
          <div class="tree-empty-card">
            <h3>No albums yet</h3>
            <p>Start the first one — give it a name and add a few photos.</p>
            <button class="btn btn-primary" id="btn-album-add-first">+ Create the first album</button>
          </div>
        </div>
        <!-- Album detail (hidden until an album is opened) -->
        <section id="album-detail" class="album-detail" hidden></section>
      </div>
    </main>
```

- [ ] **Step 3: Wire routing.** In `Views.show`, add after the memories line ([app.js:3481](../../../app.js#L3481)):

```javascript
    $('#view-albums').hidden       = name !== 'albums';
```

and in the deferred render block after the memories render ([app.js:3515](../../../app.js#L3515)):

```javascript
      if (name === 'albums')    AlbumsView.render();
```

- [ ] **Step 4: Register init.** After `MemoriesView.init();` ([app.js:9427](../../../app.js#L9427)):

```javascript
  AlbumsView.init();
```

- [ ] **Step 5: Verify the tab appears.** Start server, screenshot, confirm the Albums tab renders and clicking it shows the (empty) view without console errors.

```bash
node serve.mjs &   # if not already running
node screenshot.mjs http://localhost:3000 albums-tab
```
Expected: nav shows "Albums"; clicking it shows the empty-state card; no uncaught errors. (AlbumsView is added in Task 5; until then a stub `const AlbumsView = { init(){}, render(){} };` placed before Task 5 keeps the app booting — add the stub now and replace it in Task 5.)

- [ ] **Step 6: Commit**

```bash
git add index.html app.js
git commit -m "feat(albums): nav tab, view shell, routing + init wiring"
```

## Task 5: AlbumsView gallery (Layout B — hero + grid)

**Files:**
- Modify: `app.js` — add `const AlbumsView = {...}` near `MemoriesView` ([app.js:15506](../../../app.js#L15506)); replace the Task-4 stub.

Layout B: newest album as a wide hero banner, the rest in a cover-card grid below. Cover image = the album's `cover_photo_id` photo if set, else the newest photo; if no photos, a tinted placeholder.

- [ ] **Step 1: Add the `AlbumsView` object (gallery render)**

```javascript
const AlbumsView = {
  signedUrlCache: new Map(),   // bucket|path -> { url, expiresAt }
  albums: [],                   // cached list for the gallery
  coverByAlbum: new Map(),      // album_id -> { bucket, path } | null

  init() {
    on($('#btn-album-add'),       'click', () => AlbumModal.openAdd());
    on($('#btn-album-add-first'), 'click', () => AlbumModal.openAdd());
    AlbumModal.init();
  },

  canCreate() { return !!Backend.user; },          // any logged-in user
  isOwner(album) { return album && Backend.user && album.created_by === Backend.user.id; },
  canManage(album) { return this.isOwner(album) || Auth.isAdmin(); },

  async render() {
    // Always return to the gallery (not a stale detail view) on tab entry.
    $('#album-detail').hidden = true;
    $('#album-detail').innerHTML = '';
    const gallery = $('#albums-gallery');
    const empty   = $('#albums-empty');
    if (!gallery) return;
    this.albums = await AlbumsApi.listAlbums();
    // Resolve a cover ref per album (newest photo unless an explicit cover set).
    await this._resolveCovers();
    if (!this.albums.length) { gallery.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    const [hero, ...rest] = this.albums;
    gallery.innerHTML = `
      ${this.heroHTML(hero)}
      ${rest.length ? `<div class="albums-grid">${rest.map(a => this.cardHTML(a)).join('')}</div>` : ''}
    `;
    gallery.querySelectorAll('[data-album-open]').forEach(el => {
      on(el, 'click', () => this.openAlbum(el.dataset.albumOpen));
      on(el, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openAlbum(el.dataset.albumOpen); } });
    });
    gallery.querySelectorAll('[data-album-cover]').forEach(el => this.resolvePhotoSrc(el));
  },

  // For each album, fetch its newest photo to use as the cover. One light
  // query per album; albums are few. Cached so re-renders don't refetch.
  async _resolveCovers() {
    for (const a of this.albums) {
      if (this.coverByAlbum.has(a.id)) continue;
      let ref = null;
      if (Backend.client) {
        let q = Backend.client.from('album_photos').select('bucket, path').eq('album_id', a.id);
        q = a.cover_photo_id ? q.eq('id', a.cover_photo_id) : q.order('created_at', { ascending: false }).limit(1);
        const { data } = await q;
        if (data && data[0]) ref = { bucket: data[0].bucket, path: data[0].path };
      }
      this.coverByAlbum.set(a.id, ref);
    }
  },

  metaLine(a) {
    const by = AuthorNames.nameFor(a.created_by);
    const date = a.event_date ? formatDate(a.event_date) : '';
    return `by ${escape(by)}${date ? ' · ' + escape(date) : ''}`;
  },

  coverAttrs(a) {
    const ref = this.coverByAlbum.get(a.id);
    return ref
      ? `data-album-cover data-bucket="${escape(ref.bucket)}" data-path="${escape(ref.path)}"`
      : 'data-album-cover'; // no photo → placeholder via CSS .is-missing fallback
  },

  heroHTML(a) {
    return `
      <article class="album-hero" data-album-open="${escape(a.id)}" tabindex="0" role="button" aria-label="Open album ${escape(a.title)}">
        <div class="album-hero-cover" ${this.coverAttrs(a)}></div>
        <div class="album-hero-cap">
          <h3 class="album-hero-title">${escape(a.title)}</h3>
          <p class="album-hero-meta">${this.metaLine(a)}</p>
        </div>
      </article>`;
  },

  cardHTML(a) {
    return `
      <article class="album-card" data-album-open="${escape(a.id)}" tabindex="0" role="button" aria-label="Open album ${escape(a.title)}">
        <div class="album-card-cover" ${this.coverAttrs(a)}></div>
        <div class="album-card-body">
          <h4 class="album-card-title">${escape(a.title)}</h4>
          <p class="album-card-meta">${this.metaLine(a)}</p>
        </div>
      </article>`;
  },

  // Shared signed-URL resolver (same shape as MemoriesView.resolvePhotoSrc).
  async resolvePhotoSrc(el) {
    const bucket = el.dataset.bucket, path = el.dataset.path;
    if (!bucket || !path) { el.classList.add('is-missing'); return; }
    const key = `${bucket}|${path}`, now = Date.now();
    const cached = this.signedUrlCache.get(key);
    if (cached && cached.expiresAt > now) { el.style.backgroundImage = `url('${cssUrl(cached.url)}')`; return; }
    const url = await Backend.getMediaUrl(bucket, path, 3600);
    if (!url) { el.classList.add('is-missing'); return; }
    this.signedUrlCache.set(key, { url, expiresAt: now + 50 * 60 * 1000 });
    el.style.backgroundImage = `url('${cssUrl(url)}')`;
  },

  // openAlbum / detail render — added in Task 6.
  // (placeholder so the file is valid between tasks:)
  async openAlbum(id) { /* implemented in Task 6 */ },
};
```

- [ ] **Step 2: Verify the gallery renders empty + the "New album" button opens a modal** (the modal itself lands in Task 7; for now confirm no errors, empty state shows).

```bash
node screenshot.mjs http://localhost:3000 albums-empty
```
Expected: empty-state card visible, no console errors.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(albums): gallery view (layout B hero + grid) with cover resolution"
```

## Task 6: Album detail view (photo grid + lightbox + manage controls)

**Files:**
- Modify: `app.js` — replace the `openAlbum` placeholder in `AlbumsView` and add detail render + photo/comment wiring.

- [ ] **Step 1: Implement `openAlbum` + `renderDetail`**

```javascript
  async openAlbum(id) {
    const data = await AlbumsApi.getAlbum(id);
    if (!data) { toast("Couldn't open that album.", 'warn'); return; }
    this.current = data;                 // { album, photos, comments }
    $('#albums-gallery').innerHTML = '';
    $('#albums-empty').hidden = true;
    this.renderDetail();
  },

  backToGallery() { this.current = null; this.render(); },

  renderDetail() {
    const wrap = $('#album-detail');
    if (!wrap || !this.current) return;
    const { album, photos, comments } = this.current;
    const manage = this.canManage(album);
    const photosHTML = photos.map((p, i) => `
      <div class="album-photo" data-album-photo data-bucket="${escape(p.bucket)}" data-path="${escape(p.path)}" data-photo-idx="${i}" data-photo-id="${escape(p.id)}" tabindex="0" role="button" aria-label="Photo ${i + 1}">
        ${manage ? `<button type="button" class="album-photo-x" data-remove-photo="${escape(p.id)}" aria-label="Remove photo">×</button>` : ''}
      </div>`).join('');
    // album-level comments = those with photo_id null
    const albumComments = comments.filter(c => !c.photo_id);
    wrap.hidden = false;
    wrap.innerHTML = `
      <button type="button" class="btn btn-ghost btn-sm album-back" id="album-back">← All albums</button>
      <header class="album-detail-head">
        <div>
          <h3 class="album-detail-title">${escape(album.title)}</h3>
          <p class="album-detail-meta">${this.metaLine(album)}</p>
          ${album.description ? `<p class="album-detail-desc">${escape(album.description).replace(/\n/g, '<br>')}</p>` : ''}
        </div>
        ${manage ? `
          <div class="album-detail-actions">
            <label class="btn btn-secondary btn-sm" id="album-photo-add-label">+ Add photos
              <input type="file" accept="image/*" id="album-photo-input" hidden multiple />
            </label>
            <button class="btn btn-ghost btn-sm"        type="button" id="album-edit">Edit</button>
            <button class="btn btn-danger-ghost btn-sm" type="button" id="album-delete">Delete album</button>
          </div>` : ''}
      </header>
      ${photos.length ? `<div class="album-photo-grid">${photosHTML}</div>`
                      : `<p class="muted" style="padding:24px;text-align:center;">No photos yet${manage ? ' — add the first one.' : '.'}</p>`}
      ${this.commentsHTML(album, null, albumComments)}
    `;
    // wiring
    on($('#album-back'), 'click', () => this.backToGallery());
    if (manage) {
      on($('#album-photo-input'), 'change', (e) => this.onPhotoPick(e));
      on($('#album-edit'),   'click', () => AlbumModal.openEdit(album));
      on($('#album-delete'), 'click', () => this.deleteAlbum());
      wrap.querySelectorAll('[data-remove-photo]').forEach(btn =>
        on(btn, 'click', (e) => { e.stopPropagation(); this.removePhoto(btn.dataset.removePhoto); }));
    }
    wrap.querySelectorAll('[data-album-photo]').forEach(el => this.resolvePhotoSrc(el));
    wrap.querySelectorAll('[data-album-photo]').forEach(tile => {
      on(tile, 'click', () => this.openLightbox(Number(tile.dataset.photoIdx)));
      on(tile, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openLightbox(Number(tile.dataset.photoIdx)); } });
    });
    this.wireComments(album);
  },

  openLightbox(idx) {
    const photos = (this.current?.photos || []).map(p => ({ bucket: p.bucket, path: p.path }));
    if (!photos.length) return;
    MyKidsLightbox.open(photos, idx || 0);
  },

  async onPhotoPick(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length || !this.current) return;
    const album = this.current.album;
    const uploaded = [];
    for (const file of files) {
      try {
        const blob = await downscaleImageToBlob(file, 2400, 0.85);
        const r = await Backend.uploadMedia(new File([blob], file.name, { type: 'image/jpeg' }),
          { bucket: 'family-photos', folder: 'albums', maxBytes: 10 * 1024 * 1024 });
        if (!r.ok) throw new Error(r.reason);
        uploaded.push({ bucket: r.bucket, path: r.path });
      } catch (err) { toast(`Photo upload failed: ${err.message || err}`, 'warn'); }
    }
    if (uploaded.length) {
      const res = await AlbumsApi.addPhotos(album.id, uploaded);
      if (!res.ok) { toast('Could not save photos.', 'warn'); return; }
      this.coverByAlbum.delete(album.id);     // cover may have changed
      await this.openAlbum(album.id);          // re-fetch + re-render
      toast(`${uploaded.length} photo${uploaded.length === 1 ? '' : 's'} added.`);
    }
  },

  async removePhoto(photoId) {
    if (!this.current) return;
    if (!confirm('Remove this photo from the album?')) return;
    const photo = this.current.photos.find(p => p.id === photoId);
    const res = await AlbumsApi.removePhoto(photoId);
    if (!res.ok) { toast('Could not remove photo.', 'warn'); return; }
    if (photo) await Backend.deleteMedia(photo.bucket, photo.path);  // best-effort storage cleanup
    this.coverByAlbum.delete(this.current.album.id);
    await this.openAlbum(this.current.album.id);
  },

  async deleteAlbum() {
    if (!this.current) return;
    const album = this.current.album;
    if (!confirm('Delete this whole album and its photos? This cannot be undone.')) return;
    // best-effort storage cleanup before the cascade delete removes the rows
    for (const p of this.current.photos) await Backend.deleteMedia(p.bucket, p.path);
    const res = await AlbumsApi.deleteAlbum(album.id);
    if (!res.ok) { toast('Could not delete album.', 'warn'); return; }
    this.coverByAlbum.delete(album.id);
    toast('Album deleted.');
    this.backToGallery();
  },
```

- [ ] **Step 2: Verify (after Task 7 lands the create modal) — deferred to Task 10 matrix.** For now, confirm the file parses and `node serve.mjs` boots with no console error on the Albums tab.

- [ ] **Step 3: Commit**

```bash
git add app.js
git commit -m "feat(albums): album detail view — photo grid, lightbox, add/remove/delete"
```

## Task 7: AlbumModal (create / edit)

**Files:**
- Modify: `index.html` — add an album modal after the memory modal ([index.html:759](../../../index.html#L759)).
- Modify: `app.js` — add `const AlbumModal = {...}` after `AlbumsView`.

Mirror `MemoryModal` ([app.js:15968](../../../app.js#L15968)) open/close (`aria-hidden` + `.is-open`) and form handling. The modal only collects album metadata (title/description/date); photos are added in the detail view (Task 6), so create flow = make album → open it → add photos.

- [ ] **Step 1: Add modal markup**

```html
    <!-- ===== ALBUM MODAL (v4.58) -->
    <div id="album-modal" class="modal" aria-hidden="true">
      <div class="modal-backdrop" data-close></div>
      <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="album-modal-title">
        <header class="modal-head">
          <h3 id="album-modal-title">New album</h3>
          <button class="icon-btn" data-close aria-label="Close">
            <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          </button>
        </header>
        <form id="album-form" class="modal-body">
          <label class="field"><span>Title *</span><input name="title" type="text" maxlength="120" required placeholder="e.g. Summer 2025 Trip" /></label>
          <label class="field"><span>Date <span class="muted small">(optional)</span></span><input name="event_date" type="date" /></label>
          <label class="field"><span>Description <span class="muted small">(optional)</span></span><textarea name="description" rows="3" maxlength="2000" placeholder="A sentence about this album."></textarea></label>
          <p class="form-error" id="album-error" role="alert" hidden></p>
          <div class="modal-actions">
            <button class="btn btn-primary" type="submit" id="album-submit">Create album</button>
            <button class="btn btn-ghost" type="button" data-close>Cancel</button>
          </div>
        </form>
      </div>
    </div>
```

- [ ] **Step 2: Add `AlbumModal` object**

```javascript
const AlbumModal = {
  editing: null,   // album object when editing, else null
  init() {
    const fm = $('#album-form');
    on(fm, 'submit', (e) => { e.preventDefault(); this.save(); });
    $('#album-modal').querySelectorAll('[data-close]').forEach(el => on(el, 'click', () => this.close()));
  },
  openAdd() {
    if (!AlbumsView.canCreate()) { toast('Sign in to create an album.', 'warn'); return; }
    this.editing = null;
    $('#album-form').reset();
    $('#album-error').hidden = true;
    $('#album-modal-title').textContent = 'New album';
    $('#album-submit').textContent = 'Create album';
    this.open();
    setTimeout(() => $('#album-form').title.focus(), 50);
  },
  openEdit(album) {
    if (!AlbumsView.canManage(album)) return;
    this.editing = album;
    const fm = $('#album-form');
    fm.reset();
    fm.title.value = album.title || '';
    fm.event_date.value = album.event_date || '';
    fm.description.value = album.description || '';
    $('#album-error').hidden = true;
    $('#album-modal-title').textContent = 'Edit album';
    $('#album-submit').textContent = 'Save changes';
    this.open();
  },
  open()  { const el = $('#album-modal'); el.setAttribute('aria-hidden', 'false'); el.classList.add('is-open'); },
  close() { const el = $('#album-modal'); el.setAttribute('aria-hidden', 'true');  el.classList.remove('is-open'); this.editing = null; },
  async save() {
    const fm = $('#album-form');
    const title = (fm.title.value || '').trim();
    if (!title) { $('#album-error').textContent = 'A title is required.'; $('#album-error').hidden = false; return; }
    const payload = { title, description: (fm.description.value || '').trim(), event_date: fm.event_date.value || null };
    if (this.editing) {
      const res = await AlbumsApi.updateAlbum(this.editing.id, payload);
      if (!res.ok) { $('#album-error').textContent = res.reason || 'Could not save.'; $('#album-error').hidden = false; return; }
      this.close();
      await AlbumsView.openAlbum(this.editing.id);
      toast('Album updated.');
    } else {
      const res = await AlbumsApi.createAlbum(payload);
      if (!res.ok) { $('#album-error').textContent = res.reason || 'Could not create album.'; $('#album-error').hidden = false; return; }
      this.close();
      await AlbumsView.openAlbum(res.id);   // jump into the new album to add photos
      toast('Album created — now add some photos.');
    }
  },
};
```

- [ ] **Step 3: Verify create flow** (manual, via screenshot in Task 10).

- [ ] **Step 4: Commit**

```bash
git add index.html app.js
git commit -m "feat(albums): create/edit album modal"
```

## Task 8: Album & photo comments

**Files:**
- Modify: `app.js` — add `commentsHTML`, `wireComments`, `addComment`, `deleteComment` to `AlbumsView`; add a comment strip to the lightbox for per-photo comments.

Comments are open to everyone logged in (insert). Delete allowed for the comment author, the album owner, or admin (matches RLS). Album-level comments render under the photo grid; per-photo comments are reachable from the photo lightbox.

- [ ] **Step 1: Add comment rendering + wiring to `AlbumsView`** (adapt `MemoriesView.commentsHTML` at [app.js:15790](../../../app.js#L15790)):

```javascript
  canComment() { return !!Backend.user; },
  canDeleteComment(c, album) {
    const me = Backend.user?.id;
    return (c.author && me && c.author === me) || this.isOwner(album) || Auth.isAdmin();
  },

  // photoId null → album-level comments. `list` is the pre-filtered subset.
  commentsHTML(album, photoId, list) {
    const items = (list || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(c => `
      <li class="album-comment">
        <div class="album-comment-head">
          <strong class="album-comment-author">${escape(AuthorNames.nameFor(c.author))}</strong>
          <time class="album-comment-date muted small">${relativeTime(new Date(c.created_at).getTime())}</time>
          ${this.canDeleteComment(c, album) ? `<button type="button" class="album-comment-x" data-del-comment="${escape(c.id)}" aria-label="Delete comment">×</button>` : ''}
        </div>
        <div class="album-comment-body">${escape(c.body).replace(/\n/g, '<br>')}</div>
      </li>`).join('');
    const composer = this.canComment()
      ? `<form class="album-comment-add" data-comment-submit="${photoId ? escape(photoId) : 'album'}">
           <textarea rows="2" placeholder="Write a comment…" maxlength="2000"></textarea>
           <button type="submit" class="btn btn-secondary btn-sm">Post</button>
         </form>`
      : '';
    return `<section class="album-comments">
        <h4 class="album-comments-title">Comments</h4>
        ${items ? `<ul class="album-comment-list">${items}</ul>` : '<p class="muted small">No comments yet.</p>'}
        ${composer}
      </section>`;
  },

  wireComments(album) {
    const wrap = $('#album-detail');
    wrap.querySelectorAll('form[data-comment-submit]').forEach(form => {
      on(form, 'submit', (e) => {
        e.preventDefault();
        const target = form.dataset.commentSubmit;          // 'album' or a photo id
        const photoId = target === 'album' ? null : target;
        this.addComment(album, photoId, form.querySelector('textarea'));
      });
    });
    wrap.querySelectorAll('[data-del-comment]').forEach(btn =>
      on(btn, 'click', () => this.deleteComment(album, btn.dataset.delComment)));
  },

  async addComment(album, photoId, textarea) {
    if (!this.canComment()) { toast('Sign in to comment.', 'warn'); return; }
    const body = (textarea.value || '').trim();
    if (!body) return;
    const res = await AlbumsApi.addComment(album.id, photoId, body);
    if (!res.ok) { toast('Could not post comment.', 'warn'); return; }
    this.current.comments.push(res.comment);
    textarea.value = '';
    this.renderDetail();
  },

  async deleteComment(album, commentId) {
    const c = this.current.comments.find(x => x.id === commentId);
    if (!c || !this.canDeleteComment(c, album)) return;
    if (!confirm('Delete this comment?')) return;
    const res = await AlbumsApi.deleteComment(commentId);
    if (!res.ok) { toast('Could not delete comment.', 'warn'); return; }
    this.current.comments = this.current.comments.filter(x => x.id !== commentId);
    this.renderDetail();
  },
```

- [ ] **Step 2: Per-photo comments in the lightbox.** Reuse the album-level pattern but scope to a photo. Minimal approach for v1: in `renderDetail`, under each photo's lightbox open, we already pass `photo_id`. Add a small "💬 N" count badge on photo tiles that have comments, and when the lightbox opens, show that photo's comments below the grid by re-rendering the comments section filtered to `photo_id`. Implement by adding to `openLightbox(idx)`:

```javascript
  openLightbox(idx) {
    const photos = (this.current?.photos || []);
    if (!photos.length) return;
    MyKidsLightbox.open(photos.map(p => ({ bucket: p.bucket, path: p.path })), idx || 0);
    // surface this photo's comment thread beneath the grid
    this._activePhotoId = photos[idx]?.id || null;
    this._renderPhotoComments();
  },

  _renderPhotoComments() {
    let host = $('#album-photo-comments');
    if (!host) {
      host = document.createElement('div');
      host.id = 'album-photo-comments';
      $('#album-detail').appendChild(host);
    }
    if (!this._activePhotoId) { host.innerHTML = ''; return; }
    const album = this.current.album;
    const list = this.current.comments.filter(c => c.photo_id === this._activePhotoId);
    host.innerHTML = `<div class="album-photo-comments-inner"><h4 class="album-comments-title">Comments on the selected photo</h4>${this.commentsHTML(album, this._activePhotoId, list).replace('<h4 class="album-comments-title">Comments</h4>', '')}</div>`;
    this.wireComments(album);
  },
```

(Note: `wireComments` re-binds all `data-comment-submit` forms including the per-photo one because the photo form's `data-comment-submit` carries the photo id.)

- [ ] **Step 3: Verify comments round-trip** (Task 10 matrix).

- [ ] **Step 4: Commit**

```bash
git add app.js
git commit -m "feat(albums): album + per-photo comments (open to all, owner/admin moderation)"
```

## Task 9: Albums CSS (gallery B, detail, comments)

**Files:**
- Modify: `styles.css` — append an `/* ===== ALBUMS (v4.58) ===== */` block near the Memories styles.

- [ ] **Step 1: Add styles** using existing tokens. Match the mockup the user approved (Layout B). Key rules:

```css
/* ===== ALBUMS (v4.58) ===== */
.albums-gallery { display: block; }
.album-hero {
  position: relative; display: block; width: 100%; aspect-ratio: 16/7;
  border-radius: var(--radius-lg); overflow: hidden; cursor: pointer;
  margin-bottom: var(--space-5); box-shadow: var(--shadow-lift);
}
.album-hero-cover, .album-card-cover {
  position: absolute; inset: 0; background-size: cover; background-position: center;
  background-color: var(--paper-veil); transition: transform .4s var(--ease-out);
}
.album-hero-cover.is-missing, .album-card-cover.is-missing {
  background: linear-gradient(135deg, var(--brand-300), var(--brand-500));
}
.album-hero:hover .album-hero-cover { transform: scale(1.03); }
.album-hero-cap {
  position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: flex-end;
  padding: var(--space-6); color: #fff;
  background: linear-gradient(to top, rgba(23,48,40,.78), transparent 55%);
}
.album-hero-title { font-family: var(--font-display); font-size: 28px; margin: 0; color: #fff; }
.album-hero-meta { margin: 4px 0 0; color: rgba(255,255,255,.85); font-size: 13px; }

.albums-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-4); }
.album-card {
  background: var(--paper-soft); border: 1px solid var(--hairline); border-radius: var(--radius);
  overflow: hidden; cursor: pointer; box-shadow: var(--shadow-soft);
  transition: transform .2s var(--ease-out), box-shadow .2s var(--ease-out);
}
.album-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lift); }
.album-card-cover { position: relative; aspect-ratio: 4/3; }
.album-card-body { padding: var(--space-3) var(--space-4) var(--space-4); }
.album-card-title { font-family: var(--font-display); font-size: 16px; margin: 0; color: var(--brand-900); }
.album-card-meta { margin: 2px 0 0; font-size: 12px; color: var(--ink-400); }

/* detail */
.album-back { margin-bottom: var(--space-3); }
.album-detail-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-5); }
.album-detail-title { font-family: var(--font-display); font-size: 24px; margin: 0; color: var(--brand-900); }
.album-detail-meta { margin: 2px 0 0; color: var(--ink-400); font-size: 13px; }
.album-detail-desc { margin: var(--space-3) 0 0; max-width: 60ch; }
.album-detail-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.album-photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: var(--space-3); }
.album-photo {
  position: relative; aspect-ratio: 1; border-radius: var(--radius-sm); overflow: hidden;
  background-size: cover; background-position: center; background-color: var(--paper-veil); cursor: pointer;
}
.album-photo.is-missing { background: var(--paper-veil); }
.album-photo-x, .album-comment-x {
  position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border: none; border-radius: 50%;
  background: rgba(23,48,40,.6); color: #fff; cursor: pointer; line-height: 1; font-size: 16px;
}
.album-comment-x { position: static; width: 18px; height: 18px; font-size: 13px; background: transparent; color: var(--ink-400); }

/* comments */
.album-comments, .album-photo-comments-inner { margin-top: var(--space-6); border-top: 1px solid var(--hairline); padding-top: var(--space-4); }
.album-comments-title { font-size: 14px; margin: 0 0 var(--space-3); color: var(--brand-700); }
.album-comment-list { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.album-comment-head { display: flex; align-items: center; gap: var(--space-2); }
.album-comment-add { display: flex; gap: var(--space-2); align-items: flex-start; }
.album-comment-add textarea { flex: 1; }
@media (max-width: 640px) {
  .album-hero { aspect-ratio: 16/10; }
  .album-hero-title { font-size: 22px; }
}
```

- [ ] **Step 2: Screenshot the styled gallery + detail; compare to the approved Layout-B mockup; fix spacing/scale mismatches.**

```bash
node screenshot.mjs http://localhost:3000 albums-styled
```

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat(albums): styles — gallery (layout B), detail grid, comments"
```

## Task 10: Phase-1 verification matrix (local)

**Files:** none (verification only). Requires the Phase-1 SQL (Tasks 1–2) applied to a **Supabase clone/branch** and two test accounts (one admin, one non-admin "user").

- [ ] **Step 1: Apply Tasks 1–2 SQL to a Supabase clone** (SQL Editor). Confirm no errors.
- [ ] **Step 2: As a non-admin user** — create an album, add 3 photos, comment on the album, comment on a photo, edit the title, delete a photo. Screenshot each. Expected: all succeed.
- [ ] **Step 3: As a different non-admin** — open the first user's album: can view + comment; **cannot** see Add/Edit/Delete; attempting a write via console (`AlbumsApi.addPhotos(<id>,[…])`) is rejected by RLS. Expected: RLS error logged, no row added.
- [ ] **Step 4: As admin** — can edit/delete any album, remove any photo, delete any comment.
- [ ] **Step 5: Graceful degradation** — point the app at a project **without** the tables; confirm the Albums tab shows the empty state and the rest of the app works (no uncaught errors).
- [ ] **Step 6: Regression** — Family Tree, Recipes, Memories still render; `archive` writes still work for admin.
- [ ] **Step 7: Commit** any fixes found during verification.

---

# PHASE 2 — Open Memories (everyone posts) + data migration

## Task 11: Memories SQL migration (tables + RLS)

**Files:**
- Create: `supabase/migrations/2026-06-22-memories.sql`

- [ ] **Step 1: Write the migration**

```sql
-- =============================================================
-- Family Archive — Memories moved to dedicated tables (open feed)
-- =============================================================
-- Everyone signed in can post/react/comment; authors (or admin) edit/delete
-- their own. Reactions are one row per (memory,user,emoji) so concurrent
-- taps never clobber. Photos/tags stay as JSONB on the memory row (per-post,
-- not concurrently edited). Existing posts are migrated by a separate,
-- non-destructive backfill (see migrations/README + plan Task 15).
-- =============================================================

create table if not exists public.memories (
  id          uuid primary key default gen_random_uuid(),
  author      uuid not null references auth.users(id) on delete set null default auth.uid(),
  date        date not null,
  body        text,
  tags        jsonb not null default '[]'::jsonb,
  photos      jsonb not null default '[]'::jsonb,   -- [{bucket,path}]
  created_at  timestamptz not null default now()
);

create table if not exists public.memory_reactions (
  memory_id   uuid not null references public.memories(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade default auth.uid(),
  emoji       text not null,
  created_at  timestamptz not null default now(),
  primary key (memory_id, user_id, emoji)
);

create table if not exists public.memory_comments (
  id          uuid primary key default gen_random_uuid(),
  memory_id   uuid not null references public.memories(id) on delete cascade,
  author      uuid not null references auth.users(id) on delete set null default auth.uid(),
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists memory_reactions_mem_idx on public.memory_reactions(memory_id);
create index if not exists memory_comments_mem_idx   on public.memory_comments(memory_id);

alter table public.memories         enable row level security;
alter table public.memory_reactions enable row level security;
alter table public.memory_comments  enable row level security;

drop policy if exists "memories read"   on public.memories;
drop policy if exists "memories insert" on public.memories;
drop policy if exists "memories update" on public.memories;
drop policy if exists "memories delete" on public.memories;
create policy "memories read"   on public.memories for select using (auth.role() = 'authenticated');
create policy "memories insert" on public.memories for insert with check (author = auth.uid());
create policy "memories update" on public.memories for update using (author = auth.uid() or public.is_admin()) with check (author = auth.uid() or public.is_admin());
create policy "memories delete" on public.memories for delete using (author = auth.uid() or public.is_admin());

drop policy if exists "memory_reactions read"   on public.memory_reactions;
drop policy if exists "memory_reactions insert" on public.memory_reactions;
drop policy if exists "memory_reactions delete" on public.memory_reactions;
create policy "memory_reactions read"   on public.memory_reactions for select using (auth.role() = 'authenticated');
create policy "memory_reactions insert" on public.memory_reactions for insert with check (user_id = auth.uid());
create policy "memory_reactions delete" on public.memory_reactions for delete using (user_id = auth.uid());

drop policy if exists "memory_comments read"   on public.memory_comments;
drop policy if exists "memory_comments insert" on public.memory_comments;
drop policy if exists "memory_comments delete" on public.memory_comments;
create policy "memory_comments read"   on public.memory_comments for select using (auth.role() = 'authenticated');
create policy "memory_comments insert" on public.memory_comments for insert with check (author = auth.uid());
create policy "memory_comments delete" on public.memory_comments for delete using (author = auth.uid() or public.is_admin());

-- ROLLBACK:
--   drop table if exists public.memory_comments;
--   drop table if exists public.memory_reactions;
--   drop table if exists public.memories;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/migrations/2026-06-22-memories.sql
git commit -m "feat(memories): SQL migration — memories/reactions/comments tables + RLS"
```

## Task 12: Migration transform (pure function) — TDD

**Files:**
- Create: `tools/migrate-memories.mjs` (exports `blobMemoryToRows`)
- Create: `tools/migrate-memories.test.mjs`

The transform converts one blob memory object (shape from [app.js:16113](../../../app.js#L16113): `{id, date, body, photos, tags, createdAt, createdBy, reactions:[{emoji,userId,createdAt}], comments:[{id,body,authorId,authorName,createdAt}]}`) into table-shaped rows. Pure → unit-testable with `node --test`.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/migrate-memories.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobMemoryToRows } from './migrate-memories.mjs';

test('maps core fields + photos/tags to a memory row', () => {
  const { memory } = blobMemoryToRows({
    id: 'mem_1', date: '2025-06-01', body: 'Hi', tags: ['m:abc'],
    photos: [{ bucket: 'family-photos', path: 'memories/x.jpg' }],
    createdAt: 1730000000000, createdBy: 'user-uuid-1',
  }, 'admin-uuid');
  assert.equal(memory.date, '2025-06-01');
  assert.equal(memory.author, 'user-uuid-1');           // prefer original createdBy
  assert.equal(memory.body, 'Hi');
  assert.deepEqual(memory.tags, ['m:abc']);
  assert.equal(memory.photos[0].path, 'memories/x.jpg');
  assert.equal(new Date(memory.created_at).getTime(), 1730000000000);
});

test('falls back to fallbackAuthor when createdBy missing', () => {
  const { memory } = blobMemoryToRows({ id: 'm', date: '2025-01-01' }, 'admin-uuid');
  assert.equal(memory.author, 'admin-uuid');
});

test('dedupes reactions by (user,emoji) and maps comments', () => {
  const { reactions, comments } = blobMemoryToRows({
    id: 'm', date: '2025-01-01',
    reactions: [
      { emoji: '❤️', userId: 'u1', createdAt: 1 },
      { emoji: '❤️', userId: 'u1', createdAt: 2 },   // dup → collapsed
      { emoji: '🎉', userId: 'u2', createdAt: 3 },
    ],
    comments: [{ id: 'c1', body: 'nice', authorId: 'u2', createdAt: 5 }],
  }, 'admin-uuid');
  assert.equal(reactions.length, 2);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, 'nice');
  assert.equal(comments[0].author, 'u2');
});

test('skips reactions/comments with no user/author (cannot satisfy NOT NULL author)', () => {
  const { reactions, comments } = blobMemoryToRows({
    id: 'm', date: '2025-01-01',
    reactions: [{ emoji: '👍', userId: null }],
    comments: [{ id: 'c', body: 'x', authorId: null }],
  }, null);
  assert.equal(reactions.length, 0);
  assert.equal(comments.length, 0);
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `node --test tools/migrate-memories.test.mjs`
Expected: FAIL — `Cannot find module './migrate-memories.mjs'` / `blobMemoryToRows is not a function`.

- [ ] **Step 3: Implement the transform**

```javascript
// tools/migrate-memories.mjs
// Pure transform: one blob memory object -> { memory, reactions, comments }
// rows ready to insert into the memories/* tables. No I/O here.
export function blobMemoryToRows(m, fallbackAuthor) {
  const author = m.createdBy || fallbackAuthor || null;
  const memory = {
    legacy_id: m.id,                                  // kept only to map children; not a column → stripped before insert
    author,
    date: m.date,
    body: m.body || null,
    tags: Array.isArray(m.tags) ? m.tags : [],
    photos: Array.isArray(m.photos) ? m.photos.map(p => ({ bucket: p.bucket, path: p.path })) : [],
    created_at: new Date(m.createdAt || Date.now()).toISOString(),
  };
  const seen = new Set();
  const reactions = [];
  for (const r of (m.reactions || [])) {
    if (!r || !r.emoji || !r.userId) continue;        // author/user is NOT NULL in the table
    const key = `${r.userId}|${r.emoji}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reactions.push({ user_id: r.userId, emoji: r.emoji, created_at: new Date(r.createdAt || Date.now()).toISOString() });
  }
  const comments = (m.comments || [])
    .filter(c => c && c.body && c.authorId)
    .map(c => ({ author: c.authorId, body: c.body, created_at: new Date(c.createdAt || Date.now()).toISOString() }));
  return { memory, reactions, comments };
}
```

- [ ] **Step 4: Run tests; verify pass**

Run: `node --test tools/migrate-memories.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/migrate-memories.mjs tools/migrate-memories.test.mjs
git commit -m "feat(memories): blob→rows migration transform + tests"
```

## Task 13: Memories data-access layer (`MemoriesApi`)

**Files:**
- Modify: `app.js` — add `const MemoriesApi = {...}` next to `AlbumsApi`.

- [ ] **Step 1: Add the API object**

```javascript
// Memories data access — dedicated tables (v4.58). Mirrors AlbumsApi.
const MemoriesApi = {
  _warn(w, e) { if (e) console.warn(`MemoriesApi.${w}:`, e.message); },

  // Returns array of memory objects shaped like the legacy blob objects so
  // MemoriesView renders unchanged: { id, date, body, tags, photos,
  // createdAt, createdBy, reactions:[{emoji,userId,createdAt}], comments:[…] }.
  async list() {
    if (!Backend.client) return [];
    const mem = await Backend.client.from('memories')
      .select('id, author, date, body, tags, photos, created_at')
      .order('date', { ascending: false }).order('created_at', { ascending: false });
    if (mem.error) { this._warn('list', mem.error); return []; }
    const memories = mem.data || [];
    if (!memories.length) return [];
    const ids = memories.map(m => m.id);
    const rx = await Backend.client.from('memory_reactions').select('memory_id, user_id, emoji, created_at').in('memory_id', ids);
    const cm = await Backend.client.from('memory_comments').select('id, memory_id, author, body, created_at').in('memory_id', ids);
    const rxBy = new Map(), cmBy = new Map();
    for (const r of (rx.data || [])) { (rxBy.get(r.memory_id) || rxBy.set(r.memory_id, []).get(r.memory_id)).push(r); }
    for (const c of (cm.data || [])) { (cmBy.get(c.memory_id) || cmBy.set(c.memory_id, []).get(c.memory_id)).push(c); }
    return memories.map(m => ({
      id: m.id, date: m.date, body: m.body || '', tags: m.tags || [], photos: m.photos || [],
      createdAt: new Date(m.created_at).getTime(), createdBy: m.author,
      reactions: (rxBy.get(m.id) || []).map(r => ({ emoji: r.emoji, userId: r.user_id, createdAt: new Date(r.created_at).getTime() })),
      comments: (cmBy.get(m.id) || []).map(c => ({ id: c.id, body: c.body, authorId: c.author, authorName: AuthorNames.nameFor(c.author), createdAt: new Date(c.created_at).getTime() })),
    }));
  },

  async create({ date, body, tags, photos }) {
    const { data, error } = await Backend.client.from('memories')
      .insert({ date, body: body || null, tags: tags || [], photos: photos || [] }).select('id').single();
    if (error) { this._warn('create', error); return { ok: false, reason: error.message }; }
    return { ok: true, id: data.id };
  },
  async update(id, { date, body, tags, photos }) {
    const { error } = await Backend.client.from('memories').update({ date, body: body || null, tags: tags || [], photos: photos || [] }).eq('id', id);
    if (error) { this._warn('update', error); return { ok: false, reason: error.message }; }
    return { ok: true };
  },
  async remove(id) {
    const { error } = await Backend.client.from('memories').delete().eq('id', id);
    if (error) { this._warn('remove', error); return { ok: false, reason: error.message }; }
    return { ok: true };
  },
  async addReaction(memoryId, emoji) {
    const { error } = await Backend.client.from('memory_reactions').insert({ memory_id: memoryId, emoji });
    if (error) { this._warn('addReaction', error); return { ok: false }; }
    return { ok: true };
  },
  async removeReaction(memoryId, emoji) {
    const { error } = await Backend.client.from('memory_reactions').delete()
      .eq('memory_id', memoryId).eq('user_id', Backend.user?.id).eq('emoji', emoji);
    if (error) { this._warn('removeReaction', error); return { ok: false }; }
    return { ok: true };
  },
  async addComment(memoryId, body) {
    const { data, error } = await Backend.client.from('memory_comments').insert({ memory_id: memoryId, body }).select('id, author, body, created_at').single();
    if (error) { this._warn('addComment', error); return { ok: false }; }
    return { ok: true, comment: data };
  },
  async deleteComment(commentId) {
    const { error } = await Backend.client.from('memory_comments').delete().eq('id', commentId);
    if (error) { this._warn('deleteComment', error); return { ok: false }; }
    return { ok: true };
  },
};
```

(Note: the one-liner `Map` accumulate idiom above is terse; in execution, expand to a clear `if (!rxBy.has(id)) rxBy.set(id, []); rxBy.get(id).push(r);` for readability.)

- [ ] **Step 2: Commit**

```bash
git add app.js
git commit -m "feat(memories): MemoriesApi data-access layer over the new tables"
```

## Task 14: Rewrite `MemoriesView`/`MemoryModal` to use the tables + open the feed

**Files:**
- Modify: `app.js` — `MemoriesView` ([app.js:15506](../../../app.js#L15506)) and `MemoryModal` ([app.js:15968](../../../app.js#L15968)).
- Modify: `index.html` — remove `data-admin-only` from the two "new post" buttons ([index.html:684](../../../index.html#L684), [index.html:701](../../../index.html#L701)).

The UI/markup stays; only the data source and permission gates change.

- [ ] **Step 1: Hold memories in a view cache, loaded from the API.** Change `MemoriesView.list()` to read a cache and add an async loader:

```javascript
  _items: [],
  list() { return this._items; },
  async load() { this._items = await MemoriesApi.list(); },
```

Make `render()` call `await this.load()` first (convert `render` to `async`, and the `Views.show` call site already runs it without awaiting — acceptable; add `await this.load();` at the top of `render`).

- [ ] **Step 2: Open the feed — change permission gates.**
  - `canEngage()` → `return !!Backend.user;` (any logged-in user can react/comment).
  - In `postHTML`, change `const actions = Auth.isAdmin() ? …` to show Edit/Delete when the viewer authored the post or is admin:
    ```javascript
    const me = this.currentUserId();
    const canManage = (m.createdBy && me && m.createdBy === me) || Auth.isAdmin();
    const actions = canManage ? `<div class="memory-actions">…</div>` : '';
    ```
  - `MemoryModal.openAdd`/`openEdit`/`save`: replace the `if (!Auth.isAdmin()) return;` guards with `if (!Backend.user) return;` (openAdd) and an owner-or-admin check in `openEdit`/`save` (load the memory, verify `m.createdBy === Backend.user.id || Auth.isAdmin()`).
  - `deletePost`: replace `if (!Auth.isAdmin()) return;` with the owner-or-admin check.

- [ ] **Step 3: Route writes through the API instead of `Store.save()`.**
  - `toggleReaction(memId, emoji)`: after computing add vs remove, call `await MemoriesApi.addReaction/removeReaction(...)`, then `await this.load(); this.render();` (drop the `Store.save()` / in-place `m.reactions` mutation as the source of truth — optionally keep optimistic local update then reconcile).
  - `addComment`/`deleteComment`: call `MemoriesApi.addComment/deleteComment`, then reload + render.
  - `MemoryModal.save`: build `{date, body, tags, photos}` (same as today, [app.js:16113](../../../app.js#L16113)) and call `MemoriesApi.create`/`update`; on success `await MemoriesView.load(); MemoriesView.render();`.
  - `MemoriesView.deletePost`: delete attached storage objects (existing loop), then `await MemoriesApi.remove(id)`, reload + render.
  - Remove all `Store.state.memories` reads/writes in these paths.

- [ ] **Step 4: Remove the admin-only gate in markup.** In `index.html`, delete `data-admin-only` from `#btn-memory-add` and `#btn-memory-add-first`.

- [ ] **Step 5: Verify (manual, Task 16).** Confirm a non-admin can post/react/comment; an author sees Edit/Delete on their own post but not others'; admin sees them on all.

- [ ] **Step 6: Commit**

```bash
git add app.js index.html
git commit -m "feat(memories): open feed to all logged-in users; read/write via tables"
```

## Task 15: One-time data migration (existing posts → tables)

**Files:**
- Create: `tools/seed-memories.mjs` — a Node script run once that reads the current `archive.state.memories` from Supabase and inserts table rows using `blobMemoryToRows`. Mirrors the existing `seed_recipes.mjs` connection pattern.

This must run **after** the Task-14 app deploy is live (so the tables are read), and is **non-destructive** — the blob `memories` array is retained until verification passes.

- [ ] **Step 1: Write the script** (uses the service-role key from env — never commit it; mirror how `seed_recipes.mjs` reads config). Pseudocode contract:
  1. Connect with `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (env).
  2. `select state from archive where id=1`; read `state.memories` (array).
  3. For each, `const {memory, reactions, comments} = blobMemoryToRows(m, ADMIN_UUID)`; strip the `legacy_id` helper field; insert the memory row, capture returned `id`, then insert reactions (`memory_id=id`) and comments (`memory_id=id`).
  4. Log counts; do NOT modify the blob.

```javascript
// tools/seed-memories.mjs — run: node tools/seed-memories.mjs (after deploy)
import { createClient } from '@supabase/supabase-js';
import { blobMemoryToRows } from './migrate-memories.mjs';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_UUID = process.env.ADMIN_UUID;            // fallback author for legacy posts
if (!url || !key || !ADMIN_UUID) { console.error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_UUID'); process.exit(1); }
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: row, error } = await db.from('archive').select('state').eq('id', 1).single();
if (error) { console.error(error); process.exit(1); }
const blobMemories = (row.state.memories || []);
console.log(`Found ${blobMemories.length} memories in the blob.`);
let m = 0, r = 0, c = 0;
for (const bm of blobMemories) {
  const { memory, reactions, comments } = blobMemoryToRows(bm, ADMIN_UUID);
  delete memory.legacy_id;
  const ins = await db.from('memories').insert(memory).select('id').single();
  if (ins.error) { console.warn('memory insert failed:', ins.error.message); continue; }
  m++;
  if (reactions.length) { const x = await db.from('memory_reactions').insert(reactions.map(z => ({ ...z, memory_id: ins.data.id }))); if (!x.error) r += reactions.length; }
  if (comments.length)  { const x = await db.from('memory_comments').insert(comments.map(z => ({ ...z, memory_id: ins.data.id }))); if (!x.error) c += comments.length; }
}
console.log(`Inserted ${m} memories, ${r} reactions, ${c} comments. Blob left untouched.`);
```

- [ ] **Step 2: Dry-run against the Supabase clone**; verify counts match the blob and the feed renders identically.
- [ ] **Step 3: Backup + retire the blob array (after production verification).** In the SQL Editor:
  ```sql
  create table if not exists public.archive_backup_20260622 as select * from public.archive;
  update public.archive set state = state - 'memories', updated_at = now() where id = 1;
  ```
  And remove the now-dead `Store.state.memories` backfill/normalization code paths in a follow-up commit.
- [ ] **Step 4: Commit the script** (not the keys).

```bash
git add tools/seed-memories.mjs
git commit -m "chore(memories): one-time non-destructive blob→tables seed script"
```

## Task 16: Phase-2 verification matrix (local)

**Files:** none. Requires Phase-2 SQL (Task 11) on the clone + the Task-15 seed run.

- [ ] **Step 1:** After seeding, confirm the existing memories render with the same dates/photos/reactions/comments as before.
- [ ] **Step 2:** Non-admin posts a new memory (with photo), reacts, comments → all persist; reload confirms.
- [ ] **Step 3:** Author edits/deletes own post; cannot edit another's; admin can edit/delete any; admin can delete any comment.
- [ ] **Step 4:** Two browsers react to the same post with the same emoji → both counts persist (no clobber); reacting twice toggles your own only.
- [ ] **Step 5:** Graceful degradation if `memories` table absent → empty feed, no crash.
- [ ] **Step 6:** Commit fixes.

---

# Task D: Deploy runbook (GitHub Pages from `main`)

**Ordering is mandatory: backend SQL FIRST, then front-end merge.** Merging to `main` auto-publishes.

- [ ] **D1 — Phase 1 backend (you, in Supabase SQL Editor):** run `2026-06-22-albums.sql` then `2026-06-22-storage-authenticated-upload.sql`. Confirm no errors.
- [ ] **D2 — Phase 1 front-end:** open a PR from `albums-memories-design` → `main`; after your review, merge. Pages publishes. Smoke-test the live Albums tab as a non-admin.
- [ ] **D3 — Phase 2 backend:** run `2026-06-22-memories.sql`.
- [ ] **D4 — Phase 2 front-end:** merge the Phase-2 commits to `main`; Pages publishes (Memories now reads tables — empty until seeded).
- [ ] **D5 — Seed:** run `tools/seed-memories.mjs` with env vars set; verify the feed matches the old one.
- [ ] **D6 — Retire blob memories:** run the backup + `state - 'memories'` strip (Task 15 Step 3) once verified.
- [ ] **D7 — Changelog:** add a History/changelog entry (the app tracks versions, e.g. "v4.58: Albums + open Memories"), per the repo's convention.

**Rollback:** revert the relevant merge commit on `main` (Pages re-publishes the prior version); the SQL ROLLBACK blocks drop the new tables; the blob `memories` array is still intact until D6, and `archive_backup_20260622` after.

---

## Self-Review

- **Spec coverage:** Audience (login-gated, all roles) → Tasks 1/2/11 RLS + Task 4 ungated tab. Memories open feed → Task 14. Albums separate/owned → Tasks 1,5,6,7. Comments (album + photo), no reactions/captions → Task 8 (+ schema Task 1, no reaction/caption columns). Layout B → Tasks 5,9. Detail grid+lightbox → Task 6. Dedicated tables + per-row RLS → Tasks 1,11. Storage authenticated upload → Task 2. Migration non-destructive + backup → Tasks 12,15. Graceful degradation → AlbumsApi/MemoriesApi + Tasks 10/16. Deploy order → Task D. All spec sections mapped.
- **Placeholder scan:** The only intentional deferred stub is `AlbumsView.openAlbum` in Task 5 (explicitly implemented in Task 6) and a noted terse `Map` idiom in Task 13 (expanded in execution) — both flagged, neither left vague. No "TBD/handle errors/etc."
- **Type consistency:** `AlbumsApi.getAlbum` returns `{album, photos, comments}` → consumed by `AlbumsView.openAlbum`/`renderDetail`. `MemoriesApi.list()` returns legacy-shaped objects (`createdBy`, `reactions[].userId`, `comments[].authorId/authorName`) matching what `MemoriesView.postHTML`/`reactionsHTML`/`commentsHTML` already read. `blobMemoryToRows(m, fallbackAuthor)` signature consistent across Task 12 test + Task 15 use. Comment delete predicate consistent with RLS (author OR album owner OR admin).
