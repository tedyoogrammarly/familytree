// =============================================================
// The Family Archive — application logic
// =============================================================

const STORAGE_KEY = 'family-archive-v1';

// -------------------- SUPABASE BACKEND --------------------
// Single source of truth lives in a JSONB blob in the `archive` table on
// Supabase. localStorage is kept as a warm cache so the UI can render
// instantly on boot before the network round-trip resolves.
const Backend = {
  client: null,
  user: null,
  account: null,        // row from member_accounts for the logged-in user
  saveTimer: null,
  saveInFlight: null,
  saveQueued: false,    // v4.32: another save asked to fire while one was in-flight
  lastWriteAt: 0,
  // v4.32: hash of the last *successfully written* state. New saves whose
  // serialized JSON matches this hash are no-ops — we skip the network +
  // Postgres roundtrip entirely. Cuts CPU when a render fires a save but
  // nothing actually changed (e.g. opening the drawer then closing it).
  lastSavedHash: '',
  // Debounce window for archive writes. Bumped 500 → 1500ms in v4.32 so
  // burst-y interactions (typing, dragging, rapid clicks) coalesce into
  // one network call instead of three. Tradeoff is slightly slower
  // cross-device echo; for a family CRUD app that's an easy trade.
  SAVE_DEBOUNCE_MS: 1500,
  subscribed: false,
  onRemoteChange: null, // set by init() once UI is wired

  recoveryPending: false,
  onRecovery: null,        // set by main init() once UI is wired

  init() {
    if (!window.supabase || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
      console.warn('Supabase not configured — falling back to local-only mode.');
      return false;
    }
    this.client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    // Check the URL synchronously: if it carries a recovery token, suppress
    // the auto-enter-app flow at boot. Supabase will parse the hash itself
    // and fire PASSWORD_RECOVERY via onAuthStateChange below.
    if (window.location.hash.includes('type=recovery')) {
      this.recoveryPending = true;
    }
    this.client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        this.recoveryPending = true;
        this.user = session?.user || null;
        if (typeof this.onRecovery === 'function') this.onRecovery();
      }
    });
    return true;
  },

  async sendPasswordReset(email) {
    if (!this.client) return { ok: false, reason: 'Backend unavailable.' };
    const { error } = await this.client.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  },

  // Set another user's password via the admin-reset-password Edge Function.
  // The Edge Function holds service_role (which can't safely live in the
  // browser) and performs the admin.updateUserById call on our behalf after
  // verifying the caller is an admin.
  async adminSetPassword(memberId, newPassword) {
    if (!this.client) return { ok: false, reason: 'Backend unavailable.' };
    const { data: link, error: linkErr } = await this.client
      .from('member_accounts')
      .select('user_id')
      .eq('member_id', memberId)
      .maybeSingle();
    if (linkErr) return { ok: false, reason: linkErr.message };
    if (!link)   return { ok: false, reason: 'This member has no Supabase login linked.' };
    const { data, error } = await this.client.functions.invoke('admin-reset-password', {
      body: { target_user_id: link.user_id, new_password: newPassword },
    });
    if (error) {
      // Supabase's FunctionsHttpError swallows the response body — pull it out
      // so the admin sees a useful message instead of just "non-2xx".
      let detail = error.message || 'Function call failed.';
      try {
        const body = await error.context?.json?.();
        if (body?.error) detail = body.error;
      } catch {}
      return { ok: false, reason: detail };
    }
    if (data?.error) return { ok: false, reason: data.error };
    return { ok: true };
  },

  // Create a Supabase Auth user *and* link them to an in-app member record.
  // Tricky bit: signUp() normally replaces the active session, which would
  // log the admin out. We sidestep that with a second, session-less client
  // — it talks to the same project but throws its tokens away.
  async createMemberAccount({ email, password, memberId, isAdmin = false }) {
    if (!this.client) return { ok: false, reason: 'Backend unavailable.' };
    if (!email)    return { ok: false, reason: 'Email is required.' };
    if (!password) return { ok: false, reason: 'Password is required.' };
    const temp = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await temp.auth.signUp({ email, password });
    if (error) return { ok: false, reason: error.message };
    const userId = data.user?.id;
    if (!userId) return { ok: false, reason: 'Sign-up returned no user.' };
    // If confirmations are on, signUp returns a user but no session.
    const needsConfirmation = !data.session;
    // Map auth user → member. The admin's RLS lets this insert through.
    const { error: linkErr } = await this.client
      .from('member_accounts')
      .insert({ user_id: userId, member_id: memberId, is_admin: isAdmin });
    if (linkErr) return { ok: false, reason: 'User created, but linking failed: ' + linkErr.message };
    return { ok: true, userId, needsConfirmation };
  },

  async session() {
    if (!this.client) return null;
    const { data } = await this.client.auth.getSession();
    return data?.session || null;
  },

  async signUp(email, password) {
    if (!this.client) return { ok: false, reason: 'Backend unavailable.' };
    const { data, error } = await this.client.auth.signUp({ email, password });
    if (error) return { ok: false, reason: error.message };
    // If email confirmation is off, the user is signed in immediately.
    this.user = data.user;
    return { ok: true, user: data.user, session: data.session };
  },

  async signIn(email, password) {
    if (!this.client) return { ok: false, reason: 'Backend unavailable.' };
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) return { ok: false, reason: error.message };
    this.user = data.user;
    return { ok: true, user: data.user, session: data.session };
  },

  async signOut() {
    if (!this.client) return;
    await this.client.auth.signOut();
    this.user = null;
    this.account = null;
  },

  // Promote the very first signed-in user to admin. No-op if any admin exists.
  async claimFirstAdmin() {
    if (!this.client) return null;
    const { error } = await this.client.rpc('claim_first_admin');
    if (error) console.warn('claim_first_admin:', error.message);
    return await this.loadMyAccount();
  },

  // Load member_accounts row for the logged-in user (admin flag + member id).
  async loadMyAccount() {
    if (!this.client || !this.user) return null;
    const { data, error } = await this.client
      .from('member_accounts')
      .select('user_id, member_id, is_admin')
      .eq('user_id', this.user.id)
      .maybeSingle();
    if (error) { console.warn('loadMyAccount:', error.message); return null; }
    this.account = data;
    return data;
  },

  // Fetch the archive row. Returns the JSONB state or null on miss/error.
  async fetchArchive() {
    if (!this.client) return null;
    const { data, error } = await this.client
      .from('archive')
      .select('state, updated_at')
      .eq('id', 1)
      .maybeSingle();
    if (error) { console.warn('fetchArchive:', error.message); return null; }
    return data || null;
  },

  // Push the in-memory state up. Debounced — many Store.save() calls in a
  // single tick coalesce into one network round-trip. If a save is already
  // in flight when the timer fires, we wait for it before pushing the
  // next one so we don't overlap two writes against the same row (which
  // would double the Postgres CPU for the same effective end-state).
  queueSaveArchive(state) {
    if (!this.client) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      // If a write is still pending, let it complete first — then schedule
      // the next save with the freshest state (Store.state by reference).
      if (this.saveInFlight) {
        if (this.saveQueued) return; // already chained
        this.saveQueued = true;
        try { await this.saveInFlight; } catch {}
        this.saveQueued = false;
        // Re-queue with the *current* state, not the (possibly stale)
        // closure capture. Store.state is mutated in place.
        this.queueSaveArchive(typeof Store !== 'undefined' ? Store.state : state);
        return;
      }
      this.flushSaveArchive(state);
    }, this.SAVE_DEBOUNCE_MS);
  },

  async flushSaveArchive(state) {
    if (!this.client) return;
    // No-op skip: serialize once and compare to the last successfully
    // written hash. If unchanged, skip the network call entirely. Common
    // case: code paths that defensively call Store.save() but nothing
    // actually mutated (UI re-renders, idempotent normalization passes).
    let serialized;
    try { serialized = JSON.stringify(state); } catch { serialized = null; }
    if (serialized) {
      const hash = hashStringFast(serialized);
      if (hash === this.lastSavedHash) return; // nothing to write
      this._pendingHash = hash;
    }
    this.saveInFlight = (async () => {
      const now = Date.now();
      const { error } = await this.client
        .from('archive')
        .upsert({ id: 1, state, updated_at: new Date().toISOString(), updated_by: this.user?.id || null });
      if (error) {
        console.warn('saveArchive:', error.message);
        // Surface the failure rather than silently dropping the write — but ONLY
        // for admins. An admin has write RLS, so a failure is a real problem
        // (network/outage) worth flagging. A non-admin's writes are rejected by
        // RLS BY DESIGN today (the app also fires background normalization saves
        // on load), so toasting those would alarm regular family members on every
        // navigation — pure noise, not signal. Re-enable for non-admins once the
        // collaborative-data RLS ships (see supabase/migrations/README).
        // lastSavedHash is left unchanged so the next mutation retries.
        const t = Date.now();
        const isAdmin = typeof Auth !== 'undefined' && Auth.isAdmin && Auth.isAdmin();
        if (isAdmin && typeof toast === 'function' && t - (this._lastSaveErrAt || 0) > 8000) {
          this._lastSaveErrAt = t;
          toast("Couldn't save your changes — check your connection, then try again.", 'error');
        }
      } else {
        this.lastWriteAt = now;
        if (this._pendingHash) this.lastSavedHash = this._pendingHash;
      }
      this._pendingHash = '';
      this.saveInFlight = null;
    })();
    return this.saveInFlight;
  },

  // -------------------------------------------------------------
  // v4.39: Supabase Storage helpers for media-heavy features
  // (Memories Wall, My Kids, Recipes, Voice/Video Stories, Documents).
  // Buckets + RLS are set up by supabase/storage.sql. The archive JSONB
  // only stores `{ bucket, path }` references; uploadMedia returns those
  // and getMediaUrl resolves them to a signed URL on display.
  // -------------------------------------------------------------
  // Upload a File (from <input type=file>) to a named bucket.
  //   opts: { bucket: 'family-photos', folder: 'memories', maxBytes }
  // Returns { ok, bucket, path, contentType, sizeBytes } or { ok: false, reason }.
  async uploadMedia(file, opts = {}) {
    if (!this.client) return { ok: false, reason: 'Backend unavailable.' };
    if (!file)        return { ok: false, reason: 'No file selected.' };
    const bucket = opts.bucket;
    if (!bucket) return { ok: false, reason: 'Missing bucket.' };
    if (opts.maxBytes && file.size > opts.maxBytes) {
      return { ok: false, reason: `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; max allowed is ${(opts.maxBytes / 1024 / 1024).toFixed(0)} MB.` };
    }
    // Object path: `{folder}/{ts}-{random}.{ext}`. The timestamp gives a
    // rough chronology when browsing the bucket in the dashboard; the
    // random suffix prevents accidental collisions on rapid uploads.
    const folder = (opts.folder || 'misc').replace(/[^a-z0-9/_-]/gi, '');
    const dot    = file.name.lastIndexOf('.');
    const extRaw = dot > 0 ? file.name.slice(dot + 1) : '';
    const ext    = (extRaw || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6) || 'bin';
    const rand   = Math.random().toString(36).slice(2, 9);
    const path   = `${folder}/${Date.now()}-${rand}.${ext}`;
    const { data, error } = await this.client.storage
      .from(bucket)
      .upload(path, file, { contentType: file.type || undefined, upsert: false });
    if (error) return { ok: false, reason: error.message };
    return { ok: true, bucket, path: data.path, contentType: file.type || '', sizeBytes: file.size };
  },

  // Resolve a `{ bucket, path }` reference to a signed URL the browser
  // can render. expirySec defaults to 1 hour, which is long enough for a
  // page session — callers should re-resolve when re-entering a page.
  async getMediaUrl(bucket, path, expirySec = 3600) {
    if (!this.client || !bucket || !path) return null;
    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(path, expirySec);
    if (error) return null;
    return data.signedUrl;
  },

  // Delete a media object. Admin-only (enforced by storage RLS). Safe to
  // call from cleanup paths — returns true if deleted or didn't exist.
  async deleteMedia(bucket, path) {
    if (!this.client || !bucket || !path) return false;
    const { error } = await this.client.storage.from(bucket).remove([path]);
    if (error) { console.warn('deleteMedia:', error.message); return false; }
    return true;
  },

  // Realtime: re-hydrate Store.state when another device updates the row.
  // We ignore our own echoes by checking updated_by.
  subscribeArchive() {
    if (!this.client || this.subscribed) return;
    this.subscribed = true;
    this.client
      .channel('archive-changes')
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'archive', filter: 'id=eq.1' },
        (payload) => {
          const row = payload.new;
          if (!row) return;
          if (row.updated_by && row.updated_by === this.user?.id) return; // our own write echoing back
          if (this.onRemoteChange) this.onRemoteChange(row.state);
        }
      )
      .subscribe();
  },
};

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
    if (title !== undefined)          patch.title = title;
    if (description !== undefined)    patch.description = description || null;
    if (event_date !== undefined)     patch.event_date = event_date || null;
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

// -------------------- MEMORIES DATA ACCESS (v4.58) --------------------
// CRUD against the dedicated memories/* tables (open feed). Returns objects
// shaped like the legacy blob so MemoriesView renders unchanged. Degrades
// gracefully (returns []/false) if the tables aren't there yet.
const MemoriesApi = {
  _warn(w, e) { if (e) console.warn(`MemoriesApi.${w}:`, e.message); },

  // Returns array shaped like the legacy blob memory objects:
  // { id, date, body, tags, photos, createdAt, createdBy,
  //   reactions:[{emoji,userId,createdAt}], comments:[{id,body,authorId,authorName,createdAt}] }
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
    for (const r of (rx.data || [])) { if (!rxBy.has(r.memory_id)) rxBy.set(r.memory_id, []); rxBy.get(r.memory_id).push(r); }
    for (const c of (cm.data || [])) { if (!cmBy.has(c.memory_id)) cmBy.set(c.memory_id, []); cmBy.get(c.memory_id).push(c); }
    // v4.65: comment reactions (degrades gracefully if the table isn't there yet).
    const commentIds = (cm.data || []).map(c => c.id);
    const crBy = new Map();
    if (commentIds.length) {
      const cr = await Backend.client.from('memory_comment_reactions').select('comment_id, user_id, emoji').in('comment_id', commentIds);
      if (cr.error) { this._warn('list(comment reactions)', cr.error); }
      for (const r of (cr.data || [])) { if (!crBy.has(r.comment_id)) crBy.set(r.comment_id, []); crBy.get(r.comment_id).push(r); }
    }
    return memories.map(m => ({
      id: m.id, date: m.date, body: m.body || '', tags: m.tags || [], photos: m.photos || [],
      createdAt: new Date(m.created_at).getTime(), createdBy: m.author,
      reactions: (rxBy.get(m.id) || []).map(r => ({ emoji: r.emoji, userId: r.user_id, createdAt: new Date(r.created_at).getTime() })),
      comments: (cmBy.get(m.id) || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(c => ({
          id: c.id, body: c.body, authorId: c.author, authorName: AuthorNames.nameFor(c.author),
          createdAt: new Date(c.created_at).getTime(),
          reactions: (crBy.get(c.id) || []).map(r => ({ emoji: r.emoji, userId: r.user_id })),
        })),
    }));
  },

  async create({ date, body, tags, photos }) {
    if (!Backend.client) return { ok: false, reason: 'Backend unavailable.' };
    const { data, error } = await Backend.client.from('memories')
      .insert({ date, body: body || null, tags: tags || [], photos: photos || [] }).select('id').single();
    if (error) { this._warn('create', error); return { ok: false, reason: error.message }; }
    return { ok: true, id: data.id };
  },
  async update(id, { date, body, tags, photos }) {
    if (!Backend.client) return { ok: false, reason: 'Backend unavailable.' };
    const { error } = await Backend.client.from('memories')
      .update({ date, body: body || null, tags: tags || [], photos: photos || [] }).eq('id', id);
    if (error) { this._warn('update', error); return { ok: false, reason: error.message }; }
    return { ok: true };
  },
  async remove(id) {
    if (!Backend.client) return { ok: false };
    const { error } = await Backend.client.from('memories').delete().eq('id', id);
    if (error) { this._warn('remove', error); return { ok: false, reason: error.message }; }
    return { ok: true };
  },
  async addReaction(memoryId, emoji) {
    if (!Backend.client) return { ok: false };
    const { error } = await Backend.client.from('memory_reactions').insert({ memory_id: memoryId, emoji });
    if (error) { this._warn('addReaction', error); return { ok: false }; }
    return { ok: true };
  },
  async removeReaction(memoryId, emoji) {
    if (!Backend.client) return { ok: false };
    const { error } = await Backend.client.from('memory_reactions').delete()
      .eq('memory_id', memoryId).eq('user_id', Backend.user?.id).eq('emoji', emoji);
    if (error) { this._warn('removeReaction', error); return { ok: false }; }
    return { ok: true };
  },
  async addComment(memoryId, body) {
    if (!Backend.client) return { ok: false };
    const { data, error } = await Backend.client.from('memory_comments')
      .insert({ memory_id: memoryId, body }).select('id, author, body, created_at').single();
    if (error) { this._warn('addComment', error); return { ok: false }; }
    return { ok: true, comment: data };
  },
  async deleteComment(commentId) {
    if (!Backend.client) return { ok: false };
    const { error } = await Backend.client.from('memory_comments').delete().eq('id', commentId);
    if (error) { this._warn('deleteComment', error); return { ok: false }; }
    return { ok: true };
  },
  async addCommentReaction(commentId, emoji) {
    if (!Backend.client) return { ok: false };
    const { error } = await Backend.client.from('memory_comment_reactions').insert({ comment_id: commentId, emoji });
    if (error) { this._warn('addCommentReaction', error); return { ok: false }; }
    return { ok: true };
  },
  async removeCommentReaction(commentId, emoji) {
    if (!Backend.client) return { ok: false };
    const { error } = await Backend.client.from('memory_comment_reactions').delete()
      .eq('comment_id', commentId).eq('user_id', Backend.user?.id).eq('emoji', emoji);
    if (error) { this._warn('removeCommentReaction', error); return { ok: false }; }
    return { ok: true };
  },
};

// -------------------- ethnicities --------------------
// Common ethnicities + ISO 3166 country code → flag emoji (regional indicators).
const ETHNICITIES = [
  ['AM','American','US'], ['MX','Mexican','MX'], ['CA','Canadian','CA'], ['BR','Brazilian','BR'],
  ['AR','Argentine','AR'], ['CL','Chilean','CL'], ['CO','Colombian','CO'], ['PE','Peruvian','PE'],
  ['CU','Cuban','CU'], ['DO','Dominican','DO'], ['PR','Puerto Rican','PR'], ['JM','Jamaican','JM'],
  ['HT','Haitian','HT'],
  ['UK','British','GB'], ['IE','Irish','IE'], ['SC','Scottish','GB-SCT'], ['FR','French','FR'],
  ['DE','German','DE'], ['IT','Italian','IT'], ['ES','Spanish','ES'], ['PT','Portuguese','PT'],
  ['NL','Dutch','NL'], ['BE','Belgian','BE'], ['CH','Swiss','CH'], ['AT','Austrian','AT'],
  ['SE','Swedish','SE'], ['NO','Norwegian','NO'], ['DK','Danish','DK'], ['FI','Finnish','FI'],
  ['IS','Icelandic','IS'],
  ['PL','Polish','PL'], ['CZ','Czech','CZ'], ['SK','Slovak','SK'], ['HU','Hungarian','HU'],
  ['RO','Romanian','RO'], ['BG','Bulgarian','BG'], ['GR','Greek','GR'], ['RU','Russian','RU'],
  ['UA','Ukrainian','UA'], ['RS','Serbian','RS'], ['HR','Croatian','HR'],
  ['CN','Chinese','CN'], ['JP','Japanese','JP'], ['KR','Korean','KR'], ['VN','Vietnamese','VN'],
  ['TH','Thai','TH'], ['PH','Filipino','PH'], ['ID','Indonesian','ID'], ['MY','Malaysian','MY'],
  ['SG','Singaporean','SG'], ['IN','Indian','IN'], ['PK','Pakistani','PK'], ['BD','Bangladeshi','BD'],
  ['LK','Sri Lankan','LK'], ['NP','Nepali','NP'], ['MM','Burmese','MM'], ['KH','Cambodian','KH'],
  ['MN','Mongolian','MN'], ['KZ','Kazakh','KZ'], ['UZ','Uzbek','UZ'],
  ['TR','Turkish','TR'], ['IR','Iranian','IR'], ['IL','Israeli','IL'], ['LB','Lebanese','LB'],
  ['SY','Syrian','SY'], ['JO','Jordanian','JO'], ['SA','Saudi','SA'], ['EG','Egyptian','EG'],
  ['MA','Moroccan','MA'], ['DZ','Algerian','DZ'], ['TN','Tunisian','TN'],
  ['NG','Nigerian','NG'], ['KE','Kenyan','KE'], ['ET','Ethiopian','ET'], ['GH','Ghanaian','GH'],
  ['ZA','South African','ZA'], ['SN','Senegalese','SN'], ['UG','Ugandan','UG'], ['CM','Cameroonian','CM'],
  ['AU','Australian','AU'], ['NZ','New Zealander','NZ'], ['FJ','Fijian','FJ'], ['WS','Samoan','WS'],
];
const ETH_BY_CODE = Object.fromEntries(ETHNICITIES.map(e => [e[0], { code: e[0], name: e[1], iso: e[2] }]));
function flagFor(code) {
  const e = ETH_BY_CODE[code]; if (!e) return '';
  const iso = e.iso;
  if (iso.length !== 2) return ''; // skip subdivisions like GB-SCT (no native emoji)
  return iso.toUpperCase().replace(/./g,
    c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

// Multi-select with chips + popover for picking family members.
// Selected member ids live on the container's dataset.value (comma-separated).
const MemberPicker = {
  mount(container) {
    if (container.dataset.mounted) return;
    container.dataset.mounted = '1';
    container.dataset.value = container.dataset.value || '';
    container.innerHTML = `
      <div class="mp-chips" data-role="chips"></div>
      <button type="button" class="mp-trigger" data-role="trigger">
        <span class="mp-trigger-label">+ Add member…</span>
        <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
      </button>
      <div class="mp-pop" data-role="pop" hidden>
        <input type="search" class="mp-search" data-role="search" placeholder="Search family…" />
        <div class="mp-list" data-role="list"></div>
      </div>
    `;
    const chips   = container.querySelector('[data-role=chips]');
    const trigger = container.querySelector('[data-role=trigger]');
    const pop     = container.querySelector('[data-role=pop]');
    const search  = container.querySelector('[data-role=search]');
    const list    = container.querySelector('[data-role=list]');
    const render = () => {
      const selectedIds = (container.dataset.value || '').split(',').filter(Boolean);
      chips.innerHTML = selectedIds.length
        ? selectedIds.map(id => {
            const m = Store.byId(id);
            if (!m) return '';
            return `<span class="mp-chip" data-id="${id}">
              <div class="mp-chip-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : ''}></div>
              <span>${escape(displayName(m))}</span>
              <button type="button" class="mp-chip-x" data-remove="${id}" aria-label="Remove">
                <svg viewBox="0 0 16 16" width="10" height="10"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
            </span>`;
          }).join('')
        : '<span class="mp-empty">No members selected</span>';
      const q = (search.value || '').toLowerCase();
      const sel = new Set(selectedIds);
      const matches = sortMembers(Store.membersList())
        .filter(m => !q || (`${m.firstName} ${m.middleName || ''} ${m.lastName} ${m.displayName || ''}`).toLowerCase().includes(q));
      list.innerHTML = matches.map(m => `
        <button type="button" class="mp-option ${sel.has(m.id) ? 'is-selected' : ''}" data-toggle="${m.id}">
          <div class="mp-option-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : ''}></div>
          <span>${escape(displayName(m))}</span>
          ${sel.has(m.id) ? '<svg viewBox="0 0 16 16" width="12" height="12" style="margin-left:auto;"><path d="M4 8l3 3 5-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
        </button>`).join('');
    };
    container.__set = (ids) => { container.dataset.value = (ids || []).filter(Boolean).join(','); render(); };
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      if (!pop.hidden) setTimeout(() => search.focus(), 30);
    });
    search.addEventListener('input', render);
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-toggle]'); if (!btn) return;
      const id = btn.dataset.toggle;
      const cur = (container.dataset.value || '').split(',').filter(Boolean);
      const set = new Set(cur);
      set.has(id) ? set.delete(id) : set.add(id);
      container.dataset.value = [...set].join(',');
      // Clear the search field so the next pick can find any member without
      // the previous query still filtering the list.
      if (search) { search.value = ''; setTimeout(() => search.focus(), 0); }
      render();
    });
    chips.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]'); if (!btn) return;
      const id = btn.dataset.remove;
      const cur = (container.dataset.value || '').split(',').filter(Boolean).filter(x => x !== id);
      container.dataset.value = cur.join(',');
      render();
    });
    document.addEventListener('click', (e) => {
      if (pop.hidden) return;
      if (e.target.closest('.member-picker') === container) return;
      pop.hidden = true;
    });
    render();
  },
  read(container) { return (container.dataset.value || '').split(',').filter(Boolean); },
  write(container, ids) {
    if (container.__set) container.__set(ids);
    else { container.dataset.value = (ids || []).join(','); }
  },
};

// Single-select member picker. Same chrome as MemberPicker but holds at most
// one id and closes on pick. Defaults the popover list to a small "shortlist"
// (typically the logged-in user's nuclear family) — typing in the search box
// or clicking "Show all family" expands to the full member list.
//
// Usage:
//   const el = $('#gift-to-member');
//   SingleMemberPicker.mount(el, { shortlist: [m_a, m_b], placeholder: '+ Pick recipient…' });
//   SingleMemberPicker.write(el, 'm_xyz');   // pre-select
//   SingleMemberPicker.read(el);             // returns 'm_xyz' or ''
const SingleMemberPicker = {
  mount(container, cfg = {}) {
    container.dataset.mounted = '1';
    container.dataset.value = container.dataset.value || '';
    const shortlist = Array.isArray(cfg.shortlist) ? cfg.shortlist.filter(Boolean) : [];
    container.__cfg = {
      shortlist,
      placeholder: cfg.placeholder || '+ Pick member…',
      expanded: shortlist.length === 0, // no shortlist → straight to full list
    };
    container.innerHTML = `
      <button type="button" class="mp-trigger" data-role="trigger">
        <span class="mp-trigger-label" data-role="label"></span>
        <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
      </button>
      <div class="mp-pop" data-role="pop" hidden>
        <input type="search" class="mp-search" data-role="search" placeholder="Search family…" />
        <div class="mp-list" data-role="list"></div>
        <button type="button" class="mp-show-all" data-role="showall" hidden>Show all family members</button>
      </div>
    `;
    const trigger = container.querySelector('[data-role=trigger]');
    const label   = container.querySelector('[data-role=label]');
    const pop     = container.querySelector('[data-role=pop]');
    const search  = container.querySelector('[data-role=search]');
    const list    = container.querySelector('[data-role=list]');
    const showAll = container.querySelector('[data-role=showall]');

    const render = () => {
      const id = container.dataset.value || '';
      const picked = id ? Store.byId(id) : null;
      label.textContent = picked ? displayName(picked) : container.__cfg.placeholder;
      const q = (search.value || '').toLowerCase().trim();
      const cfg = container.__cfg;
      // Search input always searches the full list. When idle (no query),
      // show the shortlist unless the user explicitly clicked "Show all".
      const useShortlist = !q && cfg.shortlist.length && !cfg.expanded;
      let source = useShortlist
        ? cfg.shortlist.map(mid => Store.byId(mid)).filter(Boolean)
        : sortMembers(Store.membersList());
      const matches = source.filter(m =>
        !q || (`${m.firstName} ${m.middleName || ''} ${m.lastName} ${m.displayName || ''}`).toLowerCase().includes(q)
      );
      list.innerHTML = matches.length
        ? matches.map(m => `
          <button type="button" class="mp-option ${m.id === id ? 'is-selected' : ''}" data-pick="${m.id}">
            <div class="mp-option-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : ''}></div>
            <span>${escape(displayName(m))}</span>
            ${m.id === id ? '<svg viewBox="0 0 16 16" width="12" height="12" style="margin-left:auto;"><path d="M4 8l3 3 5-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
          </button>`).join('')
        : '<div class="mp-empty" style="padding:10px 12px;">No matches.</div>';
      // "Show all" only matters when a shortlist is active AND we're currently
      // showing only the shortlist (no query, not yet expanded).
      showAll.hidden = !useShortlist;
    };

    container.__set = (id) => { container.dataset.value = id || ''; render(); };
    container.__reset = () => {
      container.dataset.value = '';
      container.__cfg.expanded = container.__cfg.shortlist.length === 0;
      search.value = '';
      render();
    };

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      if (!pop.hidden) setTimeout(() => search.focus(), 30);
    });
    search.addEventListener('input', render);
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pick]'); if (!btn) return;
      container.dataset.value = btn.dataset.pick;
      pop.hidden = true;
      search.value = '';
      render();
    });
    showAll.addEventListener('click', () => {
      container.__cfg.expanded = true;
      search.focus();
      render();
    });
    document.addEventListener('click', (e) => {
      if (pop.hidden) return;
      if (e.target.closest('.member-picker') === container) return;
      pop.hidden = true;
    });
    render();
  },
  read(container) { return container.dataset.value || ''; },
  write(container, id) {
    if (container.__set) container.__set(id);
    else { container.dataset.value = id || ''; }
  },
};

// Multi-select with chips + searchable popover. Selected codes live on the
// container's `dataset.value` (comma-separated) so forms can read them out.
const EthnicityPicker = {
  mount(container) {
    if (container.dataset.mounted) return;
    container.dataset.mounted = '1';
    container.dataset.value = container.dataset.value || '';
    container.innerHTML = `
      <div class="eth-chips" data-role="chips"></div>
      <button type="button" class="eth-trigger" data-role="trigger">
        <span class="eth-trigger-label">Add ethnicity…</span>
        <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>
      </button>
      <div class="eth-pop" data-role="pop" hidden>
        <input type="search" class="eth-search" data-role="search" placeholder="Search ethnicities…" />
        <div class="eth-list" data-role="list"></div>
      </div>
    `;
    const chips   = container.querySelector('[data-role=chips]');
    const trigger = container.querySelector('[data-role=trigger]');
    const pop     = container.querySelector('[data-role=pop]');
    const search  = container.querySelector('[data-role=search]');
    const list    = container.querySelector('[data-role=list]');

    const render = () => {
      const selected = (container.dataset.value || '').split(',').filter(Boolean);
      chips.innerHTML = selected.length
        ? selected.map(code => {
            const e = ETH_BY_CODE[code];
            return `<span class="eth-chip" data-code="${code}">
              <span class="eth-flag">${escape(flagFor(code) || '🏳️')}</span>
              <span>${escape(e?.name || code)}</span>
              <button type="button" class="eth-chip-x" data-remove="${code}" aria-label="Remove">
                <svg viewBox="0 0 16 16" width="10" height="10"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
            </span>`;
          }).join('')
        : '<span class="eth-empty">No ethnicities selected</span>';

      const q = (search.value || '').toLowerCase();
      const sel = new Set(selected);
      const matches = ETHNICITIES
        .filter(([code, name]) => !q || name.toLowerCase().includes(q))
        .sort((a, b) => a[1].localeCompare(b[1]));
      list.innerHTML = matches.map(([code, name]) => `
        <button type="button" class="eth-option ${sel.has(code) ? 'is-selected' : ''}" data-toggle="${code}">
          <span class="eth-flag">${escape(flagFor(code) || '🏳️')}</span>
          <span>${escape(name)}</span>
          ${sel.has(code) ? '<svg class="eth-check" viewBox="0 0 16 16" width="12" height="12"><path d="M4 8l3 3 5-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
        </button>
      `).join('');
    };

    const setSelected = (codes) => {
      container.dataset.value = (codes || []).filter(Boolean).join(',');
      render();
    };
    container.__set = setSelected;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !pop.hidden;
      pop.hidden = open;
      if (!open) setTimeout(() => search.focus(), 30);
    });
    search.addEventListener('input', render);
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-toggle]'); if (!btn) return;
      e.preventDefault();
      const code = btn.dataset.toggle;
      const cur = (container.dataset.value || '').split(',').filter(Boolean);
      const set = new Set(cur);
      set.has(code) ? set.delete(code) : set.add(code);
      container.dataset.value = [...set].join(',');
      // v4.37: clear the search box after a pick so the next ethnicity
      // search starts fresh. Previously you had to manually backspace out
      // the previous query before searching again, which got tedious when
      // tagging a multi-ethnic person.
      if (search) { search.value = ''; setTimeout(() => search.focus(), 0); }
      render();
    });
    chips.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]'); if (!btn) return;
      const code = btn.dataset.remove;
      const cur = (container.dataset.value || '').split(',').filter(Boolean).filter(c => c !== code);
      container.dataset.value = cur.join(',');
      render();
    });
    document.addEventListener('click', (e) => {
      if (pop.hidden) return;
      if (e.target.closest('.ethnicity-picker') === container) return;
      pop.hidden = true;
    });

    render();
  },
  read(container) {
    return (container.dataset.value || '').split(',').filter(Boolean);
  },
  write(container, codes) {
    if (container.__set) container.__set(codes);
    else { container.dataset.value = (codes || []).join(','); }
  },
};

// -------------------- silhouettes (SVG) --------------------
// Adult / child / baby differ in head-to-body ratio + identifying features:
//   adult — narrow head, wide trapezoidal shoulders, females have long hair past shoulders
//   child — bigger head:body ratio, smaller body; females have pigtails, males spiky hair
//   baby  — head dominates the card, soft bonnet over the crown, tiny swaddled body
const Silhouettes = {
  palette(gender) {
    return gender === 'male'
      ? { fg: '#5b8fc7', fgDark: '#3d6f9f', fgSoft: '#9bbde0', bg: '#e3edf8' }
      : { fg: '#d27aa1', fgDark: '#a55676', fgSoft: '#e6a9c1', bg: '#fbe3ec' };
  },
  adult(gender) {
    const c = this.palette(gender);
    if (gender === 'female') {
      // Business suit: long hair, blazer with notched lapels, blouse V, pearl
      return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
        <rect width="100" height="100" fill="${c.bg}"/>
        <!-- long hair flowing past the shoulders -->
        <path d="M28 36 Q28 18 50 18 Q72 18 72 36 L72 78 Q60 82 50 82 Q40 82 28 78 Z" fill="${c.fgDark}"/>
        <!-- face -->
        <circle cx="50" cy="34" r="12" fill="${c.fg}"/>
        <!-- neck -->
        <rect x="46" y="42" width="8" height="6" fill="${c.fg}"/>
        <!-- blazer: slim, structured trapezoid in the darker tone -->
        <path d="M20 100 L30 60 Q50 56 70 60 L80 100 Z" fill="${c.fgDark}"/>
        <!-- blouse V (light bg) -->
        <path d="M42 60 L50 76 L58 60 Z" fill="${c.bg}"/>
        <!-- collar / lapel hint -->
        <path d="M30 60 L42 60 L50 76 Z" fill="${c.fg}" opacity=".55"/>
        <path d="M70 60 L58 60 L50 76 Z" fill="${c.fg}" opacity=".55"/>
        <!-- pearl pendant -->
        <circle cx="50" cy="64" r="1.8" fill="#ffffff"/>
        <!-- inner buttons -->
        <circle cx="50" cy="84" r="1.2" fill="${c.fg}" opacity=".7"/>
        <circle cx="50" cy="92" r="1.2" fill="${c.fg}" opacity=".7"/>
      </svg>`;
    }
    // Male business suit: short hair, suit jacket, white shirt V, tie
    return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
      <rect width="100" height="100" fill="${c.bg}"/>
      <!-- short layered hair -->
      <path d="M36 32 Q36 20 50 20 Q64 20 64 32 Q60 28 50 28 Q40 28 36 32 Z" fill="${c.fgDark}"/>
      <!-- face -->
      <circle cx="50" cy="34" r="12" fill="${c.fg}"/>
      <!-- neck -->
      <rect x="46" y="42" width="8" height="6" fill="${c.fg}"/>
      <!-- suit jacket: dark trapezoid -->
      <path d="M14 100 L26 58 L74 58 L86 100 Z" fill="${c.fgDark}"/>
      <!-- white dress shirt V -->
      <path d="M40 58 L50 76 L60 58 Z" fill="#ffffff"/>
      <!-- jacket lapels -->
      <path d="M26 58 L40 58 L50 76 Z" fill="${c.fg}" opacity=".55"/>
      <path d="M74 58 L60 58 L50 76 Z" fill="${c.fg}" opacity=".55"/>
      <!-- tie knot + tie body -->
      <path d="M47 60 L53 60 L52 66 L48 66 Z" fill="#1f3a2e"/>
      <path d="M48 66 L52 66 L54 92 L46 92 Z" fill="#2f6b59"/>
      <!-- pocket square -->
      <rect x="33" y="80" width="6" height="3" fill="#ffffff" opacity=".75"/>
    </svg>`;
  },
  child(gender) {
    const c = this.palette(gender);
    if (gender === 'female') {
      return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
        <rect width="100" height="100" fill="${c.bg}"/>
        <!-- pigtails -->
        <circle cx="29" cy="44" r="7" fill="${c.fgDark}"/>
        <circle cx="71" cy="44" r="7" fill="${c.fgDark}"/>
        <!-- bow accents -->
        <circle cx="29" cy="44" r="2.5" fill="${c.fgSoft}"/>
        <circle cx="71" cy="44" r="2.5" fill="${c.fgSoft}"/>
        <!-- bigger head -->
        <circle cx="50" cy="42" r="15" fill="${c.fg}"/>
        <!-- bangs -->
        <path d="M37 36 Q50 30 63 36 Q63 30 50 28 Q37 30 37 36 Z" fill="${c.fgDark}"/>
        <!-- small body -->
        <path d="M30 100 L36 72 Q50 68 64 72 L70 100 Z" fill="${c.fg}"/>
      </svg>`;
    }
    return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
      <rect width="100" height="100" fill="${c.bg}"/>
      <!-- spiky hair tufts on top -->
      <path d="M36 32 L40 22 L44 32 L48 22 L52 32 L56 22 L60 32 L64 22 Q60 30 50 30 Q40 30 36 32 Z" fill="${c.fgDark}"/>
      <!-- bigger head -->
      <circle cx="50" cy="42" r="15" fill="${c.fg}"/>
      <!-- small body -->
      <path d="M28 100 L34 70 Q50 65 66 70 L72 100 Z" fill="${c.fg}"/>
    </svg>`;
  },
  baby(gender) {
    const c = this.palette(gender);
    return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
      <rect width="100" height="100" fill="${c.bg}"/>
      <!-- soft bonnet/cap covering the crown -->
      <path d="M22 50 Q22 22 50 22 Q78 22 78 50 Q78 30 50 30 Q22 30 22 50 Z" fill="${c.fgDark}"/>
      <path d="M20 52 Q20 18 50 18 Q80 18 80 52 L 76 52 Q76 26 50 26 Q24 26 24 52 Z" fill="${c.fgDark}" opacity=".55"/>
      <!-- giant round head — dominates the card -->
      <circle cx="50" cy="50" r="24" fill="${c.fg}"/>
      <!-- rosy cheek dots -->
      <circle cx="36" cy="56" r="2.4" fill="${c.fgSoft}" opacity=".7"/>
      <circle cx="64" cy="56" r="2.4" fill="${c.fgSoft}" opacity=".7"/>
      <!-- pacifier hint -->
      <ellipse cx="50" cy="63" rx="5" ry="2.2" fill="${c.fgDark}" opacity=".4"/>
      <!-- tiny swaddled body -->
      <path d="M34 100 L40 84 Q50 81 60 84 L66 100 Z" fill="${c.fg}"/>
    </svg>`;
  },
  for(member) {
    const fn = this[member.ageGroup] || this.adult;
    return fn.call(this, member.gender || 'female');
  }
};

// -------------------- store --------------------
const Store = {
  state: null,
  defaults() {
    return {
      members: {},
      groups: [],
      currentUserId: null,
      adminBootstrapped: true,
      bootstrapAdminPassword: 'admin',
      bootstrapAdminMustChange: true,
      view: { scale: 1, tx: 0, ty: 0 },
      orientation: 'vertical',
      // Tree layout flags:
      //   manualLayout — user has taken manual control of card positions.
      //     When true, autoLayout() is a no-op so adding/removing members
      //     never reshuffles the user's hand-placed cards.
      //   editLayout — cards are currently draggable. UI toggle in tree
      //     toolbar (admin only). Setting editLayout true also forces
      //     manualLayout true so positions are preserved on save.
      manualLayout: false,
      editLayout: false,
      theme: { baseHue: 205 },
      events: [],
      gifts: [],
      reminders: [],
      grocery: [],
      pageEmojis: {},     // { dashboard, tree, myfamily, calendar, events, gifts, admin } → emoji string
      googleCalendar: {
        clientId: '',
        accessToken: '',
        tokenExpiresAt: 0,
        userEmail: '',
        calendars: [],     // [{ id, summary, backgroundColor, primary, enabled }]
        lastSync: 0,
        showEvents: true,
      },
      // Private/Admin-only data. The whole vault page (Family ID fields,
      // Finance, Benefits, Home) reads + writes here. Each member's per-person
      // private fields live under member.private; the household-shared
      // sections live here.
      vault: {
        banks: [],        // [{ id, bankName, nickname, accountNumber, routingNumber, accountType,
                          //   holderIds[], balanceHistory[{id,date,amount,notes}], notes }]
        insurances: [],   // [{ id, kind, insurer, memberId, policyNumber, planNumber, groupNumber,
                          //   naicNumber, effectiveDate, expirationDate, phone,
                          //   frontPhoto, backPhoto, notes }]
        utilities: [],    // [{ id, emoji, name, website, phone, accountNumber, notes }]
        hoas: [],         // [{ id, propertyLabel, name, contact, title, address, phone, fax, website, email, notes }]
        codeSets: [],     // [{ id, propertyLabel, pedestrianGate, carGate, pool, clubhouse, buildings[], notes }]
        neighbors: [],    // [{ id, name, address, phone, kidsNote, photo, notes }]
      },
      vaultAccessIds: [], // optional extra member ids granted vault access
      // v4.31: Friend Tree. Separate dataset from `members` (which is the
      // family graph). Each friend record has the same shape as a member
      // but without parent/child/spouse linking. Stored keyed by id so
      // lookups stay O(1). Friend Tree view reads from here exclusively;
      // Family Tree never touches it.
      friends: {},
      // v4.40: per-kid timeline dataset. Keyed by member id. Each kid has
      // four parallel arrays — milestones, school, art, letters — each
      // entry referencing photos by { bucket, path } pointers into
      // Supabase Storage (not inline base64) so the archive row stays
      // small. The kid roster auto-derives from members whose age < 18
      // (computed at render time) — no per-kid flag in this map.
      myKids: {},
      // v4.42: manual override for the My Kids roster. When this list is
      // non-empty it replaces the auto-walk-from-parentIds logic — admins
      // pick exactly which family members appear on My Kids. Empty list =
      // fall back to the parent-link auto-walk.
      myKidsRoster: [],
      // v4.44: Family Recipes. Admin-only CRUD; everyone authenticated
      // can view. Each recipe carries a single optional "from" reference
      // (member id or friend household person ref like 'f:fid' / 's:fid'
      // / 'k:fid:kid_id'), plus a free-text fallback for non-people
      // attribution ("from a Korean cookbook").
      recipes: [],
      // v4.45: Memories Wall. Admin-only CRUD; everyone authenticated
      // views. Each post: date + rich-text body + up to 6 photos
      // (bucket+path refs into Storage) + multi-tag list of people refs
      // (m:/f:/s:/k:). Reverse-chrono feed.
      memories: [],
      // v4.47: Time Capsule. Admin-only authorship. Each capsule is
      // addressed to a recipient (m:/f:/s:/k: ref) and sealed until
      // unlockDate. Admin can force-reveal early (admin override policy).
      // Recipient sees a sealed-envelope card for locked capsules
      // addressed to them; the body is hidden until unlock or override.
      timeCapsules: [],
      // v4.48: Voice / Video Stories. Admin-only authorship; everyone
      // authenticated views. Each story has a `kind` (audio | video) and
      // a `source` (upload | embed). Upload-source stories carry a
      // { bucket, path, mimeType } media ref into the family-audio /
      // family-video Storage buckets. Embed-source stories carry a raw
      // URL plus a detected `embedKind` (youtube | vimeo | generic).
      // Optional tag list of people (m:/f:/s:/k:) so a story can be
      // surfaced on Family Tree cards later.
      stories: [],
      // v4.49: Documents drawer. Admin-only CRUD; admin-only view (the
      // family-documents Storage bucket is admin-only-end-to-end). Each
      // document is tagged to one member (memberId) or left null for
      // household-level docs (deed, marriage cert). Free-text category
      // with auto-suggest from previously used values.
      documents: [],
    };
  },
  // Sync load: pull a snapshot from localStorage so the UI can render
  // immediately. The backend hydrate happens after login (async).
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.state = raw ? JSON.parse(raw) : null;
    } catch { this.state = null; }
    if (!this.state) { this.bootstrap(); return; }
    this.healMissingKeys();
  },
  // Replace state wholesale (used when hydrating from Supabase or on realtime).
  // Keeps the localStorage cache in sync but skips the remote upsert to avoid
  // an echo loop.
  hydrate(state) {
    this.state = state || this.defaults();
    this.healMissingKeys();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch {}
  },
  healMissingKeys() {
    const def = this.defaults();
    for (const k of Object.keys(def)) {
      if (this.state[k] === undefined) this.state[k] = def[k];
    }
    // Per-member migrations:
    //   1. Ensure exSpouseIds[] exists on every member (new in multi-spouse model).
    //   2. Migrate legacy "divorced flag on a current spouse" pairs into the
    //      exSpouseIds model: move spouseId → exSpouseIds on both sides and
    //      clear the divorced flag. Idempotent — re-running is safe.
    const members = this.state.members || {};
    for (const m of Object.values(members)) {
      // v4.33: drop legacy auth fields. Supabase Auth owns credentials now;
      // these were dead weight on every member record (passwordHash alone
      // is 64 chars × N members). Free space reclamation.
      if ('passwordHash'        in m) delete m.passwordHash;
      if ('mustChangePassword'  in m) delete m.mustChangePassword;
      if (!Array.isArray(m.exSpouseIds)) m.exSpouseIds = [];
      if (m.dateOfDeath === undefined) m.dateOfDeath = '';
      if (m.plan529      === undefined) m.plan529 = '';
      if (m.notes        === undefined) m.notes = '';
      // v4.20: nickname → displayName rename. Carry any legacy nickname
      // forward as the new displayName so existing tags don't vanish on
      // first load. The display helper falls back to fullName(m) when
      // displayName is empty.
      if (m.displayName === undefined) m.displayName = (m.nickname || '').trim();
      if (m.nickname !== undefined) delete m.nickname;
      // v4.29: optional International name — e.g. a Korean or Vietnamese
      // rendering of the same person. Rendered under the main displayName
      // on the tree card and inside the drawer. Empty by default for back-
      // compat.
      if (m.internationalName === undefined) m.internationalName = '';
      // v4.20: groups-add-to-events opt-out. Default true so existing
      // members keep their current behavior — they still get added when
      // an admin picks "+ Add by group…" on an event.
      if (m.includeInGroupEvents === undefined) m.includeInGroupEvents = true;
      // v4.36: hard hide from the "+ Add member" picker on events. Distinct
      // from includeInGroupEvents — that one only opts out of bulk group
      // invites. This one hides the person from the picker entirely so the
      // dropdown stays scannable when there are many low-event-attending
      // people in the archive. Default false (everyone visible) so the
      // change is opt-in.
      if (m.excludeFromEventsList === undefined) m.excludeFromEventsList = false;
      // v4.22: per-member private fields for the Admin/vault page. Only
      // populated for the household's nuclear-family members, but every
      // member gets the empty container so save handlers can assign without
      // null-checks.
      if (!m.private || typeof m.private !== 'object') {
        m.private = {
          driversLicenses: [], // [{ id, state, number }]
          passport: '',
          ktn: '',
          rapidRewards: '',
          instagram: '',
          googleDrive: '',
          birth: { place: '', hospital: '', weightLbs: '', weightOz: '', lengthIn: '', time: '', notes: '' },
          // v4.49: Health & Legacy locker per member. Allergies +
          // medications are free-text textareas; bloodType is a fixed
          // set; emergency contact + primary doctor are tiny structs.
          health: {
            allergies: '',
            medications: '',
            bloodType: '',
            emergencyContact: { name: '', phone: '', relationship: '' },
            primaryDoctor: { name: '', practice: '', phone: '' },
          },
        };
      } else {
        if (!Array.isArray(m.private.driversLicenses)) m.private.driversLicenses = [];
        if (typeof m.private.birth !== 'object' || m.private.birth === null) {
          m.private.birth = { place: '', hospital: '', weightLbs: '', weightOz: '', lengthIn: '', time: '', notes: '' };
        }
        ['passport', 'ktn', 'rapidRewards', 'instagram', 'googleDrive'].forEach(k => {
          if (m.private[k] === undefined) m.private[k] = '';
        });
        ['place', 'hospital', 'time', 'notes'].forEach(k => {
          if (m.private.birth[k] === undefined) m.private.birth[k] = '';
        });
        // v4.49: Health & Legacy locker backfill. Older archives won't
        // have it; default each sub-shape so render code can assume
        // the object exists.
        if (typeof m.private.health !== 'object' || m.private.health === null) {
          m.private.health = { allergies: '', medications: '', bloodType: '',
            emergencyContact: { name: '', phone: '', relationship: '' },
            primaryDoctor:    { name: '', practice: '', phone: '' } };
        } else {
          ['allergies','medications','bloodType'].forEach(k => {
            if (m.private.health[k] === undefined) m.private.health[k] = '';
          });
          if (typeof m.private.health.emergencyContact !== 'object' || m.private.health.emergencyContact === null) {
            m.private.health.emergencyContact = { name: '', phone: '', relationship: '' };
          }
          ['name','phone','relationship'].forEach(k => {
            if (m.private.health.emergencyContact[k] === undefined) m.private.health.emergencyContact[k] = '';
          });
          if (typeof m.private.health.primaryDoctor !== 'object' || m.private.health.primaryDoctor === null) {
            m.private.health.primaryDoctor = { name: '', practice: '', phone: '' };
          }
          ['name','practice','phone'].forEach(k => {
            if (m.private.health.primaryDoctor[k] === undefined) m.private.health.primaryDoctor[k] = '';
          });
        }
        // v4.23: weight/length structure. Parse legacy free-text "7 lbs 4 oz"
        // / "20.5 in" strings into structured fields once; drop the originals.
        const b = m.private.birth;
        if (b.weightLbs === undefined) b.weightLbs = '';
        if (b.weightOz  === undefined) b.weightOz  = '';
        if (b.lengthIn  === undefined) b.lengthIn  = '';
        if (b.weight && !b.weightLbs && !b.weightOz) {
          const lbsM = /(\d+(?:\.\d+)?)\s*lb/i.exec(b.weight);
          const ozM  = /(\d+(?:\.\d+)?)\s*oz/i.exec(b.weight);
          if (lbsM) b.weightLbs = lbsM[1];
          if (ozM)  b.weightOz  = ozM[1];
        }
        if (b.length && !b.lengthIn) {
          const inM = /(\d+(?:\.\d+)?)\s*(?:in|inches?|")/i.exec(b.length);
          if (inM) b.lengthIn = inM[1];
        }
        delete b.weight;
        delete b.length;
      }
    }
    // v4.22+v4.23: heal the vault sub-state — defaults() already returns a vault
    // object, but existing archives won't have it. v4.23 also migrates the
    // singletons (vault.hoa, vault.codes) into lists (vault.hoas[], vault.codeSets[]).
    if (!this.state.vault || typeof this.state.vault !== 'object') {
      this.state.vault = JSON.parse(JSON.stringify(def.vault));
    } else {
      const v = this.state.vault;
      if (!Array.isArray(v.banks)) v.banks = [];
      if (!Array.isArray(v.insurances)) v.insurances = [];
      if (!Array.isArray(v.utilities)) v.utilities = [];

      // v4.23: banks — single holderId → holderIds[]; new nickname, balanceHistory.
      v.banks.forEach(b => {
        if (!Array.isArray(b.holderIds)) {
          b.holderIds = b.holderId ? [b.holderId] : [];
        }
        delete b.holderId;
        if (b.nickname === undefined) b.nickname = '';
        if (!Array.isArray(b.balanceHistory)) b.balanceHistory = [];
        if (b.notes === undefined) b.notes = '';
      });

      // v4.23: insurances — new fields (plan, NAIC, dates).
      // v4.25: per-card emoji prefix (overrides the kind-based default icon).
      v.insurances.forEach(i => {
        ['planNumber', 'naicNumber', 'effectiveDate', 'expirationDate'].forEach(k => {
          if (i[k] === undefined) i[k] = '';
        });
        if (i.emoji === undefined) i.emoji = '';
      });

      // v4.23: utilities — new emoji prefix.
      v.utilities.forEach(u => {
        if (u.emoji === undefined) u.emoji = '';
      });

      // v4.23: HOAs/codes: singletons → lists. If the old single record had
      // any value at all, lift it into the new list under a "Primary"
      // propertyLabel so the data isn't lost on first load.
      if (!Array.isArray(v.hoas)) v.hoas = [];
      if (v.hoa && typeof v.hoa === 'object') {
        const hasAny = Object.values(v.hoa).some(x => Array.isArray(x) ? x.length : !!x);
        if (hasAny) {
          v.hoas.push({
            id: uid('hoa'),
            propertyLabel: 'Primary',
            name: v.hoa.name || '', contact: v.hoa.contact || '',
            title: v.hoa.title || '', address: v.hoa.address || '',
            phone: v.hoa.phone || '', fax: v.hoa.fax || '',
            website: v.hoa.website || '', email: v.hoa.email || '',
            notes: v.hoa.notes || '',
          });
        }
        delete v.hoa;
      }
      v.hoas.forEach(h => {
        if (!h.id) h.id = uid('hoa');
        if (h.propertyLabel === undefined) h.propertyLabel = '';
      });

      if (!Array.isArray(v.codeSets)) v.codeSets = [];
      if (v.codes && typeof v.codes === 'object') {
        const hasAny = ['pedestrianGate', 'carGate', 'pool', 'clubhouse', 'notes']
          .some(k => !!v.codes[k]) || (Array.isArray(v.codes.buildings) && v.codes.buildings.length);
        if (hasAny) {
          v.codeSets.push({
            id: uid('cs'),
            propertyLabel: 'Primary',
            pedestrianGate: v.codes.pedestrianGate || '',
            carGate: v.codes.carGate || '',
            pool: v.codes.pool || '',
            clubhouse: v.codes.clubhouse || '',
            buildings: Array.isArray(v.codes.buildings) ? v.codes.buildings.slice() : [],
            notes: v.codes.notes || '',
          });
        }
        delete v.codes;
      }
      v.codeSets.forEach(cs => {
        if (!cs.id) cs.id = uid('cs');
        if (cs.propertyLabel === undefined) cs.propertyLabel = '';
        if (!Array.isArray(cs.buildings)) cs.buildings = [];
      });

      // v4.25: neighbors list. Lightweight people-rolodex for the household
      // (name, address, phone, kidsNote, photo, notes). Backfilled here so
      // older archives don't crash on Store.state.vault.neighbors access.
      if (!Array.isArray(v.neighbors)) v.neighbors = [];
      v.neighbors.forEach(n => {
        if (!n.id) n.id = uid('nbr');
        ['name', 'address', 'phone', 'kidsNote', 'photo', 'notes'].forEach(k => {
          if (n[k] === undefined) n[k] = '';
        });
      });
    }
    if (!Array.isArray(this.state.vaultAccessIds)) this.state.vaultAccessIds = [];

    // v4.40: My Kids per-kid timeline. Defensive backfill. Each kid record
    // must have four arrays so render code can assume the shape.
    if (!this.state.myKids || typeof this.state.myKids !== 'object') {
      this.state.myKids = {};
    }
    // v4.42: manual roster override list. Backfill as empty array on
    // archives saved before the picker shipped.
    if (!Array.isArray(this.state.myKidsRoster)) this.state.myKidsRoster = [];

    // v4.44: family recipes list. Each recipe has a fixed shape so the
    // grid / detail render can assume the fields exist.
    if (!Array.isArray(this.state.recipes)) this.state.recipes = [];
    for (const r of this.state.recipes) {
      if (!r.id) r.id = uid('rcp');
      ['name','category','ingredients','instructions','notes','link',
       'fromRef','fromText'].forEach(k => { if (r[k] === undefined) r[k] = ''; });
      if (r.photo !== null && (typeof r.photo !== 'object' || Array.isArray(r.photo))) r.photo = null;
      if (r.createdAt === undefined) r.createdAt = Date.now();
    }

    // v4.49: documents drawer. Each entry has a fixed shape so render
    // code can assume the fields exist.
    if (!Array.isArray(this.state.documents)) this.state.documents = [];
    for (const d of this.state.documents) {
      if (!d.id) d.id = uid('doc');
      ['title','category','notes'].forEach(k => { if (d[k] === undefined) d[k] = ''; });
      if (d.memberId === undefined) d.memberId = '';
      if (d.file !== null && (typeof d.file !== 'object' || Array.isArray(d.file))) d.file = null;
      if (d.createdAt === undefined) d.createdAt = Date.now();
    }

    // v4.48: voice / video stories. Backfill so render code can assume
    // the shape.
    if (!Array.isArray(this.state.stories)) this.state.stories = [];
    for (const s of this.state.stories) {
      if (!s.id) s.id = uid('sto');
      ['title','description','kind','source','embedUrl','embedKind','embedId','recordedDate']
        .forEach(k => { if (s[k] === undefined) s[k] = ''; });
      if (s.media !== null && (typeof s.media !== 'object' || Array.isArray(s.media))) s.media = null;
      if (!Array.isArray(s.tags)) s.tags = [];
      if (s.durationSec === undefined) s.durationSec = 0;
      if (s.createdAt   === undefined) s.createdAt = Date.now();
    }

    // v4.47: time capsules. Each entry has a fixed shape so render +
    // lock-check code can assume the fields exist.
    if (!Array.isArray(this.state.timeCapsules)) this.state.timeCapsules = [];
    for (const c of this.state.timeCapsules) {
      if (!c.id) c.id = uid('tcp');
      ['recipientRef','unlockDate','title','body','link','authorName']
        .forEach(k => { if (c[k] === undefined) c[k] = ''; });
      if (c.photo !== null && (typeof c.photo !== 'object' || Array.isArray(c.photo))) c.photo = null;
      if (c.authorId  === undefined) c.authorId = null;
      if (c.sealedAt  === undefined) c.sealedAt = Date.now();
      if (c.revealedBy === undefined) c.revealedBy = null;
    }

    // v4.45: memories feed. Defensive backfill so render code can assume
    // the shape — photos array, tags array, body string.
    // v4.46: reactions + comments arrays added.
    if (!Array.isArray(this.state.memories)) this.state.memories = [];
    for (const m of this.state.memories) {
      if (!m.id) m.id = uid('mem');
      if (!Array.isArray(m.photos))    m.photos    = [];
      if (!Array.isArray(m.tags))      m.tags      = [];
      if (!Array.isArray(m.reactions)) m.reactions = []; // [{ emoji, userId, createdAt }]
      if (!Array.isArray(m.comments))  m.comments  = []; // [{ id, body, authorId, authorName, createdAt }]
      m.comments.forEach(c => {
        if (!c.id) c.id = uid('cmt');
        if (c.body       === undefined) c.body = '';
        if (c.authorId   === undefined) c.authorId = null;
        if (c.authorName === undefined) c.authorName = '';
        if (c.createdAt  === undefined) c.createdAt = Date.now();
      });
      if (m.body      === undefined) m.body = '';
      if (m.date      === undefined) m.date = '';
      if (m.createdAt === undefined) m.createdAt = Date.now();
    }
    for (const kidId of Object.keys(this.state.myKids)) {
      const k = this.state.myKids[kidId];
      if (!k || typeof k !== 'object') { delete this.state.myKids[kidId]; continue; }
      for (const section of ['milestones', 'school', 'art', 'letters']) {
        if (!Array.isArray(k[section])) k[section] = [];
        // Normalize each entry — older shapes may be missing optional fields.
        k[section].forEach(e => {
          if (!e.id)        e.id = uid('mk');
          if (!Array.isArray(e.photos)) e.photos = [];
          if (e.title       === undefined) e.title = '';
          if (e.body        === undefined) e.body  = '';
          if (e.date        === undefined) e.date  = '';
          if (e.createdAt   === undefined) e.createdAt = Date.now();
        });
      }
    }

    // v4.31: Friend Tree dataset — defensive backfill so older archives don't
    // crash on Store.state.friends access. Each existing record is normalized
    // so the friend renderer can assume the same shape as a family member.
    if (!this.state.friends || typeof this.state.friends !== 'object') {
      this.state.friends = {};
    }
    for (const f of Object.values(this.state.friends)) {
      if (!f.id) f.id = uid('frd');
      ['firstName','middleName','lastName','displayName','internationalName',
       'birthday','email','phone','address','city','state','zip',
       'group','notes','photo','gender','dateOfDeath','plan529']
        .forEach(k => { if (f[k] === undefined) f[k] = ''; });
      if (!f.ageGroup) f.ageGroup = 'adult';
      if (!f.createdAt) f.createdAt = Date.now();
      // v4.36: same "Do not show in events list" flag mirrored from members.
      if (f.excludeFromEventsList === undefined) f.excludeFromEventsList = false;
      // v4.35: household roster. Each friend record represents a household.
      // `spouse` is a single optional sub-record (adult). `kids` is an array
      // of sub-records (children). Sub-records carry their own birthday +
      // ethnicities + 529 link so the household view can surface them in
      // expanded rows without joining to another table.
      if (!Array.isArray(f.ethnicities)) f.ethnicities = [];
      if (f.spouse !== null && (typeof f.spouse !== 'object' || Array.isArray(f.spouse))) f.spouse = null;
      if (f.spouse) {
        if (!f.spouse.id) f.spouse.id = uid('sps');
        ['firstName','middleName','lastName','displayName','birthday','phone','email','plan529','photo']
          .forEach(k => { if (f.spouse[k] === undefined) f.spouse[k] = ''; });
        if (!f.spouse.gender) f.spouse.gender = 'female';
        if (!Array.isArray(f.spouse.ethnicities)) f.spouse.ethnicities = [];
        if (f.spouse.excludeFromEventsList === undefined) f.spouse.excludeFromEventsList = false;
      } else if (f.spouse === undefined) {
        f.spouse = null;
      }
      if (!Array.isArray(f.kids)) f.kids = [];
      f.kids.forEach(k => {
        if (!k.id) k.id = uid('kid');
        ['firstName','middleName','lastName','displayName','birthday','plan529','photo']
          .forEach(key => { if (k[key] === undefined) k[key] = ''; });
        if (!k.gender) k.gender = 'female';
        if (!Array.isArray(k.ethnicities)) k.ethnicities = [];
        if (k.excludeFromEventsList === undefined) k.excludeFromEventsList = false;
      });
    }
    // Heal asymmetric parent/child links: if A says "B is my parent", make
    // sure B says "A is my child". This fixes profiles where one parent
    // shows up in the drawer but the other doesn't because childrenIds got
    // out of sync at some point. Runs every load; idempotent.
    for (const m of Object.values(members)) {
      (m.parentIds || []).forEach(pid => {
        const p = members[pid];
        if (!p) return;
        p.childrenIds = p.childrenIds || [];
        if (!p.childrenIds.includes(m.id)) p.childrenIds.push(m.id);
      });
      (m.childrenIds || []).forEach(cid => {
        const c = members[cid];
        if (!c) return;
        c.parentIds = c.parentIds || [];
        if (!c.parentIds.includes(m.id)) c.parentIds.push(m.id);
      });
      // exSpouseIds symmetry too — same fragility applies.
      (m.exSpouseIds || []).forEach(eid => {
        const e = members[eid];
        if (!e) return;
        e.exSpouseIds = e.exSpouseIds || [];
        if (!e.exSpouseIds.includes(m.id)) e.exSpouseIds.push(m.id);
      });
    }
    for (const m of Object.values(members)) {
      if (m.spouseId && m.divorced) {
        const s = members[m.spouseId];
        m.exSpouseIds = [...new Set([...(m.exSpouseIds || []), m.spouseId])];
        if (s) {
          s.exSpouseIds = [...new Set([...(s.exSpouseIds || []), m.id])];
          s.spouseId = null;
          s.divorced = false;
        }
        m.spouseId = null;
        m.divorced = false;
      }
    }
  },
  // Save: write through to localStorage (cache) AND queue a debounced upsert
  // to Supabase. Sync to all existing callers — no awaiting required.
  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch {}
    Backend.queueSaveArchive(this.state);
  },
  bootstrap() { this.state = this.defaults(); this.save(); },
  reset() { localStorage.removeItem(STORAGE_KEY); this.bootstrap(); },
  membersList() { return Object.values(this.state.members); },
  byId(id) { return this.state.members[id] || null; },
};

// -------------------- crypto helpers --------------------
async function hashPassword(pw) {
  const data = new TextEncoder().encode(pw + '::family-archive-salt');
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomPassword(len = 10) {
  // friendly: lowercase + digits, no ambiguous chars
  const alpha = 'abcdefghjkmnpqrstuvwxyz';
  const num = '23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b, i) => (i % 3 === 2 ? num : alpha)[b % (i % 3 === 2 ? num.length : alpha.length)]).join('');
}

function uid(prefix = 'm') {
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}
function slug(s) { return s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// v4.32: djb2-style fast string hash. Used by Backend.flushSaveArchive to
// short-circuit no-op writes (avoids POSTing the same JSONB twice in a row).
// Not cryptographic — collisions are vanishingly unlikely on app state but
// would only mean we skip a write that should have happened. Good enough.
function hashStringFast(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  // Mix in length so two same-length strings can't accidentally collide on
  // tail-bytes alone, and convert to unsigned hex.
  return (h >>> 0).toString(36) + '.' + s.length.toString(36);
}

// -------------------- AUTH --------------------
// All authentication goes through Supabase. The legacy username/passwordHash
// fields on member records still exist for back-compat data (and so we can
// map a member to a Supabase account by editing member_accounts in the dashboard)
// but they're no longer used to validate logins.
const Auth = {
  current: null,                                 // 'admin-bootstrap' marker or member object
  isAdmin() {
    if (!this.current) return false;
    if (this.current === 'admin-bootstrap') return true;
    return Backend.account?.is_admin || this.current.role === 'admin';
  },
  isSelf(memberId) {
    return this.current && this.current !== 'admin-bootstrap' && this.current.id === memberId;
  },

  // ----- v4.26 "Family" role -----
  // A read-only-ish role between User and Admin. Family sees age on Tree
  // cards and gets read-only access to Calendar (no +Reminder, no Google,
  // no creating events). Helpers below let view code stay declarative:
  // "can this role do X?" instead of branching on string literals.
  isFamily() {
    return !!this.current && this.current !== 'admin-bootstrap' && this.current.role === 'family';
  },
  // v4.54: ages on tree cards are visible to every authenticated viewer
  // — User role included. The 529 chip on the card still uses a
  // tighter admin-or-family check (inlined at its render site) since
  // that's financial info, not a birthday.
  canViewAge() { return !!this.current; },
  // The Drawer's bottom-action buttons (Edit, Link, Mark divorced, Reset
  // password, Remove) are all hidden from Family. Even on their own card —
  // the rule is "view only, no editing" for this role.
  canEditMember(_m) { return this.isAdmin() || (this.isSelf(_m?.id) && !this.isFamily()); },
  // Drawer's Gifts mini-list is admin-only. Family hides it the same way
  // regular Users always have.
  canSeeDrawerGifts() { return this.isAdmin(); },
  // Per-card variant for the Family role: they see Gifts when looking at
  // their own card or their spouse's card; never on cards of cousins /
  // siblings / parents / kids. Admin always sees Gifts; plain User keeps
  // the legacy behavior (always shown — there's no Gifts page for them).
  canSeeDrawerGiftsFor(m) {
    if (!m) return false;
    if (this.isAdmin()) return true;
    if (this.isFamily()) {
      const me = this.current;
      if (!me || me === 'admin-bootstrap') return false;
      return m.id === me.id || m.id === me.spouseId;
    }
    return true;
  },
  // Family role + admin can pop the profile drawer for any tree card.
  // Plain User cannot — their drawer access is restricted to the My Family
  // page where the per-card "allowed" set already gates by self/spouse.
  canOpenTreeDrawer() { return this.isAdmin() || this.isFamily(); },
  // Calendar page is visible to admin AND family; family gets the read-only
  // variant (no +Reminder, no Google, no event creation, reminder chips
  // hidden, non-invited events filtered out).
  canViewCalendar() { return this.isAdmin() || this.isFamily(); },
  canEditCalendarEvents() { return this.isAdmin(); },
  canManageReminders() { return this.isAdmin(); },
  canUseGoogleCalendar() { return this.isAdmin(); },

  // Gate for the "Admin" private-vault page. Stricter than isAdmin(): only
  // Ted Yoo, Doan Yoo, and the bootstrap-admin sentinel get in. Match by
  // legal name (first + last) so a custom displayName override doesn't
  // accidentally lock the household out.
  //
  // To grant access to another household member without code changes, set
  // their member.role = 'admin' AND ensure their legal first/last matches
  // one of the names below — or add their id to state.vaultAccessIds.
  canAccessVault() {
    if (!this.isAdmin()) return false;
    if (this.current === 'admin-bootstrap') return true;
    const me = this.current;
    if (!me) return false;
    const extra = (Store?.state?.vaultAccessIds || []);
    if (extra.includes(me.id)) return true;
    const f = (me.firstName || '').trim().toLowerCase();
    const l = (me.lastName  || '').trim().toLowerCase();
    if (l !== 'yoo') return false;
    return f === 'ted' || f === 'doan';
  },

  // Resolve who the logged-in Supabase user *is* in family terms. Reads
  // member_accounts.member_id, then looks that member up in Store.state.
  // 'admin-bootstrap' is a sentinel for the first signed-up user before any
  // real member records have been claimed.
  applyAccount() {
    if (!Backend.account) { this.current = null; return; }
    const mid = Backend.account.member_id;
    if (!mid || mid === 'admin-bootstrap') {
      this.current = 'admin-bootstrap';
      return;
    }
    const m = Store.byId(mid);
    this.current = m || (Backend.account.is_admin ? 'admin-bootstrap' : null);
  },

  async logout() {
    await Backend.signOut();
    this.current = null;
  },

  async setPassword(newPw) {
    if (!Backend.client) return;
    const { error } = await Backend.client.auth.updateUser({ password: newPw });
    if (error) throw new Error(error.message);
  },

  // Kept as a no-op stub for legacy call sites (e.g. ChangePasswordModal
  // confirming the current password). Supabase doesn't require it; we trust
  // the active session.
  async checkCurrentPassword(_pw) { return true; },
};

// -------------------- USERNAME GENERATION --------------------
function generateUsername(firstName, lastName) {
  const base = slug(firstName) + slug(lastName);
  const taken = new Set(Store.membersList().map(m => m.username));
  if (base === 'admin' || taken.has(base)) {
    let i = 2;
    while (taken.has(base + i)) i++;
    return base + i;
  }
  return base;
}

// -------------------- TREE / MEMBERS --------------------
// Places a freshly-created member relative to whomever they were linked to.
// Used in manual-layout mode where autoLayout() is disabled — without this
// the new card would render at (0, 0) far from its actual family. Picks a
// natural slot based on the relationship type (child → below the parent,
// spouse → beside, parent → above, sibling → beside the existing sibling)
// and then slides along the primary axis until it isn't on top of an
// existing card.
function placeMemberNearRelative(member, relType, targetId, secondId) {
  const target = targetId ? Store.byId(targetId) : null;
  if (!target) {
    // Standalone add (rare in this app). Drop just below+right of the
    // bottom-right of the existing tree so it's at least visible.
    const all = Store.membersList().filter(m => m.id !== member.id);
    if (!all.length) { member.x = 0; member.y = 0; return; }
    const maxX = Math.max(...all.map(m => m.x));
    const maxY = Math.max(...all.map(m => m.y));
    member.x = maxX + NODE_W + X_GAP * 2;
    member.y = maxY;
    return;
  }
  const second = secondId ? Store.byId(secondId) : null;
  let x, y;
  switch (relType) {
    case 'child':
      if (second) {
        x = (target.x + second.x) / 2;
        y = Math.max(target.y, second.y) + NODE_H + Y_GAP;
      } else {
        x = target.x;
        y = target.y + NODE_H + Y_GAP;
      }
      break;
    case 'parent':
      x = target.x;
      y = target.y - NODE_H - Y_GAP;
      break;
    case 'spouse':
    case 'sibling':
    default:
      x = target.x + NODE_W + X_GAP;
      y = target.y;
      break;
  }
  // Nudge along the primary axis until we don't overlap an existing card.
  // Step by a card-and-gap width so the layout stays grid-aligned even
  // after several adds. Caps at 30 attempts (~6000px) — beyond that the
  // user has bigger problems.
  const others = Store.membersList().filter(m => m.id !== member.id);
  const overlaps = (tx, ty) => others.some(m =>
    Math.abs(m.x - tx) < NODE_W * 0.9 && Math.abs(m.y - ty) < NODE_H * 0.9);
  let attempts = 0;
  while (overlaps(x, y) && attempts < 30) {
    x += NODE_W + X_GAP;
    attempts++;
  }
  member.x = x;
  member.y = y;
}

const Tree = {
  async addMember(input) {
    const id = uid();
    const username = generateUsername(input.firstName, input.lastName);
    // The temporary password is still returned to the caller (used to seed
    // the corresponding Supabase Auth account), but we no longer persist
    // its hash on the member record — Supabase Auth owns the credential
    // lifecycle now. v4.33: dropped passwordHash + mustChangePassword
    // from the on-disk shape to shrink the archive row.
    const password = randomPassword();

    const birthday = input.birthday || '';
    const inferredAge = ageGroupForBirthday(birthday);
    const m = {
      id,
      firstName: input.firstName.trim(),
      middleName: (input.middleName || '').trim(),
      lastName: input.lastName.trim(),
      displayName: (input.displayName || '').trim(),
      internationalName: (input.internationalName || '').trim(),
      includeInGroupEvents: input.includeInGroupEvents !== false,
      birthday,
      email: input.email || '',
      phone: input.phone ? formatPhoneUS(input.phone) : '',
      address: input.address || '',
      city: input.city || '',
      state: (input.state || '').toUpperCase().slice(0, 3),
      zip: (input.zip || '').toString().slice(0, 10),
      anniversary: '',
      gender: input.gender || 'female',
      ageGroup: inferredAge || input.ageGroup || 'adult',
      photo: input.photo || null,
      group: input.group || '',
      role: input.role || 'user',
      ethnicities: Array.isArray(input.ethnicities) ? input.ethnicities : [],
      username,
      parentIds: [],
      spouseId: null,
      childrenIds: [],
      siblingLinkIds: [],
      exSpouseIds: [],
      dateOfDeath: '',
      plan529: '',
      notes: '',
      x: 0, y: 0,
      createdAt: Date.now(),
    };
    Store.state.members[id] = m;

    // wire relationship. For a spouse with the divorced flag, we route through
    // exSpouseIds so the rest of the model treats it as a past marriage.
    if (input.relType && input.relTargetId) {
      this.connect(m, input.relType, input.relTargetId, input.relSecondId, {
        divorced: input.relType === 'spouse' && !!input.relDivorced,
      });
    }
    // Children inherit ethnicities from their parents.
    inheritEthnicities();
    if (Store.state.manualLayout) {
      // The user has hand-placed the tree, so we must NOT re-run autoLayout
      // (it'd reshuffle every card). Instead, drop the new card right next
      // to the target of the relationship so the spatial relationship is
      // preserved and the user only has to nudge if needed.
      placeMemberNearRelative(m, input.relType, input.relTargetId, input.relSecondId);
    } else {
      // Re-run the full auto-layout so the new member slots into a clean tree.
      autoLayout();
    }
    Store.save();
    return { member: m, password };
  },
  connect(member, relType, targetId, secondId, opts = {}) {
    const target = Store.byId(targetId);
    if (!target) return;
    const divorced = !!opts.divorced;
    const second = secondId ? Store.byId(secondId) : null;
    if (relType === 'child') {
      member.parentIds = [targetId, ...(second ? [secondId] : [])];
      target.childrenIds = unique([...(target.childrenIds || []), member.id]);
      if (second) second.childrenIds = unique([...(second.childrenIds || []), member.id]);
    } else if (relType === 'parent') {
      // Propagate the new parent to every existing sibling-link of the target so
      // a parent added after the siblings flows through to the whole group.
      const group = unique([target.id, ...(target.siblingLinkIds || [])]);
      group.forEach(cid => {
        const c = Store.byId(cid);
        if (!c) return;
        c.parentIds = unique([...(c.parentIds || []), member.id]);
      });
      member.childrenIds = unique([...(member.childrenIds || []), ...group]);
    } else if (relType === 'spouse') {
      member.exSpouseIds = member.exSpouseIds || [];
      target.exSpouseIds = target.exSpouseIds || [];
      if (divorced) {
        // Past marriage. Record on both sides; don't touch the current spouse.
        member.exSpouseIds = unique([...member.exSpouseIds, target.id].filter(x => x !== member.id));
        target.exSpouseIds = unique([...target.exSpouseIds, member.id].filter(x => x !== target.id));
        // If the pair is somehow also the current spouse, demote it.
        if (member.spouseId === target.id) member.spouseId = null;
        if (target.spouseId === member.id) target.spouseId = null;
      } else {
        // New current marriage. Demote any existing current spouse to an ex
        // on each side so we don't lose history.
        const demote = (person) => {
          const oldId = person.spouseId;
          if (oldId && oldId !== member.id && oldId !== target.id) {
            const old = Store.byId(oldId);
            if (old) {
              old.exSpouseIds = unique([...(old.exSpouseIds || []), person.id]);
              old.spouseId = null;
              old.divorced = false;
            }
            person.exSpouseIds = unique([...(person.exSpouseIds || []), oldId]);
          }
          person.spouseId = null;
          person.divorced = false;
        };
        demote(member);
        demote(target);
        // If these two were exes before, remove that history — they're back together.
        member.exSpouseIds = (member.exSpouseIds || []).filter(x => x !== target.id);
        target.exSpouseIds = (target.exSpouseIds || []).filter(x => x !== member.id);
        member.spouseId = target.id;
        target.spouseId = member.id;
      }
    } else if (relType === 'sibling') {
      // Share parents with target (if known)
      member.parentIds = [...(target.parentIds || [])];
      member.parentIds.forEach(pid => {
        const p = Store.byId(pid);
        if (p) p.childrenIds = unique([...(p.childrenIds || []), member.id]);
      });
      // Also link the sibling group symmetrically so future parents propagate.
      const group = unique([
        target.id,
        member.id,
        ...(target.siblingLinkIds || []),
        ...(member.siblingLinkIds || []),
      ]);
      group.forEach(sid => {
        const s = Store.byId(sid);
        if (!s) return;
        s.siblingLinkIds = group.filter(x => x !== sid);
      });
    }
  },
  remove(id) {
    const m = Store.byId(id);
    if (!m) return;
    if (m.spouseId) {
      const s = Store.byId(m.spouseId); if (s) s.spouseId = null;
    }
    (m.exSpouseIds || []).forEach(eid => {
      const ex = Store.byId(eid);
      if (ex) ex.exSpouseIds = (ex.exSpouseIds || []).filter(x => x !== id);
    });
    (m.parentIds || []).forEach(pid => {
      const p = Store.byId(pid);
      if (p) p.childrenIds = (p.childrenIds || []).filter(x => x !== id);
    });
    (m.childrenIds || []).forEach(cid => {
      const c = Store.byId(cid);
      if (c) c.parentIds = (c.parentIds || []).filter(x => x !== id);
    });
    delete Store.state.members[id];
    autoLayout();
    Store.save();
  },
  computeRelation(memberId) {
    if (!Auth.current || Auth.current === 'admin-bootstrap') return labelFor(memberId);
    if (Auth.isSelf(memberId)) return 'You';
    const me = Auth.current;
    const them = Store.byId(memberId);
    if (!them) return '';
    if (me.spouseId === them.id) return 'Spouse';
    if ((me.parentIds || []).includes(them.id)) return 'Parent';
    if ((me.childrenIds || []).includes(them.id)) return 'Child';
    // sibling: shares a parent
    const myParents = new Set(me.parentIds || []);
    if ((them.parentIds || []).some(p => myParents.has(p))) return 'Sibling';
    // grandparent
    if ((me.parentIds || []).some(pid => (Store.byId(pid)?.parentIds || []).includes(them.id))) return 'Grandparent';
    // grandchild
    if ((me.childrenIds || []).some(cid => (Store.byId(cid)?.childrenIds || []).includes(them.id))) return 'Grandchild';
    // aunt/uncle: parent's sibling
    for (const pid of (me.parentIds || [])) {
      const p = Store.byId(pid); if (!p) continue;
      const grand = new Set(p.parentIds || []);
      if ((them.parentIds || []).some(x => grand.has(x)) && them.id !== pid) return 'Aunt / Uncle';
    }
    // cousin: shares a grandparent
    const myGrand = new Set();
    (me.parentIds || []).forEach(pid => (Store.byId(pid)?.parentIds || []).forEach(gp => myGrand.add(gp)));
    const theirGrand = new Set();
    (them.parentIds || []).forEach(pid => (Store.byId(pid)?.parentIds || []).forEach(gp => theirGrand.add(gp)));
    for (const g of myGrand) if (theirGrand.has(g)) return 'Cousin';
    return 'Family';
  },
  relations(member) {
    const out = [];
    if (member.spouseId) {
      const s = Store.byId(member.spouseId);
      if (s) out.push({ label: 'Spouse', member: s });
    }
    (member.exSpouseIds || []).forEach(eid => {
      const ex = Store.byId(eid);
      if (ex) out.push({ label: 'Previous spouse', member: ex });
    });
    // Parents: union of m.parentIds and anyone whose childrenIds includes m.
    // The reverse-lookup defends against asymmetric data that healMissingKeys
    // might miss on the first load.
    const parentIds = new Set(member.parentIds || []);
    Store.membersList().forEach(o => {
      if ((o.childrenIds || []).includes(member.id)) parentIds.add(o.id);
    });
    parentIds.forEach(pid => {
      const p = Store.byId(pid); if (p) out.push({ label: 'Parent', member: p });
    });
    // Children: same union pattern.
    const childIds = new Set(member.childrenIds || []);
    Store.membersList().forEach(o => {
      if ((o.parentIds || []).includes(member.id)) childIds.add(o.id);
    });
    childIds.forEach(cid => {
      const c = Store.byId(cid); if (c) out.push({ label: 'Child', member: c });
    });
    // Siblings: anyone who shares a parent with me, computed from the unioned
    // parent set so we catch siblings reachable through either link direction.
    const sibIds = new Set();
    parentIds.forEach(pid => {
      const p = Store.byId(pid);
      (p?.childrenIds || []).forEach(cid => { if (cid !== member.id) sibIds.add(cid); });
    });
    sibIds.forEach(sid => {
      const s = Store.byId(sid); if (s) out.push({ label: 'Sibling', member: s });
    });
    return out;
  },
};

function unique(arr) { return [...new Set(arr)]; }
function labelFor(id) { return ''; }

// Canonical alphabetical sort for member lists: last name, then first name.
// Case-insensitive, trim whitespace, empty last names sort to the bottom.
function sortMembers(list) {
  const norm = (s) => (s || '').toString().trim();
  return list.slice().sort((a, b) => {
    const aLast = norm(a.lastName), bLast = norm(b.lastName);
    if (!aLast && bLast) return 1;
    if (aLast && !bLast) return -1;
    const c1 = aLast.localeCompare(bLast, undefined, { sensitivity: 'base' });
    if (c1 !== 0) return c1;
    return norm(a.firstName).localeCompare(norm(b.firstName), undefined, { sensitivity: 'base' });
  });
}

let _gensCache = null;

// Walk the tree top-down; when a person is collapsed, skip their children.
// Spouses inherit collapsed state via the toggle, so couples collapse together.
function computeVisibleIds() {
  const all = Store.membersList();
  const seen = new Set();
  const queue = [];
  all.forEach(m => { if (!(m.parentIds || []).length) queue.push(m.id); });
  if (!queue.length && all.length) all.forEach(m => queue.push(m.id));
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const m = Store.byId(id); if (!m) continue;
    if (m.spouseId && !seen.has(m.spouseId)) queue.push(m.spouseId);
    (m.exSpouseIds || []).forEach(eid => { if (!seen.has(eid)) queue.push(eid); });
    if (m.collapsed) continue;
    (m.childrenIds || []).forEach(cid => queue.push(cid));
  }
  return seen;
}

function descendantCount(member) {
  const ids = new Set();
  const spouse = member.spouseId ? Store.byId(member.spouseId) : null;
  const stack = [...(member.childrenIds || []), ...(spouse?.childrenIds || [])];
  while (stack.length) {
    const id = stack.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    const c = Store.byId(id); if (!c) continue;
    (c.childrenIds || []).forEach(x => stack.push(x));
    if (c.spouseId) {
      const sp = Store.byId(c.spouseId);
      (sp?.childrenIds || []).forEach(x => stack.push(x));
    }
  }
  return ids.size;
}

function toggleCollapse(id) {
  const m = Store.byId(id); if (!m) return;
  const next = !m.collapsed;
  m.collapsed = next;
  if (m.spouseId) {
    const s = Store.byId(m.spouseId);
    if (s) s.collapsed = next;
  }
  Store.save();
}

function expandAll() {
  Store.membersList().forEach(m => { if (m.collapsed) m.collapsed = false; });
  Store.save();
}

function collapseAll() {
  Store.membersList().forEach(m => {
    const sp = m.spouseId ? Store.byId(m.spouseId) : null;
    const hasKids = (m.childrenIds || []).length || (sp?.childrenIds || []).length;
    if (hasKids) m.collapsed = true;
  });
  Store.save();
}

// Repair divorced-flag drift. A legitimate divorce flags BOTH spouses; a
// mismatch is always stale data (e.g., from before Tree.connect cleared the
// flag on remarriage). Resolve mismatched pairs to "married" — the user can
// re-mark as divorced explicitly if needed. Also clears the flag from anyone
// without a current spouse, since "divorced" is a property of a relationship.
function normalizeDivorced() {
  let changed = false;
  Store.membersList().forEach(m => {
    if (!m.spouseId) {
      if (m.divorced) { m.divorced = false; changed = true; }
      return;
    }
    const s = Store.byId(m.spouseId);
    if (!s) {
      // Broken spouse link
      m.spouseId = null;
      if (m.divorced) { m.divorced = false; changed = true; }
      return;
    }
    if (!!m.divorced !== !!s.divorced) {
      m.divorced = false;
      s.divorced = false;
      changed = true;
    }
  });
  if (changed) Store.save();
}

// Reconcile sibling links from shared parents. Members with the same parent
// get linked into a single sibling group with symmetric `siblingLinkIds`.
function reconcileSiblings() {
  const all = Store.membersList();
  all.forEach(m => { if (!Array.isArray(m.siblingLinkIds)) m.siblingLinkIds = []; });
  // From shared parents → mutual sibling membership
  all.forEach(m => {
    const sibs = new Set(m.siblingLinkIds || []);
    (m.parentIds || []).forEach(pid => {
      const p = Store.byId(pid);
      (p?.childrenIds || []).forEach(cid => { if (cid !== m.id) sibs.add(cid); });
    });
    m.siblingLinkIds = [...sibs];
  });
  // Symmetrize: if A says B is a sibling, B says A is too.
  all.forEach(m => {
    (m.siblingLinkIds || []).forEach(sid => {
      const s = Store.byId(sid); if (!s) return;
      if (!s.siblingLinkIds.includes(m.id)) s.siblingLinkIds.push(m.id);
    });
  });
  Store.save();
}

// Children inherit the union of their parents' ethnicities. Walk top-down by
// generation so each child sees its parents' fully-merged set.
function inheritEthnicities() {
  const gens = computeGenerations();
  const order = Store.membersList().slice().sort((a, b) => (gens[a.id] ?? 0) - (gens[b.id] ?? 0));
  let touched = false;
  order.forEach(m => {
    const parents = (m.parentIds || []).map(id => Store.byId(id)).filter(Boolean);
    if (!parents.length) {
      if (!Array.isArray(m.ethnicities)) { m.ethnicities = []; touched = true; }
      return;
    }
    const set = new Set(m.ethnicities || []);
    const before = set.size;
    parents.forEach(p => (p.ethnicities || []).forEach(e => set.add(e)));
    if (set.size !== before) { m.ethnicities = [...set]; touched = true; }
    else if (!Array.isArray(m.ethnicities)) { m.ethnicities = [...set]; touched = true; }
  });
  if (touched) Store.save();
}

function familyKey(parentIds) {
  return parentIds.slice().sort().join('|');
}
// Build a stable map of family-key → hue, evenly spread around the wheel.
// Rank-based so adjacent families never end up near-identical colors.
function buildFamilyHueMap(allKeys) {
  const uniq = [...new Set(allKeys)].sort();
  const N = uniq.length;
  const m = new Map();
  // Step around the wheel at the golden angle so the first few families are far apart;
  // wrap to a denominator that fits everyone evenly when N is small.
  const golden = 137.508;
  uniq.forEach((k, i) => {
    const hue = Math.round((i * golden + 25) % 360);
    m.set(k, hue);
  });
  return m;
}

// Per-generation hue derived from the user's chosen base color.
// Saturation/lightness fixed so all generations read together.
function genColorVarsCSS() {
  const base = (Store.state.theme && Store.state.theme.baseHue) ?? 205;
  const gens = computeGenerations();
  const max = Math.max(0, ...Object.values(gens));
  const css = [];
  for (let g = 0; g <= max; g++) {
    const hue = ((base + g * 47) % 360 + 360) % 360;
    css.push(`--gen-${g}: hsl(${hue} 55% 52%);`);
    css.push(`--gen-${g}-soft: hsl(${hue} 55% 92%);`);
    css.push(`--gen-${g}-edge: hsl(${hue} 50% 38%);`);
  }
  return ':root{' + css.join('') + '}';
}

function applyTheme() {
  let s = document.getElementById('theme-vars');
  if (!s) { s = document.createElement('style'); s.id = 'theme-vars'; document.head.appendChild(s); }
  s.textContent = genColorVarsCSS();
  // sync swatch + color input
  const base = (Store.state.theme && Store.state.theme.baseHue) ?? 205;
  const swatch = document.getElementById('theme-swatch');
  if (swatch) swatch.style.background = `hsl(${base} 55% 52%)`;
  const picker = document.getElementById('theme-color');
  if (picker) picker.value = hueToHex(base);
  renderThemePreview();
}

function renderThemePreview() {
  const wrap = document.getElementById('theme-preview');
  if (!wrap) return;
  const base = (Store.state.theme && Store.state.theme.baseHue) ?? 205;
  const dots = [];
  for (let g = 0; g < 6; g++) {
    const hue = ((base + g * 47) % 360 + 360) % 360;
    dots.push(`<span class="theme-preview-dot" style="background: hsl(${hue} 55% 52%)" title="Gen ${g}"></span>`);
  }
  wrap.innerHTML = dots.join('');
}

function hueToHex(h) {
  const c = `hsl(${h} 55% 52%)`;
  const tmp = document.createElement('div');
  tmp.style.color = c;
  document.body.appendChild(tmp);
  const rgb = getComputedStyle(tmp).color;
  document.body.removeChild(tmp);
  const m = rgb.match(/\d+/g);
  if (!m) return '#000000';
  return '#' + m.slice(0, 3).map(n => Number(n).toString(16).padStart(2, '0')).join('');
}
function hexToHue(hex) {
  const v = hex.replace('#', '');
  const r = parseInt(v.substr(0, 2), 16) / 255;
  const g = parseInt(v.substr(2, 2), 16) / 255;
  const b = parseInt(v.substr(4, 2), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0;
  if (max !== min) {
    const d = max - min;
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)); break;
      case g: h = ((b - r) / d + 2); break;
      case b: h = ((r - g) / d + 4); break;
    }
    h *= 60;
  }
  return Math.round(h);
}

// SVG heart at (x, y). Solid for married, broken (with crack) for divorced.
function heartMarker(x, y, divorced) {
  // v4.21: bumped visual size — the heart now reads at a glance against the
  // spouse line. Halo grows proportionally so the paper-soft background
  // still cleanly contrasts with the underlying connector.
  const w = 30, h = 27;
  // Heart path centered roughly on (0,0)
  const path = 'M 0 6 C 0 -1, -10 -1, -10 6 C -10 12, 0 16, 0 18 C 0 16, 10 12, 10 6 C 10 -1, 0 -1, 0 6 Z';
  const halo = `<rect x="${x - w/2}" y="${y - h/2}" width="${w}" height="${h}" rx="5" fill="var(--paper-soft)" opacity=".95"/>`;
  if (!divorced) {
    return `<g class="spouse-heart" transform="translate(${x} ${y - 2}) scale(1.1)">
      ${halo}
      <path d="${path}" class="heart-fill"/>
    </g>`;
  }
  // broken: heart fill + a jagged white line down the middle
  return `<g class="spouse-heart broken" transform="translate(${x} ${y - 2}) scale(1.1)">
    ${halo}
    <path d="${path}" class="heart-fill"/>
    <path d="M -1.4 -0.5 L 1 4 L -1 8 L 1.4 13 L -0.5 17" class="heart-crack"/>
  </g>`;
}

// -------------------- LAYOUT --------------------
const NODE_W = 200, NODE_H = 280, X_GAP = 40, Y_GAP = 80;

function computeGenerations() {
  const members = Store.membersList();
  const gen = {};
  const visited = new Set();
  // start with members who have no parents → gen 0
  const queue = [];
  members.forEach(m => {
    if (!(m.parentIds || []).length) { gen[m.id] = 0; queue.push(m.id); }
  });
  // expand by children (and lift spouses)
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const m = Store.byId(id);
    if (!m) continue;
    // spouse same generation
    if (m.spouseId && gen[m.spouseId] === undefined) {
      gen[m.spouseId] = gen[id];
      queue.push(m.spouseId);
    }
    // children one below
    (m.childrenIds || []).forEach(cid => {
      const childGen = gen[id] + 1;
      gen[cid] = Math.max(gen[cid] ?? -Infinity, childGen);
      queue.push(cid);
    });
  }
  // anything still unset → gen 0
  members.forEach(m => { if (gen[m.id] === undefined) gen[m.id] = 0; });
  return gen;
}

// Subtree-width-based auto-layout. Each (couple + descendants) takes only as much
// space as its subtree needs; parents are centered over their combined children.
function autoLayout(orientation = Store.state.orientation || 'vertical', opts = {}) {
  // When the user has unlocked the tree and placed cards manually, skip
  // automatic reshuffles. The only callers that may force a re-layout
  // are the explicit "Auto-arrange" button + orientation toggle, which
  // pass { force: true } to override.
  if (Store.state.manualLayout && !opts.force) return;
  const all = Store.membersList();
  if (!all.length) return;

  const isVertical = orientation === 'vertical';
  // axes: "primary" = axis along which siblings spread; "depth" = generation axis
  const SIBLING_SIZE = isVertical ? NODE_W : NODE_H;
  const SIBLING_GAP  = isVertical ? X_GAP  : Y_GAP;
  const DEPTH_SIZE   = isVertical ? NODE_H : NODE_W;
  const DEPTH_GAP    = isVertical ? Y_GAP  : X_GAP;

  const placed = new Set();
  const placeAt = (m, primary, depth) => {
    if (isVertical) { m.x = primary; m.y = depth * (DEPTH_SIZE + DEPTH_GAP) + 60; }
    else            { m.y = primary; m.x = depth * (DEPTH_SIZE + DEPTH_GAP) + 60; }
  };

  // The descendants of a "couple unit" are the union of both spouses' children.
  // We process each couple as a single layout unit so children are centered under both.
  const layoutCouple = (memberId, depth, start) => {
    if (placed.has(memberId)) return 0;
    const m = Store.byId(memberId);
    if (!m) return 0;
    const spouse = m.spouseId && !placed.has(m.spouseId) ? Store.byId(m.spouseId) : null;
    // Ex-spouses join the cluster as additional slots beside the anchor.
    // Each unplaced ex slots in once. Children of any marriage hang centered
    // below the whole cluster.
    const exes = (m.exSpouseIds || [])
      .filter(eid => !placed.has(eid))
      .map(eid => Store.byId(eid))
      .filter(Boolean);
    placed.add(m.id);
    if (spouse) placed.add(spouse.id);
    exes.forEach(ex => placed.add(ex.id));

    // Cluster ordering: anchor, then anchor's current spouse, then for each
    // ex we also pull in the ex's current spouse if any (and not yet placed)
    // and slot her immediately after the ex. This keeps current marriages
    // visually adjacent on the row regardless of which side of the cluster
    // is the anchor, and prevents the "Kimberly orphaned far to the right"
    // case where Hee's current wife got no slot in the cluster because Myong
    // (Hee's ex) was the layout root.
    const orderedPartners = [];
    if (spouse) orderedPartners.push(spouse);
    exes.forEach(ex => {
      orderedPartners.push(ex);
      if (ex.spouseId && !placed.has(ex.spouseId)) {
        const cs = Store.byId(ex.spouseId);
        if (cs && !orderedPartners.includes(cs)) {
          placed.add(cs.id);
          orderedPartners.push(cs);
        }
      }
    });

    // When the cluster is collapsed, treat it as a leaf for layout purposes
    // so the tree compresses around the hidden subtree.
    const isCollapsed = m.collapsed || orderedPartners.some(p => p.collapsed);
    // Children come from anchor + every cluster member's offspring so the
    // descendant subtree still hangs centered below the whole cluster.
    const childIds = isCollapsed ? [] : unique([
      ...(m.childrenIds || []),
      ...orderedPartners.flatMap(p => p.childrenIds || []),
    ]).filter(cid => !placed.has(cid) && Store.byId(cid));

    const slotCount = 1 + orderedPartners.length;
    const coupleSize = slotCount * SIBLING_SIZE + Math.max(0, slotCount - 1) * SIBLING_GAP;
    const placePartners = (anchorStart) => {
      placeAt(m, anchorStart, depth);
      orderedPartners.forEach((p, i) => placeAt(p, anchorStart + (i + 1) * (SIBLING_SIZE + SIBLING_GAP), depth));
    };

    if (!childIds.length) {
      placePartners(start);
      return coupleSize;
    }

    let cursor = start;
    childIds.forEach(cid => {
      const w = layoutCouple(cid, depth + 1, cursor);
      cursor += w + SIBLING_GAP;
    });
    const childrenTotal = cursor - start - SIBLING_GAP;
    const span = Math.max(coupleSize, childrenTotal);
    const coupleStart = start + Math.max(0, (childrenTotal - coupleSize) / 2);
    placePartners(coupleStart);
    return span;
  };

  // Roots = top-of-tree ancestors. A member counts as a "starting root" only
  // if they themselves have no parents AND every spouse / ex of theirs also
  // has no parents in the dataset. That filter drops ex-spouses (Myong) and
  // current spouses (Kimberly) that look root-y on their own but actually
  // belong inside their partner's deeper subtree — letting them be the
  // layout root scattered Hee's descendants apart from Kum-Bong's. They get
  // pulled in via the orderedPartners logic below instead.
  const hasParents = (m) => m && (m.parentIds || []).some(pid => Store.byId(pid));
  const partnerHasParents = (m) => {
    if (m.spouseId && hasParents(Store.byId(m.spouseId))) return true;
    return (m.exSpouseIds || []).some(eid => hasParents(Store.byId(eid)));
  };
  const realRoots = all.filter(m => !hasParents(m) && !partnerHasParents(m));
  // Place the admin's own family on the LEFT. For each root, check whether
  // the admin is reachable through children only — that traces the bio
  // bloodline. We deliberately do NOT walk through spouses past the root
  // pair, because going Doan → Ted (her spouse) would falsely classify
  // Doan's parents' subtree as the admin's family (Ted is reached only via
  // marriage, not blood). A surname fallback covers floating roots that
  // aren't yet wired to their grandkids — e.g. a Grandpa Yoo who hasn't
  // been linked as Bong's parent still slots into the Yoo cluster on the
  // left because his last name matches the admin.
  // Auth.current is the resolved member OBJECT (or the 'admin-bootstrap'
  // sentinel / null), not a bare ID. Pull the id out explicitly so the
  // string comparisons in rootContainsAdminByBlood don't fall through.
  const adminMember   = (Auth.current && Auth.current !== 'admin-bootstrap') ? Auth.current : null;
  const adminMemberId = adminMember?.id || null;
  const adminLN       = (adminMember?.lastName || '').trim().toLowerCase();
  const rootContainsAdminByBlood = (root) => {
    if (!adminMemberId) return false;
    // Start with the root + their current spouse so we pick up the children
    // of either parent in the couple, but never walk further through any
    // spouse (which is how marriage-into-the-family was leaking through).
    const queue = [root.id];
    if (root.spouseId && Store.byId(root.spouseId)) queue.push(root.spouseId);
    const seen = new Set();
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      if (id === adminMemberId) return true;
      const mm = Store.byId(id);
      if (!mm) continue;
      (mm.childrenIds || []).forEach(cid => queue.push(cid));
    }
    return false;
  };
  const isAdminFamilyRoot = (root) => {
    if (rootContainsAdminByBlood(root)) return true;
    if (!adminLN) return false;
    if ((root.lastName || '').trim().toLowerCase() === adminLN) return true;
    const sp = root.spouseId ? Store.byId(root.spouseId) : null;
    if (sp && (sp.lastName || '').trim().toLowerCase() === adminLN) return true;
    return false;
  };
  const roots = realRoots.slice().sort((a, b) => {
    const ra = isAdminFamilyRoot(a) ? 0 : 1;
    const rb = isAdminFamilyRoot(b) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    // Within the admin family group, push roots that contain admin by blood
    // to the RIGHT so surname-only roots (typically older ancestors that
    // haven't been wired into the bloodline yet — Bong+Kum, Wonjoon Yoo,
    // Grandpa/Grandma Yoo) lay out to the LEFT of the admin's direct-chain
    // root. This keeps the admin near the boundary with the spouse's family
    // and the admin's wider Yoo cluster to the far left.
    if (ra === 0) {
      const ba = rootContainsAdminByBlood(a) ? 1 : 0;
      const bb = rootContainsAdminByBlood(b) ? 1 : 0;
      return ba - bb;
    }
    return 0;
  });
  let cursor = 0;
  roots.forEach(r => {
    if (placed.has(r.id)) return;
    const w = layoutCouple(r.id, 0, cursor);
    cursor += w + SIBLING_GAP * 2;
  });
  // anything not reached (cycles / orphans) → place after
  all.forEach(m => {
    if (!placed.has(m.id)) {
      placeAt(m, cursor, 0);
      cursor += SIBLING_SIZE + SIBLING_GAP;
    }
  });

  // Center the whole tree around primary=0 so it fits nicely
  const minP = isVertical
    ? Math.min(...all.map(m => m.x))
    : Math.min(...all.map(m => m.y));
  const maxP = isVertical
    ? Math.max(...all.map(m => m.x + NODE_W))
    : Math.max(...all.map(m => m.y + NODE_H));
  const shift = -((minP + maxP) / 2);
  if (isVertical) all.forEach(m => { m.x += shift; });
  else            all.forEach(m => { m.y += shift; });

  Store.save();
}

// -------------------- RENDER: TREE CANVAS --------------------
const Canvas = {
  el: null, world: null, edges: null, nodes: null,
  scale: 1, tx: 100, ty: 60,
  init() {
    this.el = $('#tree-canvas');
    this.world = $('#tree-world');
    this.edges = $('#tree-edges');
    this.nodes = $('#tree-nodes');
    this.scale = Store.state.view?.scale || 1;
    this.tx = Store.state.view?.tx || 100;
    this.ty = Store.state.view?.ty || 60;
    this.bindPanZoom();
  },
  apply() {
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    $('#zoom-label').textContent = Math.round(this.scale * 100) + '%';
    Store.state.view = { scale: this.scale, tx: this.tx, ty: this.ty };
  },
  zoomTo(newScale, anchorX, anchorY) {
    newScale = clamp(newScale, 0.25, 2.5);
    const rect = this.el.getBoundingClientRect();
    const cx = anchorX ?? rect.width / 2;
    const cy = anchorY ?? rect.height / 2;
    const wx = (cx - this.tx) / this.scale;
    const wy = (cy - this.ty) / this.scale;
    this.scale = newScale;
    this.tx = cx - wx * this.scale;
    this.ty = cy - wy * this.scale;
    this.apply();
  },
  bindPanZoom() {
    let dragging = false, sx = 0, sy = 0;
    // v4.32: track whether the pan actually moved the view. A pointerdown +
    // immediate pointerup (the user just clicked the empty canvas) used to
    // call Store.save() unconditionally, which kicked a full archive write
    // to Supabase for nothing. Now we save only if the view actually changed.
    let startTx = 0, startTy = 0, moved = false;
    this.el.addEventListener('pointerdown', (e) => {
      // ignore if on a node or interactive child
      if (e.target.closest('.node')) return;
      dragging = true;
      moved = false;
      sx = e.clientX; sy = e.clientY;
      startTx = this.tx; startTy = this.ty;
      this.el.classList.add('is-grabbing');
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.tx += e.clientX - sx;
      this.ty += e.clientY - sy;
      sx = e.clientX; sy = e.clientY;
      moved = true;
      this.apply();
    });
    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove('is-grabbing');
      try { this.el.releasePointerCapture(e.pointerId); } catch {}
      if (moved && (this.tx !== startTx || this.ty !== startTy)) Store.save();
    };
    this.el.addEventListener('pointerup', stop);
    this.el.addEventListener('pointercancel', stop);

    this.el.addEventListener('wheel', (e) => {
      // pinch / mouse wheel
      e.preventDefault();
      const rect = this.el.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      this.zoomTo(this.scale * factor, x, y);
    }, { passive: false });
  },
  fit() {
    const members = Store.membersList();
    if (!members.length) { this.tx = 100; this.ty = 60; this.scale = 1; this.apply(); return; }
    const minX = Math.min(...members.map(m => m.x));
    const minY = Math.min(...members.map(m => m.y));
    const maxX = Math.max(...members.map(m => m.x + NODE_W));
    const maxY = Math.max(...members.map(m => m.y + NODE_H));
    const rect = this.el.getBoundingClientRect();
    const pad = 80;
    const sx = (rect.width  - pad * 2) / (maxX - minX);
    const sy = (rect.height - pad * 2) / (maxY - minY);
    this.scale = clamp(Math.min(sx, sy), 0.25, 1.4);
    this.tx = pad - minX * this.scale;
    this.ty = pad - minY * this.scale;
    this.apply();
  },
  renderAll() {
    this.renderEdges();
    this.renderNodes();
    $('#tree-empty').toggleAttribute('hidden', Store.membersList().length > 0);
  },
  renderEdges() {
    const visibleIds = computeVisibleIds();
    const visibleMembers = Store.membersList().filter(m => visibleIds.has(m.id));
    if (!visibleMembers.length) { this.edges.innerHTML = ''; return; }
    const pad = 200;
    const minX = Math.min(...visibleMembers.map(m => m.x)) - pad;
    const minY = Math.min(...visibleMembers.map(m => m.y)) - pad;
    const maxX = Math.max(...visibleMembers.map(m => m.x + NODE_W)) + pad;
    const maxY = Math.max(...visibleMembers.map(m => m.y + NODE_H)) + pad;
    this.edges.setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    this.edges.style.left = minX + 'px';
    this.edges.style.top  = minY + 'px';
    this.edges.style.width  = (maxX - minX) + 'px';
    this.edges.style.height = (maxY - minY) + 'px';

    const orientation = Store.state.orientation || 'vertical';
    const lines = [];

    const cx = (m) => m.x + NODE_W / 2;
    const cy = (m) => m.y + NODE_H / 2;

    // Family grouping:
    //   - If a child has two parents who are CURRENTLY married → group under
    //     the couple (unified trunk anchored at spouse-line midpoint).
    //   - Otherwise (single parent, or two parents who aren't currently
    //     married — divorced co-parents, never-married co-parents, etc.) →
    //     each parent gets its own solo line to that child. This avoids
    //     drawing long horizontal connectors across the canvas between
    //     ex-partners who may now sit far apart.
    const families = new Map();
    const addToSolo = (parentId, child) => {
      const key = 'solo|' + parentId;
      if (!families.has(key)) families.set(key, { parentIds: [parentId], children: [], type: 'solo' });
      families.get(key).children.push(child);
    };
    visibleMembers.forEach(child => {
      const parents = (child.parentIds || []).filter(id => visibleIds.has(id));
      if (!parents.length) return;
      if (parents.length === 1) { addToSolo(parents[0], child); return; }
      // Find a currently-married pair within the parents
      let couple = null;
      outer:
      for (let i = 0; i < parents.length; i++) {
        for (let j = i + 1; j < parents.length; j++) {
          const a = Store.byId(parents[i]), b = Store.byId(parents[j]);
          if (a && b && a.spouseId === b.id) { couple = [parents[i], parents[j]]; break outer; }
        }
      }
      if (couple) {
        const key = 'couple|' + couple.slice().sort().join('|');
        if (!families.has(key)) families.set(key, { parentIds: couple, children: [], type: 'couple' });
        families.get(key).children.push(child);
        // Any remaining parents (rare — a third co-parent) get their own solo line.
        parents.filter(p => !couple.includes(p)).forEach(p => addToSolo(p, child));
      } else {
        // No currently-married pair; render a separate solo line from each parent.
        parents.forEach(p => addToSolo(p, child));
      }
    });

    // Bucket families by depth axis so we can assign Y-stagger lanes per row,
    // preventing adjacent couples' trunks from merging into a single visual line.
    const familyArr = [...families.values()].map(f => {
      const ps = f.parentIds.map(id => Store.byId(id)).filter(Boolean);
      const depthCoord = orientation === 'vertical'
        ? Math.max(...ps.map(p => p.y))
        : Math.max(...ps.map(p => p.x));
      const primaryCoord = orientation === 'vertical'
        ? ps.reduce((s, p) => s + p.x + NODE_W / 2, 0) / ps.length
        : ps.reduce((s, p) => s + p.y + NODE_H / 2, 0) / ps.length;
      return { ...f, _ps: ps, _depth: depthCoord, _primary: primaryCoord, _key: familyKey(f.parentIds) };
    });
    const hueMap = buildFamilyHueMap(familyArr.map(f => f._key));
    const lanesByDepth = new Map();
    familyArr.sort((a, b) => a._depth - b._depth || a._primary - b._primary)
      .forEach(f => {
        const key = f._depth;
        if (!lanesByDepth.has(key)) lanesByDepth.set(key, 0);
        f._lane = lanesByDepth.get(key);
        lanesByDepth.set(key, f._lane + 1);
      });
    const LANE_OFFSET = 14;

    // Single unified trunk geometry for both single-parent and couple families.
    familyArr.forEach(({ parentIds, children, _ps: ps, _lane, _key }) => {
      if (!ps.length) return;
      const areSpouses = ps.length === 2 && ps[0].spouseId === ps[1].id;
      const hue = hueMap.get(_key) ?? 0;
      const stroke = `hsl(${hue} 60% 38%)`;
      const styleAttr = `style="stroke: ${stroke}"`;
      const fLane = (_lane % 3) * LANE_OFFSET;   // 0, 14, 28 → break visual continuity
      let anchorX, anchorY;

      if (orientation === 'vertical') {
        if (ps.length === 1) {
          anchorX = cx(ps[0]); anchorY = ps[0].y + NODE_H;
        } else if (areSpouses) {
          const sortedP = ps.slice().sort((a, b) => a.x - b.x);
          anchorY = Math.max(...ps.map(p => p.y)) + NODE_H * 0.5;
          anchorX = (sortedP[0].x + NODE_W + sortedP[1].x) / 2;
        } else {
          anchorY = Math.max(...ps.map(p => p.y)) + NODE_H;
          anchorX = ps.reduce((s, p) => s + cx(p), 0) / ps.length;
        }
        const minChildTop = Math.min(...children.map(c => c.y));
        const baseY = anchorY + Math.max(24, (minChildTop - anchorY) / 2);
        const trunkY = baseY - 18 + fLane;
        lines.push(`<path class="edge family" ${styleAttr} d="M ${anchorX} ${anchorY} V ${trunkY}"/>`);
        const xs = [anchorX, ...children.map(cx)];
        const trunkL = Math.min(...xs), trunkR = Math.max(...xs);
        if (trunkR - trunkL > 0.5) lines.push(`<path class="edge family" ${styleAttr} d="M ${trunkL} ${trunkY} H ${trunkR}"/>`);
        children.forEach(c => lines.push(`<path class="edge family" ${styleAttr} d="M ${cx(c)} ${trunkY} V ${c.y}"/>`));
      } else {
        if (ps.length === 1) {
          anchorX = ps[0].x + NODE_W; anchorY = cy(ps[0]);
        } else if (areSpouses) {
          const sortedP = ps.slice().sort((a, b) => a.y - b.y);
          anchorX = Math.max(...ps.map(p => p.x)) + NODE_W * 0.5;
          anchorY = (sortedP[0].y + NODE_H + sortedP[1].y) / 2;
        } else {
          anchorX = Math.max(...ps.map(p => p.x)) + NODE_W;
          anchorY = ps.reduce((s, p) => s + cy(p), 0) / ps.length;
        }
        const minChildLeft = Math.min(...children.map(c => c.x));
        const baseX = anchorX + Math.max(24, (minChildLeft - anchorX) / 2);
        const trunkX = baseX - 18 + fLane;
        lines.push(`<path class="edge family" ${styleAttr} d="M ${anchorX} ${anchorY} H ${trunkX}"/>`);
        const ys = [anchorY, ...children.map(cy)];
        const trunkT = Math.min(...ys), trunkB = Math.max(...ys);
        if (trunkB - trunkT > 0.5) lines.push(`<path class="edge family" ${styleAttr} d="M ${trunkX} ${trunkT} V ${trunkB}"/>`);
        children.forEach(c => lines.push(`<path class="edge family" ${styleAttr} d="M ${trunkX} ${cy(c)} H ${c.x}"/>`));
      }
    });

    // sibling bracket: connect sibling-linked groups that have no shared visible parent
    const handled = new Set();
    visibleMembers.forEach(m => {
      if (handled.has(m.id)) return;
      const groupIds = unique([m.id, ...(m.siblingLinkIds || [])]).filter(id => visibleIds.has(id));
      if (groupIds.length < 2) return;
      const groupMembers = groupIds.map(id => Store.byId(id)).filter(Boolean);
      // skip if any pair already shares a visible parent — the family trunk handles them
      let sharesParent = false;
      outer:
      for (let i = 0; i < groupMembers.length; i++) {
        const ai = (groupMembers[i].parentIds || []).filter(p => visibleIds.has(p));
        for (let j = i + 1; j < groupMembers.length; j++) {
          const bj = (groupMembers[j].parentIds || []).filter(p => visibleIds.has(p));
          if (ai.some(p => bj.includes(p))) { sharesParent = true; break outer; }
        }
      }
      if (sharesParent) { groupIds.forEach(id => handled.add(id)); return; }

      if (orientation === 'vertical') {
        const sorted = groupMembers.slice().sort((a, b) => a.x - b.x);
        const y = Math.min(...sorted.map(s => s.y)) - 26;
        const xs = sorted.map(s => s.x + NODE_W / 2);
        const xMin = Math.min(...xs), xMax = Math.max(...xs);
        if (xMax - xMin > 0.5) lines.push(`<path class="edge sibling" d="M ${xMin} ${y} H ${xMax}"/>`);
        sorted.forEach(s => lines.push(`<path class="edge sibling" d="M ${s.x + NODE_W / 2} ${y} V ${s.y}"/>`));
        // small "siblings" tick at midpoint
        const midX = (xMin + xMax) / 2;
        lines.push(`<g class="sibling-badge" transform="translate(${midX} ${y - 10})"><rect x="-22" y="-9" width="44" height="18" rx="9" fill="var(--paper-soft)" stroke="var(--ink-300)" stroke-width="1"/><text x="0" y="3.5" font-family="Inter, system-ui" font-size="9" font-weight="600" fill="var(--ink-500)" text-anchor="middle" letter-spacing=".06em">SIBLINGS</text></g>`);
      } else {
        const sorted = groupMembers.slice().sort((a, b) => a.y - b.y);
        const x = Math.min(...sorted.map(s => s.x)) - 26;
        const ys = sorted.map(s => s.y + NODE_H / 2);
        const yMin = Math.min(...ys), yMax = Math.max(...ys);
        if (yMax - yMin > 0.5) lines.push(`<path class="edge sibling" d="M ${x} ${yMin} V ${yMax}"/>`);
        sorted.forEach(s => lines.push(`<path class="edge sibling" d="M ${x} ${s.y + NODE_H / 2} H ${s.x}"/>`));
      }
      groupIds.forEach(id => handled.add(id));
    });

    // spouse + ex-spouse connectors. Pairs are drawn once each — keyed by
    // the sorted (id, id) tuple — so multi-spouse clusters don't duplicate.
    const drawnPair = new Set();
    const pairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
    const drawPair = (m, s, divorced) => {
      let mx, my;
      if (orientation === 'vertical') {
        const left = m.x < s.x ? m : s, right = m.x < s.x ? s : m;
        const y = Math.max(left.y, right.y) + NODE_H * 0.5;
        const cls = divorced ? 'edge spouse ex' : 'edge spouse';
        lines.push(`<path class="${cls}" d="M ${left.x + NODE_W} ${y} H ${right.x}"/>`);
        mx = (left.x + NODE_W + right.x) / 2;
        my = y;
      } else {
        const top = m.y < s.y ? m : s, bot = m.y < s.y ? s : m;
        const x = Math.max(top.x, bot.x) + NODE_W * 0.5;
        const cls = divorced ? 'edge spouse ex' : 'edge spouse';
        lines.push(`<path class="${cls}" d="M ${x} ${top.y + NODE_H} V ${bot.y}"/>`);
        mx = x;
        my = (top.y + NODE_H + bot.y) / 2;
      }
      lines.push(heartMarker(mx, my, divorced));
      return { mx, my };
    };

    visibleMembers.forEach(m => {
      // current spouse (solid heart)
      if (m.spouseId && visibleIds.has(m.spouseId)) {
        const s = Store.byId(m.spouseId);
        const key = pairKey(m.id, m.spouseId);
        if (s && !drawnPair.has(key)) {
          drawnPair.add(key);
          const { mx, my } = drawPair(m, s, false);
          // "X yrs" chip near the heart for current couples with an anniversary on file.
          const aniso = m.anniversary || s.anniversary || '';
          if (aniso) {
            const yrs = yearsTogether(aniso);
            if (yrs != null) {
              const isVertical = orientation === 'vertical';
              const lx = isVertical ? mx + 16 : mx;
              const ly = isVertical ? my + 4  : my + 22;
              const anchor = isVertical ? 'start' : 'middle';
              lines.push(
                `<text class="spouse-years" x="${lx}" y="${ly}" text-anchor="${anchor}">${yrs} yr${yrs === 1 ? '' : 's'}</text>`
              );
            }
          }
        }
      }
      // ex-spouses (broken heart, one per pair)
      (m.exSpouseIds || []).forEach(eid => {
        if (!visibleIds.has(eid)) return;
        const ex = Store.byId(eid); if (!ex) return;
        const key = pairKey(m.id, eid);
        if (drawnPair.has(key)) return;
        drawnPair.add(key);
        drawPair(m, ex, true);
      });
    });

    this.edges.innerHTML = lines.join('');
  },
  renderNodes() {
    const visibleIds = computeVisibleIds();
    const all = Store.membersList();
    _gensCache = computeGenerations();
    this.nodes.innerHTML = all
      .filter(m => visibleIds.has(m.id))
      .map(m => nodeHTML(m))
      .join('');
    _gensCache = null;
    this.bindNodes();
  },
  bindNodes() {
    this.nodes.querySelectorAll('.node').forEach(node => {
      const id = node.dataset.id;

      // contextual "+" button → add relative linked to this person
      const addBtn = node.querySelector('.node-add');
      if (addBtn) {
        const stop = (e) => { e.stopPropagation(); };
        addBtn.addEventListener('pointerdown', stop);
        addBtn.addEventListener('pointerup', stop);
        addBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!Auth.isAdmin()) return;
          // Drop focus from the button so :focus-within on its node doesn't
          // keep the "+" visible after the modal opens (and after it closes).
          addBtn.blur();
          MemberModal.open({ targetId: id });
        });
      }

      // expand / collapse toggle
      const toggleBtn = node.querySelector('.node-toggle');
      if (toggleBtn) {
        const stop = (e) => { e.stopPropagation(); };
        toggleBtn.addEventListener('pointerdown', stop);
        toggleBtn.addEventListener('pointerup', stop);
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleCollapse(id);
          autoLayout();
          Canvas.renderAll();
        });
      }

      // Cards are positioned by the layout — clicking opens the drawer.
      // Non-admins cannot open the profile drawer from the tree.
      // When edit-layout is on (admin unlocked the layout), the card can be
      // dragged instead. A drag of more than a few pixels suppresses the
      // click → drawer behaviour so the user can reposition without
      // accidentally opening profiles.
      let pressX = 0, pressY = 0, moved = false;
      node.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.node-add')) return;
        if (e.target.closest('.node-toggle')) return;
        if (!Auth.isAdmin()) return;
        if (!Store.state.editLayout) return;
        pressX = e.clientX; pressY = e.clientY; moved = false;
        TreeEditLayout.beginDrag(node, id, e);
      });
      node.addEventListener('click', (e) => {
        if (e.target.closest('.node-add')) return;
        if (e.target.closest('.node-toggle')) return;
        // Quick-links inside the card (e.g. the 529 chip) should open in a
        // new tab without also triggering the drawer.
        if (e.target.closest('[data-stop-node-click]')) return;
        // Admins and the Family role can open any card. Plain Users can't
        // browse the tree drawer-by-drawer (they use My Family for that).
        if (!Auth.canOpenTreeDrawer()) return;
        // Skip the drawer if the click followed a drag (>4px movement).
        const dx = Math.abs(e.clientX - pressX), dy = Math.abs(e.clientY - pressY);
        if (Store.state.editLayout && (moved || dx > 4 || dy > 4)) return;
        Drawer.open(id);
      });
      // Expose pointer-move tracking to the drag module so it can flip
      // the local `moved` flag for the click guard above.
      node._markMoved = () => { moved = true; };
    });
  },
};

// Tree edit-layout: lets admins unlock the auto-arranged tree, drag cards
// to bespoke positions, and lock the result back in. Manual positions are
// stored on each member's x/y so they survive page reloads + sync, and
// autoLayout() becomes a no-op until the user clicks Auto-arrange.
const TreeEditLayout = {
  init() {
    this.syncToolbar();
    on($('#btn-toggle-edit-layout'), 'click', () => {
      if (!Auth.isAdmin()) return;
      Store.state.editLayout = !Store.state.editLayout;
      // Unlocking implies the user is taking manual control. Once they've
      // dragged anything (or even just unlocked), the auto-arrange should
      // not re-run on data changes. Locking later keeps the flag on so
      // their hand-placed positions persist; only the Auto-arrange button
      // wipes manualLayout back to false.
      if (Store.state.editLayout) Store.state.manualLayout = true;
      Store.save();
      this.syncToolbar();
      // Re-render so the body class flips + cursor styling updates.
      document.body.classList.toggle('tree-edit-mode', Store.state.editLayout);
      Canvas.renderAll();
      toast(Store.state.editLayout
        ? 'Layout unlocked — drag cards to reposition. Click the icon again to lock.'
        : 'Layout locked — manual positions saved.');
    });
    document.body.classList.toggle('tree-edit-mode', !!Store.state.editLayout);
  },
  syncToolbar() {
    const btn = $('#btn-toggle-edit-layout'); if (!btn) return;
    const locked   = $('#edit-layout-icon-locked');
    const unlocked = $('#edit-layout-icon-unlocked');
    const on = !!Store.state.editLayout;
    if (locked)   locked.hidden   = on;
    if (unlocked) unlocked.hidden = !on;
    btn.classList.toggle('is-active', on);
    btn.title = on
      ? 'Lock layout — finish editing'
      : 'Unlock layout — drag cards manually';
  },
  // Begin a card drag. The pointer is already down (we got here from the
  // node's pointerdown handler) and the canvas pan listener already skips
  // events when e.target.closest('.node') matches, so this drag won't fight
  // the pan/zoom logic.
  beginDrag(node, id, downEvent) {
    const member = Store.byId(id); if (!member) return;
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const mStartX = member.x, mStartY = member.y;
    const scale = Canvas.scale || 1;
    let rafScheduled = false;
    let latestEvent = null;

    const flushMove = () => {
      rafScheduled = false;
      if (!latestEvent) return;
      const dx = (latestEvent.clientX - startX) / scale;
      const dy = (latestEvent.clientY - startY) / scale;
      member.x = mStartX + dx;
      member.y = mStartY + dy;
      // Preserve the existing transform's CSS variables — only swap the
      // translate piece — so the generation tint vars on .node stay intact.
      node.style.transform = `translate(${member.x}px, ${member.y}px)`;
      // Repaint just the SVG edges; nodes don't need re-rendering since we
      // already updated this card's transform inline.
      Canvas.renderEdges();
    };

    const onMove = (e) => {
      // Flip the click-guard flag once we've moved past the threshold.
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if ((dx > 4 || dy > 4) && node._markMoved) node._markMoved();
      latestEvent = e;
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flushMove);
      }
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      Store.save();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  },
};

function nodeHTML(m) {
  const photoBg = m.photo ? `style="background-image:url('${cssUrl(m.photo)}'); background-size: cover;"` : '';
  const inner = m.photo ? '' : Silhouettes.for(m);
  const isSelf = Auth.isSelf(m.id) ? ' is-self' : '';
  const relation = Tree.computeRelation(m.id);
  // Age is sensitive — only admins and the Family role see it on tree cards.
  const ageStr = Auth.canViewAge() ? ageLabel(m.birthday, m.dateOfDeath) : '';
  // 529 plan chip on the tree card. Surfaced to Admin and Family so they
  // can jump straight to the plan portal without opening the drawer. URL is
  // escaped + opens in a new tab; the chip's click stops bubbling so it
  // doesn't double as a "open drawer" click. Gate inlined (admin OR
  // family) because canViewAge() now also covers User role for the age
  // chip, but the 529 plan is financial info and should stay restricted.
  const plan529Href = m.plan529 && /^https?:\/\//i.test(m.plan529)
    ? m.plan529
    : (m.plan529 ? `https://${m.plan529}` : '');
  const canSee529 = Auth.isAdmin() || Auth.isFamily();
  const plan529HTML = (canSee529 && plan529Href) ? `
    <a class="node-529" href="${escape(plan529Href)}" target="_blank" rel="noopener" title="Open 529 plan in a new tab" data-stop-node-click>
      <span class="node-529-icon" aria-hidden="true">🎓</span>
      <span class="node-529-text">529 plan</span>
    </a>` : '';
  const inMemoriam = !!m.dateOfDeath;
  const gen = ((_gensCache || computeGenerations())[m.id] ?? 0);

  const sp = m.spouseId ? Store.byId(m.spouseId) : null;
  // Anniversary read either off the member directly or off their current
  // spouse, so the chip shows on both cards even when only one side has the
  // date filled in.
  const anniIso = m.anniversary || sp?.anniversary || '';
  const togetherStr = anniIso ? togetherLabel(anniIso) : '';
  const childCount = unique([...(m.childrenIds || []), ...(sp?.childrenIds || [])]).length;
  const hidden = m.collapsed ? descendantCount(m) : 0;
  const collapsedClass = m.collapsed ? ' is-collapsed' : '';
  const toggleHTML = childCount > 0 ? `
    <button class="node-toggle${m.collapsed ? ' is-collapsed' : ''}" data-toggle-for="${m.id}"
            title="${m.collapsed ? 'Expand' : 'Collapse'} ${escape(m.firstName)}'s descendants"
            aria-label="${m.collapsed ? 'Expand' : 'Collapse'} descendants"
            aria-expanded="${m.collapsed ? 'false' : 'true'}">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
      ${hidden ? `<span class="node-toggle-count">+${hidden}</span>` : ''}
    </button>
  ` : '';

  const styleVars = `transform: translate(${m.x}px, ${m.y}px); --gen: var(--gen-${gen}); --gen-soft: var(--gen-${gen}-soft); --gen-edge: var(--gen-${gen}-edge);`;
  const ethnicities = (m.ethnicities || []);
  const flagsHTML = ethnicities.length ? `<div class="node-flags" title="${ethnicities.map(c => ETH_BY_CODE[c]?.name || c).join(' · ')}">${ethnicities.slice(0, 4).map(c => `<span class="node-flag">${flagFor(c) || '🏳️'}</span>`).join('')}${ethnicities.length > 4 ? `<span class="node-flag-more">+${ethnicities.length - 4}</span>` : ''}</div>` : '';

  const selfStar = isSelf
    ? `<span class="node-self-star" aria-label="You" title="This is you">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2.5l2.96 6 6.62.96-4.79 4.67 1.13 6.59L12 17.6l-5.92 3.12 1.13-6.59L2.42 9.46l6.62-.96L12 2.5z" fill="currentColor"/>
        </svg>
      </span>`
    : '';

  return `
    <div class="node${isSelf}${collapsedClass}${inMemoriam ? ' in-memoriam' : ''}" data-id="${m.id}" data-gen="${gen}" style="${styleVars}">
      <div class="node-gen-bar" aria-hidden="true"></div>
      ${selfStar}
      ${inMemoriam ? '<div class="node-memoriam" title="In loving memory"><span class="node-memoriam-icon" aria-hidden="true">🕊️</span>In loving memory</div>' : ''}
      <div class="node-photo is-${m.gender}" ${photoBg}>${inner}</div>
      <div class="node-body">
        ${relation ? `<div class="node-relation">${relation}</div>` : ''}
        <div class="node-name">${escape(displayName(m))}</div>
        ${m.internationalName ? `<div class="node-international-name" title="International name">${escape(m.internationalName)}</div>` : ''}
        ${m.group ? `<div class="node-group">${escape(m.group)}</div>` : ''}
        ${ageStr ? `<div class="node-meta">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          ${ageStr}
        </div>` : ''}
        ${togetherStr ? `<div class="node-anniv" title="Anniversary: ${escape(anniIso)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-4.35-7-10.5C5 7.46 7.46 5 10.5 5c1.74 0 3.41.81 4.5 2.09C16.09 5.81 17.76 5 19.5 5 22.54 5 25 7.46 25 10.5 25 16.65 18 21 18 21H12z" fill="currentColor" transform="translate(-2 0)"/></svg>
          ${escape(togetherStr)}
        </div>` : ''}
        ${plan529HTML}
        ${flagsHTML}
      </div>
      ${toggleHTML}
      <button class="node-add" data-add-for="${m.id}" data-admin-only title="Add a relative connected to ${escape(m.firstName)}" aria-label="Add a relative">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
    </div>
  `;
}

// -------------------- DRAWER --------------------
const Drawer = {
  el: null, currentId: null, editing: false,
  init() {
    this.el = $('#drawer');
    on(this.el, 'click', (e) => {
      if (e.target.closest('[data-close]')) this.close();
    });

    on($('#drawer-edit-btn'), 'click', () => this.startEdit());
    on($('#drawer-cancel'),  'click', () => this.cancelEdit());
    on($('#drawer-edit'),    'submit', (e) => { e.preventDefault(); this.saveEdit(); });
    on($('#photo-input'),    'change', (e) => this.onPhoto(e));
    on($('#photo-clear'),    'click',  () => this.clearPhoto());
    on($('#photo-recrop'),   'click',  () => this.recropPhoto());
    on($('#drawer-pwd-btn'), 'click',  () => this.resetPassword());
    on($('#drawer-delete-btn'), 'click', () => this.deleteMember());
    on($('#drawer-divorce-btn'), 'click', () => this.toggleDivorce());
    on($('#drawer-link-btn'),    'click', () => LinkFamilyModal.open(this.currentId));
    on($('#kv-address-copy'),    'click', async () => {
      const m = Store.byId(this.currentId); if (!m) return;
      const addr = formatPostalAddress(m);
      if (!addr) return;
      try {
        await navigator.clipboard.writeText(addr);
        toast('Address copied.');
      } catch { toast('Copy failed.', 'warn'); }
    });
    on($('#kv-email-copy'), 'click', async () => {
      const m = Store.byId(this.currentId); if (!m || !m.email) return;
      try {
        await navigator.clipboard.writeText(m.email);
        toast('Email copied.');
      } catch { toast('Copy failed.', 'warn'); }
    });

    // Live phone formatting on the edit form
    bindPhoneFormat($('#drawer-edit').querySelector('input[name=phone]'));

    on($('#edit-anniversary'), 'input', () => {
      $('#edit-anniv-years').textContent = togetherLabel($('#edit-anniversary').value);
    });

    // Zip → city/state autofill
    on($('#edit-zip'), 'blur', async () => {
      const zip = $('#edit-zip').value.trim();
      const status = $('#edit-zip-status');
      if (!zip) { status.hidden = true; return; }
      if (!/^\d{5}$/.test(zip)) { status.hidden = true; return; }
      status.hidden = false; status.textContent = 'Looking up zip…';
      const r = await lookupZipUS(zip);
      if (r) {
        $('#edit-city').value  = r.city;
        $('#edit-state').value = r.state;
        status.textContent = `Auto-filled from ${zip} — edit if needed.`;
      } else {
        status.textContent = `Couldn't find ${zip}. Enter city and state manually.`;
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.el.getAttribute('aria-hidden') === 'false') this.close();
    });
  },
  open(id) {
    this.currentId = id;
    this.editing = false;
    this.renderView();
    this.el.setAttribute('aria-hidden', 'false');
  },
  close() {
    this.el.setAttribute('aria-hidden', 'true');
    this.currentId = null;
    this.editing = false;
    $('#drawer-view').hidden = false;
    $('#drawer-edit').hidden = true;
  },
  renderView() {
    const m = Store.byId(this.currentId); if (!m) return;
    // photo
    const photo = $('#drawer-photo');
    photo.className = 'drawer-photo is-' + m.gender;
    if (m.photo) {
      photo.style.backgroundImage = `url('${cssUrl(m.photo)}')`;
      photo.innerHTML = '';
    } else {
      photo.style.backgroundImage = '';
      photo.innerHTML = Silhouettes.for(m);
    }
    $('#drawer-relation').textContent = Tree.computeRelation(m.id) || 'Family';
    $('#drawer-name').textContent = displayName(m);
    // v4.29: International name surfaces directly under the H2 so it pairs
    // with the Latin name visually.
    const intlEl = $('#drawer-international-name');
    if (intlEl) {
      if (m.internationalName) {
        intlEl.textContent = m.internationalName;
        intlEl.hidden = false;
      } else {
        intlEl.textContent = '';
        intlEl.hidden = true;
      }
    }
    // Show the full legal name as a subtitle only when the display name is a
    // custom override — otherwise the headline and subtitle would duplicate.
    const legal = fullName(m);
    $('#drawer-nick').textContent = legal && legal !== displayName(m) ? legal : '';
    // "In loving memory" badge surfaces when a date of death is on file.
    const remembering = $('#drawer-remembering');
    if (remembering) remembering.hidden = !m.dateOfDeath;
    $('#kv-birthday').textContent = m.birthday ? formatDate(m.birthday) : '—';
    const dodRow = $('#kv-dod-row');
    if (dodRow) {
      if (m.dateOfDeath) {
        dodRow.hidden = false;
        $('#kv-dod').textContent = formatDate(m.dateOfDeath);
      } else { dodRow.hidden = true; }
    }
    $('#kv-lifestage').textContent = m.ageGroup ? capitalize(m.ageGroup) : '—';
    $('#kv-email').textContent = m.email || '—';
    $('#kv-email-copy').hidden = !m.email;
    $('#kv-phone').textContent = m.phone ? formatPhoneUS(m.phone) : '—';
    const fullAddr = formatPostalAddress(m);
    $('#kv-address').textContent = fullAddr || '—';
    $('#kv-address').style.whiteSpace = 'pre-line';
    $('#kv-address-copy').hidden = !fullAddr;
    // Anniversary row + "years together" — only meaningful if there's a current spouse.
    const sp = m.spouseId ? Store.byId(m.spouseId) : null;
    const isMarried = sp && !m.divorced && !sp.divorced;
    const annivRow = $('#kv-anniv-row');
    if (annivRow) {
      if (isMarried && m.anniversary) {
        annivRow.hidden = false;
        const yrs = yearsTogether(m.anniversary);
        const dateText = formatDate(m.anniversary);
        $('#kv-anniv').textContent = yrs != null
          ? `${dateText} · ${yrs} year${yrs === 1 ? '' : 's'} together`
          : dateText;
      } else {
        annivRow.hidden = true;
      }
    }
    $('#kv-group').textContent = m.group || '—';
    const eth = (m.ethnicities || []);
    $('#kv-ethnicity').innerHTML = eth.length
      ? eth.map(c => `<span class="kv-eth"><span class="kv-flag">${flagFor(c) || '🏳️'}</span> ${escape(ETH_BY_CODE[c]?.name || c)}</span>`).join('')
      : '—';
    $('#kv-role').textContent = capitalize(m.role);

    // 529 plan row (only when set)
    const plan529Row = $('#kv-529-row');
    if (plan529Row) {
      // Scheme-validate before assigning href — a raw 'javascript:' value would
      // otherwise execute on click (the tree-card path already normalizes). C3.
      const safe529 = safeHttpUrl(m.plan529);
      if (safe529) {
        plan529Row.hidden = false;
        const a = $('#kv-529');
        a.href = safe529;
        a.textContent = m.plan529;
      } else { plan529Row.hidden = true; }
    }
    // Notes section (only when set)
    const notesSection = $('#kv-notes-section');
    if (notesSection) {
      if ((m.notes || '').trim()) {
        notesSection.hidden = false;
        $('#kv-notes').textContent = m.notes;
      } else { notesSection.hidden = true; }
    }

    // relations
    const rels = Tree.relations(m);
    $('#drawer-relations').innerHTML = rels.length
      ? rels.map(r => relRow(r)).join('')
      : '<p class="muted small" style="margin:0;">No relations connected yet.</p>';
    $('#drawer-relations').querySelectorAll('.rel-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('.rel-unlink')) return;
        Drawer.open(row.dataset.id);
      });
    });
    $('#drawer-relations').querySelectorAll('.rel-unlink').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!Auth.isAdmin()) return;
        const other = Store.byId(btn.dataset.unlink); if (!other) return;
        const relLabel = btn.dataset.relLabel;
        if (!confirm(`Remove the ${relLabel} link to ${other.firstName} ${other.lastName}? They both stay in the tree.`)) return;
        unlinkRelation(this.currentId, other.id, relLabel);
        inheritEthnicities();
        autoLayout();
        Canvas.renderAll();
        Drawer.renderView();
        toast('Relationship removed.');
      });
    });

    // Gifts section visibility. Family role only sees Gifts on self / spouse
    // cards — other members of the household hide it. Admin always sees it;
    // plain User keeps the legacy "always shown" behavior.
    const giftsSection = $('#drawer-gifts-section');
    if (giftsSection) {
      const showGifts = Auth.canSeeDrawerGiftsFor(m);
      giftsSection.hidden = !showGifts;
      if (showGifts) renderDrawerGifts(m);
      else $('#drawer-gifts').innerHTML = '';
    } else {
      renderDrawerGifts(m);
    }

    // permissions
    const canEdit = Auth.canEditMember(m);
    $('#drawer-edit-btn').toggleAttribute('hidden', !canEdit);

    // divorce-status toggle visibility + label (uses joint state). The
    // button itself is also gated by `data-admin-only` in the HTML so
    // Family/User never see it regardless of spouse status; we still
    // compute the label for the admin case here.
    const divorceBtn = $('#drawer-divorce-btn');
    if (m.spouseId) {
      divorceBtn.hidden = false;
      const spouse = Store.byId(m.spouseId);
      const isDivorced = !!(m.divorced || spouse?.divorced);
      divorceBtn.textContent = isDivorced ? 'Restore as married' : 'Mark as divorced';
    } else {
      divorceBtn.hidden = true;
    }

    $('#drawer-view').hidden = false;
    $('#drawer-edit').hidden = true;

    // node selection state
    document.querySelectorAll('.node.is-selected').forEach(n => n.classList.remove('is-selected'));
    document.querySelector(`.node[data-id="${m.id}"]`)?.classList.add('is-selected');
  },
  startEdit() {
    const m = Store.byId(this.currentId); if (!m) return;
    this.editing = true;
    const f = $('#drawer-edit');
    f.firstName.value = m.firstName;
    f.middleName.value = m.middleName || '';
    f.lastName.value = m.lastName;
    f.displayName.value = m.displayName || '';
    if (f.internationalName) f.internationalName.value = m.internationalName || '';
    f.birthday.value = m.birthday || '';
    f.phone.value = formatPhoneUS(m.phone || '');
    f.email.value = m.email || '';
    f.address.value = m.address || '';
    f.zip.value   = m.zip   || '';
    f.city.value  = m.city  || '';
    f.state.value = m.state || '';
    if (f.dateOfDeath) f.dateOfDeath.value = m.dateOfDeath || '';
    // Date-of-death is gated behind a checkbox so the date input only appears
    // when "Deceased" is checked. Keeps the field from being accidentally
    // populated by tab-fills or stray clicks on the date picker.
    const dodCheck = $('#edit-has-dod');
    const dodInput = $('#edit-dod');
    if (dodCheck && dodInput) {
      const hasDod = !!m.dateOfDeath;
      dodCheck.checked = hasDod;
      dodInput.hidden = !hasDod;
      dodCheck.onchange = () => {
        dodInput.hidden = !dodCheck.checked;
        if (!dodCheck.checked) dodInput.value = '';
      };
    }
    if (f.plan529)     f.plan529.value     = m.plan529 || '';
    if (f.notes)       f.notes.value       = m.notes   || '';
    $('#edit-zip-status').hidden = true;
    f.gender.value = m.gender;
    f.ageGroup.value = m.ageGroup;
    if (f.role) f.role.value = m.role;
    refreshGroupSelect($('#edit-group'), m.group);
    // Per-member opt-out for "+ Add by group…" on events. Default true so
    // members keep their current behavior unless an admin unchecks it.
    const grpEvtBox = $('#edit-group-events');
    if (grpEvtBox) grpEvtBox.checked = m.includeInGroupEvents !== false;
    const excludeBox = $('#edit-exclude-events');
    if (excludeBox) excludeBox.checked = !!m.excludeFromEventsList;
    const ePicker = $('[data-picker="edit-ethnicity"]');
    EthnicityPicker.mount(ePicker);
    EthnicityPicker.write(ePicker, m.ethnicities || []);

    // Anniversary: only show the field when the focus member has a current spouse.
    const sp = m.spouseId ? Store.byId(m.spouseId) : null;
    const married = sp && !m.divorced && !sp.divorced;
    const annivWrap = $('#edit-anniversary-wrap');
    if (married) {
      annivWrap.hidden = false;
      $('#edit-anniversary').value = m.anniversary || sp.anniversary || '';
      const yrs = yearsTogether($('#edit-anniversary').value);
      $('#edit-anniv-years').textContent = yrs != null
        ? `${yrs} year${yrs === 1 ? '' : 's'} together`
        : '';
    } else {
      annivWrap.hidden = true;
      $('#edit-anniversary').value = '';
      $('#edit-anniv-years').textContent = '';
    }

    const preview = $('#photo-preview');
    if (m.photo) { preview.style.backgroundImage = `url('${cssUrl(m.photo)}')`; preview.innerHTML = ''; }
    else { preview.style.backgroundImage = ''; preview.innerHTML = Silhouettes.for(m); }
    f.dataset.tempPhoto = '';
    // The Crop button only makes sense when there's a photo to crop. It tracks
    // both the saved photo and any in-flight tempPhoto from this edit session.
    $('#photo-recrop').hidden = !m.photo;

    $('#drawer-view').hidden = true;
    $('#drawer-edit').hidden = false;
  },
  cancelEdit() {
    this.editing = false;
    $('#drawer-view').hidden = false;
    $('#drawer-edit').hidden = true;
  },
  async saveEdit() {
    const m = Store.byId(this.currentId); if (!m) return;
    const f = $('#drawer-edit');
    const fd = new FormData(f);
    const firstName = (fd.get('firstName') || '').toString().trim();
    const lastName  = (fd.get('lastName')  || '').toString().trim();
    if (!firstName || !lastName) { toast('First and last name are required.', 'warn'); return; }

    m.firstName  = firstName;
    m.middleName = (fd.get('middleName') || '').toString().trim();
    m.lastName   = lastName;
    m.displayName = (fd.get('displayName') || '').toString().trim();
    m.internationalName = (fd.get('internationalName') || '').toString().trim();
    m.birthday   = (fd.get('birthday') || '').toString();
    // Normalize phone to a consistent "(XXX) XXX-XXXX" format on save.
    m.phone      = formatPhoneUS((fd.get('phone') || '').toString());
    m.email      = (fd.get('email') || '').toString().trim();
    m.address    = (fd.get('address') || '').toString().trim();
    m.city       = (fd.get('city')  || '').toString().trim();
    m.state      = (fd.get('state') || '').toString().trim().toUpperCase().slice(0, 3);
    m.zip        = (fd.get('zip')   || '').toString().trim().slice(0, 10);
    // Only honor the date input when the "Deceased" checkbox is checked.
    // Otherwise force-clear so an accidental date entry can't sneak through.
    m.dateOfDeath = $('#edit-has-dod')?.checked
      ? (fd.get('dateOfDeath') || '').toString()
      : '';
    m.plan529    = (fd.get('plan529') || '').toString().trim();
    m.notes      = (fd.get('notes')   || '').toString();
    m.group      = (fd.get('group') || '').toString();
    m.includeInGroupEvents = !!$('#edit-group-events')?.checked;
    m.excludeFromEventsList = !!$('#edit-exclude-events')?.checked;
    // Anniversary: only meaningful when there's a current spouse; mirror to the
    // spouse so both records stay in sync.
    const sp_save = m.spouseId ? Store.byId(m.spouseId) : null;
    const married_save = sp_save && !m.divorced && !sp_save.divorced;
    if (married_save) {
      const aniso = (fd.get('anniversary') || '').toString();
      m.anniversary = aniso;
      sp_save.anniversary = aniso;
    }

    if (Auth.isAdmin()) {
      m.gender   = (fd.get('gender') || m.gender).toString();
      const newRole = (fd.get('role') || m.role).toString();
      m.role = newRole;
    }
    // Life stage: auto-derived from the birthday when known; the explicit
    // select still wins when no birthday is set or the user changed it.
    const submittedAgeGroup = (fd.get('ageGroup') || '').toString();
    const auto = ageGroupForBirthday(m.birthday);
    m.ageGroup = auto || submittedAgeGroup || m.ageGroup || 'adult';
    m.ethnicities = EthnicityPicker.read($('[data-picker="edit-ethnicity"]'));

    if (f.dataset.tempPhoto === 'cleared') m.photo = null;
    else if (f.dataset.tempPhoto && f.dataset.tempPhoto !== 'cleared') m.photo = f.dataset.tempPhoto;

    Store.save();
    toast('Profile saved.');
    this.editing = false;
    Canvas.renderAll();
    UserChip.refresh();
    this.renderView();
    if (Views.current === 'admin') AdminView.render();
  },
  onPhoto(e) {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const cropped = await CropModal.open(reader.result, { size: 480 });
      // reset the input so picking the same file again still fires `change`
      e.target.value = '';
      if (!cropped) return; // user cancelled
      const f = $('#drawer-edit');
      f.dataset.tempPhoto = cropped;
      const preview = $('#photo-preview');
      preview.innerHTML = '';
      preview.style.backgroundImage = `url('${cssUrl(cropped)}')`;
      $('#photo-recrop').hidden = false;
    };
    reader.readAsDataURL(file);
  },
  // Re-crop the photo currently on display (saved or in-flight). The cropper
  // outputs a fixed-size JPEG, so re-cropping a previously-cropped image is
  // still useful for repositioning but won't recover detail outside the
  // earlier crop. That's a reasonable trade-off for not storing two copies.
  async recropPhoto() {
    const f = $('#drawer-edit');
    const m = Store.byId(this.currentId);
    const source = (f.dataset.tempPhoto && f.dataset.tempPhoto !== 'cleared')
      ? f.dataset.tempPhoto
      : m?.photo;
    if (!source) return;
    const cropped = await CropModal.open(source, { size: 480 });
    if (!cropped) return; // user cancelled
    f.dataset.tempPhoto = cropped;
    const preview = $('#photo-preview');
    preview.innerHTML = '';
    preview.style.backgroundImage = `url('${cssUrl(cropped)}')`;
  },
  clearPhoto() {
    const f = $('#drawer-edit');
    f.dataset.tempPhoto = 'cleared';
    const m = Store.byId(this.currentId);
    const preview = $('#photo-preview');
    preview.style.backgroundImage = '';
    preview.innerHTML = Silhouettes.for({ gender: f.gender.value, ageGroup: f.ageGroup.value });
    $('#photo-recrop').hidden = true;
  },
  async resetPassword() {
    if (!Auth.isAdmin()) return;
    const m = Store.byId(this.currentId); if (!m) return;
    await sendAdminResetEmail(m);
  },
  deleteMember() {
    if (!Auth.isAdmin()) return;
    const m = Store.byId(this.currentId); if (!m) return;
    if (!confirm(`Remove ${displayName(m)} from the family tree? Their account will be deleted.`)) return;
    Tree.remove(m.id);
    toast('Member removed.');
    this.close();
    Canvas.renderAll();
    if (Views.current === 'admin') AdminView.render();
  },
  toggleDivorce() {
    if (!Auth.isAdmin()) return;
    const m = Store.byId(this.currentId); if (!m || !m.spouseId) return;
    const s = Store.byId(m.spouseId);
    // One-way: move the current spouse into both sides' exSpouseIds and
    // clear spouseId. To "restore" later, the admin re-links via Link to
    // family. This keeps the data model simple now that exSpouseIds can hold
    // multiple past spouses.
    if (s) {
      s.exSpouseIds = unique([...(s.exSpouseIds || []), m.id]);
      s.spouseId = null;
      s.divorced = false;
    }
    m.exSpouseIds = unique([...(m.exSpouseIds || []), m.spouseId]);
    m.spouseId = null;
    m.divorced = false;
    Store.save();
    toast(s ? `Marked as divorced from ${s.firstName} ${s.lastName}.` : 'Marked as divorced.');
    Canvas.renderAll();
    this.renderView();
  },
};

// Profile drawer Gifts section: lists what `member` received and gave,
// each entry on its own row, with totals at the bottom. An event link
// renders as a small chip that jumps to the Events page.
function renderDrawerGifts(member) {
  const host = $('#drawer-gifts'); if (!host) return;
  const all = Store.state.gifts || [];
  const events = Store.state.events || [];
  const eventById = new Map(events.map(e => [e.id, e]));
  const fmtMoney = (n) => (n == null || isNaN(n)) ? '' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const received = all.filter(g => g.toMemberId === member.id);
  const given    = all.filter(g => Array.isArray(g.fromMemberIds) && g.fromMemberIds.includes(member.id));

  const rowHTML = (g, perspective) => {
    // perspective = 'received' → show who it's from; 'given' → show who it's to.
    const ev = g.eventId ? eventById.get(g.eventId) : null;
    let other = '';
    if (perspective === 'received') {
      const fromNames = (g.fromMemberIds || []).map(id => {
        const m = Store.byId(id); return m ? displayName(m) : null;
      }).filter(Boolean);
      other = fromNames.join(', ') || g.fromText || '—';
    } else {
      const to = g.toMemberId ? Store.byId(g.toMemberId) : null;
      other = to ? displayName(to) : (g.toText || '—');
    }
    const date = g.date ? formatDate(g.date) : '';
    const amount = fmtMoney(g.amount);
    const occasion = g.occasion || g.item || '';
    const eventChip = ev
      ? `<button type="button" class="gift-event-chip" data-event-id="${ev.id}" title="Open event">${ev.icon || '🎉'} ${escape(ev.name || 'Event')}</button>`
      : '';
    return `
      <div class="gift-row" data-direction="${perspective}">
        <div class="gift-row-main">
          <span class="gift-direction">${perspective === 'received' ? 'From' : 'To'}</span>
          <span class="gift-other">${escape(other)}</span>
          ${eventChip}
          ${occasion ? `<span class="gift-occasion">${escape(occasion)}</span>` : ''}
        </div>
        <div class="gift-row-meta">
          ${date ? `<span class="gift-date">${escape(date)}</span>` : ''}
          ${amount ? `<span class="gift-amount">${escape(amount)}</span>` : ''}
        </div>
      </div>`;
  };

  const sumAmount = (list) => list.reduce((s, g) => s + (Number(g.amount) || 0), 0);
  const receivedTotal = sumAmount(received);
  const givenTotal    = sumAmount(given);
  const net           = receivedTotal - givenTotal;

  const section = (title, rows, total, perspective) => {
    if (!rows.length) return `<p class="muted small">${title === 'Received' ? 'No gifts received yet.' : 'No gifts given yet.'}</p>`;
    const sorted = rows.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return `
      <div class="gifts-bucket">
        <div class="gifts-bucket-head">
          <h5>${title}</h5>
          <span class="gifts-bucket-total">Total ${fmtMoney(total) || '$0.00'}</span>
        </div>
        <div class="gifts-rows">
          ${sorted.map(g => rowHTML(g, perspective)).join('')}
        </div>
      </div>`;
  };

  host.innerHTML = `
    ${section('Received', received, receivedTotal, 'received')}
    ${section('Given',    given,    givenTotal,    'given')}
    <div class="gifts-net">Net: <strong>${(net >= 0 ? '+' : '') + fmtMoney(Math.abs(net))}</strong></div>
  `;

  host.querySelectorAll('.gift-event-chip').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.eventId;
      EventsView.selectedId = id;
      Views.show('events');
    });
  });
}

function relRow(r) {
  const m = r.member;
  const bg = m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : '';
  return `
    <div class="rel-row" data-id="${m.id}" data-rel="${r.label.toLowerCase()}">
      <div class="rel-avatar is-${m.gender}" ${bg}></div>
      <div class="rel-info">
        <span class="rel-label">${r.label}</span>
        <span class="rel-name">${escape(displayName(m))}</span>
      </div>
      <button class="rel-unlink" data-unlink="${m.id}" data-rel-label="${r.label.toLowerCase()}" title="Unlink this relationship" aria-label="Unlink">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="none"><path d="M6.5 2.5h-2A2.5 2.5 0 0 0 2 5v0a2.5 2.5 0 0 0 2.5 2.5h2M9.5 2.5h2A2.5 2.5 0 0 1 14 5v0a2.5 2.5 0 0 1-2.5 2.5h-2M6.5 5h3M3 13l10-10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
    </div>
  `;
}

// Remove the relationship between two members (a's perspective).
function unlinkRelation(aId, bId, relLabel) {
  const a = Store.byId(aId), b = Store.byId(bId);
  if (!a || !b) return;
  const r = (relLabel || '').toLowerCase();
  if (r === 'spouse') {
    a.spouseId = null; a.divorced = false;
    b.spouseId = null; b.divorced = false;
  } else if (r === 'previous spouse') {
    a.exSpouseIds = (a.exSpouseIds || []).filter(x => x !== b.id);
    b.exSpouseIds = (b.exSpouseIds || []).filter(x => x !== a.id);
  } else if (r === 'parent') {
    // b is a's parent → drop b from a.parentIds, drop a from b.childrenIds
    a.parentIds = (a.parentIds || []).filter(x => x !== b.id);
    b.childrenIds = (b.childrenIds || []).filter(x => x !== a.id);
  } else if (r === 'child') {
    // b is a's child → drop a from b.parentIds, drop b from a.childrenIds
    b.parentIds   = (b.parentIds   || []).filter(x => x !== a.id);
    a.childrenIds = (a.childrenIds || []).filter(x => x !== b.id);
  } else if (r === 'sibling') {
    a.siblingLinkIds = (a.siblingLinkIds || []).filter(x => x !== b.id);
    b.siblingLinkIds = (b.siblingLinkIds || []).filter(x => x !== a.id);
  }
  Store.save();
}

// -------------------- VIEWS --------------------
const Views = {
  current: 'tree',
  _renderTimer: null,
  show(name) {
    // v4.35: legacy 'friend-tree' view target now routes into the Members
    // page, Friends sub-tab. Keeps any persisted nav state working.
    let pendingMemberTab = null;
    if (name === 'friend-tree') { name = 'admin'; pendingMemberTab = 'friends'; }
    // Family role gets Calendar (read-only); everything else in the
    // admin-only set still bounces them to Tree.
    if ((name === 'admin' || name === 'gifts' || name === 'dashboard' || name === 'history') && !Auth.isAdmin()) name = 'tree';
    if (name === 'calendar' && !Auth.canViewCalendar()) name = 'tree';
    if (name === 'vault' && !Auth.canAccessVault()) name = 'tree';
    if (name === 'events' && !Auth.isAdmin() && !userEventsList().length) name = 'tree';
    // v4.40: My Kids access. Admin can always view. A linked kid can view
    // their own page only (handled inside MyKidsView when selecting a kid).
    // Non-admin, non-kid users are bounced to Tree.
    if (name === 'mykids' && !Auth.isAdmin() && !MyKidsView.canViewerAccess()) name = 'tree';
    // v4.44: Recipes is family-wide (any authenticated user can view). No
    // role gating needed beyond the implicit "must be signed in".
    this.current = name;
    // Synchronous visibility flip — cheap and gives the click immediate
    // visual feedback (active nav-tab + new view shown).
    $$('.nav-tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === name));
    $('#view-dashboard').hidden    = name !== 'dashboard';
    $('#view-tree').hidden         = name !== 'tree';
    $('#view-myfamily').hidden     = name !== 'myfamily';
    $('#view-mykids').hidden       = name !== 'mykids';
    $('#view-recipes').hidden      = name !== 'recipes';
    $('#view-memories').hidden     = name !== 'memories';
    $('#view-timecapsule').hidden  = name !== 'timecapsule';
    $('#view-stories').hidden      = name !== 'stories';
    $('#view-admin').hidden        = name !== 'admin';
    $('#view-vault').hidden        = name !== 'vault';
    $('#view-history').hidden      = name !== 'history';
    $('#view-events').hidden       = name !== 'events';
    $('#view-calendar').hidden     = name !== 'calendar';
    $('#view-gifts').hidden        = name !== 'gifts';
    // Leaving the dashboard: stop its background clock interval (v4.56).
    if (name !== 'dashboard') DashboardView.stopClock();
    // Defer the heavy per-view render to a fresh task. The click handler
    // returns immediately and the browser paints the visibility change in
    // <50ms (good INP). The render — which can run 100ms+ on a populated
    // archive (autoLayout, edges SVG, large innerHTML builds) — happens on
    // the next task and is no longer counted against this click's INP.
    // Coalesce rapid nav-tab clicks so only the latest target renders.
    if (this._renderTimer) clearTimeout(this._renderTimer);
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      if (this.current !== name) return;
      if (name === 'dashboard') DashboardView.render();
      if (name === 'admin') {
        if (pendingMemberTab) AdminView.activeTab = pendingMemberTab;
        AdminView.render();
      }
      if (name === 'vault')     VaultView.render();
      if (name === 'history')   HistoryView.render();
      if (name === 'events')    EventsView.render();
      if (name === 'calendar')  CalendarView.render();
      if (name === 'gifts')     GiftsView.render();
      if (name === 'myfamily')  MyFamilyView.render();
      if (name === 'mykids')    MyKidsView.render();
      if (name === 'recipes')   RecipesView.render();
      if (name === 'memories')  MemoriesView.showSubtab(MemoriesView.subtab);
      if (name === 'timecapsule') TimeCapsuleView.render();
      if (name === 'stories')   StoriesView.render();
      if (name === 'tree')      Canvas.renderAll();
    }, 0);
  },
};

// -------------------- MY FAMILY VIEW --------------------
// Personalized mini-tree: parents + focus member (+ spouse) + children.
// Admins can pick any member from the dropdown; users always see their own.
// Layout is a simple 3-row grid; connectors are drawn orthogonally to match
// the Family Tree page's visual language.
const MyFamilyView = {
  pickedMemberId: null,
  init() {
    on($('#myfamily-picker'), 'change', (e) => {
      this.pickedMemberId = e.target.value || null;
      this.render();
    });
  },

  // Resolve who the view is centered on.
  focusMember() {
    if (Auth.isAdmin()) {
      // Admin picker; default to the first member alphabetically.
      const all = sortMembers(Store.membersList());
      if (!all.length) return null;
      const picked = this.pickedMemberId ? Store.byId(this.pickedMemberId) : null;
      return picked || all[0];
    }
    return Auth.current && Auth.current !== 'admin-bootstrap' ? Auth.current : null;
  },

  // Refresh the admin picker options. Keeps the current selection if still valid.
  refreshPicker(currentId) {
    const sel = $('#myfamily-picker');
    if (!sel) return;
    const all = sortMembers(Store.membersList());
    sel.innerHTML = all.map(m =>
      `<option value="${m.id}" ${m.id === currentId ? 'selected' : ''}>${escape(displayName(m))}</option>`
    ).join('');
  },

  render() {
    const focus = this.focusMember();
    const stage = $('#myfamily-stage');
    const world = $('#myfamily-world');
    const nodes = $('#myfamily-nodes');
    const edges = $('#myfamily-edges');
    const empty = $('#myfamily-empty');
    const title = $('#myfamily-title');
    const sub   = $('#myfamily-sub');

    // Show / hide the admin picker
    $('#myfamily-tools').hidden = !Auth.isAdmin();
    if (Auth.isAdmin()) this.refreshPicker(focus?.id);

    if (!focus) {
      nodes.innerHTML = '';
      edges.innerHTML = '';
      world.style.transform = '';
      empty.hidden = false;
      empty.innerHTML = Auth.isAdmin()
        ? '<p class="muted">No members yet. Add one on the Family Tree page.</p>'
        : '<p class="muted">Your account is not linked to a family member yet. Ask an admin to add you.</p>';
      title.textContent = 'My Family';
      sub.textContent = 'Your parents, spouse, and children at a glance.';
      return;
    }
    empty.hidden = true;

    // Header copy reflects whose family is on screen.
    if (Auth.isAdmin()) {
      title.textContent = `${focus.firstName} ${focus.lastName}'s family`;
      sub.textContent = `${focus.firstName}'s parents, spouse, and children.`;
    } else {
      title.textContent = 'My Family';
      sub.textContent = 'Your parents, spouse, and children at a glance.';
    }

    // Collect the cast.
    // Bio parents: union of focus.parentIds and anyone whose childrenIds
    // includes focus (reverse-lookup catches asymmetric data) PLUS each
    // such parent's current spouse — but only when that parent has no
    // ex-spouses. The "no exes" guard is what tells step-parents apart
    // from bio co-parents:
    //   - Duc Nguyen has no exes → his current spouse Cuc Tran is almost
    //     certainly Doan's bio mother (no remarriage to obscure it).
    //   - Hee Yoo has an ex (Myong) → his current spouse Kimberly is a
    //     step-parent, not Ted/Sarah's bio mother.
    // Step-parents (current spouse of a bio parent who DID remarry) are
    // collected separately below and shown as in-laws in the parents row
    // without a parent-line down to the focus.
    const parentIdSet = new Set(focus.parentIds || []);
    Store.membersList().forEach(o => {
      if ((o.childrenIds || []).includes(focus.id)) parentIdSet.add(o.id);
    });
    [...parentIdSet].forEach(pid => {
      const p = Store.byId(pid);
      if (p && p.spouseId && !(p.exSpouseIds || []).length) {
        parentIdSet.add(p.spouseId);
      }
    });
    const parents = [...parentIdSet].map(id => Store.byId(id)).filter(Boolean);

    // Step-parents: every spouse — current OR ex — of a bio parent who is
    // NOT themselves a bio parent of the focus. Showing exes here surfaces
    // half-siblings' other parent (e.g. Tony Chang's ex Mimi Morse, who is
    // bio mother of Heather Grisnik but not of Suejin Chang). Each renders
    // in the parents row next to their bio-parent spouse with a heart
    // (solid for current, broken for ex) and no parent-line to the focus.
    const stepParentIds = new Set();
    parents.forEach(p => {
      if (p.spouseId && !parentIdSet.has(p.spouseId)) stepParentIds.add(p.spouseId);
      (p.exSpouseIds || []).forEach(eid => {
        if (!parentIdSet.has(eid)) stepParentIds.add(eid);
      });
    });
    const stepParents = [...stepParentIds].map(id => Store.byId(id)).filter(Boolean);
    // stepParentOf[stepParentId] → the bio parent this step-parent is/was
    // married to. Used by the layout to interleave them adjacent to that
    // bio parent and by the edge renderer to draw the heart marker.
    const stepParentOf = {};
    parents.forEach(p => {
      if (p.spouseId && stepParentIds.has(p.spouseId)) stepParentOf[p.spouseId] = p.id;
      (p.exSpouseIds || []).forEach(eid => {
        if (stepParentIds.has(eid) && stepParentOf[eid] == null) stepParentOf[eid] = p.id;
      });
    });

    const spouse  = focus.spouseId ? Store.byId(focus.spouseId) : null;
    const exes    = (focus.exSpouseIds || [])
      .map(id => Store.byId(id))
      .filter(Boolean);
    // Siblings: anyone sharing a parent with focus (union from both
    // directions, same defense as the parents calculation above) PLUS any
    // child of a visible step-parent. The step-sibling case surfaces
    // half-siblings that share only one parent — e.g. Heather Grisnik
    // (Tony + Mimi) shows up in Suejin's view via Tony's childrenIds, and
    // Jewelia Chang (Mimi only) shows up via her bio mother Mimi being a
    // step-parent. The actual parent-line routing further down then routes
    // each kid to their own bio parents only.
    const sibIdSet = new Set();
    parentIdSet.forEach(pid => {
      const p = Store.byId(pid); if (!p) return;
      (p.childrenIds || []).forEach(cid => { if (cid !== focus.id) sibIdSet.add(cid); });
    });
    stepParents.forEach(sp => {
      (sp.childrenIds || []).forEach(cid => { if (cid !== focus.id) sibIdSet.add(cid); });
    });
    Store.membersList().forEach(o => {
      // Reverse-lookup: if any visible parent (bio OR step) also lists
      // someone else as their child, pick that up too. Without including
      // step-parents in this lookup we miss step-siblings when only the
      // step-parent's side of the link is wired.
      const sharedParents = (o.parentIds || []).some(pid =>
        parentIdSet.has(pid) || stepParentIds.has(pid));
      if (sharedParents && o.id !== focus.id) sibIdSet.add(o.id);
    });
    const siblings = [...sibIdSet].map(id => Store.byId(id)).filter(Boolean);
    // Children: union from focus + current spouse + every ex. A child from
    // a previous marriage still belongs in this view — they're family.
    const allPartners = [...(spouse ? [spouse] : []), ...exes];
    const childIds = unique([
      ...(focus.childrenIds || []),
      ...allPartners.flatMap(p => p.childrenIds || []),
    ]);
    const children = childIds.map(id => Store.byId(id)).filter(Boolean);
    // In-laws: each child's current spouse joins the children row so the
    // user sees who their kids married. Tracked as separate so the layout
    // can interleave them and the connector code can skip them.
    const childSpouseIds = unique(
      children.map(c => c.spouseId).filter(Boolean)
    ).filter(id => !childIds.includes(id));  // dedupe: in-law isn't also a child
    const childSpouses = childSpouseIds.map(id => Store.byId(id)).filter(Boolean);
    const childSpouseOf = {};  // childSpouseId → child id (for layout adjacency)
    children.forEach(c => { if (c.spouseId && childSpouseOf[c.spouseId] == null) childSpouseOf[c.spouseId] = c.id; });

    // Grandchildren: the children of any of the children OR their spouses.
    const grandIds = unique([
      ...children.flatMap(c => c.childrenIds || []),
      ...childSpouses.flatMap(s => s.childrenIds || []),
    ]);
    const grandchildren = grandIds.map(id => Store.byId(id)).filter(Boolean);

    // Layout: 3 rows. Each row is centered horizontally around x = 0.
    // Card geometry matches the main Family Tree.
    const CW = NODE_W, CH = NODE_H;
    const GAP_X = 60;
    // Generous row gap so multi-group parent trunks (e.g. half-siblings
    // routed under different parent pairs) can stagger their trunks on
    // separate Y lanes without overlapping the heart-line area or each
    // other. v4.10 had 100 here and the parent → kid trunks all bunched
    // into a 60px-wide horizontal strip below the parents row.
    const ROW_GAP = 160;

    const rowFor = {};        // memberId → { x, y }
    const placeRow = (members, y) => {
      const n = members.length;
      if (!n) return;
      const totalW = n * CW + (n - 1) * GAP_X;
      let x = -totalW / 2;
      members.forEach(m => {
        rowFor[m.id] = { x, y };
        x += CW + GAP_X;
      });
    };

    // Skip rows that wouldn't contain anyone so vertical space doesn't get
    // wasted (e.g. a member with no parents shouldn't have an empty top row).
    const Y_PARENTS  = 0;
    const Y_FOCUS    = parents.length ? CH + ROW_GAP : 0;
    const Y_CHILDREN = Y_FOCUS + CH + ROW_GAP;
    const Y_GRAND    = Y_CHILDREN + CH + ROW_GAP;

    // Parents row interleaves: bio parent → their bio co-parent (if any) →
    // their step-parents (current spouse then exes), then next bio parent.
    // Placing the bio co-parent adjacent makes the bio-couple heart land
    // between them; step-parents tail after so each step gets its own heart
    // connector with the bio parent without crossing over the bio co-parent.
    const parentsRow = [];
    const seenInParentsRow = new Set();
    parents.forEach(p => {
      if (seenInParentsRow.has(p.id)) return;
      parentsRow.push(p); seenInParentsRow.add(p.id);
      // Bio co-parent next to them (a parent whose ID is in parentIdSet).
      if (p.spouseId && parentIdSet.has(p.spouseId) && !seenInParentsRow.has(p.spouseId)) {
        const sp = Store.byId(p.spouseId);
        if (sp) { parentsRow.push(sp); seenInParentsRow.add(sp.id); }
      }
      // Current step-parent.
      if (p.spouseId && stepParentIds.has(p.spouseId) && !seenInParentsRow.has(p.spouseId)) {
        const sp = Store.byId(p.spouseId);
        if (sp) { parentsRow.push(sp); seenInParentsRow.add(sp.id); }
      }
      // Ex-spouse step-parents.
      (p.exSpouseIds || []).forEach(eid => {
        if (stepParentIds.has(eid) && !seenInParentsRow.has(eid)) {
          const sp = Store.byId(eid);
          if (sp) { parentsRow.push(sp); seenInParentsRow.add(sp.id); }
        }
      });
    });
    // Trailing step-parents whose bio link wasn't visited above (defensive —
    // shouldn't happen with the iteration above, but keeps them on screen).
    stepParents.forEach(sp => {
      if (!seenInParentsRow.has(sp.id)) { parentsRow.push(sp); seenInParentsRow.add(sp.id); }
    });
    placeRow(parentsRow, Y_PARENTS);
    // Focus row: [current spouse, focus, exes..., siblings...]. Current spouse
    // on the left, exes on the right, siblings tailing after exes — all on
    // the same level since they're peers of the focus.
    const focusRow = spouse
      ? [spouse, focus, ...exes, ...siblings]
      : [focus, ...exes, ...siblings];
    placeRow(focusRow, Y_FOCUS);
    // Children row: each child immediately followed by their spouse if any.
    // Interleaving keeps couples visually together.
    const childrenRow = [];
    const seenInChildrenRow = new Set();
    children.forEach(c => {
      if (seenInChildrenRow.has(c.id)) return;
      childrenRow.push(c); seenInChildrenRow.add(c.id);
      if (c.spouseId) {
        const sp = Store.byId(c.spouseId);
        if (sp && !seenInChildrenRow.has(sp.id) && !childIds.includes(sp.id)) {
          childrenRow.push(sp); seenInChildrenRow.add(sp.id);
        }
      }
    });
    placeRow(childrenRow, Y_CHILDREN);
    placeRow(grandchildren, Y_GRAND);

    // World bounds — compute min/max so we can center the canvas.
    const all = [focus, ...parents, ...stepParents, ...allPartners, ...siblings, ...children, ...childSpouses, ...grandchildren];
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    all.forEach(m => {
      const p = rowFor[m.id];
      if (!p) return;
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + CW);
      maxY = Math.max(maxY, p.y + CH);
    });
    const worldW = Math.max(maxX - minX, 320);
    const worldH = Math.max(maxY, CH);

    // Center the world inside the stage by translating contents so that the
    // logical x = 0 sits at the horizontal midpoint of the stage.
    const stageW = stage.clientWidth || 1200;
    const padTop = 40;
    const shiftX = stageW / 2;
    const shiftY = padTop;
    world.style.width  = `${stageW}px`;
    world.style.height = `${worldH + padTop * 2}px`;

    // Pre-compute kid → parent-group mapping for color coding (consumed by
    // both the node render below and the edges section further down). When
    // there are 2+ parent groups (i.e. half-siblings with different parent
    // pairs), each kid card gets its parent-group hue painted onto its
    // gen-bar so the branches read as visually distinct.
    const kidHueByMember = new Map();
    let kidGroups = []; // { ps, kids, key, _lane, _hue }
    if (parents.length || stepParents.length) {
      const adultsInRow = new Set([
        ...parents.map(p => p.id),
        ...stepParents.map(p => p.id),
      ]);
      const _groups = new Map();
      [focus, ...siblings].forEach(k => {
        const visible = (k.parentIds || []).filter(pid => adultsInRow.has(pid));
        if (!visible.length) return;
        const key = visible.slice().sort().join('|');
        if (!_groups.has(key)) {
          _groups.set(key, { ps: visible.map(id => Store.byId(id)).filter(Boolean), kids: [], key });
        }
        _groups.get(key).kids.push(k);
      });
      kidGroups = [..._groups.values()];
      const hueMap = kidGroups.length > 1 ? buildFamilyHueMap(kidGroups.map(g => g.key)) : null;
      kidGroups.forEach((g, i) => { g._lane = i; g._hue = hueMap?.get(g.key); });
      if (kidGroups.length > 1) {
        kidGroups.forEach(g => g.kids.forEach(k => kidHueByMember.set(k.id, g._hue)));
      }
    }

    // -------- nodes --------
    const renderableMembers = [focus, ...parents, ...stepParents, ...allPartners, ...siblings, ...children, ...childSpouses, ...grandchildren];
    nodes.innerHTML = renderableMembers.map(m => {
      const p = rowFor[m.id]; if (!p) return '';
      let html = nodeHTML(m);
      // Apply the parent-group hue to a kid card whose parents differ from
      // their siblings (Suejin's view of Heather/Jewelia, etc.). We inject
      // --gen overrides at the front of the existing inline style so the
      // gen-bar adopts the group color without touching nodeHTML itself.
      const kidHue = kidHueByMember.get(m.id);
      if (kidHue != null) {
        const accent = `hsl(${kidHue} 65% 48%)`;
        const accentSoft = `hsl(${kidHue} 65% 92%)`;
        html = html.replace('style="', `style="--gen: ${accent}; --gen-soft: ${accentSoft}; `);
      }
      // nodeHTML produces a translate(x, y) inline style. Override with our row coords.
      return html.replace(/transform:\s*translate\([^)]+\);/, `transform: translate(${p.x + shiftX}px, ${p.y + shiftY}px);`);
    }).join('');

    // -------- edges (orthogonal connectors) --------
    const ANCHOR_TOP = (id) => {
      const p = rowFor[id];
      return { x: p.x + CW / 2 + shiftX, y: p.y + shiftY };
    };
    const ANCHOR_BOTTOM = (id) => {
      const p = rowFor[id];
      return { x: p.x + CW / 2 + shiftX, y: p.y + CH + shiftY };
    };

    const lines = [];
    const exLines = []; // dashed connectors for ex/divorced heart-lines
    const hearts = [];

    // Parents → focus + siblings, routed per-kid. Each kid (focus or sibling)
    // is grouped by which subset of the visible parents row (bio parents AND
    // step-parents) is in their own parentIds. Half-siblings naturally fall
    // into their own group: Heather is grouped under Tony+Mimi, Jewelia is
    // grouped under Mimi alone, Suejin is grouped under Tony+SuejinMom. Each
    // group renders its own trunk so no kid gets a parent-line from someone
    // who isn't actually their bio parent.
    // Draw the per-group trunks computed earlier. Each group's trunk sits
    // on its own Y lane so multi-group views (half-siblings) don't pile
    // every trunk onto the same horizontal rail.
    if (kidGroups.length) {
      const LANE_OFFSET = 18;
      kidGroups.forEach(({ ps, kids, _lane }) => {
        if (!ps.length || !kids.length) return;
        const parentBottoms = ps.map(p => ANCHOR_BOTTOM(p.id));
        const kidTops = kids.map(k => ANCHOR_TOP(k.id));
        const trunkY = kidTops[0].y - 40 + (_lane % 4) * LANE_OFFSET;
        const couple = ps.length === 2 &&
          ps[0].spouseId === ps[1].id && !ps[0].divorced && !ps[1].divorced;

        if (couple) {
          const yLine = parentBottoms[0].y + 28;
          const midX  = (parentBottoms[0].x + parentBottoms[1].x) / 2;
          const x0 = Math.min(parentBottoms[0].x, parentBottoms[1].x);
          const x1 = Math.max(parentBottoms[0].x, parentBottoms[1].x);
          lines.push(`M ${parentBottoms[0].x} ${parentBottoms[0].y} V ${yLine}`);
          lines.push(`M ${parentBottoms[1].x} ${parentBottoms[1].y} V ${yLine}`);
          lines.push(`M ${x0} ${yLine} H ${x1}`);
          lines.push(`M ${midX} ${yLine} V ${trunkY}`);
          if (parentIdSet.has(ps[0].id) && parentIdSet.has(ps[1].id)) {
            hearts.push(heartMarker(midX, yLine, false));
          }
        } else {
          parentBottoms.forEach(pb => {
            lines.push(`M ${pb.x} ${pb.y} V ${trunkY}`);
          });
        }

        const allX = [...parentBottoms.map(p => p.x), ...kidTops.map(t => t.x)];
        const trunkLeft  = Math.min(...allX);
        const trunkRight = Math.max(...allX);
        if (trunkRight - trunkLeft > 0.5) {
          lines.push(`M ${trunkLeft} ${trunkY} H ${trunkRight}`);
        }
        kidTops.forEach(t => lines.push(`M ${t.x} ${trunkY} V ${t.y}`));
      });
    }

    // Heart connectors between adjacent bio parents and step-parents in the
    // parents row. Two cases:
    //   1. Two bio parents are listed as each other's ex → broken heart
    //      (e.g. Myong + Hee in Ted's view).
    //   2. A bio parent + their current spouse who is a step-parent → solid
    //      heart (e.g. Hee + Kimberly). No parent-line drops from the step
    //      parent because they aren't a bio parent of the focus.
    const drawnParentPair = new Set();
    const parentPairKey = (a, b) => a < b ? `${a}|${b}` : `${b}|${a}`;
    const drawParentHeart = (a, b, divorced) => {
      const ra = rowFor[a.id], rb = rowFor[b.id]; if (!ra || !rb) return;
      const yLine = ra.y + CH / 2 + shiftY;
      const leftX  = Math.min(ra.x, rb.x) + CW + shiftX;
      const rightX = Math.max(ra.x, rb.x) + shiftX;
      const segment = `M ${leftX} ${yLine} H ${rightX}`;
      // Ex / divorced connector → dashed bucket so CSS picks it up. Solid
      // (current marriage) connectors stay in the main lines array.
      (divorced ? exLines : lines).push(segment);
      hearts.push(heartMarker((leftX + rightX) / 2, yLine, divorced));
    };
    // Divorced bio parents.
    for (let i = 0; i < parents.length; i++) {
      for (let j = i + 1; j < parents.length; j++) {
        const a = parents[i], b = parents[j];
        if ((a.exSpouseIds || []).includes(b.id) || (b.exSpouseIds || []).includes(a.id)) {
          const key = parentPairKey(a.id, b.id);
          if (drawnParentPair.has(key)) continue;
          drawnParentPair.add(key);
          drawParentHeart(a, b, true);
        }
      }
    }
    // Bio parent → step-parent. Solid heart when currently married, broken
    // heart when the step-parent is an ex of the bio parent.
    stepParents.forEach(sp => {
      const bioId = stepParentOf[sp.id];
      const bio = bioId ? Store.byId(bioId) : null;
      if (!bio) return;
      const key = parentPairKey(bio.id, sp.id);
      if (drawnParentPair.has(key)) return;
      drawnParentPair.add(key);
      const divorced = (bio.exSpouseIds || []).includes(sp.id)
        || (sp.exSpouseIds || []).includes(bio.id);
      drawParentHeart(bio, sp, divorced);
    });

    // Focus + each partner: draw a horizontal line + heart between them.
    // Current spouse → solid heart; ex-spouses → broken heart + dashed line.
    allPartners.forEach(p => {
      const a = rowFor[focus.id];
      const b = rowFor[p.id];
      if (!a || !b) return;
      const yLine = a.y + CH / 2 + shiftY;
      const leftX  = Math.min(a.x, b.x) + CW + shiftX;
      const rightX = Math.max(a.x, b.x) + shiftX;
      const isEx = p.id !== focus.spouseId;
      (isEx ? exLines : lines).push(`M ${leftX} ${yLine} H ${rightX}`);
      const heartX = (leftX + rightX) / 2;
      hearts.push(heartMarker(heartX, yLine, isEx));
    });

    // Focus(+Partners) → Children. Routed per-child by which of the row's
    // visible adults are actually in this child's parentIds — so a step-
    // parent (married to a bio parent but not a parent of the child) does
    // NOT pick up a child line. Kids with two visible bio parents drop from
    // the couple midpoint; kids with one drop from that single parent's
    // bottom; kids with no visible bio parent (rare — wonky data) fall
    // back to the focus card so they still anchor somewhere.
    if (children.length) {
      const adultsInRow = new Set([focus.id, ...allPartners.map(p => p.id)]);
      const groupsByKey = new Map(); // key → { ids: [adultId,...], kids: [] }
      children.forEach(c => {
        const bioVisible = (c.parentIds || []).filter(pid => adultsInRow.has(pid));
        let key;
        if (bioVisible.length >= 2) {
          // Use the first two visible bio parents (a child can biologically
          // have at most two parents in our model).
          const pair = bioVisible.slice(0, 2).sort();
          key = 'pair:' + pair.join('|');
          if (!groupsByKey.has(key)) groupsByKey.set(key, { ids: pair, kids: [] });
        } else if (bioVisible.length === 1) {
          key = 'one:' + bioVisible[0];
          if (!groupsByKey.has(key)) groupsByKey.set(key, { ids: [bioVisible[0]], kids: [] });
        } else {
          key = 'focus';
          if (!groupsByKey.has(key)) groupsByKey.set(key, { ids: [focus.id], kids: [] });
        }
        groupsByKey.get(key).kids.push(c);
      });

      groupsByKey.forEach(({ ids, kids }) => {
        let start;
        if (ids.length === 2) {
          // Bio couple — drop from the heart-line midpoint between the two.
          const a = rowFor[ids[0]], b = rowFor[ids[1]];
          const yLine = a.y + CH / 2 + shiftY;
          const midX = (Math.min(a.x, b.x) + CW + Math.max(a.x, b.x)) / 2 + shiftX;
          start = { x: midX, y: yLine };
        } else {
          // Single bio parent visible — drop from their card bottom.
          const p = rowFor[ids[0]];
          start = { x: p.x + CW / 2 + shiftX, y: p.y + CH + shiftY };
        }
        const childTops = kids.map(c => ANCHOR_TOP(c.id)).filter(Boolean);
        if (!childTops.length) return;
        const dropTo = rowFor[focus.id].y + CH + shiftY + 4;
        lines.push(`M ${start.x} ${start.y} V ${dropTo}`);
        const trunkY = childTops[0].y - 36;
        lines.push(`M ${start.x} ${dropTo} V ${trunkY}`);
        const minCX = Math.min(start.x, ...childTops.map(p => p.x));
        const maxCX = Math.max(start.x, ...childTops.map(p => p.x));
        lines.push(`M ${minCX} ${trunkY} H ${maxCX}`);
        childTops.forEach(ct => lines.push(`M ${ct.x} ${trunkY} V ${ct.y}`));
      });
    }

    // In-law connectors: each child paired with their spouse in the children
    // row gets a horizontal spouse line + heart between them.
    children.forEach(c => {
      if (!c.spouseId) return;
      const sp = rowFor[c.spouseId];
      const a = rowFor[c.id];
      if (!sp || !a) return;
      const yLine = a.y + CH / 2 + shiftY;
      const leftX  = Math.min(a.x, sp.x) + CW + shiftX;
      const rightX = Math.max(a.x, sp.x) + shiftX;
      lines.push(`M ${leftX} ${yLine} H ${rightX}`);
      hearts.push(heartMarker((leftX + rightX) / 2, yLine, false));
    });

    // Children → Grandchildren. Per-grandchild routing same as parents:
    // two visible bio parents → couple midpoint; one → that parent's bottom.
    if (grandchildren.length) {
      const childRowIds = new Set([...children.map(c => c.id), ...childSpouseIds]);
      grandchildren.forEach(gc => {
        const visibleParents = (gc.parentIds || []).filter(pid => childRowIds.has(pid));
        if (!visibleParents.length) return;
        let startX, startY;
        if (visibleParents.length >= 2) {
          const a = rowFor[visibleParents[0]], b = rowFor[visibleParents[1]];
          const yLine = a.y + CH / 2 + shiftY;
          startX = (Math.min(a.x, b.x) + CW + Math.max(a.x, b.x)) / 2 + shiftX;
          startY = yLine;
        } else {
          const p = rowFor[visibleParents[0]];
          startX = p.x + CW / 2 + shiftX;
          startY = p.y + CH + shiftY;
        }
        const top = ANCHOR_TOP(gc.id);
        const dropTo = rowFor[children[0].id].y + CH + shiftY + 4;
        lines.push(`M ${startX} ${startY} V ${dropTo}`);
        const trunkY = top.y - 28;
        lines.push(`M ${startX} ${dropTo} V ${trunkY}`);
        lines.push(`M ${Math.min(startX, top.x)} ${trunkY} H ${Math.max(startX, top.x)}`);
        lines.push(`M ${top.x} ${trunkY} V ${top.y}`);
      });
    }

    edges.setAttribute('width', stageW);
    edges.setAttribute('height', worldH + padTop * 2);
    edges.innerHTML = `
      <g class="myfamily-edge-lines">
        ${lines.map(d => `<path d="${d}" />`).join('')}
      </g>
      <g class="myfamily-edge-lines myfamily-edge-ex">
        ${exLines.map(d => `<path d="${d}" />`).join('')}
      </g>
      <g class="myfamily-hearts">
        ${hearts.join('')}
      </g>
    `;

    // Card click → drawer. Admins can open any card. Non-admin users may
    // only open their own card and their current spouse's — every other
    // card in the mini-tree is read-only for them so they can't pry into
    // someone else's profile fields (address, email, etc.). Auth.current
    // is the resolved member OBJECT, so we pull the id off it directly
    // (the v4.16 attempt treated it as a bare id and the set comparison
    // never matched).
    const me         = (Auth.current && Auth.current !== 'admin-bootstrap') ? Auth.current : null;
    const allowedIds = new Set([me?.id, me?.spouseId].filter(Boolean));
    nodes.querySelectorAll('.node').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.node-add')) return;
        if (e.target.closest('.node-toggle')) return;
        // Quick-links on the card (529 chip etc.) open externally instead
        // of bouncing through the drawer.
        if (e.target.closest('[data-stop-node-click]')) return;
        const id = el.dataset.id;
        // Admin / Family role can open any card here. Plain Users are
        // still restricted to their own + spouse cards (the original rule).
        if (!Auth.canOpenTreeDrawer() && !allowedIds.has(id)) return;
        Drawer.open(id);
      });
    });
  },
};

// -------------------- ADMIN VIEW --------------------
const AdminView = {
  filterGroup: '',                // active group chip; '' means "all"
  viewMode: 'table',              // 'table' | 'cards' — toggle in Members panel
  nameSort: 'last',               // 'last' | 'first' — toggled by clicking the Name header
  accountIds: null,               // Set<member_id> known to have a Supabase login (populated async)
  lastSeenById: null,             // Map<member_id, Date> from auth.users.last_sign_in_at (populated async)
  activeTab: 'family',            // v4.35: 'family' | 'friends' | 'all' — sub-tab inside Members page
  init() {
    on($('#btn-admin-add'), 'click', () => MemberModal.open());
    on($('#btn-admin-export'), 'click', () => this.exportCSV());
    on($('#group-form'), 'submit', (e) => {
      e.preventDefault();
      const v = $('#group-input').value.trim();
      if (!v) return;
      if (!Store.state.groups.includes(v)) {
        Store.state.groups.push(v);
        Store.save();
      }
      $('#group-input').value = '';
      this.render();
      refreshAllGroupSelects();
    });
    on($('#btn-admin-view-table'), 'click', () => this.setViewMode('table'));
    on($('#btn-admin-view-cards'), 'click', () => this.setViewMode('cards'));
    on($('#admin-name-sort'), 'click', () => {
      this.nameSort = this.nameSort === 'last' ? 'first' : 'last';
      this.render();
    });
    // v4.35: Members sub-tabs (Family / Friends / All).
    $$('.member-tab').forEach(btn => {
      on(btn, 'click', () => this.setActiveTab(btn.dataset.memberTab));
    });
    FriendsTabView.init();
    AllTabView.init();
  },
  // Switch sub-tabs without rerunning the costly Members-table render unless
  // we're returning to it. Each sub-panel renders lazily on its first show.
  setActiveTab(tab) {
    if (!tab || tab === this.activeTab) return;
    if (tab !== 'family' && tab !== 'friends' && tab !== 'all') return;
    this.activeTab = tab;
    this.render();
  },
  // Context-aware export: each sub-tab has its own export shape.
  exportCSV() {
    if (this.activeTab === 'friends') return this.exportFriendsCSV();
    if (this.activeTab === 'all')     return AllTabView.exportCSV();
    return this.exportMembersCSV();
  },
  exportFriendsCSV() {
    const list = FriendsTabView.filtered();
    if (!list.length) { toast('Nothing to export.', 'warn'); return; }
    // Flatten primary + spouse + kids into one row per person so the export
    // matches what's on screen when households are expanded.
    const flat = [];
    list.forEach(f => {
      flat.push({ p: f, type: 'Friend',  parent: null });
      if (f.spouse) flat.push({ p: f.spouse, type: 'Spouse', parent: f });
      (f.kids || []).forEach(k => flat.push({ p: k, type: 'Child', parent: f }));
    });
    const data = [
      ['Name', 'Email', 'Phone', 'Address', 'City', 'State', 'Zip', 'Birthday', 'Group', '529 link', 'Type'],
      ...flat.map(({ p, type, parent }) => {
        const street = parent ? (parent.address || '') : (p.address || '');
        const city   = parent ? (parent.city    || '') : (p.city    || '');
        const state  = parent ? (parent.state   || '') : (p.state   || '');
        const zip    = parent ? (parent.zip     || '') : (p.zip     || '');
        const group  = parent ? (parent.group   || '') : (p.group   || '');
        return [
          fullName(p),
          p.email || '',
          p.phone || '',
          street, city, state, zip,
          p.birthday || '',
          group,
          p.plan529 || '',
          type,
        ];
      }),
    ];
    downloadCSV(`friends-${new Date().toISOString().slice(0, 10)}.csv`, data);
  },

  // Pull every (member_id, user_id) mapping once per render and stash the set
  // of member_ids that have a Supabase login. The table re-renders when this
  // resolves so checkmarks fill in. Anon-readable thanks to the RLS policy.
  async refreshAccountIds() {
    if (!Backend.client) { this.accountIds = new Set(); return; }
    try {
      const { data, error } = await Backend.client
        .from('member_accounts')
        .select('member_id');
      if (error) throw error;
      this.accountIds = new Set((data || []).map(r => r.member_id).filter(Boolean));
    } catch (e) {
      console.warn('refreshAccountIds:', e.message || e);
      this.accountIds = new Set();
    }
    if (Views.current === 'admin') this.render();
  },

  // Pull each linked account's last sign-in from auth.users (via the
  // member_last_seen SECURITY DEFINER RPC — only admins get rows back).
  // Builds a Map keyed by member_id. For accounts whose member_id is the
  // 'admin-bootstrap' sentinel, falls back to matching auth-user email
  // against member.email so the right row still lights up.
  async refreshLastSeen() {
    if (!Backend.client) { this.lastSeenById = new Map(); return; }
    try {
      const { data, error } = await Backend.client.rpc('member_last_seen');
      if (error) throw error;
      const byEmail = new Map();
      for (const m of Store.membersList()) {
        if (m.email) byEmail.set(m.email.toLowerCase(), m.id);
      }
      const map = new Map();
      for (const row of (data || [])) {
        if (!row.last_sign_in_at) continue;
        let mid = row.member_id;
        if (!mid || mid === 'admin-bootstrap') {
          mid = row.email ? byEmail.get(row.email.toLowerCase()) : null;
        }
        if (!mid) continue;
        const next = new Date(row.last_sign_in_at);
        const prev = map.get(mid);
        if (!prev || next > prev) map.set(mid, next);
      }
      this.lastSeenById = map;
    } catch (e) {
      console.warn('refreshLastSeen:', e.message || e);
      this.lastSeenById = new Map();
    }
    if (Views.current === 'admin') this.render();
  },

  setViewMode(mode) {
    if (mode !== 'table' && mode !== 'cards') return;
    if (this.viewMode === mode) return;
    this.viewMode = mode;
    this.render();
  },
  visibleMembers() {
    let list = Store.membersList();
    if (this.filterGroup) list = list.filter(m => m.group === this.filterGroup);
    const norm = (s) => (s || '').toString().trim();
    if (this.nameSort === 'first') {
      // Sort by first name, then last. Mirrors sortMembers() but with reversed
      // priority so admins can find someone when they only remember the first name.
      return list.slice().sort((a, b) => {
        const aF = norm(a.firstName), bF = norm(b.firstName);
        if (!aF && bF) return 1;
        if (aF && !bF) return -1;
        const c1 = aF.localeCompare(bF, undefined, { sensitivity: 'base' });
        if (c1 !== 0) return c1;
        return norm(a.lastName).localeCompare(norm(b.lastName), undefined, { sensitivity: 'base' });
      });
    }
    return sortMembers(list);
  },
  render() {
    // v4.35: drive the three sub-panels (Family / Friends / All) and route
    // the heavy render to the active one. Two inactive panels are kept in
    // the DOM but hidden — their innerHTML is left untouched, so the cost
    // of switching tabs is just two `hidden` flips, not a full re-render.
    $$('.member-tab').forEach(btn => {
      btn.classList.toggle('is-active', btn.dataset.memberTab === this.activeTab);
    });
    $('#member-panel-family').hidden  = this.activeTab !== 'family';
    $('#member-panel-friends').hidden = this.activeTab !== 'friends';
    $('#member-panel-all').hidden     = this.activeTab !== 'all';

    // Per-tab page-head extras
    const subline = $('#admin-page-sub');
    if (subline) {
      subline.textContent =
        this.activeTab === 'friends' ? 'Friends, neighbors, and people in our world outside the family.'
        : this.activeTab === 'all'    ? 'Everyone — family and friends — in one flat list, ready to export.'
        : 'Manage members, groups, and accounts.';
    }
    const addFriendBtn = $('#btn-friend-add');
    if (addFriendBtn) addFriendBtn.hidden = this.activeTab !== 'friends' || !Auth.isAdmin();

    if (this.activeTab === 'friends') {
      FriendsTabView.render();
      return;
    }
    if (this.activeTab === 'all') {
      AllTabView.render();
      return;
    }

    // ----- Family sub-tab (existing behavior) -----
    const list = this.visibleMembers();
    $('#admin-filter-note').textContent = this.filterGroup
      ? `Showing ${list.length} member${list.length === 1 ? '' : 's'} in “${this.filterGroup}”`
      : `Showing all members (${list.length})`;
    const sortLabel = $('#admin-name-sort-label');
    if (sortLabel) sortLabel.textContent = this.nameSort === 'first' ? 'Name (by first)' : 'Name (by last)';
    // Fire the account-id probe in the background; it'll re-render with checkmarks
    // when ready. First call only — subsequent renders reuse the cached set.
    if (this.accountIds === null) this.refreshAccountIds();
    if (this.lastSeenById === null) this.refreshLastSeen();

    // View-mode segmented control
    $('#btn-admin-view-table')?.classList.toggle('is-active', this.viewMode === 'table');
    $('#btn-admin-view-cards')?.classList.toggle('is-active', this.viewMode === 'cards');
    $('#admin-table-wrap').hidden = this.viewMode !== 'table';
    $('#admin-cards').hidden      = this.viewMode !== 'cards';

    if (this.viewMode === 'table') {
      this.renderTable(list);
    } else {
      this.renderCards(list);
    }

    // Groups — vertical list
    const groups = Store.state.groups || [];
    const totalCount = Store.membersList().length;
    $('#group-list').innerHTML = `
      <li class="group-row ${this.filterGroup === '' ? 'is-active' : ''}">
        <button class="group-pick" data-grp-pick="">
          <span class="group-pick-name">All members</span>
          <span class="group-pick-count">${totalCount}</span>
        </button>
      </li>
      ${groups.map(g => {
        const count = Store.membersList().filter(m => m.group === g).length;
        return `<li class="group-row ${this.filterGroup === g ? 'is-active' : ''}">
          <button class="group-pick" data-grp-pick="${escape(g)}">
            <span class="group-pick-name">${escape(g)}</span>
            <span class="group-pick-count">${count}</span>
          </button>
          <button class="group-delete" data-grp-delete="${escape(g)}" aria-label="Delete group ${escape(g)}" title="Delete group">
            <svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
          </button>
        </li>`;
      }).join('')}
    `;
    $('#group-list').querySelectorAll('[data-grp-pick]').forEach(btn => on(btn, 'click', () => {
      this.filterGroup = btn.dataset.grpPick;
      this.render();
    }));
    $('#group-list').querySelectorAll('[data-grp-delete]').forEach(btn => on(btn, 'click', (e) => {
      e.stopPropagation();
      const g = btn.dataset.grpDelete;
      if (!confirm(`Delete group “${g}”? Members in this group will become ungrouped.`)) return;
      Store.state.groups = Store.state.groups.filter(x => x !== g);
      Store.membersList().forEach(m => { if (m.group === g) m.group = ''; });
      if (this.filterGroup === g) this.filterGroup = '';
      Store.save();
      this.render();
      refreshAllGroupSelects();
    }));

    // Group membership editor: show only when a real group is selected.
    this.renderMembershipEditor();
  },
  renderTable(list) {
    const accountIds = this.accountIds; // may be null while pending
    const lastSeenById = this.lastSeenById; // may be null while pending
    const rows = list.map(m => {
      const bg = m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : '';
      const hasLogin = accountIds ? accountIds.has(m.id) : null;
      const loginCell = accountIds == null
        ? '<span class="muted small">…</span>'
        : `<span class="admin-login-flag" title="${hasLogin ? 'Has a Supabase login' : 'No Supabase login yet — use Reset PW to create one'}">
            <input type="checkbox" disabled ${hasLogin ? 'checked' : ''} aria-label="Has Supabase login" />
            <span class="muted small">${hasLogin ? 'Yes' : 'No'}</span>
          </span>`;
      const lastSeen = lastSeenById ? lastSeenById.get(m.id) : null;
      const lastSeenCell = lastSeenById == null
        ? '<span class="muted small">…</span>'
        : (lastSeen
            ? `<span title="${lastSeen.toLocaleString()}">${formatDate(lastSeen.toISOString().slice(0,10))}</span>`
            : '<span class="muted">—</span>');
      return `
        <tr data-id="${m.id}">
          <td>
            <div class="row-name">
              <div class="row-avatar is-${m.gender}" ${bg}></div>
              <div>
                <div style="font-weight:600">${escape(displayName(m))}</div>
                ${fullName(m) !== displayName(m) ? `<div class="muted small">${escape(fullName(m))}</div>` : ''}
              </div>
            </div>
          </td>
          <td>${m.email
            ? `<span class="admin-email-cell"><code>${escape(m.email)}</code><button class="admin-email-copy" type="button" data-action="copy-email" data-email="${escape(m.email)}" title="Copy email"><svg viewBox="0 0 16 16" width="12" height="12" fill="none"><rect x="4" y="3" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3 11V4a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></span>`
            : '<span class="muted">—</span>'}</td>
          <td>${m.group ? escape(m.group) : '—'}</td>
          <td>${m.birthday ? formatDate(m.birthday) : '—'}</td>
          <td>${loginCell}</td>
          <td>${lastSeenCell}</td>
          <td style="text-align:center;">
            <label class="event-toggle" title="When checked, this person is hidden from the &quot;+ Add member&quot; picker on events.">
              <input type="checkbox" data-action="toggle-event-exclude" ${m.excludeFromEventsList ? 'checked' : ''} aria-label="Hide ${escape(displayName(m))} from events picker" />
            </label>
          </td>
          <td style="text-align:right; white-space:nowrap;">
            <button class="btn btn-ghost btn-sm" data-action="reset">Reset PW</button>
            <button class="btn btn-danger-ghost btn-sm" data-action="delete">Delete</button>
          </td>
        </tr>`;
    }).join('');
    $('#admin-rows').innerHTML = rows || `<tr><td colspan="8" class="muted" style="padding:24px; text-align:center;">No members ${this.filterGroup ? `in “${escape(this.filterGroup)}”` : 'yet'}.</td></tr>`;

    $('#admin-rows').querySelectorAll('button[data-action], input[data-action]').forEach(btn => {
      const handler = async (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr');
        const id = tr.dataset.id;
        const m = Store.byId(id);
        const action = btn.dataset.action;
        if (action === 'reset')                { await this.resetPassword(m); }
        else if (action === 'delete')          { this.deleteMember(m); }
        else if (action === 'copy-email') {
          try { await navigator.clipboard.writeText(btn.dataset.email); toast('Email copied.'); }
          catch { toast('Copy failed.', 'warn'); }
        }
        else if (action === 'toggle-event-exclude') {
          // v4.38: inline toggle for the events-list visibility flag. Same
          // semantics as the checkbox inside the member drawer — checked
          // means "hide from the + Add member picker on events".
          m.excludeFromEventsList = !!btn.checked;
          Store.save();
        }
      };
      // Checkboxes fire 'change', buttons fire 'click'.
      btn.addEventListener(btn.tagName === 'INPUT' ? 'change' : 'click', handler);
    });
    $('#admin-rows').querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', (e) => {
        // v4.38: bail on buttons (Reset PW / Delete), the inline events
        // toggle (input + label wrapper), and the email-copy chip so a
        // click inside any of those doesn't accidentally open the drawer.
        if (e.target.closest('button')) return;
        if (e.target.closest('input')) return;
        if (e.target.closest('label')) return;
        if (tr.dataset.id) Drawer.open(tr.dataset.id);
      });
    });
  },
  renderCards(list) {
    const grid = $('#admin-cards');
    if (!list.length) {
      grid.innerHTML = `<p class="muted" style="padding:18px;">No members ${this.filterGroup ? `in “${escape(this.filterGroup)}”` : 'yet'}.</p>`;
      return;
    }
    grid.innerHTML = list.map(m => {
      const photoBg = m.photo ? `style="background-image:url('${cssUrl(m.photo)}'); background-size: cover;"` : '';
      const inner   = m.photo ? '' : Silhouettes.for(m);
      const relation = Tree.computeRelation(m.id) || (m.group || 'Family');
      const ethnicities = m.ethnicities || [];
      const flagsHTML = ethnicities.length
        ? `<div class="node-flags" title="${ethnicities.map(c => ETH_BY_CODE[c]?.name || c).join(' · ')}">${ethnicities.slice(0, 4).map(c => `<span class="node-flag">${flagFor(c) || '🏳️'}</span>`).join('')}${ethnicities.length > 4 ? `<span class="node-flag-more">+${ethnicities.length - 4}</span>` : ''}</div>`
        : '';
      return `
        <div class="admin-card node" data-id="${m.id}">
          <div class="node-photo is-${m.gender}" ${photoBg}>${inner}</div>
          <div class="node-body">
            <div class="node-relation">${escape(relation)}</div>
            <div class="node-name">${escape(displayName(m))}</div>
            ${m.internationalName ? `<div class="node-international-name" title="International name">${escape(m.internationalName)}</div>` : ''}
            ${m.group ? `<div class="node-group">${escape(m.group)}</div>` : ''}
            ${m.birthday ? `<div class="node-meta"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>${formatDate(m.birthday)}</div>` : ''}
            ${flagsHTML}
            <div class="admin-card-actions">
              <button class="btn btn-ghost btn-sm" data-card-action="edit"   data-id="${m.id}">Edit</button>
              <button class="btn btn-ghost btn-sm" data-card-action="reset"  data-id="${m.id}">Reset PW</button>
              <button class="btn btn-danger-ghost btn-sm" data-card-action="delete" data-id="${m.id}">Delete</button>
            </div>
          </div>
        </div>`;
    }).join('');

    grid.querySelectorAll('.admin-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        Drawer.open(card.dataset.id);
      });
    });
    grid.querySelectorAll('button[data-card-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const m = Store.byId(id);
        const action = btn.dataset.cardAction;
        if (action === 'edit')        { Drawer.open(id); setTimeout(() => Drawer.startEdit(), 50); }
        else if (action === 'reset')  { await this.resetPassword(m); }
        else if (action === 'delete') { this.deleteMember(m); }
      });
    });
  },
  renderMembershipEditor() {
    const wrap = $('#group-membership');
    if (!wrap) return;
    if (!this.filterGroup) { wrap.hidden = true; wrap.innerHTML = ''; return; }
    wrap.hidden = false;
    const grp = this.filterGroup;
    const inGroup    = sortMembers(Store.membersList().filter(m => m.group === grp));
    const notInGroup = sortMembers(Store.membersList().filter(m => m.group !== grp));
    wrap.innerHTML = `
      <header class="panel-head">
        <h3>Members in “${escape(grp)}”</h3>
      </header>
      <div class="panel-body">
        <div class="group-members">
          ${inGroup.length ? inGroup.map(m => `
            <div class="group-member-row" data-mid="${m.id}">
              <div class="row-name">
                <div class="row-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : ''}></div>
                <span>${escape(displayName(m))}</span>
              </div>
              <button class="btn btn-ghost btn-sm" data-remove="${m.id}">Remove</button>
            </div>`).join('') : '<p class="muted small">No members in this group yet.</p>'}
        </div>
        <div class="group-add-row">
          <select class="input" id="group-add-member">
            <option value="">+ Add member to this group…</option>
            ${notInGroup.map(m => `<option value="${m.id}">${escape(displayName(m))}${m.group ? ' (' + escape(m.group) + ')' : ''}</option>`).join('')}
          </select>
        </div>
      </div>
    `;
    wrap.querySelectorAll('[data-remove]').forEach(btn => on(btn, 'click', () => {
      const m = Store.byId(btn.dataset.remove);
      if (!m) return;
      m.group = '';
      Store.save();
      this.render();
      refreshAllGroupSelects();
    }));
    on($('#group-add-member'), 'change', (e) => {
      const mid = e.target.value; if (!mid) return;
      const m = Store.byId(mid); if (!m) return;
      m.group = grp;
      Store.save();
      this.render();
      refreshAllGroupSelects();
    });
  },
  async resetPassword(m) {
    await sendAdminResetEmail(m);
  },
  deleteMember(m) {
    if (!confirm(`Delete ${displayName(m)}?`)) return;
    Tree.remove(m.id);
    this.render();
    Canvas.renderAll();
  },
  exportMembersCSV() {
    const list = this.visibleMembers();
    if (!list.length) { toast('Nothing to export.', 'warn'); return; }
    const data = [
      ['First name', 'Last name', 'Display name', 'Username', 'Role', 'Group', 'Email', 'Phone', 'Address', 'Birthday', 'Ethnicities'],
      ...list.map(m => [
        m.firstName, m.lastName, m.displayName || '', m.username, m.role,
        m.group || '', m.email || '', m.phone || '', m.address || '', m.birthday || '',
        (m.ethnicities || []).map(c => ETH_BY_CODE[c]?.name || c).join('; '),
      ]),
    ];
    const tag = this.filterGroup ? `-${this.filterGroup.replace(/\s+/g, '-')}` : '';
    downloadCSV(`members${tag}-${new Date().toISOString().slice(0, 10)}.csv`, data);
  },
};

// -------------------- EMOJI PICKER --------------------
// Format: `<emoji> <space-separated keywords>` per line. Keywords power search.
const EMOJI_DATA = {
  smileys: { name: 'Smileys & People', tab: '😀', raw: `
😀 grinning smile happy face
😃 smile happy joy face
😄 smile happy grin laugh face
😁 grin beaming happy face
😆 laugh smile face
😅 sweat smile relief face
🤣 rofl laugh tears face
😂 joy tears laugh face
🙂 slight smile face
🙃 upside down face silly
😉 wink face
😊 smile blush happy face
😇 angel halo innocent face
🥰 love hearts smile face
😍 love hearts eyes face
🤩 star struck eyes face
😘 kiss face
😗 kiss face
😙 kiss smile face
😚 kiss smile face
🥲 smiling tear face
😋 yum tongue tasty face
😛 tongue silly face
😜 wink tongue silly face
🤪 zany silly face
😝 tongue closed eyes face
🤑 money face dollar
🤗 hug face
🤭 hand over mouth oops face
🤫 shush quiet face
🤔 thinking face hmm
🤐 zipper mouth quiet face
🤨 raised eyebrow face
😐 neutral face
😑 expressionless face
😶 no mouth face
😏 smirk face
😒 unamused face annoyed
🙄 eye roll face
😬 grimace face awkward
🤥 lying pinocchio face
😌 relieved face
😔 pensive sad face
😪 sleepy tired face
🤤 drool face
😴 sleep zzz face
😷 mask sick face
🤒 thermometer sick face fever
🤕 bandage hurt face
🤢 nauseated sick face
🤮 vomit face
🤧 sneeze face
🥵 hot sweat face
🥶 cold freeze face
🥴 woozy drunk face
😵 dizzy face xx
🤯 mind blown face
🤠 cowboy hat face
🥳 party hat horn face
🥸 disguise glasses face
😎 sunglasses cool face
🤓 nerd glasses face
🧐 monocle face
😕 confused face
😟 worried face
🙁 slight frown sad face
☹️ frown sad face
😮 open mouth surprised face
😯 hushed surprise face
😲 astonished surprise face
😳 flushed embarrassed face
🥺 pleading begging face
😦 frowning open mouth face
😧 anguished face
😨 fearful scared face
😰 anxious cold sweat face
😥 sad relief face
😢 cry sad tear face
😭 sob crying loud sad face
😱 scream fear face
😖 confounded frustrated face
😣 persevere face
😞 disappointed sad face
😓 sweat face
😩 weary tired face
😫 tired exhausted face
🥱 yawn tired face
😤 huff angry face
😡 pout angry red face
😠 angry mad face
🤬 cursing angry face
😈 smiling devil face
👿 angry devil face
💀 skull death
☠️ skull crossbones death pirate
💩 poop pile
🤡 clown face
👹 ogre demon
👺 goblin demon
👻 ghost boo
👽 alien
👾 alien monster
🤖 robot
🎃 jack o lantern halloween pumpkin
😺 cat smile face
😻 cat heart eyes face
🙀 cat scream face
👋 wave hand hello
✋ raised hand stop
🖖 vulcan spock hand
👌 ok hand
🤌 pinched fingers
🤏 pinching hand
✌️ peace victory
🤞 fingers crossed
🤟 love you hand
🤘 rock on horns
🤙 call me hand
👈 point left
👉 point right
👆 point up
🖕 middle finger
👇 point down
☝️ point index up
👍 thumbs up like
👎 thumbs down dislike
✊ raised fist
👊 fist bump punch
🤛 left fist bump
🤜 right fist bump
👏 clap applause
🙌 raised hands celebrate
👐 open hands hug
🤲 palms up open hands
🤝 handshake
🙏 pray thank you please
💪 muscle flex strong
👶 baby
🧒 child
👦 boy
👧 girl
🧑 person
👨 man
👩 woman
🧓 older person elder
👴 old man
👵 old woman
👮 police cop officer
🕵️ detective spy investigator
💂 guard
👷 construction worker
🤴 prince
👸 princess
👰 bride wedding
🤵 groom tuxedo wedding
👼 baby angel
🤰 pregnant
🤱 breastfeeding
🦸 superhero
🦹 supervillain
🎅 santa christmas
🤶 mrs claus christmas
🧙 wizard mage
🧚 fairy
🧛 vampire
🧞 genie
🧟 zombie
💆 face massage spa
💇 haircut salon
🚶 walking person
🏃 running person
💃 dance woman
🕺 dance man
👯 dancers bunny ears
🧘 yoga meditate
🛀 bath shower bathing
🛌 sleep in bed
👫 couple holding hands
👬 men holding hands
👭 women holding hands
💏 kiss couple
💑 couple heart love
👪 family
🗣️ speaking head talking
👤 person silhouette
👥 people silhouette
🫂 hugging people
` },
  animals: { name: 'Animals & Nature', tab: '🐶', raw: `
🐶 dog face puppy
🐱 cat face kitten
🐭 mouse face
🐹 hamster
🐰 rabbit bunny face
🦊 fox face
🐻 bear face
🐼 panda face
🐨 koala face
🐯 tiger face
🦁 lion face
🐮 cow face
🐷 pig face
🐽 pig nose
🐸 frog face
🐵 monkey face
🙈 see no evil monkey
🙉 hear no evil monkey
🙊 speak no evil monkey
🐒 monkey
🐔 chicken face
🐧 penguin
🐦 bird
🐤 baby chick
🐣 hatching chick
🐥 front facing chick
🦆 duck
🦅 eagle
🦉 owl
🦇 bat
🐺 wolf face
🐗 boar
🐴 horse face
🦄 unicorn
🐝 bee
🐛 caterpillar bug
🦋 butterfly
🐌 snail
🐞 ladybug
🐜 ant
🦗 cricket
🕷️ spider
🦂 scorpion
🐢 turtle
🐍 snake
🦎 lizard
🦖 t rex dinosaur
🦕 sauropod dinosaur long neck
🐙 octopus
🦑 squid
🦐 shrimp
🦞 lobster
🦀 crab
🐡 blowfish
🐠 tropical fish
🐟 fish
🐬 dolphin
🐳 whale
🐋 whale
🦈 shark
🐊 crocodile
🐅 tiger
🐆 leopard
🦓 zebra
🦍 gorilla
🦧 orangutan
🐘 elephant
🦛 hippo
🦏 rhino
🐪 camel one hump
🐫 camel two hump
🦙 llama alpaca
🦒 giraffe
🐃 water buffalo
🐂 ox
🐄 cow
🐎 horse running
🐖 pig
🐏 ram
🐑 sheep
🐐 goat
🦌 deer
🐕 dog
🐩 poodle
🦮 guide dog service
🐈 cat
🐓 rooster
🦃 turkey thanksgiving
🦚 peacock
🦜 parrot
🦢 swan
🦩 flamingo
🕊️ dove peace
🐇 rabbit
🦝 raccoon
🦨 skunk
🦡 badger
🦔 hedgehog
🌱 seedling sprout
🌿 herb plant
☘️ shamrock
🍀 four leaf clover lucky
🎋 tanabata tree bamboo
🎍 pine tree decoration
🌵 cactus
🌲 evergreen tree
🌳 deciduous tree
🌴 palm tree tropical
🌷 tulip
🌹 rose
🥀 wilted flower
🌺 hibiscus tropical flower
🌸 cherry blossom sakura
🌼 daisy flower
🌻 sunflower
🌞 sun face
🌝 full moon face
🌛 first quarter moon face
🌜 last quarter moon face
🌚 new moon face
🌕 full moon
🌖 waning gibbous moon
🌗 last quarter moon
🌘 waning crescent moon
🌑 new moon
🌒 waxing crescent moon
🌓 first quarter moon
🌔 waxing gibbous moon
🌙 crescent moon
🌎 earth americas
🌍 earth africa europe
🌏 earth asia australia
🪐 ringed planet saturn
💫 dizzy star
⭐ star
🌟 glowing star
✨ sparkles glitter
⚡ lightning bolt high voltage
☄️ comet
💥 explosion boom
🔥 fire flame
🌪️ tornado
🌈 rainbow
☀️ sun sunny
🌤️ sun behind small cloud
⛅ sun behind cloud
🌥️ sun behind large cloud
☁️ cloud
🌦️ sun rain
🌧️ cloud rain
⛈️ cloud lightning rain storm
🌩️ cloud lightning
🌨️ cloud snow
❄️ snowflake snow
☃️ snowman
⛄ snowman without snow
🌬️ wind face
💨 dash wind
💧 droplet water
💦 sweat droplets
☔ umbrella rain
⛱️ umbrella ground beach
` },
  food: { name: 'Food & Drink', tab: '🍎', raw: `
🍏 green apple
🍎 red apple
🍐 pear
🍊 tangerine orange
🍋 lemon
🍌 banana
🍉 watermelon
🍇 grapes
🍓 strawberry
🫐 blueberries
🍈 melon
🍒 cherries
🍑 peach
🥭 mango
🍍 pineapple
🥥 coconut
🥝 kiwi
🍅 tomato
🍆 eggplant
🥑 avocado
🥦 broccoli
🥬 leafy green
🥒 cucumber
🌶️ hot pepper chili
🫑 bell pepper
🌽 corn
🥕 carrot
🧄 garlic
🧅 onion
🥔 potato
🍠 sweet potato
🥐 croissant
🥯 bagel
🍞 bread
🥖 baguette
🥨 pretzel
🧀 cheese
🥚 egg
🍳 cooking fried egg
🧈 butter
🥞 pancakes
🧇 waffle
🥓 bacon
🥩 cut of meat steak
🍗 poultry leg drumstick chicken
🍖 meat on bone
🦴 bone
🌭 hot dog
🍔 hamburger
🍟 fries
🍕 pizza
🥪 sandwich
🌮 taco
🌯 burrito
🥙 stuffed flatbread
🧆 falafel
🥗 green salad
🥘 shallow pan paella
🍲 pot of food stew
🥣 bowl with spoon
🍿 popcorn
🧈 butter
🧂 salt
🥫 canned food
🍱 bento box
🍘 rice cracker
🍙 rice ball onigiri
🍚 cooked rice
🍛 curry rice
🍜 ramen steaming bowl
🍝 spaghetti pasta
🍠 roasted sweet potato
🍢 oden
🍣 sushi
🍤 fried shrimp
🍥 fish cake swirl
🥮 moon cake
🍡 dango
🥟 dumpling
🥠 fortune cookie
🥡 takeout box
🍦 soft ice cream
🍧 shaved ice
🍨 ice cream
🍩 doughnut donut
🍪 cookie
🎂 birthday cake
🍰 shortcake slice
🧁 cupcake
🥧 pie
🍫 chocolate bar
🍬 candy
🍭 lollipop
🍮 custard pudding
🍯 honey pot
🍼 baby bottle
🥛 milk glass
☕ coffee hot beverage
🫖 teapot
🍵 tea cup
🍶 sake
🍾 champagne bottle
🍷 wine glass
🍸 cocktail
🍹 tropical drink
🍺 beer mug
🍻 clinking beer mugs cheers
🥂 clinking glasses
🥃 tumbler whiskey
🥤 cup with straw
🧋 bubble tea boba
🧃 beverage box juice
🧉 mate
🧊 ice cube
🥄 spoon
🍴 fork knife
🍽️ fork knife plate dinner meal
🥢 chopsticks
` },
  activities: { name: 'Activities', tab: '⚽', raw: `
⚽ soccer football
🏀 basketball
🏈 american football
⚾ baseball
🥎 softball
🎾 tennis
🏐 volleyball
🏉 rugby
🥏 frisbee
🎱 8 ball pool billiards
🪀 yo yo
🏓 ping pong table tennis
🏸 badminton
🥅 goal net
🏒 ice hockey
🏑 field hockey
🥍 lacrosse
🏏 cricket
🥌 curling stone
🛷 sled
🎿 skis
⛷️ skier
🏂 snowboarder
🪂 parachute
🏋️ weightlifter gym
🤼 wrestlers
🤸 cartwheel gymnastics
⛹️ basketball player
🤺 fencing
🤾 handball
🏌️ golf
🏇 horse racing jockey
🧘 yoga lotus meditate
🏄 surfing
🏊 swimming
🤽 water polo
🚣 rowboat
🧗 climbing
🚵 mountain biking
🚴 cycling biking
🏆 trophy winner
🥇 first place gold medal
🥈 second place silver medal
🥉 third place bronze medal
🏅 sports medal
🎖️ military medal
🏵️ rosette
🎗️ reminder ribbon
🎫 ticket
🎟️ admission tickets
🎪 circus tent
🤹 juggling
🎭 performing arts theater
🎨 artist palette painting
🩰 ballet shoes
🎬 clapperboard film movie
🎤 microphone karaoke
🎧 headphones music
🎼 musical score sheet
🎹 piano keyboard
🥁 drum
🪘 long drum
🎷 saxophone
🎺 trumpet
🎸 guitar
🪕 banjo
🎻 violin
🎮 video game controller
🕹️ joystick gaming
🎰 slot machine casino
🎲 dice game
🧩 jigsaw puzzle piece
♟️ chess pawn
🎯 dart bullseye
🎳 bowling
🪀 yo yo toy
🪁 kite
🛼 roller skate
` },
  travel: { name: 'Travel & Places', tab: '✈️', raw: `
🚗 car automobile
🚕 taxi
🚙 sport utility vehicle suv
🚌 bus
🚎 trolleybus
🏎️ racing car formula 1
🚓 police car
🚑 ambulance
🚒 fire engine truck
🚐 minibus
🚚 delivery truck
🚛 articulated lorry semi
🚜 tractor
🦯 white cane
🦽 manual wheelchair
🦼 motorized wheelchair
🛴 kick scooter
🚲 bicycle bike
🛵 motor scooter
🏍️ motorcycle
🛺 auto rickshaw tuk tuk
🚨 police light siren
🚔 oncoming police car
🚍 oncoming bus
🚘 oncoming car
🚖 oncoming taxi
🚡 aerial tramway
🚠 mountain cableway
🚟 suspension railway
🚃 railway car train
🚋 tram car
🚞 mountain railway
🚝 monorail
🚄 high speed train
🚅 bullet train
🚈 light rail
🚂 locomotive steam train
🚆 train
🚇 metro subway
🚊 tram
🚉 station
✈️ airplane plane flight
🛫 airplane departure takeoff
🛬 airplane arrival landing
🛩️ small airplane
💺 seat airplane train
🚀 rocket spaceship launch
🛸 flying saucer ufo
🚁 helicopter
🛶 canoe kayak
⛵ sailboat
🚤 speedboat motorboat
🛥️ motor boat
🛳️ passenger ship cruise liner
⛴️ ferry boat
🚢 ship cruise
⚓ anchor boat ship
🪝 hook
⛽ fuel pump gas station
🚧 construction barrier
🚦 vertical traffic light
🚥 horizontal traffic light
🗺️ world map
🗿 moai statue easter island
🗽 statue of liberty
🗼 tokyo tower
🏰 castle european
🏯 japanese castle
🏟️ stadium
🎡 ferris wheel
🎢 roller coaster
🎠 carousel horse merry go round
⛲ fountain
⛱️ umbrella beach
🏖️ beach umbrella sand
🏝️ desert island palm
🏜️ desert sand
🌋 volcano
⛰️ mountain
🏔️ mountain snow
🗻 mount fuji
🏕️ camping tent
⛺ tent
🛖 hut
🏠 house
🏡 house with garden
🏘️ houses
🏚️ derelict house
🏗️ building construction crane
🏭 factory
🏢 office building
🏬 department store
🏣 japanese post office
🏤 post office
🏥 hospital
🏦 bank
🏨 hotel
🏩 love hotel
🏪 convenience store
🏫 school
🏛️ classical building courthouse
⛪ church
🕌 mosque
🛕 hindu temple
🕍 synagogue
⛩️ shinto shrine
🕋 kaaba mecca
⛲ fountain park
🗽 liberty statue
🌁 foggy fog
🌃 night with stars city
🏙️ cityscape city
🌄 sunrise over mountains
🌅 sunrise
🌆 city dusk sunset
🌇 sunset cities
🌉 bridge at night
♨️ hot springs onsen
🎑 moon viewing ceremony
🎆 fireworks
🎇 sparkler
🎐 wind chime
🎏 carp streamer
` },
  objects: { name: 'Objects', tab: '💡', raw: `
⌚ watch
📱 mobile phone cell
📲 mobile phone arrow
💻 laptop computer
⌨️ keyboard
🖥️ desktop computer
🖨️ printer
🖱️ computer mouse
🖲️ trackball
🕹️ joystick
🗜️ clamp compression
💽 minidisc
💾 floppy disk save
💿 cd disc
📀 dvd
📼 videocassette
📷 camera
📸 camera with flash
📹 video camera
🎥 movie camera
📽️ film projector
🎞️ film frames
📞 telephone receiver
☎️ telephone
📟 pager
📠 fax machine
📺 television tv
📻 radio
🎙️ studio microphone
🎚️ level slider
🎛️ control knobs
🧭 compass
⏱️ stopwatch
⏲️ timer
⏰ alarm clock
🕰️ mantelpiece clock
⌛ hourglass done
⏳ hourglass not done
📡 satellite antenna
🔋 battery
🔌 electric plug
💡 light bulb idea
🔦 flashlight torch
🕯️ candle
🪔 diya lamp oil
🧯 fire extinguisher
🛢️ oil drum
💸 money with wings
💵 dollar banknote money cash
💴 yen banknote
💶 euro banknote
💷 pound banknote
💰 money bag
💳 credit card
💎 gem stone diamond
⚖️ balance scale justice
🧰 toolbox
🔧 wrench
🔨 hammer
⚒️ hammer pick
🛠️ hammer wrench tools
⛏️ pick mining
🪓 axe
🪚 carpentry saw
🔩 nut and bolt
⚙️ gear settings
🪤 mouse trap
🧱 brick
⛓️ chains
🧲 magnet
🔫 water pistol toy
💣 bomb
🧨 firecracker
🪃 boomerang
🏹 bow and arrow
🛡️ shield
🪚 saw
🔪 kitchen knife cooking
🗡️ dagger knife
⚔️ crossed swords
🚬 cigarette
⚰️ coffin
⚱️ funeral urn
🏺 amphora vase
🔮 crystal ball fortune
📿 prayer beads
🧿 nazar amulet
💈 barber pole salon
⚗️ alembic chemistry
🔭 telescope astronomy
🔬 microscope science
🕳️ hole
🩹 adhesive bandage band aid
🩺 stethoscope doctor
💊 pill medicine
💉 syringe shot vaccine
🩸 drop of blood
🧬 dna
🦠 microbe virus germ
🧫 petri dish
🧪 test tube science
🌡️ thermometer
🧹 broom sweep
🧺 basket
🧻 roll of paper toilet
🪣 bucket
🧼 soap
🪥 toothbrush
🧽 sponge
🛁 bathtub
🛀 bath shower
🪒 razor
🧴 lotion bottle shampoo
🪞 mirror
🪟 window
🛏️ bed
🛋️ couch sofa
🪑 chair
🚽 toilet
🚿 shower
🧯 fire extinguisher
🚪 door
🪑 chair seat
🛒 shopping cart
🎁 gift wrapped present
🎈 balloon party
🎏 carp streamer
🎀 ribbon bow
🪄 magic wand
🪅 piñata
🪆 nesting dolls
🎊 confetti ball party
🎉 party popper celebrate
🧧 red envelope lucky money
✉️ envelope letter mail
📩 envelope with down arrow
📨 incoming envelope mail
📧 e mail email
💌 love letter
📥 inbox tray
📤 outbox tray
📦 package box
🏷️ label tag
📪 closed mailbox flag down
📫 closed mailbox flag up
📬 open mailbox flag up
📭 open mailbox flag down
📮 postbox
📯 postal horn
📜 scroll
📃 page with curl
📄 page facing up
📑 bookmark tabs
🧾 receipt
📊 bar chart
📈 chart upwards trending
📉 chart downwards trending
🗒️ spiral notepad
🗓️ spiral calendar
📆 tear off calendar
📅 calendar date
🗑️ wastebasket trash
📇 card index
🗃️ card file box
🗳️ ballot box ballot
🗄️ file cabinet
📋 clipboard
📁 file folder
📂 open file folder
🗂️ card index dividers
🗞️ rolled up newspaper
📰 newspaper
📓 notebook
📔 notebook with decorative cover
📒 ledger
📕 closed book
📗 green book
📘 blue book
📙 orange book
📚 books stack
📖 open book
🔖 bookmark
🧷 safety pin
🔗 link
📎 paperclip
🖇️ linked paperclips
📐 triangular ruler
📏 straight ruler
🧮 abacus
📌 pushpin
📍 round pushpin
✂️ scissors
🖊️ pen
🖋️ fountain pen
✒️ black nib
🖌️ paintbrush
🖍️ crayon
📝 memo writing
✏️ pencil
🔍 magnifying glass left
🔎 magnifying glass right
🔏 locked with pen
🔐 locked with key
🔒 locked padlock
🔓 unlocked padlock
🔑 key
🗝️ old key
` },
  symbols: { name: 'Symbols', tab: '❤️', raw: `
❤️ red heart love
🧡 orange heart
💛 yellow heart
💚 green heart
💙 blue heart
💜 purple heart
🖤 black heart
🤍 white heart
🤎 brown heart
💔 broken heart
❣️ heart exclamation
💕 two hearts
💞 revolving hearts
💓 beating heart
💗 growing heart
💖 sparkling heart
💘 heart with arrow
💝 heart with ribbon
💟 heart decoration
☮️ peace symbol
✝️ latin cross christianity
☪️ star and crescent islam
🕉️ om hinduism
☸️ wheel of dharma buddhism
✡️ star of david judaism
🔯 dotted six pointed star
🕎 menorah
☯️ yin yang taoism
☦️ orthodox cross
🛐 place of worship
⛎ ophiuchus
♈ aries zodiac
♉ taurus zodiac
♊ gemini zodiac
♋ cancer zodiac
♌ leo zodiac
♍ virgo zodiac
♎ libra zodiac
♏ scorpio zodiac
♐ sagittarius zodiac
♑ capricorn zodiac
♒ aquarius zodiac
♓ pisces zodiac
🆔 id button
⚛️ atom symbol science
🉑 acceptable button
☢️ radioactive
☣️ biohazard
📴 mobile phone off
📳 vibration mode
🈶 not free of charge
🈚 free of charge
🈸 application button
🈺 open for business
🈷️ monthly amount button
✴️ eight pointed star
🆚 vs versus
💮 white flower stamp
🉐 bargain button
㊙️ secret
㊗️ congratulations button
🈴 passing grade
🈵 no vacancy
🈹 discount
🈲 prohibited
🅰️ a button blood type
🅱️ b button blood type
🆎 ab button blood type
🆑 cl button
🅾️ o button blood type
🆘 sos help
❌ cross mark x
⭕ hollow red circle
🛑 stop sign
⛔ no entry
📛 name badge
🚫 prohibited no entry
💯 hundred 100
💢 anger symbol
♨️ hot springs
🚷 no pedestrians
🚯 no littering
🚳 no bicycles
🚱 non potable water
🔞 no one under 18
📵 no mobile phones
🚭 no smoking
❗ red exclamation mark
❕ white exclamation mark
❓ red question mark
❔ white question mark
‼️ double exclamation mark
⁉️ exclamation question mark
🔅 dim button
🔆 bright button
〽️ part alternation mark
⚠️ warning
🚸 children crossing
🔱 trident emblem
⚜️ fleur de lis
🔰 japanese symbol beginner
♻️ recycling symbol
✅ check mark button green
🈯 reserved button
💹 chart increasing yen
❎ cross mark button
🌐 globe with meridians web
💠 diamond with a dot
Ⓜ️ circled m
🌀 cyclone hurricane
💤 zzz sleeping
🏧 atm sign
🚾 water closet wc
♿ wheelchair symbol accessible
🅿️ p button parking
🛗 elevator
🈳 vacancy button
🈂️ service charge
🛂 passport control
🛃 customs
🛄 baggage claim
🛅 left luggage
🚹 men sign
🚺 women sign
🚼 baby symbol
🚻 restroom
🚮 litter in bin
🎦 cinema
📶 antenna bars signal
🈁 here button
🔣 input symbols
ℹ️ information
🔤 input latin letters
🔡 input lowercase letters
🔠 input uppercase letters
🆖 ng button
🆗 ok button
🆙 up button
🆒 cool button
🆕 new button
🆓 free button
0️⃣ keycap 0
1️⃣ keycap 1
2️⃣ keycap 2
3️⃣ keycap 3
4️⃣ keycap 4
5️⃣ keycap 5
6️⃣ keycap 6
7️⃣ keycap 7
8️⃣ keycap 8
9️⃣ keycap 9
🔟 keycap 10
#️⃣ keycap hash
*️⃣ keycap asterisk
⏏️ eject button
▶️ play button
⏸️ pause button
⏯️ play pause button
⏹️ stop button
⏺️ record button
⏭️ next track button
⏮️ last track button
⏩ fast forward button
⏪ fast reverse button
⏫ fast up button
⏬ fast down button
◀️ reverse button
🔼 upwards button
🔽 downwards button
➡️ right arrow
⬅️ left arrow
⬆️ up arrow
⬇️ down arrow
↗️ up right arrow
↘️ down right arrow
↙️ down left arrow
↖️ up left arrow
↕️ up down arrow
↔️ left right arrow
↪️ left arrow curving right
↩️ right arrow curving left
⤴️ right arrow curving up
⤵️ right arrow curving down
🔀 shuffle tracks
🔁 repeat
🔂 repeat single
🔄 counterclockwise arrows
🔃 clockwise vertical arrows
🎵 musical note
🎶 musical notes
➕ plus
➖ minus
➗ divide
✖️ multiply
🟰 heavy equals
♾️ infinity
💲 dollar sign
💱 currency exchange
™️ trademark
©️ copyright
®️ registered
` },
  flags: { name: 'Flags', tab: '🏁', raw: `
🏁 chequered flag race
🚩 triangular flag
🎌 crossed flags
🏴 black flag
🏳️ white flag
🏳️‍🌈 rainbow flag pride
🏳️‍⚧️ transgender flag
🏴‍☠️ pirate flag
🇺🇸 united states usa american
🇬🇧 united kingdom britain england
🇨🇦 canada
🇲🇽 mexico
🇧🇷 brazil
🇦🇷 argentina
🇨🇱 chile
🇨🇴 colombia
🇨🇺 cuba
🇵🇪 peru
🇩🇴 dominican republic
🇵🇷 puerto rico
🇯🇲 jamaica
🇮🇪 ireland
🇫🇷 france
🇩🇪 germany
🇮🇹 italy
🇪🇸 spain
🇵🇹 portugal
🇳🇱 netherlands holland
🇧🇪 belgium
🇨🇭 switzerland
🇦🇹 austria
🇸🇪 sweden
🇳🇴 norway
🇩🇰 denmark
🇫🇮 finland
🇮🇸 iceland
🇵🇱 poland
🇨🇿 czech czech republic
🇸🇰 slovakia
🇭🇺 hungary
🇷🇴 romania
🇧🇬 bulgaria
🇬🇷 greece
🇷🇺 russia
🇺🇦 ukraine
🇷🇸 serbia
🇭🇷 croatia
🇨🇳 china
🇯🇵 japan
🇰🇷 south korea
🇻🇳 vietnam
🇹🇭 thailand
🇵🇭 philippines
🇮🇩 indonesia
🇲🇾 malaysia
🇸🇬 singapore
🇮🇳 india
🇵🇰 pakistan
🇧🇩 bangladesh
🇱🇰 sri lanka
🇳🇵 nepal
🇲🇲 myanmar burma
🇰🇭 cambodia
🇲🇳 mongolia
🇰🇿 kazakhstan
🇺🇿 uzbekistan
🇹🇷 turkey
🇮🇷 iran
🇮🇱 israel
🇱🇧 lebanon
🇸🇾 syria
🇯🇴 jordan
🇸🇦 saudi arabia
🇪🇬 egypt
🇲🇦 morocco
🇩🇿 algeria
🇹🇳 tunisia
🇳🇬 nigeria
🇰🇪 kenya
🇪🇹 ethiopia
🇬🇭 ghana
🇿🇦 south africa
🇸🇳 senegal
🇺🇬 uganda
🇨🇲 cameroon
🇦🇺 australia
🇳🇿 new zealand
🇫🇯 fiji
🇼🇸 samoa
` },
};

let _emojiIndex = null;
function getEmojiIndex() {
  if (_emojiIndex) return _emojiIndex;
  _emojiIndex = [];
  for (const [catId, cat] of Object.entries(EMOJI_DATA)) {
    cat.items = cat.raw.trim().split('\n').map(line => {
      const i = line.indexOf(' ');
      const e = line.slice(0, i);
      const k = line.slice(i + 1).trim();
      return { e, k, c: catId };
    });
    _emojiIndex.push(...cat.items);
  }
  return _emojiIndex;
}

// -------------------- CROP MODAL --------------------
// Square-aspect crop: source image rendered behind a fixed 1:1 viewfinder.
// User pans by dragging, zooms via slider or wheel. Output: JPEG data URL.
const CropModal = {
  el: null,
  state: null, // { img, scale, minScale, tx, ty, stage, frame, resolve, size }
  init() {
    this.el = $('#crop-modal');
    if (!this.el || this.el.dataset.bound) return;
    this.el.dataset.bound = '1';
    on(this.el, 'click', (e) => { if (e.target.closest('[data-close]')) this.cancel(); });
    on($('#crop-zoom'), 'input', (e) => this.setScale(parseInt(e.target.value, 10) / 100 * this.state.minScale));
    on($('#crop-apply'), 'click', () => this.apply());

    const stage = $('#crop-stage');
    let dragging = false, lastX = 0, lastY = 0;
    on(stage, 'pointerdown', (e) => {
      if (!this.state) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      stage.setPointerCapture?.(e.pointerId);
      stage.classList.add('is-dragging');
    });
    on(stage, 'pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      this.pan(dx, dy);
    });
    const stop = (e) => {
      dragging = false;
      stage.releasePointerCapture?.(e.pointerId);
      stage.classList.remove('is-dragging');
    };
    on(stage, 'pointerup', stop);
    on(stage, 'pointercancel', stop);
    on(stage, 'wheel', (e) => {
      if (!this.state) return;
      e.preventDefault();
      const next = this.state.scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08);
      this.setScale(next);
      $('#crop-zoom').value = Math.round((this.state.scale / this.state.minScale) * 100);
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.el.getAttribute('aria-hidden') === 'false') this.cancel();
    });
  },
  open(dataUrl, { size = 480 } = {}) {
    this.init();
    return new Promise((resolve) => {
      const img = $('#crop-img');
      img.onload = () => {
        const stageEl = $('#crop-stage');
        const stageRect = stageEl.getBoundingClientRect();
        const stageW = stageRect.width;
        const stageH = stageRect.height;
        // Viewfinder: square, 78% of the smaller side.
        const frame = Math.floor(Math.min(stageW, stageH) * 0.78);
        const frameLeft = (stageW - frame) / 2;
        const frameTop  = (stageH - frame) / 2;
        $('#crop-stage').style.setProperty('--crop-frame', `${frame}px`);
        $('#crop-stage').style.setProperty('--crop-frame-l', `${frameLeft}px`);
        $('#crop-stage').style.setProperty('--crop-frame-t', `${frameTop}px`);
        // Minimum scale: fill the frame on the smaller image dimension.
        const minScale = frame / Math.min(img.naturalWidth, img.naturalHeight);
        const scale = minScale;
        const drawW = img.naturalWidth * scale;
        const drawH = img.naturalHeight * scale;
        // Center the image so the frame sits over its middle.
        const tx = (stageW - drawW) / 2;
        const ty = (stageH - drawH) / 2;
        this.state = {
          img, scale, minScale, tx, ty, size,
          stageW, stageH, frame, frameLeft, frameTop,
          resolve,
        };
        this.applyTransform();
        $('#crop-zoom').value = 100;
      };
      img.src = dataUrl;
      this.el.setAttribute('aria-hidden', 'false');
    });
  },
  setScale(next) {
    if (!this.state) return;
    const { minScale, img, frame } = this.state;
    const maxScale = minScale * 5;
    next = Math.max(minScale, Math.min(maxScale, next));
    // Keep the image centered relative to the frame's center while zooming.
    const drawWBefore = img.naturalWidth * this.state.scale;
    const drawHBefore = img.naturalHeight * this.state.scale;
    const cxBefore = (this.state.frameLeft + frame / 2 - this.state.tx) / drawWBefore;
    const cyBefore = (this.state.frameTop  + frame / 2 - this.state.ty) / drawHBefore;
    this.state.scale = next;
    const drawW = img.naturalWidth * next;
    const drawH = img.naturalHeight * next;
    this.state.tx = this.state.frameLeft + frame / 2 - cxBefore * drawW;
    this.state.ty = this.state.frameTop  + frame / 2 - cyBefore * drawH;
    this.clampPan();
    this.applyTransform();
  },
  pan(dx, dy) {
    if (!this.state) return;
    this.state.tx += dx;
    this.state.ty += dy;
    this.clampPan();
    this.applyTransform();
  },
  clampPan() {
    const { img, scale, frame, frameLeft, frameTop } = this.state;
    const drawW = img.naturalWidth * scale;
    const drawH = img.naturalHeight * scale;
    // Image must always cover the frame.
    const minTx = frameLeft + frame - drawW;
    const maxTx = frameLeft;
    const minTy = frameTop + frame - drawH;
    const maxTy = frameTop;
    this.state.tx = Math.max(minTx, Math.min(maxTx, this.state.tx));
    this.state.ty = Math.max(minTy, Math.min(maxTy, this.state.ty));
  },
  applyTransform() {
    const { img, scale, tx, ty } = this.state;
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    img.style.transformOrigin = '0 0';
  },
  apply() {
    if (!this.state) return;
    const { img, scale, tx, ty, frame, frameLeft, frameTop, size, resolve } = this.state;
    // Map frame corner to source pixel coordinates.
    const srcX = (frameLeft - tx) / scale;
    const srcY = (frameTop  - ty) / scale;
    const srcSize = frame / scale;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, srcX, srcY, srcSize, srcSize, 0, 0, size, size);
    const out = canvas.toDataURL('image/jpeg', 0.88);
    this.cleanup();
    resolve(out);
  },
  cancel() {
    if (!this.state) { this.el.setAttribute('aria-hidden', 'true'); return; }
    const { resolve } = this.state;
    this.cleanup();
    resolve(null);
  },
  cleanup() {
    this.el.setAttribute('aria-hidden', 'true');
    const img = $('#crop-img');
    img.removeAttribute('src');
    img.style.transform = '';
    this.state = null;
  },
};

const EmojiPicker = {
  activeInput: null,
  popover: null,
  current: 'smileys',
  ensure() {
    if (this.popover) return this.popover;
    getEmojiIndex();
    const pop = document.createElement('div');
    pop.className = 'emoji-popover';
    pop.hidden = true;
    pop.innerHTML = `
      <input class="emoji-search" placeholder="Search emojis (e.g. cruise, cake, party)…" />
      <div class="emoji-tabs"></div>
      <div class="emoji-grid"></div>
    `;
    document.body.appendChild(pop);
    this.popover = pop;

    const tabs = pop.querySelector('.emoji-tabs');
    tabs.innerHTML = Object.entries(EMOJI_DATA).map(([id, cat]) =>
      `<button type="button" class="emoji-tab" data-cat="${id}" title="${escape(cat.name)}">${cat.tab}</button>`
    ).join('');
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]'); if (!b) return;
      this.current = b.dataset.cat;
      pop.querySelector('.emoji-search').value = '';
      this.renderGrid();
    });

    pop.querySelector('.emoji-search').addEventListener('input', () => this.renderGrid());
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]'); if (!b) return;
      if (this.activeInput) {
        this.activeInput.value = b.dataset.pick;
        this.activeInput.dispatchEvent(new Event('input', { bubbles: true }));
        this.activeInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      this.close();
    });
    document.addEventListener('click', (e) => {
      if (pop.hidden) return;
      if (e.target.closest('.emoji-popover')) return;
      if (e.target.closest('[data-emoji-trigger]')) return;
      this.close();
    });
    return pop;
  },
  renderGrid() {
    const pop = this.popover;
    pop.querySelectorAll('.emoji-tab').forEach(t => t.classList.toggle('is-active', t.dataset.cat === this.current));
    const q = pop.querySelector('.emoji-search').value.trim().toLowerCase();
    const items = q
      ? getEmojiIndex().filter(x => x.k.includes(q))
      : EMOJI_DATA[this.current].items;
    pop.querySelector('.emoji-grid').innerHTML = items.length
      ? items.map(x => `<button type="button" class="emoji-cell" data-pick="${x.e}" title="${escape(x.k.split(' ').slice(0, 3).join(', '))}">${x.e}</button>`).join('')
      : '<p class="muted small" style="padding:14px;">No emojis match.</p>';
  },
  open(input, anchor) {
    this.activeInput = input;
    const pop = this.ensure();
    const rect = anchor.getBoundingClientRect();
    pop.style.top  = (rect.bottom + window.scrollY + 6) + 'px';
    pop.style.left = (Math.max(8, Math.min(window.innerWidth - 360, rect.left + window.scrollX))) + 'px';
    pop.hidden = false;
    pop.querySelector('.emoji-search').value = '';
    setTimeout(() => pop.querySelector('.emoji-search').focus(), 30);
    this.renderGrid();
  },
  close() {
    if (this.popover) this.popover.hidden = true;
    this.activeInput = null;
  },
};

// -------------------- EVENTS VIEW --------------------
const MEAL_LABELS = { none: 'No meal', full: 'Full meal', half: 'Half meal', kids: 'Kids meal' };

// Sum-up helper for an event's expenses. Defensive: missing array → zeros.
function eventExpenseTotals(ev) {
  const xs = (ev && ev.expenses) || [];
  let total = 0, paid = 0;
  xs.forEach(x => {
    const a = Number(x.amount) || 0;
    total += a;
    if (x.paid) paid += a;
  });
  return { total, paid, unpaid: total - paid, count: xs.length };
}

const EventsView = {
  selectedId: null,
  detailView: 'attendees',           // 'attendees' | 'expenses'
  init() {
    on($('#btn-event-add'), 'click', () => this.openModal());
    on($('#event-is-trip'), 'change', (e) => {
      $('#event-trip-fieldset').hidden = !e.target.checked;
      if (e.target.checked && !$('#event-itin-rows').children.length) this._addItineraryRow();
    });
    on($('#event-add-itin'), 'click', () => this._addItineraryRow());
    on($('#event-modal'), 'click', (e) => { if (e.target.closest('[data-close]')) this.closeModal(); });
    on($('#event-form'), 'submit', (e) => { e.preventDefault(); this.saveModal(); });

    // full emoji picker — opens on Browse button click
    on($('#event-icon-browse'), 'click', (e) => {
      e.stopPropagation();
      EmojiPicker.open($('#event-icon'), $('#event-icon-browse'));
    });

    // cover photo
    on($('#event-cover-file'), 'change', async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = await resizeDataUrl(reader.result, 1024);
        $('#event-form').dataset.cover = dataUrl;
        $('#event-cover-preview').style.backgroundImage = `url('${cssUrl(dataUrl)}')`;
        $('#event-cover-url').value = '';
      };
      reader.readAsDataURL(file);
    });
    on($('#event-cover-url'), 'input', (e) => {
      const url = e.target.value.trim();
      $('#event-form').dataset.cover = url;
      $('#event-cover-preview').style.backgroundImage = url ? `url('${cssUrl(url)}')` : '';
    });
    on($('#event-cover-clear'), 'click', () => {
      $('#event-form').dataset.cover = '';
      $('#event-cover-url').value = '';
      $('#event-cover-preview').style.backgroundImage = '';
    });
  },
  render() {
    // Users only see events they're part of.
    const events = userEventsList().slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const list = $('#event-list');

    refreshEventsNav();

    if (!events.length) {
      list.innerHTML = Auth.isAdmin()
        ? `<p class="muted small" style="padding:14px 4px;">No events yet — create one to start tracking attendance.</p>`
        : `<p class="muted small" style="padding:14px 4px;">You don't have any events yet. An admin will add you when there's something to attend.</p>`;
      this.renderDetail();
      return;
    }
    // If the previously-selected event is no longer visible (e.g. user mode), reset selection.
    if (this.selectedId && !events.some(e => e.id === this.selectedId)) {
      this.selectedId = null;
    }

    // Group by month (year-month). "No date" goes at the end.
    const groups = new Map();
    events.forEach(ev => {
      let key = 'undated';
      if (ev.date) {
        const d = new Date(ev.date + 'T00:00:00');
        key = isNaN(d.getTime()) ? 'undated' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    });
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === 'undated') return 1;
      if (b === 'undated') return -1;
      return b.localeCompare(a);
    });
    const monthLabel = (k) => {
      if (k === 'undated') return 'No date';
      const [y, m] = k.split('-');
      return new Date(+y, +m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    };

    const today = new Date(); today.setHours(0, 0, 0, 0);
    list.innerHTML = keys.map(k => `
      <div class="event-month">
        <div class="event-month-label">${monthLabel(k)}</div>
        ${groups.get(k).map(ev => {
          const icon = ev.icon || '🎉';
          const evDate = ev.date ? new Date(ev.date + 'T00:00:00') : null;
          const isPast = evDate && !isNaN(evDate.getTime()) && evDate < today;
          // Card net = gifts received − gifts given − paid expenses. Negative
          // (red) when paid expenses exceed gift income; positive (green)
          // otherwise. Only paid expenses count — unpaid bills don't affect
          // the at-a-glance number.
          // Money summary chip is admin-only — non-admin users still see
          // event name + date + attendee count but never the net amount.
          const giftNet = eventGiftNet(ev.id);
          const expTot  = eventExpenseTotals(ev);
          const cardNet = giftNet.net - expTot.paid;
          const hasNum  = giftNet.received !== 0 || giftNet.given !== 0 || expTot.paid !== 0;
          const netChip = (Auth.isAdmin() && hasNum)
            ? `<span class="event-net ${cardNet >= 0 ? 'is-positive' : 'is-negative'}" title="Gifts in $${giftNet.received.toFixed(2)} · Gifts out $${giftNet.given.toFixed(2)} · Paid expenses $${expTot.paid.toFixed(2)}">${cardNet >= 0 ? '+' : '−'}$${Math.abs(cardNet).toFixed(2)}</span>`
            : '';
          return `
            <button class="event-item${ev.id === this.selectedId ? ' is-active' : ''}${isPast ? ' is-past' : ''}" data-id="${ev.id}">
              <span class="event-item-icon">${escape(icon)}</span>
              <div class="event-item-text">
                <div class="event-item-name">${escape(ev.name)}${netChip}</div>
                <div class="event-item-meta">
                  <span>${ev.date ? formatDate(ev.date) : 'No date'}</span>
                  <span>·</span>
                  <span>${(ev.attendees || []).length} attendee${(ev.attendees||[]).length === 1 ? '' : 's'}</span>
                </div>
              </div>
            </button>`;
        }).join('')}
      </div>`).join('');
    list.querySelectorAll('.event-item').forEach(b =>
      on(b, 'click', () => { this.selectedId = b.dataset.id; this.render(); })
    );
    this.renderDetail();
  },
  renderDetail() {
    const detail = $('#event-detail');
    const ev = (Store.state.events || []).find(e => e.id === this.selectedId);
    if (!ev) {
      detail.innerHTML = `<div class="event-detail-empty"><p class="muted">Pick an event on the left, or create a new one.</p></div>`;
      return;
    }
    const memMap = Object.fromEntries(Store.membersList().map(m => [m.id, m]));
    const attendeesRaw = ev.attendees || [];
    // Give every attendee a STABLE synthetic id so a row's identity never
    // depends on array position OR on an editable field (email/meal — which an
    // earlier composite key wrongly included, so editing email then meal on the
    // same row silently dropped the second edit). Legacy rows get an id lazily
    // here; it persists on the next save. uids are unique → no key collisions.
    attendeesRaw.forEach(a => { if (a && !a.attUid) a.attUid = uid('att'); });
    const keyOf = (a) => (a && a.attUid) ? a.attUid : '';
    const resolveAttendee = (idx, key) => {
      if (!key) return Number.isInteger(idx) ? idx : -1;            // legacy/no-key
      if (attendeesRaw[idx] && keyOf(attendeesRaw[idx]) === key) return idx; // fast path
      return attendeesRaw.findIndex(a => keyOf(a) === key);          // -1 if gone
    };
    const isAdmin = Auth.isAdmin();
    const MEAL_LABEL = { none: '—', full: 'Full', half: 'Half', kids: 'Kids' };
    const STATUS_LABEL = { accepted: 'Accepted', invited: 'Invited', declined: 'Declined', 'no-show': 'No-show' };
    // Sort: Accepted first → Invited → No-show → Declined last. Stable within each bucket.
    const STATUS_ORDER = { attended: 0, accepted: 0, invited: 1, 'no-show': 2, declined: 3 };
    // In user mode, pin "your row" to the top so the user sees their RSVP first.
    const u = Auth.current;
    const isOwnRow = (a) => u && u !== 'admin-bootstrap' && a.memberId === u.id;
    const attendees = attendeesRaw
      .map((a, originalIdx) => ({ a, originalIdx }))
      .sort((p, q) => {
        if (!isAdmin) {
          const po = isOwnRow(p.a) ? 0 : 1;
          const qo = isOwnRow(q.a) ? 0 : 1;
          if (po !== qo) return po - qo;
        }
        const pa = STATUS_ORDER[p.a.status] ?? 1;
        const qa = STATUS_ORDER[q.a.status] ?? 1;
        if (pa !== qa) return pa - qa;
        return p.originalIdx - q.originalIdx;
      });

    // Pre-compute gift totals per attendee for this event so each row can show
    // "$X" right before the Gift button. Match member attendees by id; custom
    // attendees by their fromText (case-insensitive name match).
    const giftTotalForAttendee = (att) => {
      let total = 0;
      const allGifts = (Store.state.gifts || []).filter(g => g.eventId === ev.id && g.direction === 'received');
      allGifts.forEach(g => {
        const amt = Number(g.amount) || 0;
        if (att.memberId) {
          if (Array.isArray(g.fromMemberIds) && g.fromMemberIds.includes(att.memberId)) total += amt;
        } else if (att.customName) {
          if ((g.fromText || '').trim().toLowerCase() === (att.customName || '').trim().toLowerCase()) total += amt;
        }
      });
      return total;
    };

    const rowsHtml = attendees.map(({ a, originalIdx: idx }) => {
      const m = a.memberId ? memMap[a.memberId] : null;
      // Migrate legacy "attended" → "accepted"
      const status = (a.status === 'attended') ? 'accepted' : (a.status || 'invited');
      const meal   = a.meal || 'none';
      const plus   = Number(a.plusN || 0);
      const emailVal = a.email != null ? a.email : (m?.email || '');
      const canEdit  = canEditAttendee(a);
      const isYou    = isOwnRow(a);
      const nameCell = m ? `
        <div class="row-name">
          <div class="row-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : ''}></div>
          <div>
            <div style="font-weight:600">${escape(displayName(m))}${isYou ? ' <span class="row-you-tag">you</span>' : ''}</div>
          </div>
        </div>` : `
        <div class="row-name">
          <div class="row-avatar guest" title="Custom attendee">${escape((a.customName || '?').slice(0, 1).toUpperCase())}</div>
          <div>
            <div style="font-weight:600">${escape(a.customName || 'Guest')}</div>
            <div class="muted small">${a.addedBy && a.addedBy === u?.id ? 'Your guest' : 'Custom attendee'}</div>
          </div>
        </div>`;

      const statusCell = canEdit
        ? `<select class="input compact attendance-status" data-idx="${idx}">
            <option value="accepted" ${status==='accepted'?'selected':''}>Accepted</option>
            <option value="invited"  ${status==='invited'?'selected':''}>Invited</option>
            <option value="declined" ${status==='declined'?'selected':''}>Declined</option>
            <option value="no-show"  ${status==='no-show'?'selected':''}>No-show</option>
          </select>`
        : `<span class="att-readonly status-pill status-${status}">${STATUS_LABEL[status] || status}</span>`;

      const plusCell = canEdit
        ? `<input type="number" min="0" max="9" class="input compact att-plus" data-idx="${idx}" value="${plus}" />`
        : `<span class="att-readonly">${plus}</span>`;

      const mealCell = canEdit
        ? `<select class="input compact att-meal" data-idx="${idx}">
            <option value="none" ${meal==='none'?'selected':''}>—</option>
            <option value="full" ${meal==='full'?'selected':''}>Full</option>
            <option value="half" ${meal==='half'?'selected':''}>Half</option>
            <option value="kids" ${meal==='kids'?'selected':''}>Kids</option>
          </select>`
        : `<span class="att-readonly">${MEAL_LABEL[meal] || meal}</span>`;

      const emailCell = canEdit
        ? `<input type="email" class="input compact att-email" data-idx="${idx}" value="${escape(emailVal)}" placeholder="email@…" />`
        : (isAdmin
            ? `<span class="att-readonly">${escape(emailVal || '—')}</span>`
            : `<span class="att-readonly muted">—</span>`);

      const giftAmount = giftTotalForAttendee(a);
      const giftChip = giftAmount > 0
        ? `<span class="att-gift-amount" title="Gifts received from this attendee for this event">$${giftAmount.toFixed(2)}</span>`
        : '';
      const actionsCell = isAdmin
        ? `${giftChip}
          <button class="btn btn-ghost btn-sm" data-gift="${idx}" title="Log a gift for this attendee">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none"><rect x="2" y="6" width="12" height="8" rx="1" stroke="currentColor" stroke-width="1.4"/><path d="M2 9h12M8 6v8M5 5a1.5 1.5 0 1 1 3 0M11 5a1.5 1.5 0 1 0-3 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            Gift
          </button>
          <button class="btn btn-ghost btn-sm" data-remove="${idx}">Remove</button>`
        : (a.addedBy === u?.id
            ? `<button class="btn btn-ghost btn-sm" data-remove="${idx}" title="Remove your guest">Remove</button>`
            : '');

      return `
        <tr data-idx="${idx}" data-att-key="${escape(keyOf(a))}" class="status-${status}${isYou ? ' is-you-row' : ''}">
          <td>${nameCell}</td>
          <td>${statusCell}</td>
          <td>${plusCell}</td>
          <td>${mealCell}</td>
          <td>${emailCell}</td>
          <td style="text-align:right; white-space:nowrap;">${actionsCell}</td>
        </tr>`;
    }).join('');

    const accepted = attendeesRaw.filter(a => a.status === 'accepted' || a.status === 'attended').length;
    const totalHeadcount = attendeesRaw.reduce((s, a) => s + 1 + Number(a.plusN || 0), 0);
    const groups = Store.state.groups || [];
    const cover = ev.coverPhoto || ev.coverUrl;

    const locationHtml = ev.location
      ? ` · <a class="event-location-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener noreferrer">${escape(ev.location)} <svg viewBox="0 0 16 16" width="11" height="11" fill="none" style="vertical-align:-1px;"><path d="M9 3h4v4M13 3l-6 6M11 9v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></a>`
      : '';

    const headerActions = isAdmin ? `
      <div class="event-head-tools">
        <div class="seg" role="tablist" aria-label="Detail view">
          <button class="seg-btn ${this.detailView === 'attendees' ? 'is-active' : ''}" data-detail="attendees" type="button">Attendees</button>
          <button class="seg-btn ${this.detailView === 'expenses' ? 'is-active' : ''}" data-detail="expenses" type="button">Expenses</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="event-edit">Edit</button>
        <button class="btn btn-danger-ghost btn-sm" id="event-delete">Delete</button>
      </div>` : '';

    // Build expenses HTML (admin-only — users don't manage event budgets).
    const expenseTotals = eventExpenseTotals(ev);
    const giftNet      = eventGiftNet(ev.id);
    const fmtMoney = (n) => `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(2)}`;
    const expenseRows = ((ev.expenses) || []).map((x) => `
      <tr data-eid="${x.id}" class="${x.paid ? 'is-paid' : ''}">
        <td><input class="input compact exp-name" data-eid="${x.id}" value="${escape(x.name || '')}" placeholder="Expense" /></td>
        <td><input class="input compact exp-amount" data-eid="${x.id}" type="number" step="0.01" min="0" value="${Number(x.amount) || 0}" /></td>
        <td><input class="input compact exp-date" data-eid="${x.id}" type="date" value="${escape(x.date || '')}" /></td>
        <td>
          <select class="input compact exp-payment" data-eid="${x.id}">
            <option value="card"      ${x.paymentType === 'card' ? 'selected' : ''}>Card</option>
            <option value="cash"      ${x.paymentType === 'cash' ? 'selected' : ''}>Cash</option>
            <option value="etransfer" ${x.paymentType === 'etransfer' ? 'selected' : ''}>E-transfer</option>
            <option value="other"     ${x.paymentType === 'other' ? 'selected' : ''}>Other</option>
          </select>
        </td>
        <td class="exp-paid-cell"><label class="exp-paid-toggle"><input type="checkbox" class="exp-paid" data-eid="${x.id}" ${x.paid ? 'checked' : ''}/><span>Paid</span></label></td>
        <td style="text-align:right;"><button class="btn btn-danger-ghost btn-sm" data-exp-remove="${x.id}">Remove</button></td>
      </tr>`).join('');
    const expensesBody = `
      <div class="event-metric-row">
        <div class="event-metric">
          <span class="event-metric-label">Total expenses</span>
          <span class="event-metric-value">${fmtMoney(expenseTotals.total)}</span>
          <span class="event-metric-sub">${expenseTotals.count} item${expenseTotals.count === 1 ? '' : 's'}</span>
        </div>
        <div class="event-metric is-paid">
          <span class="event-metric-label">Paid</span>
          <span class="event-metric-value">${fmtMoney(expenseTotals.paid)}</span>
        </div>
        <div class="event-metric ${expenseTotals.unpaid > 0 ? 'is-unpaid' : ''}">
          <span class="event-metric-label">Unpaid</span>
          <span class="event-metric-value">${fmtMoney(expenseTotals.unpaid)}</span>
        </div>
        <div class="event-metric ${giftNet.net >= 0 ? 'is-positive' : 'is-negative'}">
          <span class="event-metric-label">Gifts net</span>
          <span class="event-metric-value">${giftNet.net >= 0 ? '+' : '−'}$${Math.abs(giftNet.net).toFixed(2)}</span>
          <span class="event-metric-sub">in ${fmtMoney(giftNet.received)} · out ${fmtMoney(giftNet.given)}</span>
        </div>
      </div>
      <div class="expense-add">
        <input class="input" id="exp-new-name"    placeholder="Expense name" />
        <input class="input" id="exp-new-amount"  type="number" step="0.01" min="0" placeholder="Amount" />
        <input class="input" id="exp-new-date"    type="date" value="${ev.date || ''}" />
        <select class="input" id="exp-new-payment">
          <option value="card">Card</option>
          <option value="cash">Cash</option>
          <option value="etransfer">E-transfer</option>
          <option value="other">Other</option>
        </select>
        <button class="btn btn-primary btn-sm" id="exp-add-btn">+ Add expense</button>
      </div>
      ${(ev.expenses || []).length ? `
        <div class="table-wrap">
          <table class="table expense-table">
            <thead><tr>
              <th>Expense</th><th>Amount</th><th>Date</th><th>Payment</th><th>Paid</th><th></th>
            </tr></thead>
            <tbody>${expenseRows}</tbody>
            <tfoot>
              <tr>
                <td><strong>Total</strong></td>
                <td><strong>${fmtMoney(expenseTotals.total)}</strong></td>
                <td colspan="2" class="muted small">Paid ${fmtMoney(expenseTotals.paid)} · Unpaid ${fmtMoney(expenseTotals.unpaid)}</td>
                <td colspan="2"></td>
              </tr>
            </tfoot>
          </table>
        </div>` : `<p class="muted small" style="margin-top:8px;">No expenses logged yet — add one above.</p>`}`;

    const bulkActions = isAdmin ? `
      <div class="attendance-actions">
        <button class="btn btn-secondary btn-sm" id="event-copy-emails" title="Copy every email on file">
          <svg viewBox="0 0 16 16" width="13" height="13"><rect x="4" y="3" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M3 11V4a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>
          Copy emails
        </button>
        <button class="btn btn-secondary btn-sm" id="event-mailto" title="Compose to everyone (BCC)">
          <svg viewBox="0 0 16 16" width="13" height="13"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M2 4l6 5 6-5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          Email everyone
        </button>
        <button class="btn btn-secondary btn-sm" id="event-mailto-active" title="Compose to Accepted + Invited only">
          <svg viewBox="0 0 16 16" width="13" height="13"><path d="M2 7v6a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7M2 7l6 4 6-4M2 7l1.5-3h9L14 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
          Email going + invited
        </button>
      </div>` : '';

    // v4.36: picker now spans members + friend household persons. Each
    // friend household contributes its primary + spouse (if any) + every
    // kid. Members + each person filterable by their excludeFromEventsList
    // flag so admins can keep the list scannable.
    const memberOpts = sortMembers(
      Store.membersList()
        .filter(m => !m.excludeFromEventsList)
        .filter(m => !attendeesRaw.some(a => a.memberId === m.id))
    ).map(m => `<option value="m:${m.id}">${escape(displayName(m))}</option>`);

    const friendOpts = [];
    sortFriends(Object.values(Store.state.friends || {})).forEach(f => {
      // Drop sub-options that have already been added to this event by their
      // synthesized refId so the dropdown doesn't duplicate already-attending
      // friends.
      const refIn = (refId) => attendeesRaw.some(a => a.personRef === refId);
      if (!f.excludeFromEventsList && !refIn('f:' + f.id)) {
        friendOpts.push(`<option value="f:${f.id}">${escape(displayName(f))}</option>`);
      }
      if (f.spouse && !f.spouse.excludeFromEventsList && !refIn('s:' + f.id)) {
        friendOpts.push(`<option value="s:${f.id}">${escape(displayName(f.spouse))} <span>(spouse of ${escape(displayName(f))})</span></option>`);
      }
      (f.kids || []).forEach(k => {
        if (!k.excludeFromEventsList && !refIn('k:' + f.id + ':' + k.id)) {
          friendOpts.push(`<option value="k:${f.id}:${k.id}">${escape(displayName(k))} <span>(child of ${escape(displayName(f))})</span></option>`);
        }
      });
    });

    const bulkAddBlock = isAdmin ? `
      <select class="input" id="event-add-member">
        <option value="">+ Add member…</option>
        ${memberOpts.length ? `<optgroup label="Family">${memberOpts.join('')}</optgroup>` : ''}
        ${friendOpts.length ? `<optgroup label="Friends">${friendOpts.join('')}</optgroup>` : ''}
      </select>
      ${groups.length ? `
        <select class="input" id="event-add-group">
          <option value="">+ Add by group…</option>
          ${groups.map(g => `<option value="${escape(g)}">${escape(g)}</option>`).join('')}
        </select>` : ''}
      <button class="btn btn-secondary btn-sm" id="event-add-all">Invite all family</button>` : '';

    const customAddBlock = `
      <div class="custom-add">
        <input class="input" id="event-add-custom" placeholder="${isAdmin ? 'Add custom attendee…' : 'Add a guest you\'re bringing…'}" />
        <button class="btn btn-ghost btn-sm" id="event-add-custom-btn">${isAdmin ? 'Add' : 'Add guest'}</button>
      </div>`;

    // Non-admins always get the attendees view (no expenses access).
    const activeDetail = isAdmin ? this.detailView : 'attendees';

    const attendeesBody = `
      <div class="event-stats">
        <div><span class="event-stat-num">${attendeesRaw.length}</span><span class="event-stat-label">Invited</span></div>
        <div><span class="event-stat-num">${accepted}</span><span class="event-stat-label">Accepted</span></div>
        <div><span class="event-stat-num">${totalHeadcount}</span><span class="event-stat-label">Total seats</span></div>
      </div>
      ${bulkActions}
      <div class="attendance-add">
        ${bulkAddBlock}
        ${customAddBlock}
      </div>
      ${attendeesRaw.length ? `
        <div class="table-wrap">
          <table class="table attendance-table">
            <thead><tr>
              <th>Attendee</th><th>Status</th><th>+N</th><th>Meal</th><th>Email</th><th></th>
            </tr></thead>
            <tbody>${rowsHtml}</tbody>
            ${(() => {
              // Total gifts received is financial info — admin only. Non-
              // admin users see the attendee list but not the money sum.
              if (!Auth.isAdmin()) return '';
              // Per-attendee giftTotalForAttendee credits the FULL gift to
              // every contributor (Hee=$500 AND Kim=$500 for a joint $500
              // gift). Summing those would double-count the actual money in
              // — so the table footer iterates gifts directly and dedupes.
              const sum = (Store.state.gifts || [])
                .filter(g => g.eventId === ev.id && g.direction === 'received')
                .reduce((s, g) => s + (Number(g.amount) || 0), 0);
              if (sum <= 0) return '';
              return `<tfoot>
                <tr class="attendance-total-row">
                  <td colspan="5" style="text-align:right; font-weight:600;">Total gifts received</td>
                  <td style="text-align:right; white-space:nowrap;"><span class="att-gift-amount att-gift-total">$${sum.toFixed(2)}</span></td>
                </tr>
              </tfoot>`;
            })()}
          </table>
        </div>` : `<p class="muted small">No attendees yet — add some above.</p>`}`;

    const tripPanel = ev.isTrip ? renderTripPanel(ev) : '';
    detail.innerHTML = `
      ${cover ? `<div class="event-cover" style="background-image:url('${cssUrl(cover)}')"></div>` : ''}
      <header class="panel-head">
        <div>
          <h3>${ev.isTrip ? '<span class="trip-badge">Trip</span>' : ''}${ev.icon ? `<span class="event-title-icon">${escape(ev.icon)}</span>` : ''}${escape(ev.name)}</h3>
          <p class="muted small">${ev.date ? formatDate(ev.date) : 'Date TBD'}${ev.isTrip && ev.tripEndDate ? ` – ${formatDate(ev.tripEndDate)}` : ''}${locationHtml}${ev.isTrip && ev.tripDestination ? ` · ${escape(ev.tripDestination)}` : ''}</p>
        </div>
        ${headerActions}
      </header>
      ${ev.description ? `<p class="panel-prose">${escape(ev.description)}</p>` : ''}
      ${tripPanel}
      <div class="panel-body">
        ${activeDetail === 'expenses' ? expensesBody : attendeesBody}
      </div>`;

    if (isAdmin) {
      on($('#event-edit'),   'click', () => this.openModal(ev.id));
      on($('#event-delete'), 'click', () => {
        if (!confirm(`Delete event "${ev.name}"?`)) return;
        Store.state.events = Store.state.events.filter(x => x.id !== ev.id);
        Store.save();
        this.selectedId = null;
        this.render();
      });

      // Detail-view segmented toggle (Attendees / Expenses)
      detail.querySelectorAll('.event-head-tools [data-detail]').forEach(btn => on(btn, 'click', () => {
        this.detailView = btn.dataset.detail;
        this.renderDetail();
      }));

      // Expense add + per-row edits + remove. All admin-only.
      if (this.detailView === 'expenses') {
        ev.expenses = ev.expenses || [];
        on($('#exp-add-btn'), 'click', () => {
          const name   = $('#exp-new-name').value.trim();
          const amount = parseFloat($('#exp-new-amount').value) || 0;
          if (!name && !amount) { toast('Add a name or amount first.', 'warn'); return; }
          ev.expenses.push({
            id: uid('exp'),
            name,
            amount,
            date: $('#exp-new-date').value || ev.date || '',
            paymentType: $('#exp-new-payment').value,
            paid: false,
          });
          Store.save();
          this.renderDetail();
        });

        const findExpense = (id) => ev.expenses.find(x => x.id === id);
        const updateExp = (sel, field, transform, rerender = false) => {
          detail.querySelectorAll(sel).forEach(el => on(el, 'change', () => {
            const x = findExpense(el.dataset.eid); if (!x) return;
            x[field] = transform(el.type === 'checkbox' ? el.checked : el.value);
            Store.save();
            if (rerender) this.renderDetail();
          }));
        };
        updateExp('.exp-name',    'name',        v => (v || '').toString());
        updateExp('.exp-amount',  'amount',      v => parseFloat(v) || 0, true);
        updateExp('.exp-date',    'date',        v => (v || '').toString());
        updateExp('.exp-payment', 'paymentType', v => (v || '').toString());
        updateExp('.exp-paid',    'paid',        v => !!v, true);

        detail.querySelectorAll('[data-exp-remove]').forEach(btn => on(btn, 'click', () => {
          const id = btn.dataset.expRemove;
          ev.expenses = ev.expenses.filter(x => x.id !== id);
          Store.save();
          this.renderDetail();
        }));
      }

      const pushAttendee = (member) => ({
        memberId: member.id, status: 'invited', notes: '', plusN: 0,
        meal: defaultMealForMember(member),
      });
      on($('#event-add-member'), 'change', (e) => {
        const v = e.target.value; if (!v) return;
        // v4.36: parse prefixed picker value. Members keep the simple
        // memberId attendee shape (existing code knows how to render
        // them). Friend household persons are pushed as customName +
        // email attendees with a `personRef` snapshot of where they came
        // from — the link survives renames if we ever decide to live-
        // resolve, but downstream UI doesn't need to change today.
        if (v.startsWith('m:')) {
          const m = Store.byId(v.slice(2)); if (!m) return;
          attendeesRaw.push(pushAttendee(m));
        } else if (v.startsWith('f:')) {
          const f = Store.state.friends?.[v.slice(2)]; if (!f) return;
          attendeesRaw.push({
            customName: fullName(f),
            email: f.email || '',
            status: 'invited', notes: '', plusN: 0,
            meal: defaultMealForMember(f),
            personRef: v,
          });
        } else if (v.startsWith('s:')) {
          const f = Store.state.friends?.[v.slice(2)]; if (!f || !f.spouse) return;
          attendeesRaw.push({
            customName: fullName(f.spouse),
            email: f.spouse.email || '',
            status: 'invited', notes: '', plusN: 0,
            meal: defaultMealForMember(f.spouse),
            personRef: v,
          });
        } else if (v.startsWith('k:')) {
          const parts = v.split(':'); // ['k', friendId, kidId]
          const f = Store.state.friends?.[parts[1]]; if (!f) return;
          const k = (f.kids || []).find(x => x.id === parts[2]); if (!k) return;
          attendeesRaw.push({
            customName: fullName(k),
            email: '', // kids typically don't have their own email
            status: 'invited', notes: '', plusN: 0,
            meal: defaultMealForMember(k),
            personRef: v,
          });
        }
        ev.attendees = attendeesRaw;
        Store.save();
        this.renderDetail();
      });
      on($('#event-add-group'), 'change', (e) => {
        const grp = e.target.value; if (!grp) return;
        const present = new Set(attendeesRaw.map(a => a.memberId).filter(Boolean));
        // Skip members who opted out of group-based event invites — they can
        // still be added one-by-one via "+ Add family member…".
        Store.membersList()
          .filter(m => m.group === grp && !present.has(m.id) && m.includeInGroupEvents !== false)
          .forEach(m => attendeesRaw.push(pushAttendee(m)));
        ev.attendees = attendeesRaw;
        Store.save();
        this.renderDetail();
      });
      on($('#event-add-all'), 'click', () => {
        const present = new Set(attendeesRaw.map(a => a.memberId).filter(Boolean));
        Store.membersList().forEach(m => {
          if (!present.has(m.id)) attendeesRaw.push(pushAttendee(m));
        });
        ev.attendees = attendeesRaw;
        Store.save();
        this.renderDetail();
      });
    }

    const addCustom = () => {
      const nameInp = $('#event-add-custom');
      const v = nameInp.value.trim();
      if (!v) return;
      const row = { customName: v, status: 'invited', notes: '', plusN: 0, meal: 'none', email: '' };
      // Tag guests added by a user so they can edit them later. Admin-added
      // customs are unowned — anyone with admin sees them as editable.
      if (!isAdmin && u && u !== 'admin-bootstrap') row.addedBy = u.id;
      attendeesRaw.push(row);
      ev.attendees = attendeesRaw;
      Store.save();
      nameInp.value = '';
      this.renderDetail();
    };
    on($('#event-add-custom-btn'), 'click', addCustom);
    on($('#event-add-custom'), 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); }});

    const updateField = (sel, field, transform = v => v, requireRerender = false) => {
      detail.querySelectorAll(sel).forEach(el => on(el, 'change', () => {
        const i = resolveAttendee(+el.dataset.idx, el.closest('tr')?.dataset.attKey);
        if (i < 0) { this.renderDetail(); return; } // index went stale — re-render
        // Belt-and-suspenders: even if the row's controls are rendered, refuse
        // to write through unless the viewer is allowed to edit this attendee.
        if (!canEditAttendee(attendeesRaw[i])) return;
        attendeesRaw[i][field] = transform(el.value);
        ev.attendees = attendeesRaw;
        Store.save();
        if (field === 'status') refreshEventsNav();
        if (requireRerender) this.renderDetail();
      }));
    };
    updateField('.attendance-status', 'status', v => v, true);   // re-render to re-sort + recolor
    updateField('.att-plus',  'plusN', v => Math.max(0, Math.min(9, parseInt(v, 10) || 0)), true);
    updateField('.att-meal',  'meal');
    updateField('.att-email', 'email');

    detail.querySelectorAll('[data-remove]').forEach(btn => on(btn, 'click', () => {
      const i = resolveAttendee(+btn.dataset.remove, btn.closest('tr')?.dataset.attKey);
      if (i < 0) { this.renderDetail(); return; } // index went stale — re-render
      if (!isAdmin && attendeesRaw[i]?.addedBy !== u?.id) return; // user can only remove own guest
      attendeesRaw.splice(i, 1);
      ev.attendees = attendeesRaw;
      Store.save();
      this.renderDetail();
    }));

    if (isAdmin) {
      // Per-attendee "Add gift" — opens the gift modal pre-filled with this event
      detail.querySelectorAll('[data-gift]').forEach(btn => on(btn, 'click', () => {
        const i = resolveAttendee(+btn.dataset.gift, btn.closest('tr')?.dataset.attKey);
        const a = attendeesRaw[i]; if (!a) return;
        Views.show('gifts');
        GiftsView.openModal(null, {
          eventId: ev.id,
          // From this attendee — common case: they gave us a gift.
          direction: 'received',
          fromMemberIds: a.memberId ? [a.memberId] : [],
          fromText:      a.memberId ? '' : (a.customName || ''),
        });
      }));

      const collectEmails = (filter) => {
        const set = new Set();
        attendeesRaw.forEach(a => {
          if (filter && !filter(a)) return;
          let em = a.email;
          if (em == null && a.memberId) em = memMap[a.memberId]?.email || '';
          em = (em || '').trim();
          if (em) set.add(em);
        });
        return [...set];
      };
      on($('#event-copy-emails'), 'click', async () => {
        const emails = collectEmails(null);
        if (!emails.length) { toast('No emails to copy.', 'warn'); return; }
        try { await navigator.clipboard.writeText(emails.join(', ')); toast(`Copied ${emails.length} email${emails.length === 1 ? '' : 's'}.`); }
        catch { toast('Copy failed.', 'warn'); }
      });
      on($('#event-mailto'), 'click', () => {
        const emails = collectEmails(null);
        if (!emails.length) { toast('No emails to send to.', 'warn'); return; }
        window.location.href = `mailto:?bcc=${encodeURIComponent(emails.join(','))}&subject=${encodeURIComponent(ev.name)}`;
      });
      on($('#event-mailto-active'), 'click', () => {
        const emails = collectEmails(a => {
          const s = a.status === 'attended' ? 'accepted' : (a.status || 'invited');
          return s === 'accepted' || s === 'invited';
        });
        if (!emails.length) { toast('No accepted or invited attendees with emails.', 'warn'); return; }
        window.location.href = `mailto:?bcc=${encodeURIComponent(emails.join(','))}&subject=${encodeURIComponent(ev.name)}`;
      });
    }
  },
  openModal(editId = null, opts = {}) {
    const f = $('#event-form');
    f.reset();
    f.dataset.editId = editId || '';
    f.dataset.cover = '';
    $('#event-cover-preview').style.backgroundImage = '';
    $('#event-itin-rows').innerHTML = '';
    if (editId) {
      const ev = Store.state.events.find(e => e.id === editId);
      $('#event-modal-title').textContent = 'Edit event';
      f.name.value = ev.name || '';
      f.date.value = ev.date || '';
      f.location.value = ev.location || '';
      f.description.value = ev.description || '';
      $('#event-icon').value = ev.icon || '';
      const cover = ev.coverPhoto || ev.coverUrl || '';
      f.dataset.cover = cover;
      $('#event-cover-url').value = ev.coverUrl || '';
      $('#event-cover-preview').style.backgroundImage = cover ? `url('${cssUrl(cover)}')` : '';
      // Trip fields
      const isTrip = !!ev.isTrip;
      f.isTrip.checked = isTrip;
      $('#event-trip-fieldset').hidden = !isTrip;
      if (f.tripDestination)        f.tripDestination.value        = ev.tripDestination || '';
      if (f.tripEndDate)            f.tripEndDate.value            = ev.tripEndDate || '';
      if (f.tripTransportBudget)    f.tripTransportBudget.value    = ev.tripTransportBudget ?? '';
      if (f.tripLodgingBudget)      f.tripLodgingBudget.value      = ev.tripLodgingBudget ?? '';
      if (f.tripFoodBudget)         f.tripFoodBudget.value         = ev.tripFoodBudget ?? '';
      if (f.tripActivitiesBudget)   f.tripActivitiesBudget.value   = ev.tripActivitiesBudget ?? '';
      (ev.itinerary || []).forEach(d => this._addItineraryRow(d));
    } else {
      $('#event-modal-title').textContent = 'New event';
      $('#event-icon').value = '🎉';
      if (opts.defaultDate) f.date.value = opts.defaultDate;
      f.isTrip.checked = false;
      $('#event-trip-fieldset').hidden = true;
    }
    $('#event-modal').setAttribute('aria-hidden', 'false');
  },
  _addItineraryRow(data = { date: '', activity: '', notes: '' }) {
    const host = $('#event-itin-rows');
    const row = document.createElement('div');
    row.className = 'trip-itin-row';
    row.innerHTML = `
      <input type="date" class="input itin-date" value="${escape(data.date || '')}" />
      <input type="text" class="input itin-activity" placeholder="Day activity (e.g. Tsukiji market)" value="${escape(data.activity || '')}" />
      <input type="text" class="input itin-notes" placeholder="Notes" value="${escape(data.notes || '')}" />
      <button type="button" class="btn btn-ghost btn-sm itin-del" aria-label="Remove">×</button>
    `;
    row.querySelector('.itin-del').addEventListener('click', () => row.remove());
    host.appendChild(row);
  },
  closeModal() { $('#event-modal').setAttribute('aria-hidden', 'true'); },
  saveModal() {
    const f = $('#event-form');
    const fd = new FormData(f);
    const name = (fd.get('name') || '').toString().trim();
    if (!name) return;
    const editId = f.dataset.editId;
    const coverValue = f.dataset.cover || '';
    const coverIsUpload = coverValue.startsWith('data:');
    const isTrip = !!fd.get('isTrip');
    const itinerary = isTrip
      ? [...$('#event-itin-rows').querySelectorAll('.trip-itin-row')].map(r => ({
          date:     r.querySelector('.itin-date').value || '',
          activity: r.querySelector('.itin-activity').value.trim(),
          notes:    r.querySelector('.itin-notes').value.trim(),
        })).filter(d => d.date || d.activity)
      : [];
    const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : null; };
    const data = {
      name,
      date: (fd.get('date') || '').toString(),
      location: (fd.get('location') || '').toString().trim(),
      description: (fd.get('description') || '').toString().trim(),
      icon: ((fd.get('icon') || '').toString().trim() || ''),
      coverPhoto: coverIsUpload ? coverValue : null,
      coverUrl:   coverIsUpload ? '' : coverValue,
      isTrip,
      tripDestination:      isTrip ? (fd.get('tripDestination') || '').toString().trim() : '',
      tripEndDate:          isTrip ? (fd.get('tripEndDate')     || '').toString() : '',
      tripTransportBudget:  isTrip ? num(fd.get('tripTransportBudget'))  : null,
      tripLodgingBudget:    isTrip ? num(fd.get('tripLodgingBudget'))    : null,
      tripFoodBudget:       isTrip ? num(fd.get('tripFoodBudget'))       : null,
      tripActivitiesBudget: isTrip ? num(fd.get('tripActivitiesBudget')) : null,
      itinerary,
    };
    Store.state.events ||= [];
    if (editId) {
      const ev = Store.state.events.find(e => e.id === editId);
      Object.assign(ev, data);
    } else {
      const ev = { id: uid('evt'), ...data, attendees: [] };
      Store.state.events.unshift(ev);
      this.selectedId = ev.id;
    }
    Store.save();
    this.closeModal();
    this.render();
  },
};

// Render the trip-specific panel for an event: budget breakdown + itinerary.
// Spent column reads from the existing expenses array on the event; budget
// numbers live on ev.trip*Budget fields. Itinerary is a simple ordered list
// from ev.itinerary[].
function renderTripPanel(ev) {
  const fmtMoney = (n) => (n == null || !isFinite(n)) ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const totalBudget = ['tripTransportBudget','tripLodgingBudget','tripFoodBudget','tripActivitiesBudget']
    .reduce((s, k) => s + (Number(ev[k]) || 0), 0);
  const totalSpent = (ev.expenses || []).reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const lines = [
    ['Flights / transport', ev.tripTransportBudget],
    ['Lodging',             ev.tripLodgingBudget],
    ['Food & drink',        ev.tripFoodBudget],
    ['Activities',          ev.tripActivitiesBudget],
  ];
  const budgetRows = lines.map(([label, val]) => `
    <tr><td>${label}</td><td class="num">${fmtMoney(val)}</td></tr>
  `).join('');
  const itin = (ev.itinerary || []).slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const itinRows = itin.length
    ? itin.map(d => `
        <tr>
          <td class="itin-cell-date">${d.date ? escape(formatDate(d.date)) : '<span class="muted">—</span>'}</td>
          <td>${escape(d.activity || '')}</td>
          <td class="muted small">${escape(d.notes || '')}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="3" class="muted small">No itinerary days yet — add some when editing the event.</td></tr>';
  return `
    <div class="trip-panel">
      <div class="trip-budget">
        <h4>Travel budget</h4>
        <table class="table table-compact">
          <thead><tr><th>Category</th><th class="num">Budget</th></tr></thead>
          <tbody>${budgetRows}</tbody>
          <tfoot>
            <tr><th>Total budget</th><th class="num">${fmtMoney(totalBudget)}</th></tr>
            <tr><th>Logged spent</th><th class="num">${fmtMoney(totalSpent)}</th></tr>
          </tfoot>
        </table>
      </div>
      <div class="trip-itinerary-view">
        <h4>Itinerary</h4>
        <table class="table table-compact">
          <thead><tr><th>Date</th><th>Activity</th><th>Notes</th></tr></thead>
          <tbody>${itinRows}</tbody>
        </table>
      </div>
    </div>`;
}

// -------------------- US HOLIDAYS --------------------
function pad2(n) { return String(n).padStart(2, '0'); }
// Ordinal suffix for small numbers — 1st, 2nd, 3rd, 4th, 11th, 21st, etc.
function nthSuffix(n) {
  const v = Math.abs(n) % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (v % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}
function toIsoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
// weekday: 0=Sun..6=Sat. nth: 1..5 for nth occurrence, -1 for last.
function nthWeekdayOfMonth(year, month, weekday, nth) {
  if (nth > 0) {
    const first = new Date(year, month, 1);
    const offset = (weekday - first.getDay() + 7) % 7;
    return new Date(year, month, 1 + offset + (nth - 1) * 7);
  }
  const last = new Date(year, month + 1, 0);
  const offset = (last.getDay() - weekday + 7) % 7;
  return new Date(year, month, last.getDate() - offset);
}
function usHolidaysForYear(year) {
  return [
    { date: `${year}-01-01`, name: "New Year's Day" },
    { date: toIsoDate(nthWeekdayOfMonth(year, 0, 1, 3)),  name: 'Martin Luther King Jr. Day' },
    { date: toIsoDate(nthWeekdayOfMonth(year, 1, 1, 3)),  name: "Presidents' Day" },
    { date: toIsoDate(nthWeekdayOfMonth(year, 4, 1, -1)), name: 'Memorial Day' },
    { date: `${year}-06-19`, name: 'Juneteenth' },
    { date: `${year}-07-04`, name: 'Independence Day' },
    { date: toIsoDate(nthWeekdayOfMonth(year, 8, 1, 1)),  name: 'Labor Day' },
    { date: toIsoDate(nthWeekdayOfMonth(year, 9, 1, 2)),  name: 'Columbus Day' },
    { date: `${year}-11-11`, name: 'Veterans Day' },
    { date: toIsoDate(nthWeekdayOfMonth(year, 10, 4, 4)), name: 'Thanksgiving Day' },
    { date: `${year}-12-25`, name: 'Christmas Day' },
  ];
}

// -------------------- GOOGLE CALENDAR --------------------
// Read-only sync of the user's Google Calendar events into the Calendar view.
// Auth: Google Identity Services (GIS) Implicit flow → access token in localStorage.
// Tokens are short-lived (~1h); we silently re-prompt after expiry when consent
// has already been granted. Each install needs its own OAuth Client ID — there
// is no shared client because Google rate-limits per-project.
const GoogleCalendar = {
  GIS_URL: 'https://accounts.google.com/gsi/client',
  SCOPE: 'https://www.googleapis.com/auth/calendar.readonly',
  tokenClient: null,
  scriptPromise: null,
  eventCache: new Map(),     // 'calId|YYYY-M' → [{ date, summary, htmlLink, color, calendarName }]

  config() { return Store.state.googleCalendar || {}; },

  hasClient() { return !!this.config().clientId; },

  isConnected() {
    const c = this.config();
    return !!c.accessToken && c.tokenExpiresAt > Date.now();
  },

  loadScript() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (this.scriptPromise) return this.scriptPromise;
    this.scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = this.GIS_URL;
      s.async = true; s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load Google Identity Services.'));
      document.head.appendChild(s);
    });
    return this.scriptPromise;
  },

  buildTokenClient(clientId, callback) {
    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: this.SCOPE,
      callback,
    });
  },

  // First-time consent. Opens the Google popup; user signs in & grants scope.
  async connect(clientId) {
    if (!clientId) throw new Error('Client ID required.');
    await this.loadScript();
    return new Promise((resolve, reject) => {
      this.buildTokenClient(clientId, async (resp) => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        const cfg = this.config();
        cfg.clientId = clientId;
        cfg.accessToken = resp.access_token;
        cfg.tokenExpiresAt = Date.now() + ((resp.expires_in || 3600) * 1000) - 30_000;
        Store.state.googleCalendar = cfg;
        Store.save();
        try {
          await this.refreshMetadata();
          resolve(cfg);
        } catch (err) { reject(err); }
      });
      this.tokenClient.requestAccessToken({ prompt: 'consent' });
    });
  },

  // Silent re-auth after token expiry — only works if consent already granted.
  async reauthorize() {
    const cfg = this.config();
    if (!cfg.clientId) throw new Error('Not configured.');
    await this.loadScript();
    return new Promise((resolve, reject) => {
      this.buildTokenClient(cfg.clientId, (resp) => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        cfg.accessToken = resp.access_token;
        cfg.tokenExpiresAt = Date.now() + ((resp.expires_in || 3600) * 1000) - 30_000;
        Store.state.googleCalendar = cfg;
        Store.save();
        resolve(cfg);
      });
      this.tokenClient.requestAccessToken({ prompt: '' });
    });
  },

  async ensureToken() {
    if (this.isConnected()) return;
    await this.reauthorize();
  },

  // Pulls userinfo (email) + the calendar list. Preserves the user's enable
  // selections across refreshes; new calendars default to disabled unless primary.
  async refreshMetadata() {
    const cfg = this.config();
    if (!cfg.accessToken) throw new Error('Not connected.');
    try {
      const ui = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { 'Authorization': `Bearer ${cfg.accessToken}` },
      });
      if (ui.ok) {
        const u = await ui.json();
        cfg.userEmail = u.email || '';
      }
    } catch {}
    const r = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { 'Authorization': `Bearer ${cfg.accessToken}` },
    });
    if (!r.ok) throw new Error('Could not load calendar list (' + r.status + ').');
    const d = await r.json();
    const prev = new Map((cfg.calendars || []).map(c => [c.id, c.enabled]));
    cfg.calendars = (d.items || []).map(c => ({
      id: c.id,
      summary: c.summary || c.id,
      backgroundColor: c.backgroundColor || '#4285f4',
      primary: !!c.primary,
      enabled: prev.has(c.id) ? prev.get(c.id) : !!c.primary,
    }));
    cfg.lastSync = Date.now();
    Store.state.googleCalendar = cfg;
    Store.save();
    this.eventCache.clear();
  },

  async fetchEventsForMonth(year, month /* 0-11 */) {
    const cfg = this.config();
    if (!cfg.clientId || !cfg.calendars?.length) return [];
    if (!this.isConnected()) {
      try { await this.reauthorize(); } catch { return []; }
    }
    const enabled = cfg.calendars.filter(c => c.enabled);
    if (!enabled.length) return [];
    // Buffer ±1 month so events that bleed into the displayed grid are included.
    const timeMin = new Date(year, month - 1, 1).toISOString();
    const timeMax = new Date(year, month + 2, 1).toISOString();
    const out = [];
    for (const cal of enabled) {
      const key = `${cal.id}|${year}-${month}`;
      let items;
      if (this.eventCache.has(key)) {
        items = this.eventCache.get(key);
      } else {
        items = await this.fetchOneCalendar(cal.id, timeMin, timeMax);
        if (items == null) continue; // failure
        this.eventCache.set(key, items);
      }
      items.forEach(ev => {
        const startDate = ev.start?.date || (ev.start?.dateTime ? ev.start.dateTime.slice(0, 10) : null);
        if (!startDate) return;
        out.push({
          id: 'g:' + (ev.id || Math.random().toString(36).slice(2)),
          date: startDate,
          summary: ev.summary || '(untitled)',
          htmlLink: ev.htmlLink || '',
          color: cal.backgroundColor || '#4285f4',
          calendarName: cal.summary,
          allDay: !!ev.start?.date,
        });
      });
    }
    return out;
  },

  async fetchOneCalendar(calId, timeMin, timeMax) {
    const cfg = this.config();
    const params = new URLSearchParams({
      timeMin, timeMax,
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250',
    });
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`;
    const doFetch = () => fetch(url, { headers: { 'Authorization': `Bearer ${cfg.accessToken}` } });
    let r = await doFetch();
    if (r.status === 401) {
      try { await this.reauthorize(); } catch { return null; }
      r = await doFetch();
    }
    if (!r.ok) return null;
    const d = await r.json();
    return d.items || [];
  },

  setCalendarEnabled(id, enabled) {
    const cfg = this.config();
    const c = (cfg.calendars || []).find(x => x.id === id);
    if (!c) return;
    c.enabled = enabled;
    Store.state.googleCalendar = cfg;
    Store.save();
    this.eventCache.clear();
  },

  setShowEvents(show) {
    const cfg = this.config();
    cfg.showEvents = !!show;
    Store.state.googleCalendar = cfg;
    Store.save();
  },

  disconnect() {
    const cfg = this.config();
    const token = cfg.accessToken;
    Store.state.googleCalendar = {
      clientId: '', accessToken: '', tokenExpiresAt: 0,
      userEmail: '', calendars: [], lastSync: 0, showEvents: true,
    };
    Store.save();
    this.eventCache.clear();
    if (token && window.google?.accounts?.oauth2?.revoke) {
      try { window.google.accounts.oauth2.revoke(token, () => {}); } catch {}
    }
  },
};

// -------------------- CALENDAR VIEW --------------------
const CalendarView = {
  year: null,
  month: null, // 0..11
  init() {
    const now = new Date();
    this.year  = now.getFullYear();
    this.month = now.getMonth();
    on($('#cal-prev'),  'click', () => this.shift(-1));
    on($('#cal-next'),  'click', () => this.shift(1));
    on($('#cal-today'), 'click', () => {
      const n = new Date();
      this.year = n.getFullYear(); this.month = n.getMonth();
      this.render();
    });
    on($('#cal-year'),  'change', (e) => { this.year = parseInt(e.target.value, 10); this.render(); });
    on($('#cal-refresh'), 'click', () => {
      // Clear any cached Google events so the next render goes back to the
      // network. Also re-render local data (events/birthdays/holidays).
      if (typeof GoogleCalendar !== 'undefined') GoogleCalendar.eventCache.clear();
      this.render();
      toast('Calendar refreshed.');
    });
    on($('#cal-google-btn'), 'click', () => this.openGoogleModal());
    on($('#gcal-modal'), 'click', (e) => { if (e.target.closest('[data-close]')) this.closeGoogleModal(); });
    on($('#cal-add-reminder'), 'click', () => RemindersModal.open());
    // Static weekday header
    const wkLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    $('#cal-weekdays').innerHTML = wkLabels.map(w => `<div class="cal-weekday">${w}</div>`).join('');
  },
  shift(delta) {
    this.month += delta;
    if (this.month < 0)  { this.month = 11; this.year -= 1; }
    if (this.month > 11) { this.month = 0;  this.year += 1; }
    this.render();
  },
  render() {
    if (this.year == null || this.month == null) {
      const n = new Date();
      this.year = n.getFullYear(); this.month = n.getMonth();
    }
    const today = new Date();
    const todayIso = toIsoDate(today);
    const monthFirst = new Date(this.year, this.month, 1);
    $('#cal-label').textContent = monthFirst.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    // Year dropdown (current ± 50)
    const yrSel = $('#cal-year');
    const yrNow = today.getFullYear();
    const yrs = [];
    for (let y = yrNow - 50; y <= yrNow + 50; y++) yrs.push(y);
    yrSel.innerHTML = yrs.map(y => `<option value="${y}" ${y === this.year ? 'selected' : ''}>${y}</option>`).join('');

    // Build lookups. Family role gets a read-only view: they see only the
    // events they're personally invited to (filter parity with Events tab),
    // plus birthdays / anniversaries / US holidays. Admin sees everything.
    const isFamilyReadOnly = !Auth.isAdmin() && Auth.isFamily();
    const visibleEvents = isFamilyReadOnly ? userEventsList() : (Store.state.events || []);
    const eventsByDate = new Map();
    visibleEvents.forEach(ev => {
      if (!ev.date) return;
      if (!eventsByDate.has(ev.date)) eventsByDate.set(ev.date, []);
      eventsByDate.get(ev.date).push(ev);
    });
    const birthdaysByMD = new Map(); // 'MM-DD' → [members]
    Store.membersList().forEach(m => {
      if (!m.birthday || m.birthday.length < 10) return;
      const md = m.birthday.slice(5, 10);
      if (!birthdaysByMD.has(md)) birthdaysByMD.set(md, []);
      birthdaysByMD.get(md).push(m);
    });
    // Spouse anniversaries — recurring annually on MM-DD. Dedupe by couple so
    // we render one chip per pair instead of one per spouse. Click target is
    // the alphabetically-first spouse's profile (deterministic).
    const anniversariesByMD = new Map(); // 'MM-DD' → [{ pair: [a, b], focus, isoDate }]
    {
      const seenPairs = new Set();
      Store.membersList().forEach(m => {
        if (!m.spouseId || m.divorced) return;
        const sp = Store.byId(m.spouseId);
        if (!sp || sp.divorced) return;
        const pairKey = [m.id, sp.id].sort().join('|');
        if (seenPairs.has(pairKey)) return;
        seenPairs.add(pairKey);
        const aniso = m.anniversary || sp.anniversary;
        if (!aniso || aniso.length < 10) return;
        const md = aniso.slice(5, 10);
        // Render this anniversary attached to whichever spouse comes first by id.
        const focus = m.id < sp.id ? m : sp;
        const partner = focus === m ? sp : m;
        if (!anniversariesByMD.has(md)) anniversariesByMD.set(md, []);
        anniversariesByMD.get(md).push({ focus, partner, isoDate: aniso });
      });
    }
    const holidaysByDate = new Map();
    [...usHolidaysForYear(this.year - 1), ...usHolidaysForYear(this.year), ...usHolidaysForYear(this.year + 1)]
      .forEach(h => holidaysByDate.set(h.date, h));

    // Cells: prev-month tail + this month + next-month head, 6 rows × 7 cols = 42 cells
    const startWeekday = monthFirst.getDay();
    const daysInMonth  = new Date(this.year, this.month + 1, 0).getDate();
    const prevDays     = new Date(this.year, this.month, 0).getDate();
    const cells = [];
    for (let i = startWeekday - 1; i >= 0; i--) {
      const dt = new Date(this.year, this.month - 1, prevDays - i);
      cells.push({ dt, inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push({ dt: new Date(this.year, this.month, d), inMonth: true });
    }
    while (cells.length < 42) {
      const last = cells[cells.length - 1].dt;
      const next = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
      cells.push({ dt: next, inMonth: false });
    }

    const html = cells.map(c => {
      const iso = toIsoDate(c.dt);
      const md  = iso.slice(5, 10);
      const dayEvents    = eventsByDate.get(iso) || [];
      const dayBdays     = birthdaysByMD.get(md) || [];
      const dayHoliday   = holidaysByDate.get(iso);
      const isToday      = iso === todayIso;

      const chips = [];
      if (dayHoliday) {
        chips.push(`<button type="button" class="cal-chip cal-chip-holiday" title="${escape(dayHoliday.name)} (US holiday)">
          <span class="cal-chip-icon">🇺🇸</span><span class="cal-chip-text">${escape(dayHoliday.name)}</span>
        </button>`);
      }
      dayEvents.forEach(ev => {
        chips.push(`<button type="button" class="cal-chip cal-chip-event" data-event-id="${ev.id}" title="${escape(ev.name)} — open in Events">
          <span class="cal-chip-icon">${escape(ev.icon || '🎉')}</span><span class="cal-chip-text">${escape(ev.name)}</span>
        </button>`);
      });
      dayBdays.forEach(m => {
        const bYear = parseInt((m.birthday || '').slice(0, 4), 10);
        const turning = Number.isFinite(bYear) ? (c.dt.getFullYear() - bYear) : null;
        const ageHint = turning != null && turning >= 0 ? ` — turns ${turning}` : '';
        chips.push(`<button type="button" class="cal-chip cal-chip-birthday" data-member-id="${m.id}" title="${escape(displayName(m))}${ageHint}">
          <span class="cal-chip-icon">🎂</span><span class="cal-chip-text">${escape(displayName(m))}</span>
        </button>`);
      });
      const dayAnnivs = anniversariesByMD.get(md) || [];
      dayAnnivs.forEach(({ focus, partner, isoDate }) => {
        const aYear = parseInt((isoDate || '').slice(0, 4), 10);
        const nth   = Number.isFinite(aYear) ? (c.dt.getFullYear() - aYear) : null;
        const ordHint = nth != null && nth > 0 ? ` — ${nth}${nthSuffix(nth)} anniversary` : '';
        const label = `${focus.firstName} & ${partner.firstName}`;
        chips.push(`<button type="button" class="cal-chip cal-chip-anniv" data-member-id="${focus.id}" title="${escape(displayName(focus))} & ${escape(displayName(partner))}${ordHint}">
          <span class="cal-chip-icon">💍</span><span class="cal-chip-text">${escape(label)}</span>
        </button>`);
      });
      // Calendar-only reminders (recurring). Hidden entirely from the
      // Family role per the v4.26 spec — they're an admin-only construct.
      if (!isFamilyReadOnly) {
        const dayReminders = (Store.state.reminders || []).filter(r => reminderOccursOn(r, iso));
        dayReminders.forEach(r => {
          chips.push(`<button type="button" class="cal-chip cal-chip-reminder" data-reminder-id="${r.id}" title="${escape(r.title)} — click to edit">
            <span class="cal-chip-icon">${escape(r.icon || '🔔')}</span><span class="cal-chip-text">${escape(r.title)}</span>
          </button>`);
        });
      }

      // The per-day "+ create event" affordance is admin-only. Family /
      // User see the calendar read-only.
      const addBtnHtml = Auth.isAdmin() ? `<button type="button" class="cal-add" data-add-event="${iso}" title="Create event on this day" aria-label="Create event on this day">
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>` : '';

      return `
        <div class="cal-cell${c.inMonth ? '' : ' is-other-month'}${isToday ? ' is-today' : ''}" data-date="${iso}">
          <div class="cal-cell-head">
            <span class="cal-day-num">${c.dt.getDate()}</span>
            ${addBtnHtml}
          </div>
          <div class="cal-chips">${chips.join('')}</div>
        </div>`;
    }).join('');

    const grid = $('#cal-grid');
    grid.innerHTML = html;

    // Wire interactions. Family role is read-only on the Calendar — event
    // chips don't drill in (Events tab is admin-only anyway). Birthday and
    // anniversary chips still open the Drawer for them since Family can
    // browse profiles (the Drawer hides Gifts + editing actions on its own).
    if (Auth.isAdmin()) {
      grid.querySelectorAll('.cal-chip-event').forEach(b => on(b, 'click', (e) => {
        e.stopPropagation();
        EventsView.selectedId = b.dataset.eventId;
        Views.show('events');
      }));
    } else {
      grid.querySelectorAll('.cal-chip-event').forEach(b => {
        b.classList.add('is-readonly');
        b.disabled = true;
      });
    }
    grid.querySelectorAll('.cal-chip-birthday').forEach(b => on(b, 'click', (e) => {
      e.stopPropagation();
      Drawer.open(b.dataset.memberId);
    }));
    grid.querySelectorAll('.cal-chip-anniv').forEach(b => on(b, 'click', (e) => {
      e.stopPropagation();
      Drawer.open(b.dataset.memberId);
    }));
    grid.querySelectorAll('.cal-chip-reminder').forEach(b => on(b, 'click', (e) => {
      e.stopPropagation();
      RemindersModal.open(b.dataset.reminderId);
    }));
    grid.querySelectorAll('.cal-add').forEach(b => on(b, 'click', (e) => {
      e.stopPropagation();
      EventsView.openModal(null, { defaultDate: b.dataset.addEvent });
    }));

    this.refreshGoogleIndicator();
    this.renderGoogleEvents();
  },

  refreshGoogleIndicator() {
    const cfg = GoogleCalendar.config();
    const connected = !!cfg.clientId && (!!cfg.accessToken || cfg.calendars?.length > 0);
    $('#cal-google-dot').hidden = !connected;
    $('#cal-google-label').textContent = connected ? 'Google · synced' : 'Google';
  },

  async renderGoogleEvents() {
    // Google Calendar integration is admin-only. Family / User never see
    // pulled Google events on the grid.
    if (!Auth.canUseGoogleCalendar()) return;
    const cfg = GoogleCalendar.config();
    if (!cfg.clientId || !cfg.showEvents) return;
    const renderKey = `${this.year}-${this.month}`;
    this._renderKey = renderKey;
    let events;
    try {
      events = await GoogleCalendar.fetchEventsForMonth(this.year, this.month);
    } catch {
      return;
    }
    if (this._renderKey !== renderKey) return; // user navigated away
    events.forEach(ev => {
      const cell = document.querySelector(`#cal-grid .cal-cell[data-date="${ev.date}"]`);
      if (!cell) return;
      const chips = cell.querySelector('.cal-chips');
      if (chips.querySelector(`[data-google-id="${ev.id}"]`)) return;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'cal-chip cal-chip-google';
      chip.dataset.googleId = ev.id;
      chip.style.setProperty('--gcal-color', ev.color);
      chip.title = `${ev.summary} (${ev.calendarName}) — open in Google Calendar`;
      chip.innerHTML = `<span class="cal-chip-icon cal-chip-gicon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="11" height="11">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.19 3.32v2.77h3.55c2.08-1.92 3.28-4.74 3.28-8.1Z"/>
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.55-2.77c-.98.66-2.24 1.05-3.73 1.05-2.86 0-5.29-1.93-6.15-4.53H2.18v2.84A11 11 0 0 0 12 23Z"/>
          <path fill="#FBBC05" d="M5.85 14.1A6.55 6.55 0 0 1 5.5 12c0-.73.13-1.43.35-2.1V7.07H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.94l3.67-2.84Z"/>
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.07.56 4.21 1.65l3.15-3.15C17.45 2.12 14.97 1 12 1A11 11 0 0 0 2.18 7.07L5.85 9.9C6.71 7.31 9.14 5.38 12 5.38Z"/>
        </svg></span><span class="cal-chip-text">${escape(ev.summary)}</span>`;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (ev.htmlLink) window.open(ev.htmlLink, '_blank', 'noopener');
      });
      chips.appendChild(chip);
    });
  },

  openGoogleModal() {
    this.renderGoogleModal();
    $('#gcal-modal').setAttribute('aria-hidden', 'false');
  },
  closeGoogleModal() {
    $('#gcal-modal').setAttribute('aria-hidden', 'true');
  },
  renderGoogleModal() {
    const body = $('#gcal-body');
    const cfg  = GoogleCalendar.config();
    const isConfigured = !!cfg.clientId;

    if (!isConfigured) {
      body.innerHTML = `
        <p class="muted small">Display events from your Google Calendar alongside family events. Read-only sync; nothing is written back to Google.</p>
        <details class="gcal-setup">
          <summary>One-time setup — create a Google OAuth Client ID</summary>
          <ol class="gcal-steps">
            <li>Open <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a> and create (or pick) a project.</li>
            <li>Enable the <strong>Google Calendar API</strong> for the project.</li>
            <li>Configure the OAuth consent screen as <strong>External</strong>; add your own email as a test user.</li>
            <li>Credentials → Create credentials → <strong>OAuth 2.0 Client ID</strong> → <strong>Web application</strong>.</li>
            <li>Under <em>Authorized JavaScript origins</em>, add <code>http://localhost:3000</code>.</li>
            <li>Copy the Client ID and paste it below.</li>
          </ol>
        </details>
        <label class="field">
          <span>OAuth Client ID</span>
          <input id="gcal-client-id" placeholder="xxxxxxxxxxxx.apps.googleusercontent.com" autocomplete="off" />
        </label>
        <p id="gcal-error" class="form-error" role="alert"></p>
        <div class="modal-actions">
          <button class="btn btn-primary" id="gcal-connect">Connect Google Calendar</button>
          <button class="btn btn-ghost" type="button" data-close>Cancel</button>
        </div>
      `;
      on($('#gcal-connect'), 'click', async () => {
        const cid = $('#gcal-client-id').value.trim();
        const err = $('#gcal-error');
        if (!cid) { err.textContent = 'Paste your OAuth Client ID first.'; return; }
        err.textContent = '';
        const btn = $('#gcal-connect');
        btn.disabled = true; btn.textContent = 'Connecting…';
        try {
          await GoogleCalendar.connect(cid);
          toast('Google Calendar connected.');
          this.renderGoogleModal();
          this.refreshGoogleIndicator();
          this.renderGoogleEvents();
        } catch (e) {
          err.textContent = e.message || 'Connection failed.';
          btn.disabled = false; btn.textContent = 'Connect Google Calendar';
        }
      });
      return;
    }

    // Configured (and possibly connected)
    const cals = cfg.calendars || [];
    const lastSyncText = cfg.lastSync
      ? new Date(cfg.lastSync).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : 'never';
    body.innerHTML = `
      <div class="gcal-header">
        <div>
          <div class="gcal-status">
            <span class="gcal-status-dot is-on"></span>
            <strong>Connected</strong>
            ${cfg.userEmail ? `<span class="muted small">· ${escape(cfg.userEmail)}</span>` : ''}
          </div>
          <p class="muted small" style="margin:4px 0 0;">Last synced ${escape(lastSyncText)}</p>
        </div>
      </div>
      <label class="checkbox-row">
        <input type="checkbox" id="gcal-show" ${cfg.showEvents ? 'checked' : ''} />
        <span>Show Google events on the calendar</span>
      </label>
      <div class="field">
        <span>Calendars to display</span>
        ${cals.length ? `
          <div class="gcal-list">
            ${cals.map(c => `
              <label class="gcal-cal-row">
                <input type="checkbox" data-gcal-id="${escape(c.id)}" ${c.enabled ? 'checked' : ''} />
                <span class="gcal-cal-swatch" style="background:${escape(c.backgroundColor)}"></span>
                <span class="gcal-cal-name">${escape(c.summary)}${c.primary ? ' <span class="muted small">(primary)</span>' : ''}</span>
              </label>
            `).join('')}
          </div>
        ` : '<p class="muted small" style="margin:6px 0 0;">No calendars loaded yet — try Sync now.</p>'}
      </div>
      <p id="gcal-error" class="form-error" role="alert"></p>
      <div class="modal-actions">
        <button class="btn btn-secondary" id="gcal-sync">Sync now</button>
        <button class="btn btn-danger-ghost" id="gcal-disconnect">Disconnect</button>
      </div>
    `;
    on($('#gcal-show'), 'change', (e) => {
      GoogleCalendar.setShowEvents(e.target.checked);
      // Re-render the calendar grid so Google chips appear/disappear immediately.
      this.render();
    });
    body.querySelectorAll('[data-gcal-id]').forEach(cb => on(cb, 'change', () => {
      GoogleCalendar.setCalendarEnabled(cb.dataset.gcalId, cb.checked);
      this.render();
    }));
    on($('#gcal-sync'), 'click', async () => {
      const btn = $('#gcal-sync'); const err = $('#gcal-error');
      btn.disabled = true; btn.textContent = 'Syncing…';
      err.textContent = '';
      try {
        await GoogleCalendar.ensureToken();
        await GoogleCalendar.refreshMetadata();
        this.renderGoogleModal();
        this.refreshGoogleIndicator();
        this.render();
        toast('Synced from Google Calendar.');
      } catch (e) {
        err.textContent = e.message || 'Sync failed.';
        btn.disabled = false; btn.textContent = 'Sync now';
      }
    });
    on($('#gcal-disconnect'), 'click', () => {
      if (!confirm('Disconnect Google Calendar? Your OAuth Client ID will be cleared from this browser.')) return;
      GoogleCalendar.disconnect();
      toast('Google Calendar disconnected.');
      this.renderGoogleModal();
      this.refreshGoogleIndicator();
      this.render();
    });
  },
};

// -------------------- GIFTS VIEW --------------------
const GiftsView = {
  direction: 'received',
  init() {
    on($('#btn-gift-add'), 'click', () => this.openModal());
    on($('#btn-gift-export'), 'click', () => this.exportCSV());
    $$('.gift-tab').forEach(t => on(t, 'click', () => {
      this.direction = t.dataset.direction;
      $$('.gift-tab').forEach(x => x.classList.toggle('is-active', x === t));
      this.render();
    }));
    // Delegate report-side member-row clicks → open the drawer for that person.
    on($('#gift-reports-panel'), 'click', (e) => {
      const row = e.target.closest('[data-report-mid]');
      if (row) Drawer.open(row.dataset.reportMid);
    });
    on($('#gift-modal'), 'click', (e) => { if (e.target.closest('[data-close]')) this.closeModal(); });
    on($('#gift-form'), 'submit', (e) => { e.preventDefault(); this.saveModal(); });
    on($('#gift-direction'), 'change', () => this.refreshDirectionLabels());
    on($('#gift-event'), 'change', () => {
      const id = $('#gift-event').value;
      if (!id) return;
      const ev = (Store.state.events || []).find(e => e.id === id);
      if (!ev) return;
      const f = $('#gift-form');
      // Always overwrite when picking an event — picking one means "this gift is for that event"
      if (ev.date) f.date.value = ev.date;
      if (ev.name) f.occasion.value = ev.name;
    });
  },
  refreshDirectionLabels() {
    const dir = $('#gift-direction').value;
    if (dir === 'received') {
      $('#gift-from-label').textContent = 'From (giver)';
      $('#gift-to-label').textContent   = 'To (recipient in family)';
    } else {
      $('#gift-from-label').textContent = 'From (giver in family)';
      $('#gift-to-label').textContent   = 'To (recipient)';
    }
  },
  rowsForDirection() {
    const all = Store.state.gifts || [];
    // 'reports' isn't a row filter — it's a view mode. Export from there
    // returns the full set so admins can still hit "Export" while on Reports.
    if (this.direction === 'both' || this.direction === 'reports') return all.slice();
    return all.filter(g => g.direction === this.direction);
  },
  render() {
    const dir = this.direction;
    // Reports tab is its own panel — swap visibility and exit early.
    const listPanel = $('#gift-list-panel');
    const reportsPanel = $('#gift-reports-panel');
    if (dir === 'reports') {
      listPanel.hidden = true;
      reportsPanel.hidden = false;
      this.renderReports();
      return;
    }
    listPanel.hidden = false;
    reportsPanel.hidden = true;

    $('#gift-th-from').textContent = dir === 'received' ? 'Giver'
                                     : dir === 'given'  ? 'From (us)'
                                     :                    'From';
    $('#gift-th-to').textContent   = dir === 'received' ? 'Recipient (us)'
                                     : dir === 'given'  ? 'Recipient'
                                     :                    'To';
    const memMap = Object.fromEntries(Store.membersList().map(m => [m.id, m]));
    const filtered = this.rowsForDirection();

    if (!filtered.length) {
      $('#gift-rows').innerHTML = `<tr><td colspan="9" class="muted" style="padding:24px; text-align:center;">No ${dir} gifts logged yet.</td></tr>`;
      $('#gift-foot').innerHTML = '';
      return;
    }

    // Group by month
    const groups = new Map();
    filtered.forEach(g => {
      let key = 'undated';
      if (g.date) {
        const d = new Date(g.date + 'T00:00:00');
        key = isNaN(d.getTime()) ? 'undated' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(g);
    });
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === 'undated') return 1;
      if (b === 'undated') return -1;
      return b.localeCompare(a);
    });
    const monthLabel = (k) => {
      if (k === 'undated') return 'No date';
      const [y, m] = k.split('-');
      return new Date(+y, +m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    };

    const fmtMoney = (v) => {
      const n = parseFloat(v);
      if (!isFinite(n) || n === 0) return '';
      return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
    };

    const renderRow = (g) => {
      // From: support multi-select array OR legacy single id OR text
      const fromIds = Array.isArray(g.fromMemberIds) && g.fromMemberIds.length
        ? g.fromMemberIds
        : (g.fromMemberId ? [g.fromMemberId] : []);
      const fromNames = fromIds.map(id => memMap[id]).filter(Boolean)
        .map(m => displayName(m));
      const fromName = fromNames.length
        ? fromNames.join(', ')
        : (g.fromText || '—');
      const toName = g.toMemberId && memMap[g.toMemberId]
        ? displayName(memMap[g.toMemberId])
        : (g.toText || '—');
      const dirIcon = g.direction === 'given'
        ? '<span class="gift-dir-pill given">Given</span>'
        : '<span class="gift-dir-pill received">Received</span>';
      return `
        <tr data-id="${g.id}" class="gift-row gift-${g.direction}">
          <td>${dirIcon}</td>
          <td>${g.date ? formatDate(g.date) : '—'}</td>
          <td><strong>${escape(g.item || '—')}</strong></td>
          <td class="gift-amount-cell">${escape(fmtMoney(g.amount))}</td>
          <td>${escape(fromName)}</td>
          <td>${escape(toName)}</td>
          <td>${escape(g.occasion || '—')}</td>
          <td class="muted small">${escape(g.notes || '')}</td>
          <td style="text-align:right; white-space:nowrap;">
            <button class="btn btn-ghost btn-sm" data-edit="${g.id}">Edit</button>
            <button class="btn btn-danger-ghost btn-sm" data-delete="${g.id}">Delete</button>
          </td>
        </tr>`;
    };

    const rowsHtml = keys.map(k => `
      <tr class="gift-month"><td colspan="9">${escape(monthLabel(k))}</td></tr>
      ${groups.get(k).sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(renderRow).join('')}
    `).join('');
    $('#gift-rows').innerHTML = rowsHtml;

    // Totals (in dollars)
    const totalAll      = filtered.reduce((s, g) => s + (parseFloat(g.amount) || 0), 0);
    const totalReceived = filtered.filter(g => g.direction === 'received').reduce((s, g) => s + (parseFloat(g.amount) || 0), 0);
    const totalGiven    = filtered.filter(g => g.direction === 'given').reduce((s, g) => s + (parseFloat(g.amount) || 0), 0);

    if (dir === 'both') {
      $('#gift-foot').innerHTML = `
        <tr class="gift-total">
          <td colspan="3" style="text-align:right;"><strong>Totals</strong></td>
          <td class="gift-amount-cell">
            <div><span class="gift-dir-pill received">Received</span> <strong>${fmtMoney(totalReceived) || '$0.00'}</strong></div>
            <div style="margin-top:4px;"><span class="gift-dir-pill given">Given</span> <strong>${fmtMoney(totalGiven) || '$0.00'}</strong></div>
            <div style="margin-top:4px;"><strong>Net:</strong> ${fmtMoney(totalAll) || '$0.00'}</div>
          </td>
          <td colspan="5"></td>
        </tr>`;
    } else {
      $('#gift-foot').innerHTML = `
        <tr class="gift-total">
          <td colspan="3" style="text-align:right;"><strong>Total amount</strong></td>
          <td class="gift-amount-cell"><strong>${fmtMoney(totalAll) || '$0.00'}</strong></td>
          <td colspan="5"></td>
        </tr>`;
    }

    $('#gift-rows').querySelectorAll('[data-edit]').forEach(b => on(b, 'click', () => this.openModal(b.dataset.edit)));
    $('#gift-rows').querySelectorAll('[data-delete]').forEach(b => on(b, 'click', () => {
      if (!confirm('Delete this gift entry?')) return;
      Store.state.gifts = Store.state.gifts.filter(x => x.id !== b.dataset.delete);
      Store.save();
      this.render();
    }));
  },

  // Reports dashboard. Renders into #gift-reports-panel. Reads everything
  // straight from Store.state.gifts — no caching, idempotent re-renders.
  // Sections:
  //   1. Headline stat cards (received total, given total, net, gift count)
  //   2. Last-12-months grouped bar chart (received vs. given per month)
  //   3. Top recipients (we give to) + Top givers (give to us), side by side
  //   4. Breakdown by occasion (horizontal bars)
  renderReports() {
    const host = $('#gift-reports-panel');
    const all = Store.state.gifts || [];
    if (!all.length) {
      host.innerHTML = `<p class="muted" style="padding:32px; text-align:center;">No gift history to report on yet. Log a gift to start seeing trends here.</p>`;
      return;
    }
    const memMap = Object.fromEntries(Store.membersList().map(m => [m.id, m]));
    const fmt$ = (n) => (n || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
    const amt = (g) => parseFloat(g.amount) || 0;

    // --- 1. Headline numbers ---
    let received = 0, given = 0, rcount = 0, gcount = 0;
    for (const g of all) {
      if (g.direction === 'received') { received += amt(g); rcount++; }
      else if (g.direction === 'given') { given += amt(g); gcount++; }
    }
    const net = given - received;
    const netLabel = net >= 0 ? `You've given ${fmt$(net)} more than received` : `You've received ${fmt$(-net)} more than given`;

    // --- 2. Last 12 months grouped bars ---
    // Build the month buckets going back from today. "YYYY-MM" → totals.
    const now = new Date();
    const monthKeys = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const monthData = Object.fromEntries(monthKeys.map(k => [k, { received: 0, given: 0 }]));
    for (const g of all) {
      if (!g.date) continue;
      const k = g.date.slice(0, 7); // 'YYYY-MM'
      if (monthData[k]) {
        if (g.direction === 'received')   monthData[k].received += amt(g);
        else if (g.direction === 'given') monthData[k].given    += amt(g);
      }
    }
    const peakMonth = Math.max(1, ...monthKeys.flatMap(k => [monthData[k].received, monthData[k].given]));
    const monthLabel = (k) => {
      const [y, m] = k.split('-');
      return new Date(+y, +m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
    };
    const chartH = 160;
    const slotW  = 56;
    const chartW = monthKeys.length * slotW;
    const barW   = 18;
    const gapW   = 4;
    const monthBars = monthKeys.map((k, i) => {
      const x = i * slotW + slotW / 2;
      const r = monthData[k].received;
      const g = monthData[k].given;
      const rh = peakMonth > 0 ? Math.round((r / peakMonth) * chartH) : 0;
      const gh = peakMonth > 0 ? Math.round((g / peakMonth) * chartH) : 0;
      const rx = x - barW - gapW / 2;
      const gx = x + gapW / 2;
      const title = `${monthLabel(k)} ${k.slice(0, 4)}\nReceived: ${fmt$(r)}\nGiven: ${fmt$(g)}`;
      return `
        <g class="report-month" transform="translate(${i * slotW}, 0)">
          <title>${escape(title)}</title>
          <rect x="${slotW/2 - barW - gapW/2}" y="${chartH - rh + 20}" width="${barW}" height="${rh}" rx="3" fill="#c084fc"></rect>
          <rect x="${slotW/2 + gapW/2}"        y="${chartH - gh + 20}" width="${barW}" height="${gh}" rx="3" fill="#22c55e"></rect>
          <text x="${slotW/2}" y="${chartH + 36}" text-anchor="middle" class="report-bar-label">${monthLabel(k)}</text>
          ${i === 0 || i === monthKeys.length - 1 ? `<text x="${slotW/2}" y="${chartH + 50}" text-anchor="middle" class="report-bar-sublabel">${k.slice(0, 4)}</text>` : ''}
        </g>`;
    }).join('');

    // --- 3. Top recipients / top givers ---
    // "Top recipient" = a real member we have given gifts to (g.direction = 'given')
    //                   aggregated by g.toMemberId.
    // "Top giver"     = a real member who gave us gifts (g.direction = 'received')
    //                   aggregated across g.fromMemberIds (list) + g.fromMemberId (legacy).
    const recipientTotals = new Map(); // mid → $
    const giverTotals     = new Map();
    for (const g of all) {
      const a = amt(g);
      if (g.direction === 'given' && g.toMemberId && memMap[g.toMemberId]) {
        recipientTotals.set(g.toMemberId, (recipientTotals.get(g.toMemberId) || 0) + a);
      }
      if (g.direction === 'received') {
        const fromIds = Array.isArray(g.fromMemberIds) && g.fromMemberIds.length
          ? g.fromMemberIds
          : (g.fromMemberId ? [g.fromMemberId] : []);
        // Multiple senders → split the total evenly so a $200 gift from two
        // people doesn't inflate each of their totals to $200.
        const split = fromIds.length ? a / fromIds.length : 0;
        for (const id of fromIds) {
          if (memMap[id]) giverTotals.set(id, (giverTotals.get(id) || 0) + split);
        }
      }
    }
    const topN = (map, n = 5) => [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
    const topRecipients = topN(recipientTotals);
    const topGivers     = topN(giverTotals);
    const renderTopList = (entries, kind) => {
      if (!entries.length) return `<p class="muted small" style="padding:8px;">No data yet.</p>`;
      const max = entries[0][1] || 1;
      return entries.map(([mid, total]) => {
        const m = memMap[mid];
        const pct = Math.max(2, Math.round((total / max) * 100));
        const colorClass = kind === 'recipient' ? 'is-given' : 'is-received';
        return `
          <div class="report-row" data-report-mid="${mid}" role="button" tabindex="0" title="Open ${escape(displayName(m))}'s profile">
            <div class="report-row-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : ''}></div>
            <div class="report-row-body">
              <div class="report-row-label">${escape(displayName(m))}</div>
              <div class="report-bar-wrap"><div class="report-bar ${colorClass}" style="width:${pct}%"></div></div>
            </div>
            <div class="report-row-value">${fmt$(total)}</div>
          </div>`;
      }).join('');
    };

    // --- 4. By occasion ---
    const occMap = new Map(); // occasion → { received, given }
    for (const g of all) {
      const occ = (g.occasion || '').trim() || 'No occasion';
      if (!occMap.has(occ)) occMap.set(occ, { received: 0, given: 0, count: 0 });
      const bucket = occMap.get(occ);
      bucket.count++;
      if (g.direction === 'received')   bucket.received += amt(g);
      else if (g.direction === 'given') bucket.given    += amt(g);
    }
    const topOcc = [...occMap.entries()]
      .map(([k, v]) => ({ name: k, total: v.received + v.given, ...v }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
    const occMax = topOcc[0]?.total || 1;
    const occRows = topOcc.length
      ? topOcc.map(o => {
          const pctR = Math.round((o.received / occMax) * 100);
          const pctG = Math.round((o.given / occMax) * 100);
          return `
            <div class="report-row report-row-occasion">
              <div class="report-row-body">
                <div class="report-row-label">${escape(o.name)} <span class="muted small">· ${o.count} ${o.count === 1 ? 'gift' : 'gifts'}</span></div>
                <div class="report-bar-wrap report-bar-stacked">
                  ${pctR ? `<div class="report-bar is-received" style="width:${pctR}%" title="Received ${fmt$(o.received)}"></div>` : ''}
                  ${pctG ? `<div class="report-bar is-given" style="width:${pctG}%" title="Given ${fmt$(o.given)}"></div>` : ''}
                </div>
              </div>
              <div class="report-row-value">${fmt$(o.total)}</div>
            </div>`;
        }).join('')
      : `<p class="muted small" style="padding:8px;">No occasion data.</p>`;

    // --- assemble ---
    host.innerHTML = `
      <div class="report-stats">
        <div class="report-stat">
          <div class="report-stat-eyebrow"><span class="gift-dir-pill received">Received</span></div>
          <div class="report-stat-num">${fmt$(received)}</div>
          <div class="report-stat-sub">${rcount} ${rcount === 1 ? 'gift' : 'gifts'} logged</div>
        </div>
        <div class="report-stat">
          <div class="report-stat-eyebrow"><span class="gift-dir-pill given">Given</span></div>
          <div class="report-stat-num">${fmt$(given)}</div>
          <div class="report-stat-sub">${gcount} ${gcount === 1 ? 'gift' : 'gifts'} logged</div>
        </div>
        <div class="report-stat">
          <div class="report-stat-eyebrow">Net (Given − Received)</div>
          <div class="report-stat-num" style="color:${net >= 0 ? '#16a34a' : '#dc2626'};">${(net >= 0 ? '+' : '−')}${fmt$(Math.abs(net))}</div>
          <div class="report-stat-sub">${netLabel}</div>
        </div>
      </div>

      <section class="report-section">
        <header class="report-section-head">
          <h3>Last 12 months</h3>
          <div class="report-legend">
            <span><span class="report-swatch" style="background:#c084fc;"></span>Received</span>
            <span><span class="report-swatch" style="background:#22c55e;"></span>Given</span>
          </div>
        </header>
        <div class="report-chart-scroll">
          <svg viewBox="0 0 ${chartW} ${chartH + 60}" width="${chartW}" height="${chartH + 60}" class="report-month-chart">
            <line x1="0" y1="${chartH + 20}" x2="${chartW}" y2="${chartH + 20}" stroke="var(--ink-200)" stroke-width="1"/>
            ${monthBars}
          </svg>
        </div>
      </section>

      <div class="report-two-up">
        <section class="report-section">
          <header class="report-section-head">
            <h3>Top recipients <span class="muted small">(who we gave to)</span></h3>
          </header>
          <div class="report-list">${renderTopList(topRecipients, 'recipient')}</div>
        </section>
        <section class="report-section">
          <header class="report-section-head">
            <h3>Top givers <span class="muted small">(who gave to us)</span></h3>
          </header>
          <div class="report-list">${renderTopList(topGivers, 'giver')}</div>
        </section>
      </div>

      <section class="report-section">
        <header class="report-section-head">
          <h3>By occasion</h3>
        </header>
        <div class="report-list">${occRows}</div>
      </section>
    `;
  },

  exportCSV() {
    const memMap = Object.fromEntries(Store.membersList().map(m => [m.id, m]));
    const rows = this.rowsForDirection().slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (!rows.length) { toast('Nothing to export.', 'warn'); return; }
    const fromOf = g => {
      const fromIds = Array.isArray(g.fromMemberIds) && g.fromMemberIds.length
        ? g.fromMemberIds
        : (g.fromMemberId ? [g.fromMemberId] : []);
      const names = fromIds.map(id => memMap[id]).filter(Boolean).map(m => displayName(m));
      return names.length ? names.join(', ') : (g.fromText || '');
    };
    const toOf = g => g.toMemberId && memMap[g.toMemberId]
      ? displayName(memMap[g.toMemberId]) : (g.toText || '');
    const data = [
      ['Direction', 'Date', 'Item', 'Amount (USD)', 'From', 'To', 'Occasion', 'Notes'],
      ...rows.map(g => [g.direction, g.date || '', g.item || '', g.amount || '', fromOf(g), toOf(g), g.occasion || '', g.notes || '']),
    ];
    downloadCSV(`gifts-${this.direction}-${new Date().toISOString().slice(0, 10)}.csv`, data);
  },
  openModal(editId = null, prefill = null) {
    const f = $('#gift-form');
    f.reset();
    f.dataset.editId = editId || '';

    // To-member: typeahead single-picker. Default popover view shows just the
    // logged-in user's nuclear family (self + spouse + children) because
    // received gifts almost always go to "us". Typing or clicking "Show all
    // family" expands to the full member list.
    const toEl = $('#gift-to-member');
    SingleMemberPicker.mount(toEl, {
      shortlist: nuclearFamilyIds(),
      placeholder: '+ Pick recipient…',
    });
    SingleMemberPicker.write(toEl, '');

    // Linked event dropdown
    const events = (Store.state.events || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    $('#gift-event').innerHTML = ['<option value="">— none —</option>',
      ...events.map(ev => `<option value="${ev.id}">${escape((ev.icon ? ev.icon + ' ' : '') + ev.name)}${ev.date ? ' · ' + formatDate(ev.date) : ''}</option>`)
    ].join('');

    // Mount the multi-select for From members
    const mp = $('[data-picker="gift-from-members"]');
    MemberPicker.mount(mp);
    MemberPicker.write(mp, []);

    if (editId) {
      const g = Store.state.gifts.find(x => x.id === editId);
      $('#gift-modal-title').textContent = 'Edit gift';
      f.direction.value = g.direction || 'received';
      f.item.value = g.item || '';
      f.amount.value = (g.amount != null ? g.amount : '');
      f.date.value = g.date || '';
      f.fromText.value = g.fromText || '';
      f.toText.value = g.toText || '';
      SingleMemberPicker.write(toEl, g.toMemberId || '');
      f.occasion.value = g.occasion || '';
      f.notes.value = g.notes || '';
      $('#gift-event').value = g.eventId || '';
      // Support legacy single-id field
      const ids = Array.isArray(g.fromMemberIds) ? g.fromMemberIds
                : (g.fromMemberId ? [g.fromMemberId] : []);
      MemberPicker.write(mp, ids);
    } else {
      $('#gift-modal-title').textContent = 'Log a gift';
      f.direction.value = (prefill?.direction) || (this.direction === 'both' ? 'received' : this.direction);
    }

    if (prefill) {
      if (prefill.fromMemberIds) MemberPicker.write(mp, prefill.fromMemberIds);
      if (prefill.fromText) f.fromText.value = prefill.fromText;
      if (prefill.eventId) {
        $('#gift-event').value = prefill.eventId;
        // also prefill date/occasion from event
        const ev = (Store.state.events || []).find(e => e.id === prefill.eventId);
        if (ev) {
          if (ev.date && !f.date.value) f.date.value = ev.date;
          if (ev.name && !f.occasion.value) f.occasion.value = ev.name;
        }
      }
    }

    this.refreshDirectionLabels();
    $('#gift-modal').setAttribute('aria-hidden', 'false');
  },
  closeModal() { $('#gift-modal').setAttribute('aria-hidden', 'true'); },
  saveModal() {
    const f = $('#gift-form');
    const fd = new FormData(f);
    const item   = (fd.get('item')   || '').toString().trim();
    const amount = (fd.get('amount') || '').toString().trim();
    // Require at least one of item or amount, otherwise it's an empty entry.
    if (!item && !amount) { toast('Enter an item or an amount.', 'warn'); return; }
    const data = {
      direction: (fd.get('direction') || 'received').toString(),
      item,
      amount: amount ? parseFloat(amount) : null,
      date: (fd.get('date') || '').toString(),
      fromText: (fd.get('fromText') || '').toString().trim(),
      toText:   (fd.get('toText')   || '').toString().trim(),
      fromMemberIds: MemberPicker.read($('[data-picker="gift-from-members"]')),
      fromMemberId: '',  // legacy field cleared
      toMemberId:   SingleMemberPicker.read($('#gift-to-member')),
      eventId:      (fd.get('eventId')      || '').toString(),
      occasion: (fd.get('occasion') || '').toString().trim(),
      notes:    (fd.get('notes')    || '').toString().trim(),
    };
    Store.state.gifts ||= [];
    const editId = f.dataset.editId;
    if (editId) {
      const g = Store.state.gifts.find(x => x.id === editId);
      Object.assign(g, data);
    } else {
      Store.state.gifts.unshift({ id: uid('gift'), ...data });
    }
    Store.save();
    this.closeModal();
    // If we're on a single-direction tab and just added the other direction, switch to "both".
    if (this.direction !== 'both' && this.direction !== data.direction) this.direction = 'both';
    $$('.gift-tab').forEach(x => x.classList.toggle('is-active', x.dataset.direction === this.direction));
    this.render();
  },
};

// -------------------- MEMBER MODAL --------------------
const MemberModal = {
  el: null,
  init() {
    this.el = $('#modal');
    on(this.el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#member-form'), 'submit', (e) => { e.preventDefault(); this.submit(); });
    on($('#modal-rel-type'), 'change', () => this.updateRelTargets());
  },
  open(opts = {}) {
    if (!Auth.isAdmin()) return;
    const { targetId = null } = opts;
    const f = $('#member-form');
    f.reset();
    f.dataset.photo = '';
    f.dataset.lockedTargetId = targetId || '';
    refreshGroupSelect($('#modal-group'), '');
    const ePicker = $('[data-picker="modal-ethnicity"]');
    EthnicityPicker.mount(ePicker);
    EthnicityPicker.write(ePicker, []);

    const typeSel = $('#modal-rel-type');
    const anchor = $('#modal-anchor');

    // Rebuild the relationship-type options for clarity in each mode.
    // Stored values stay the same; only the labels change.
    typeSel.innerHTML = '';
    if (!targetId) {
      typeSel.append(...[
        ['root',    'Root (no relation yet)'],
        ['child',   'Child of…'],
        ['parent',  'Parent of…'],
        ['spouse',  'Spouse of…'],
        ['sibling', 'Sibling of…'],
      ].map(([v, label]) => new Option(label, v)));
    }

    if (targetId) {
      const t = Store.byId(targetId);
      $('#modal-title').textContent = `Add a relative of ${t.firstName} ${t.lastName}`;
      $('#modal-anchor-name').textContent = `${t.firstName} ${t.lastName}`;
      const av = $('#modal-anchor-avatar');
      av.className = 'modal-anchor-avatar is-' + t.gender;
      if (t.photo) { av.style.backgroundImage = `url('${cssUrl(t.photo)}')`; av.innerHTML = ''; }
      else { av.style.backgroundImage = ''; av.innerHTML = Silhouettes.for(t); }
      anchor.hidden = false;

      // Anchor-perspective options: "{Target}'s child" stores 'child' (new person is child of target).
      typeSel.append(...[
        ['child',   `${t.firstName}'s child`],
        ['parent',  `${t.firstName}'s parent`],
        ['spouse',  `${t.firstName}'s spouse`],
        ['sibling', `${t.firstName}'s sibling`],
      ].map(([v, label]) => new Option(label, v)));
      typeSel.value = 'child';
      typeSel.required = true;
      $('#modal-rel-legend').textContent = `Relationship to ${t.firstName} (required)`;
      $('#modal-rel-type-label').textContent = 'New person is';
    } else {
      $('#modal-title').textContent = 'Add family member';
      anchor.hidden = true;
      typeSel.value = 'root';
      typeSel.required = false;
      $('#modal-rel-legend').textContent = 'Relationship to existing family';
      $('#modal-rel-type-label').textContent = 'Relationship type';
    }

    this.updateRelTargets();
    this.el.setAttribute('aria-hidden', 'false');
    // Make sure the modal body opens scrolled to the top so the user sees the
    // first fields, not the bottom of the form.
    requestAnimationFrame(() => {
      const body = this.el.querySelector('.modal-body');
      if (body) body.scrollTop = 0;
      this.el.querySelector('.modal-panel')?.scrollTo?.(0, 0);
    });
    setTimeout(() => f.firstName.focus(), 50);
  },
  close() {
    this.el.setAttribute('aria-hidden', 'true');
    // Blur whatever has focus so the source node's "+" button doesn't stay
    // visible via :focus-within once the modal goes away.
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  },
  updateRelTargets() {
    const f = $('#member-form');
    const lockedId = f.dataset.lockedTargetId || '';
    const t = $('#modal-rel-type').value;
    const targetWrap = $('#modal-rel-target-wrap');
    const secondWrap = $('#modal-rel-second-wrap');
    const divorceWrap = $('#modal-divorce-wrap');

    if (t === 'root') {
      targetWrap.hidden = true; secondWrap.hidden = true; divorceWrap.hidden = true; return;
    }
    targetWrap.hidden = false;
    const sel = $('#modal-rel-target');
    if (lockedId) {
      const tm = Store.byId(lockedId);
      sel.innerHTML = `<option value="${tm.id}">${escape(displayName(tm))}</option>`;
      sel.value = tm.id;
      sel.disabled = true;
      targetWrap.querySelector('span').textContent = 'Anchor person';
    } else {
      sel.disabled = false;
      targetWrap.querySelector('span').textContent = 'Connect to';
      const opts = sortMembers(Store.membersList()).map(m => `<option value="${m.id}">${escape(displayName(m))}</option>`).join('');
      sel.innerHTML = opts;
    }

    if (t === 'child') {
      secondWrap.hidden = false;
      this.refreshSecondParent();
      sel.onchange = () => this.refreshSecondParent();
    } else {
      secondWrap.hidden = true;
    }
    // Show divorced checkbox only for spouse relationships
    divorceWrap.hidden = (t !== 'spouse');
    if (divorceWrap.hidden) $('#modal-divorced').checked = false;
  },
  refreshSecondParent() {
    const targetId = $('#modal-rel-target').value;
    const target = Store.byId(targetId);
    const sec = $('#modal-rel-second');
    if (!target) { sec.innerHTML = '<option value="">— none —</option>'; return; }
    const opts = ['<option value="">— none —</option>'];
    if (target.spouseId) {
      const s = Store.byId(target.spouseId);
      if (s) opts.push(`<option value="${s.id}" selected>${displayName(s)} (spouse)</option>`);
    }
    sortMembers(Store.membersList().filter(m => m.id !== target.id && m.id !== target.spouseId)).forEach(m => {
      opts.push(`<option value="${m.id}">${displayName(m)}</option>`);
    });
    sec.innerHTML = opts.join('');
  },
  async submit() {
    if (!Auth.isAdmin()) return;
    const f = $('#member-form');
    const fd = new FormData(f);
    const firstName = (fd.get('firstName') || '').toString().trim();
    const lastName  = (fd.get('lastName')  || '').toString().trim();
    if (!firstName || !lastName) { toast('First and last name are required.', 'warn'); return; }

    const lockedId = f.dataset.lockedTargetId || '';
    const relType = (fd.get('relType') || '').toString();
    let relTargetId = (fd.get('relTargetId') || '').toString();
    if (lockedId) relTargetId = lockedId;

    if (lockedId) {
      if (!relType || relType === 'root') {
        toast('Pick how this person is related.', 'warn');
        $('#modal-rel-type').focus();
        return;
      }
      if (!relTargetId) {
        toast('Missing the anchor person — please reopen and try again.', 'warn');
        return;
      }
    }

    const ethnicities = EthnicityPicker.read($('[data-picker="modal-ethnicity"]'));
    const input = {
      firstName,
      middleName: (fd.get('middleName') || '').toString().trim(),
      lastName,
      displayName: fd.get('displayName'),
      internationalName: fd.get('internationalName'),
      birthday: fd.get('birthday'),
      gender: fd.get('gender'),
      ageGroup: fd.get('ageGroup'),
      group: fd.get('group') || '',
      email: (fd.get('email') || '').toString().trim(),
      role: 'user',
      relType,
      relTargetId,
      relSecondId: fd.get('relSecondId') || '',
      relDivorced: !!fd.get('divorced'),
      ethnicities,
    };
    const { member, password } = await Tree.addMember(input);
    Canvas.renderAll();
    Canvas.fit();
    AdminView.render && AdminView.render();
    this.close();

    // Mirror the new member into Supabase Auth when we have an email to use.
    // No email → no login (admin can add one later from the drawer).
    if (member.email) {
      const r = await Backend.createMemberAccount({
        email: member.email,
        password,
        memberId: member.id,
        isAdmin: false,
      });
      if (r.ok) {
        showCredentials({
          email: member.email,
          password,
          title: 'Account created',
          note: r.needsConfirmation
            ? 'They must click the confirmation link in their email before signing in. Share the password too — they’ll need it after confirming.'
            : 'Share these with the family member. They can change their password after signing in.',
        });
        AdminView.accountIds = null;  // refresh the Login column on next render
      } else {
        toast('Member saved, but the Supabase login could not be created: ' + r.reason, 'warn');
      }
    } else {
      toast('Member saved. Add an email later to give them a login.');
    }
  },
};

// -------------------- LINK FAMILY MODAL --------------------
const LinkFamilyModal = {
  el: null, memberId: null,
  init() {
    this.el = $('#link-modal');
    on(this.el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#link-rel-type'), 'change', () => this.refreshDivorce());
    on($('#link-form'), 'submit', (e) => { e.preventDefault(); this.submit(); });
  },
  open(memberId) {
    if (!Auth.isAdmin()) return;
    if (!memberId) return;
    this.memberId = memberId;
    const m = Store.byId(memberId); if (!m) return;
    $('#link-subject').textContent = `Connect ${displayName(m)} to someone already in the tree.`;
    const sel = $('#link-target');
    const opts = sortMembers(Store.membersList().filter(x => x.id !== memberId))
      .map(x => `<option value="${x.id}">${escape(displayName(x))}</option>`)
      .join('');
    sel.innerHTML = opts || '<option value="">— no one else to link to —</option>';
    $('#link-rel-type').value = 'spouse';
    $('#link-divorced').checked = false;
    $('#link-error').textContent = '';
    this.refreshDivorce();
    this.el.setAttribute('aria-hidden', 'false');
  },
  close() { this.el.setAttribute('aria-hidden', 'true'); },
  refreshDivorce() {
    $('#link-divorce-wrap').hidden = ($('#link-rel-type').value !== 'spouse');
    if ($('#link-divorce-wrap').hidden) $('#link-divorced').checked = false;
  },
  submit() {
    const member = Store.byId(this.memberId); if (!member) return;
    const fd = new FormData($('#link-form'));
    const relType = (fd.get('relType') || '').toString();
    const targetId = (fd.get('targetId') || '').toString();
    if (!targetId) { $('#link-error').textContent = 'Pick someone to link to.'; return; }
    const target = Store.byId(targetId);
    if (!target) { $('#link-error').textContent = 'Target not found.'; return; }
    // disallow self-loop or pre-existing identical link
    if (target.id === member.id) { $('#link-error').textContent = 'Pick a different person.'; return; }
    const divorced = relType === 'spouse' && !!fd.get('divorced');
    Tree.connect(member, relType, target.id, undefined, { divorced });
    inheritEthnicities();
    autoLayout();
    Store.save();
    Canvas.renderAll();
    Canvas.fit();
    this.close();
    Drawer.renderView();
    toast('Linked.');
  },
};

// -------------------- USER CHIP --------------------
const UserChip = {
  init() {
    const chip = $('#user-chip');
    on(chip, 'click', (e) => {
      // ignore clicks within menu so menu buttons fire
      if (e.target.closest('.user-menu')) return;
      $('#user-menu').toggleAttribute('hidden');
    });
    on($('#user-menu'), 'click', (e) => {
      const action = e.target.dataset?.action; if (!action) return;
      $('#user-menu').setAttribute('hidden', '');
      if (action === 'logout') { (async () => { await Auth.logout(); location.reload(); })(); }
      if (action === 'my-profile') {
        if (Auth.current === 'admin-bootstrap') {
          toast('The admin account is not on the tree. Add or promote a member.', 'warn');
        } else {
          Drawer.open(Auth.current.id);
        }
      }
      if (action === 'change-password') ChangePasswordModal.open();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#user-chip')) $('#user-menu').setAttribute('hidden', '');
    });
  },
  refresh() {
    const u = Auth.current;
    if (u === 'admin-bootstrap') {
      $('#user-chip-name').textContent = 'Admin';
      $('#user-chip-role').textContent = 'Admin';
      $('#user-chip-avatar').style.background = 'linear-gradient(135deg, #1f4a3d, #b6743d)';
      $('#user-chip-avatar').style.backgroundImage = '';
    } else if (u) {
      $('#user-chip-name').textContent = `${u.firstName} ${u.lastName}`;
      $('#user-chip-role').textContent = capitalize(u.role || 'user');
      $('#user-chip-avatar').style.background = '';
      if (u.photo) {
        $('#user-chip-avatar').style.backgroundImage = `url('${cssUrl(u.photo)}')`;
      } else {
        $('#user-chip-avatar').style.backgroundImage = '';
        $('#user-chip-avatar').style.backgroundColor = u.gender === 'male' ? '#e3edf8' : '#fbe3ec';
      }
    }
    document.body.classList.toggle('is-admin', Auth.isAdmin());
    document.body.classList.toggle('is-family', Auth.isFamily());
    document.body.classList.toggle('is-vault-authorized', Auth.canAccessVault());
  },
};

// Admin "Reset PW" button. Generates a random password, sets it on the
// member's Supabase Auth user via the admin-reset-password Edge Function,
// and shows the email + new password once for the admin to share.
// For members with no Supabase login yet, creates the login on the spot.
async function sendAdminResetEmail(m) {
  if (!Auth.isAdmin()) return;
  if (!m) return;
  if (!m.email) {
    toast('Add an email to this member first — accounts are tied to email.', 'warn');
    return;
  }
  // Does this member already have a Supabase login?
  const { data: link, error } = await Backend.client
    .from('member_accounts')
    .select('user_id')
    .eq('member_id', m.id)
    .maybeSingle();
  if (error) { toast('Could not check login state: ' + error.message, 'warn'); return; }

  const password = randomPassword();

  if (!link) {
    // No login yet — create one (pre-existing member from before auto-mirror).
    if (!confirm(`${m.firstName} doesn't have a Supabase login yet.\n\nCreate one now with email ${m.email}?`)) return;
    const r = await Backend.createMemberAccount({
      email: m.email,
      password,
      memberId: m.id,
      isAdmin: false,
    });
    if (r.ok) {
      showCredentials({
        email: m.email,
        password,
        title: 'Login created',
        note: r.needsConfirmation
          ? 'They must click the confirmation link in their email before signing in. Share the password too — they’ll need it after confirming.'
          : 'Share these with the family member. They can change their password after signing in.',
      });
      AdminView.accountIds = null;
    } else {
      toast('Could not create login: ' + r.reason, 'warn');
    }
    return;
  }

  // Has login — reset the password via the Edge Function.
  if (!confirm(`Reset ${m.firstName}'s password? A new randomized password will be generated for you to share.`)) return;
  const r = await Backend.adminSetPassword(m.id, password);
  if (r.ok) {
    showCredentials({
      email: m.email,
      password,
      title: 'Password reset',
      note: 'Share this new password with the family member. They can change it after signing in.',
    });
  } else {
    const looksLikeMissingFunction = /not\s*found|404|failed to send|fetch/i.test(r.reason || '');
    const hint = looksLikeMissingFunction
      ? '\n\nTip: deploy (or redeploy) the admin-reset-password Edge Function in Supabase — see supabase/functions/admin-reset-password/index.ts. Then check Supabase → Edge Functions → Logs for any startup errors.'
      : '';
    toast('Could not reset password: ' + r.reason + hint, 'warn');
  }
}

// -------------------- CHANGE / SET PASSWORD --------------------
// Two modes:
//   change   — signed-in user changes their own password.
//   recovery — user arrived via a "reset your password" email link.
//              Supabase has established a short-lived recovery session; after
//              they pick a new password, we run the normal post-sign-in flow
//              to enter the app.
const ChangePasswordModal = {
  mode: 'change',
  init() {
    on($('#cpw-modal'), 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#cpw-form'), 'submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      const next    = f.next.value;
      const confirm = f.confirm.value;
      if (!next) { $('#cpw-error').textContent = 'Enter a new password.'; return; }
      if (next !== confirm) { $('#cpw-error').textContent = 'The two passwords do not match.'; return; }

      try {
        await Auth.setPassword(next);
      } catch (err) {
        $('#cpw-error').textContent = err.message || 'Could not update password.';
        return;
      }
      $('#cpw-error').textContent = '';
      f.reset();
      const wasRecovery = this.mode === 'recovery';
      this.close();

      if (wasRecovery) {
        Backend.recoveryPending = false;
        // Drop the recovery hash so a refresh doesn't loop us back here.
        try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch {}
        toast('Password updated. Signing you in…');
        await onSignedIn();
      } else {
        toast('Password updated.');
      }
    });
  },
  open(opts = {}) {
    const { mode = 'change' } = opts;
    this.mode = mode;
    const f = $('#cpw-form');
    f.reset();
    $('#cpw-error').textContent = '';
    if (mode === 'recovery') {
      $('#cpw-title').textContent = 'Set a new password';
      $('#cpw-subject').textContent = 'You followed a password reset link. Choose a new password to finish signing in.';
    } else {
      $('#cpw-title').textContent = 'Change password';
      $('#cpw-subject').textContent = 'Enter a new password. No need to retype your current one.';
    }
    $('#cpw-modal').setAttribute('aria-hidden', 'false');
    setTimeout(() => f.next.focus(), 30);
  },
  close() { $('#cpw-modal').setAttribute('aria-hidden', 'true'); this.mode = 'change'; },
};

// -------------------- IDLE TIMEOUT --------------------
// 1 hour of inactivity → 60-second warning modal → auto sign-out.
const IdleMonitor = {
  IDLE_MS: 60 * 60 * 1000,   // 1 hour
  WARN_MS: 60 * 1000,        // 60 seconds
  CHECK_MS: 30 * 1000,       // poll every 30 seconds
  lastActivity: 0,
  checkInterval: null,
  countdownInterval: null,
  warning: false,
  countdownRemaining: 0,
  start() {
    if (this.checkInterval) return;
    this.lastActivity = Date.now();
    const touch = () => { if (!this.warning) this.lastActivity = Date.now(); };
    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(ev =>
      document.addEventListener(ev, touch, { passive: true, capture: true })
    );
    this.checkInterval = setInterval(() => this.check(), this.CHECK_MS);
    // Bind the modal buttons once
    on($('#idle-continue'),   'click', () => this.continueSession());
    on($('#idle-logout-now'), 'click', () => this.signOut());
  },
  stop() {
    if (this.checkInterval) { clearInterval(this.checkInterval); this.checkInterval = null; }
    this.stopCountdown();
  },
  check() {
    if (this.warning) return;
    if (Date.now() - this.lastActivity >= this.IDLE_MS) this.showWarning();
  },
  showWarning() {
    this.warning = true;
    this.countdownRemaining = this.WARN_MS / 1000;
    this.renderCountdown();
    $('#idle-modal').setAttribute('aria-hidden', 'false');
    this.countdownInterval = setInterval(() => {
      this.countdownRemaining -= 1;
      this.renderCountdown();
      if (this.countdownRemaining <= 0) this.signOut();
    }, 1000);
  },
  renderCountdown() {
    const el = $('#idle-countdown'); if (el) el.textContent = this.countdownRemaining;
    const bar = $('#idle-bar-fill'); if (bar) bar.style.width = `${(this.countdownRemaining / (this.WARN_MS / 1000)) * 100}%`;
  },
  stopCountdown() {
    if (this.countdownInterval) { clearInterval(this.countdownInterval); this.countdownInterval = null; }
  },
  continueSession() {
    this.stopCountdown();
    this.warning = false;
    this.lastActivity = Date.now();
    $('#idle-modal').setAttribute('aria-hidden', 'true');
    toast('Welcome back.');
  },
  async signOut() {
    this.stopCountdown();
    this.warning = false;
    $('#idle-modal').setAttribute('aria-hidden', 'true');
    await Auth.logout();
    location.reload();
  },
};

// -------------------- CREDENTIALS MODAL --------------------
// Accepts ({ email, password, title?, note? }) — admin sees this once after
// creating a new login, copies to share, then it's gone.
function showCredentials({ email, password, title, note }) {
  $('#pwd-title').textContent = title || 'Account credentials';
  $('#pwd-username').textContent = email || '';
  $('#pwd-password').textContent = password || '';
  $('#pwd-note').textContent = note || 'Share these with the family member. They can change their password later.';
  $('#pwd-modal').setAttribute('aria-hidden', 'false');
}
function bindCredsModal() {
  on($('#pwd-modal'), 'click', (e) => { if (e.target.closest('[data-close]')) e.currentTarget.setAttribute('aria-hidden','true'); });
  on($('#pwd-copy'), 'click', async () => {
    const u = $('#pwd-username').textContent, p = $('#pwd-password').textContent;
    try { await navigator.clipboard.writeText(`Email: ${u}\nPassword: ${p}`); toast('Copied.'); } catch { toast('Copy failed', 'warn'); }
  });
}

// -------------------- LOGIN BIND --------------------
// Toggle the login form between "sign in" and "sign up" modes. Sign-up uses
// the same email + password fields; we just flip the submit handler.
let _loginMode = 'signin';
function setLoginMode(mode) {
  _loginMode = mode;
  $('#btn-login-submit').textContent = (mode === 'signin') ? 'Sign in' : 'Create account';
  $('#btn-login-toggle').textContent = (mode === 'signin') ? 'Need an account? Sign up' : 'Have an account? Sign in';
  $('#login-error').textContent = '';
}

function bindLogin() {
  on($('#login-form'), 'submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const email = (fd.get('email') || '').toString().trim();
    const password = (fd.get('password') || '').toString();
    const errEl = $('#login-error');
    errEl.textContent = '';
    const submitBtn = $('#btn-login-submit');
    submitBtn.disabled = true;
    const result = (_loginMode === 'signup')
      ? await Backend.signUp(email, password)
      : await Backend.signIn(email, password);
    submitBtn.disabled = false;
    if (!result.ok) { errEl.textContent = result.reason; return; }
    if (_loginMode === 'signup' && !result.session) {
      errEl.textContent = 'Account created. Check your inbox to confirm before signing in.';
      setLoginMode('signin');
      return;
    }
    await onSignedIn();
  });
  on($('#btn-login-toggle'), 'click', () => {
    setLoginMode(_loginMode === 'signin' ? 'signup' : 'signin');
  });
  on($('#btn-import-local'), 'click', async () => {
    if (!confirm('Copy the family data already saved in this browser into the database? This overwrites anything currently in the database.')) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const local = raw ? JSON.parse(raw) : null;
      if (!local) { toast('Nothing to import.', 'warn'); return; }
      await Backend.flushSaveArchive(local);
      toast('Imported into database.');
    } catch (e) { toast('Import failed: ' + e.message, 'warn'); }
  });
}

// Re-hydrate the in-memory state when another device updates the archive row.
// Triggers a full UI re-render so anything that depends on `Store.state` reflects
// the change.
function applyRemoteState(state) {
  Store.hydrate(state);
  // v4.32: seed the no-op skip with the remote state we just adopted. Any
  // local healing changes that happen during hydrate are part of the
  // "current state" — without this seed, the next Store.save() would
  // immediately push a redundant write right after every realtime echo.
  try { Backend.lastSavedHash = hashStringFast(JSON.stringify(Store.state)); } catch {}
  Auth.applyAccount();
  if (typeof TreeFilters !== 'undefined' && TreeFilters.refreshGroupOptions) {
    TreeFilters.refreshGroupOptions();
  }
  if (typeof PageEmojis !== 'undefined' && PageEmojis.applyAll) PageEmojis.applyAll();
  document.body.classList.toggle('is-admin', Auth.isAdmin());
  document.body.classList.toggle('is-family', Auth.isFamily());
  if (Canvas?.renderAll) Canvas.renderAll();
  if (Views?.current === 'admin')    AdminView.render();
  if (Views?.current === 'vault')    VaultView.render();
  if (Views?.current === 'dashboard') DashboardView.render();
  if (Views?.current === 'events')   EventsView.render();
  if (Views?.current === 'calendar') CalendarView.render();
  if (Views?.current === 'gifts')    GiftsView.render();
  if (Views?.current === 'myfamily') MyFamilyView.render();
  refreshEventsNav();
  toast('Updated from another device.');
}

// Common post-login flow: claim first-admin if needed, hydrate archive,
// resolve which member the logged-in account is, and enter the app.
async function onSignedIn() {
  const session = await Backend.session();
  Backend.user = session?.user || null;
  if (!Backend.user) { $('#login-error').textContent = 'Sign-in failed.'; return; }

  // Promote first user to admin if none exists yet.
  await Backend.claimFirstAdmin();

  // Pull the canonical state. Empty row → use whatever's in localStorage
  // (lets the user "import" later) or defaults.
  const remote = await Backend.fetchArchive();
  if (remote?.state && Object.keys(remote.state).length > 0) {
    Store.hydrate(remote.state);
  } else if (Store.state) {
    Store.healMissingKeys();
  } else {
    Store.bootstrap();
  }
  // v4.32: seed the no-op skip with the freshly-hydrated state hash. Healing
  // / bootstrap may mutate the in-memory state, so the seed runs *after*
  // hydration. The first user mutation will produce a different hash and
  // trigger the first real write; everything before then is silent.
  try { Backend.lastSavedHash = hashStringFast(JSON.stringify(Store.state)); } catch {}

  Auth.applyAccount();
  // v4.58: warm the auth-id → display-name cache for Albums/Memories author
  // labels. Fire-and-forget; views re-render with names once it resolves.
  AuthorNames.warm().catch(e => console.warn('AuthorNames.warm:', e.message || e));
  if (typeof TreeFilters !== 'undefined' && TreeFilters.refreshGroupOptions) {
    TreeFilters.refreshGroupOptions();
  }
  // v4.38: backfill member_accounts.is_admin for any member whose in-app
  // role is 'admin' but whose DB account flag is still false. The
  // Members → Last Activity column reads from a SECURITY DEFINER RPC
  // (member_last_seen) gated on the DB is_admin flag, so without this
  // sync an admin-role member sees an empty column.
  // Only runs when the *currently logged-in* user is already a DB admin
  // (RLS gates the UPDATE on member_accounts to is_admin = true).
  if (Backend.account?.is_admin) {
    syncAdminFlagsFromState().catch(e => console.warn('admin-flag sync:', e.message || e));
  }
  Backend.onRemoteChange = applyRemoteState;
  Backend.subscribeArchive();
  enterApp();
}

// Walk the in-memory state looking for members with role='admin' whose
// linked Supabase account still has is_admin = false, then push an update
// to flip the flag. Safe to re-run — UPDATE is idempotent. Errors per-row
// are logged and skipped so one bad row doesn't block the rest.
async function syncAdminFlagsFromState() {
  if (!Backend.client) return;
  const adminMemberIds = Store.membersList()
    .filter(m => m.role === 'admin')
    .map(m => m.id);
  if (!adminMemberIds.length) return;
  // Pull the current is_admin flag for each linked account in one query.
  const { data, error } = await Backend.client
    .from('member_accounts')
    .select('user_id, member_id, is_admin')
    .in('member_id', adminMemberIds);
  if (error) { console.warn('syncAdminFlagsFromState read:', error.message); return; }
  const needsPromotion = (data || []).filter(r => r.is_admin !== true);
  if (!needsPromotion.length) return;
  // One UPDATE per account. These are admin-only writes (RLS), and we
  // already gated entry on Backend.account.is_admin so the policy passes.
  for (const r of needsPromotion) {
    const { error: upErr } = await Backend.client
      .from('member_accounts')
      .update({ is_admin: true })
      .eq('user_id', r.user_id);
    if (upErr) console.warn(`promote ${r.member_id}:`, upErr.message);
  }
  // Force the Members table to re-pull last-activity now that the
  // promoted users may unlock the RPC for themselves on their next visit.
  if (typeof AdminView !== 'undefined') {
    AdminView.lastSeenById = null;
    if (Views?.current === 'admin') AdminView.render();
  }
}

// -------------------- TREE TOOLBAR --------------------
function bindTreeToolbar() {
  on($('#btn-zoom-in'),    'click', () => Canvas.zoomTo(Canvas.scale * 1.2));
  on($('#btn-zoom-out'),   'click', () => Canvas.zoomTo(Canvas.scale / 1.2));
  on($('#btn-zoom-reset'), 'click', () => { Canvas.scale = 1; Canvas.tx = 100; Canvas.ty = 60; Canvas.apply(); });
  on($('#btn-fit'),        'click', () => Canvas.fit());
  on($('#btn-auto-layout'),'click', () => {
    // Explicit "Auto-arrange" wipes any manual positioning so the tree
    // returns to the algorithm-driven layout. If the user wants to fine-
    // tune again, they unlock the layout from the toolbar after.
    Store.state.manualLayout = false;
    Store.state.editLayout = false;
    autoLayout(undefined, { force: true });
    Canvas.renderAll();
    Canvas.fit();
    Store.save();
    TreeEditLayout.syncToolbar();
    toast('Tree arranged.');
  });
  on($('#btn-expand-all'), 'click', () => { expandAll(); autoLayout(); Canvas.renderAll(); Canvas.fit(); toast('All branches expanded.'); });
  on($('#btn-collapse-all'), 'click', () => { collapseAll(); autoLayout(); Canvas.renderAll(); Canvas.fit(); toast('All branches collapsed.'); });
  // v4.37: orientation toggle removed — tree is always vertical now. The
  // underlying orientation state is preserved in Store.state.orientation
  // for backward compat (existing archives may have it set to 'horizontal')
  // but it's force-normalized below.

  // theme popover
  const themeBtn = $('#btn-theme');
  const themePop = $('#theme-popover');
  on(themeBtn, 'click', (e) => {
    e.stopPropagation();
    const open = !themePop.hidden;
    themePop.hidden = open;
    themeBtn.setAttribute('aria-expanded', String(!open));
  });
  document.addEventListener('click', (e) => {
    if (!themePop.hidden && !e.target.closest('#theme-popover') && !e.target.closest('#btn-theme')) {
      themePop.hidden = true;
      themeBtn.setAttribute('aria-expanded', 'false');
    }
  });
  on($('#theme-color'), 'input', (e) => {
    const hue = hexToHue(e.target.value);
    Store.state.theme = { baseHue: hue };
    Store.save();
    applyTheme();
    Canvas.renderAll();
  });
  $$('#theme-popover .preset').forEach(btn => on(btn, 'click', () => {
    const hue = parseInt(btn.dataset.hue, 10);
    Store.state.theme = { baseHue: hue };
    Store.save();
    applyTheme();
    Canvas.renderAll();
  }));
  on($('#btn-add-first'),  'click', () => MemberModal.open());
  $$('.nav-tab').forEach(tab => on(tab, 'click', () => Views.show(tab.dataset.view)));

  on($('#tree-search'), 'input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    const matches = new Set();
    if (q) {
      Store.membersList().forEach(m => {
        if ((`${m.firstName} ${m.middleName || ''} ${m.lastName} ${m.displayName || ''}`).toLowerCase().includes(q)) {
          matches.add(m.id);
        }
      });
    }
    $$('.tree-nodes .node').forEach(n => {
      const id = n.dataset.id;
      n.classList.toggle('is-search-match', q && matches.has(id));
      n.classList.toggle('is-faded', q && !matches.has(id));
    });
  });

  TreeFilters.init();
}

// -------------------- TREE FILTERS --------------------
// Two mutually-exclusive filters that operate by toggling .collapsed on members.
// Members in the "keep set" stay expanded (their children render); everyone
// else is collapsed (their children hide). Picking either filter cancels the
// other so we don't have to reason about a 2D combination.
const TreeFilters = {
  group: '',
  myFamily: false,

  init() {
    this.refreshGroupOptions();
    on($('#tree-filter-group'), 'change', (e) => {
      this.group = e.target.value;
      if (this.group) this.myFamily = false;
      this.apply();
    });
    on($('#btn-filter-myfamily'), 'click', () => {
      this.myFamily = !this.myFamily;
      if (this.myFamily) this.group = '';
      this.apply();
    });
  },

  refreshGroupOptions() {
    const sel = $('#tree-filter-group'); if (!sel) return;
    const groups = (Store.state && Store.state.groups) || [];
    sel.innerHTML = '<option value="">All groups</option>' +
      groups.map(g => `<option value="${escape(g)}">${escape(g)}</option>`).join('');
    sel.value = this.group;
  },

  syncToolbar() {
    const sel = $('#tree-filter-group'); if (sel) sel.value = this.group;
    const btn = $('#btn-filter-myfamily');
    if (btn) {
      btn.setAttribute('aria-pressed', String(this.myFamily));
      btn.classList.toggle('is-active', this.myFamily);
    }
  },

  // Recompute and apply. Called when a filter changes OR when the underlying
  // data changes (members added/removed/regrouped, sign-in, etc.).
  apply() {
    const keep = this.computeKeepSet();
    if (keep) {
      Store.membersList().forEach(m => { m.collapsed = !keep.has(m.id); });
    } else {
      // No filter active — release everyone. We deliberately blow away any
      // pre-existing collapse state too; mixing manual collapse with filter
      // collapse made the toolbar feel unpredictable.
      Store.membersList().forEach(m => { m.collapsed = false; });
    }
    Store.save();
    autoLayout();
    Canvas.renderAll();
    Canvas.fit();
    this.syncToolbar();
  },

  computeKeepSet() {
    if (this.group) {
      const groupMembers = Store.membersList().filter(m => m.group === this.group);
      if (!groupMembers.length) {
        toast(`No one is in group "${this.group}".`, 'warn');
        return null;
      }
      // Keep set: every group member, their immediate family, AND every
      // ancestor up to the root. The ancestor walk is essential — without
      // it, autoLayout drops anyone whose parent is collapsed into the
      // "orphan" bucket, which is why a Group filter used to flatten the
      // tree into a horizontal row.
      const keep = new Set();
      const walkAncestors = (id) => {
        const stack = [id];
        while (stack.length) {
          const cur = stack.pop();
          if (keep.has(cur)) continue;
          keep.add(cur);
          const m = Store.byId(cur); if (!m) continue;
          (m.parentIds || []).forEach(pid => stack.push(pid));
        }
      };
      groupMembers.forEach(m => {
        walkAncestors(m.id);
        if (m.spouseId) keep.add(m.spouseId);
        (m.exSpouseIds || []).forEach(eid => keep.add(eid));
        // siblings (anyone sharing a parent with this group member)
        (m.parentIds || []).forEach(pid => {
          const p = Store.byId(pid); if (!p) return;
          (p.childrenIds || []).forEach(sid => keep.add(sid));
        });
        (m.childrenIds || []).forEach(cid => keep.add(cid));
      });
      // Keep ancestors' spouses too — otherwise a parent couple visually
      // splits with one half collapsed mid-tree.
      [...keep].forEach(id => {
        const m = Store.byId(id); if (!m) return;
        if (m.spouseId) keep.add(m.spouseId);
      });
      return keep;
    }
    if (this.myFamily) {
      const me = Auth.current;
      if (!me || me === 'admin-bootstrap') {
        toast('Sign in as a family member to use My Family filter.', 'warn');
        this.myFamily = false;
        return null;
      }
      return myFamilyIdSet(me.id);
    }
    return null;
  },
};

// "My Family" scope: me + spouse(s) (current + ex) + children + grandchildren
// + parents + grandparents + siblings + nieces/nephews.
function myFamilyIdSet(meId) {
  const ids = new Set([meId]);
  const me = Store.byId(meId); if (!me) return ids;
  if (me.spouseId) ids.add(me.spouseId);
  (me.exSpouseIds || []).forEach(id => ids.add(id));
  (me.childrenIds || []).forEach(cid => {
    ids.add(cid);
    const c = Store.byId(cid); if (!c) return;
    (c.childrenIds || []).forEach(gc => ids.add(gc));   // grandchildren
  });
  (me.parentIds || []).forEach(pid => {
    ids.add(pid);
    const p = Store.byId(pid); if (!p) return;
    (p.parentIds || []).forEach(gp => ids.add(gp));     // grandparents
    (p.childrenIds || []).forEach(sid => {              // siblings via shared parent
      if (sid === meId) return;
      ids.add(sid);
      const sib = Store.byId(sid); if (!sib) return;
      (sib.childrenIds || []).forEach(nn => ids.add(nn));// nieces/nephews
    });
  });
  return ids;
}

// -------------------- HELPERS --------------------
function $(s, root = document) { return root.querySelector(s); }
function $$(s, root = document) { return [...root.querySelectorAll(s)]; }
function on(el, ev, fn) { el && el.addEventListener(ev, fn); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function escape(s) { return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Safe "YYYY-MM-DD" from a timestamp/date-ish value. Returns '' for missing or
// unparseable input instead of throwing — a single bad/legacy record (e.g. a
// time-capsule with no sealedAt) must not blank an entire rendered list.
function isoDay(value) {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(value);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

// Build a safe CSS url() body from a possibly-untrusted image source. Photos can
// come from free-text URL fields (event cover, "paste an image URL"), so a value
// containing a quote or paren could break out of url('...') inside an inline
// style attribute and inject CSS. Validate the scheme (data:image / http(s) /
// blob: only) and CSS-escape any breakout character; return '' for anything
// unrecognized so the rule simply renders no image. (v4.56 hardening — C2.)
function cssUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^(data:image\/|https?:|blob:)/i.test(s)) return '';
  return s.replace(/[\\'"()\u0000-\u001F\u007F]/g, (c) => '\\' + c.charCodeAt(0).toString(16) + ' ');
}

// Normalize a user-supplied external link to a safe http(s) URL, or '' if it
// can't be made safe — blocks javascript:/vbscript:/data: on hrefs. Schemeless
// input is assumed https. (v4.56 hardening — C3; used by 529-plan links.)
function safeHttpUrl(raw) {
  const s = String(raw == null ? '' : raw).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ''; // some other explicit scheme → reject
  return 'https://' + s;                          // schemeless → assume https
}
// Human-friendly relative time stamp for memory comments and reactions
// ("just now", "5m ago", "Mar 12"). Falls back to a full date for
// anything older than ~7 days so old comments stay readable.
function relativeTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60)            return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60)            return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)             return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7)             return `${day}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
// `asOf` lets the caller freeze the age clock — used to stop counting at the
// date of death so we never show "82 years old" for someone who passed at 75.
function ageParts(iso, asOf) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  let stop;
  if (asOf) {
    stop = new Date(asOf + 'T00:00:00');
    if (isNaN(stop.getTime())) stop = new Date();
  } else {
    stop = new Date();
  }
  let years  = stop.getFullYear() - d.getFullYear();
  let months = stop.getMonth()    - d.getMonth();
  let days   = stop.getDate()     - d.getDate();
  if (days < 0) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return null;
  return { years, months };
}
function ageLabel(iso, asOf) {
  const a = ageParts(iso, asOf); if (!a) return '';
  const suffix = asOf ? '' : ' old'; // "X years" reads better when frozen at DOD
  if (a.years >= 4) return `${a.years} years${suffix}`;
  if (a.years === 0) return `${a.months} ${a.months === 1 ? 'month' : 'months'}${suffix}`;
  const yr = `${a.years} ${a.years === 1 ? 'year' : 'years'}`;
  const mo = a.months ? ` ${a.months} ${a.months === 1 ? 'month' : 'months'}` : '';
  return `${yr}${mo}${suffix}`;
}
function ageGroupForBirthday(iso) {
  const a = ageParts(iso); if (!a) return null;
  if (a.years < 5)  return 'baby';
  if (a.years < 18) return 'child';
  return 'adult';
}

// Full display name including the optional middle name. Falls back to "first last"
// when the middle is empty so we don't render double-spaces or trailing whitespace.
function fullName(m) {
  if (!m) return '';
  const mid = (m.middleName || '').trim();
  const parts = [m.firstName, mid, m.lastName].filter(Boolean);
  return parts.join(' ');
}

// What we actually render whenever a member's name appears. The optional
// `displayName` field is the override; when empty it falls back to the full
// legal name. Centralizing this means we don't have to remember the fallback
// at every call site.
function displayName(m) {
  if (!m) return '';
  const dn = (m.displayName || '').trim();
  return dn || fullName(m);
}

// Returns the logged-in user's nuclear-family member ids: self + current
// spouse + children. Used as the default shortlist on the Gifts To-member
// picker (and anywhere else "my household" is the natural starting point).
// Empty array when no real member is resolved (e.g. admin-bootstrap) —
// callers should treat that as "show full list".
function nuclearFamilyIds() {
  const me = Auth?.current;
  if (!me || me === 'admin-bootstrap') return [];
  const ids = new Set([me.id]);
  if (me.spouseId) ids.add(me.spouseId);
  (me.childrenIds || []).forEach(id => ids.add(id));
  return [...ids];
}

// US phone auto-format. Accepts any input, returns "(XXX) XXX-XXXX" once
// enough digits are present; otherwise a partial prefix. Non-digits stripped.
function formatPhoneUS(raw) {
  const d = (raw || '').toString().replace(/\D/g, '').slice(0, 10);
  if (d.length === 0) return '';
  if (d.length < 4)   return `(${d}`;
  if (d.length < 7)   return `(${d.slice(0,3)}) ${d.slice(3)}`;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

// Attach live US-phone formatting to a tel input. Caret stays at the end after
// reformat (good enough for typing; users editing the middle will see a small
// jump — acceptable tradeoff vs a complex caret-preservation routine).
function bindPhoneFormat(input) {
  if (!input || input.dataset.phoneBound) return;
  input.dataset.phoneBound = '1';
  input.addEventListener('input', () => { input.value = formatPhoneUS(input.value); });
  input.addEventListener('blur',  () => { input.value = formatPhoneUS(input.value); });
}

// US zip → city/state lookup via zippopotam.us (free, no API key, CORS-enabled).
// Returns { city, state } or null on miss.
async function lookupZipUS(zip) {
  const z = (zip || '').toString().trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  try {
    const r = await fetch(`https://api.zippopotam.us/us/${z}`);
    if (!r.ok) return null;
    const d = await r.json();
    const p = d.places?.[0];
    if (!p) return null;
    return {
      city:  p['place name'] || '',
      state: p['state abbreviation'] || p.state || '',
    };
  } catch { return null; }
}

// Whole years since an anniversary date. Returns null when date missing/invalid
// or hasn't occurred yet (avoids "-1 years").
function yearsTogether(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let y = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() ||
      (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) {
    y -= 1;
  }
  return y < 0 ? null : y;
}

// Human-readable "X years/months together" string. Falls back to months when
// the couple has been together less than a year. Returns '' for invalid /
// future-dated anniversaries so callers can guard with a falsy check.
function togetherLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  if (d > now) return '';
  let y = now.getFullYear() - d.getFullYear();
  let m = now.getMonth() - d.getMonth();
  if (now.getDate() < d.getDate()) m -= 1;
  if (m < 0) { y -= 1; m += 12; }
  if (y >= 1) return `${y} year${y === 1 ? '' : 's'} together`;
  if (m >= 1) return `${m} month${m === 1 ? '' : 's'} together`;
  return 'Just married';
}

// Pick a sensible default meal type based on the member's life stage.
function defaultMealForMember(m) {
  if (!m) return 'none';
  const g = m.ageGroup;
  if (g === 'baby')  return 'kids';
  if (g === 'child') return 'half';
  if (g === 'adult') return 'full';
  return 'none';
}

// v4.37: bank account / routing number masking. Always shows only the last 4
// digits with a bullets prefix — e.g. "••••1234". Returns an em-dash when
// the field is blank so callers don't have to null-check. The full value is
// never rendered anywhere in the UI (admin must look it up off-app to grab
// the full number; this is intentional per the v4.37 security ask).
function maskAccountNumber(value) {
  const s = (value || '').toString().replace(/\s+/g, '');
  if (!s) return '—';
  const last4 = s.slice(-4);
  return s.length <= 4 ? `••••${last4}` : `••••${last4}`;
}
// Short hint string used in edit-form placeholders so admins can confirm
// they're touching the right field without ever seeing the full number.
function maskAccountHint(value) {
  const s = (value || '').toString().replace(/\s+/g, '');
  if (!s) return '';
  return `Current ends in ${s.slice(-4)} — type a new number to replace, or leave blank to keep.`;
}

// Compose a single-line postal address from the new split fields, falling back
// gracefully when only some are present (or only the legacy `address` field).
function formatPostalAddress(m) {
  if (!m) return '';
  const street = (m.address || '').trim();
  const city   = (m.city || '').trim();
  const state  = (m.state || '').trim();
  const zip    = (m.zip || '').trim();
  const cityStateZip = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, cityStateZip].filter(Boolean).join('\n');
}

// Net gift balance for an event — sum(received) − sum(given) of gifts that
// reference this event. Returns { received, given, net }.
function eventGiftNet(eventId) {
  let received = 0, given = 0;
  (Store.state.gifts || []).forEach(g => {
    if (g.eventId !== eventId) return;
    const amt = Number(g.amount) || 0;
    if (g.direction === 'received') received += amt;
    else if (g.direction === 'given') given += amt;
  });
  return { received, given, net: received - given };
}

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  // Apply severity so failures don't render identically to confirmations.
  // Callers pass 'ok' (default), 'warn', or 'error'.
  t.classList.remove('is-warn', 'is-error');
  if (kind === 'warn' || kind === 'error') t.classList.add('is-' + kind);
  // Errors interrupt assistive tech; routine confirmations announce politely.
  t.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  t.classList.add('is-show');
  clearTimeout(toastTimer);
  // Failures linger a little longer — they often carry an instruction.
  toastTimer = setTimeout(() => t.classList.remove('is-show'), kind === 'ok' ? 2400 : 4200);
}

// -------------------- USER EVENT VISIBILITY --------------------
// Returns the events the currently-logged-in user is an attendee of.
// Admins see everything; users see only events containing them.
function userEventsList() {
  const all = Store.state.events || [];
  if (Auth.isAdmin()) return all;
  const u = Auth.current;
  if (!u || u === 'admin-bootstrap') return [];
  return all.filter(ev => (ev.attendees || []).some(a => a.memberId === u.id));
}

// Count of events where the logged-in member has status === 'invited' (pending
// action). Works for both regular users AND admin members (i.e. any member with
// a real id) — the bootstrap admin has no member tie and gets zero.
function pendingInviteCount() {
  const u = Auth.current;
  if (!u || u === 'admin-bootstrap') return 0;
  return (Store.state.events || []).filter(ev => (ev.attendees || []).some(a =>
    a.memberId === u.id && (a.status || 'invited') === 'invited'
  )).length;
}

// True if this attendee row may be edited by the current viewer.
function canEditAttendee(att) {
  if (Auth.isAdmin()) return true;
  const u = Auth.current;
  if (!u || u === 'admin-bootstrap') return false;
  return att.memberId === u.id || att.addedBy === u.id;
}

// Refresh the Events nav-tab visibility + invite badge. Call after any change
// to events/attendees, on login, and on app boot.
function refreshEventsNav() {
  const tab   = $('#nav-events');
  const badge = $('#events-badge');
  if (!tab) return;
  // Bootstrap admin: always show the tab (they manage events), no badge since
  // they have no member tie. Other admins (member with role:admin) keep their
  // own RSVP badge — we missed this case originally.
  if (Auth.current === 'admin-bootstrap') {
    tab.hidden = false;
    badge.hidden = true;
    return;
  }
  if (Auth.isAdmin()) {
    tab.hidden = false; // admin members see Events regardless of their RSVPs
  } else {
    const events = userEventsList();
    tab.hidden = events.length === 0;
  }
  const pending = pendingInviteCount();
  if (pending > 0) {
    badge.hidden = false;
    badge.textContent = pending > 9 ? '9+' : String(pending);
  } else {
    badge.hidden = true;
  }
}

// Sentinel value used by group `<select>`s for the inline "new group" option.
const NEW_GROUP_SENTINEL = '__new_group__';

function refreshGroupSelect(sel, current = '', allowAll = false) {
  if (!sel) return;
  const groups = Store.state.groups;
  const opts = [];
  if (allowAll) opts.push('<option value="">All groups</option>');
  else opts.push('<option value="">— none —</option>');
  groups.forEach(g => opts.push(`<option value="${escape(g)}" ${g === current ? 'selected' : ''}>${escape(g)}</option>`));
  // Admins can spawn a new group inline without leaving the form.
  if (!allowAll && Auth.isAdmin()) {
    opts.push(`<option value="${NEW_GROUP_SENTINEL}">+ Create new group…</option>`);
  }
  sel.innerHTML = opts.join('');
  // Wire the sentinel handler once.
  if (!sel.dataset.newGroupBound) {
    sel.dataset.newGroupBound = '1';
    on(sel, 'change', () => {
      if (sel.value !== NEW_GROUP_SENTINEL) return;
      const prev = sel.dataset.prevValue || '';
      const name = (prompt('Name for the new group?') || '').trim();
      if (!name) { sel.value = prev; return; }
      if (Store.state.groups.includes(name)) {
        toast(`"${name}" already exists.`, 'warn');
        sel.value = prev;
        return;
      }
      Store.state.groups.push(name);
      Store.save();
      refreshAllGroupSelects();
      // Re-select this dropdown to the new group.
      sel.value = name;
      sel.dataset.prevValue = name;
      // Keep the admin Groups panel in sync if it's open.
      if (typeof AdminView !== 'undefined' && Views.current === 'admin') AdminView.render();
      toast(`Group "${name}" created.`);
    });
    on(sel, 'focus', () => { sel.dataset.prevValue = sel.value; });
  } else {
    sel.dataset.prevValue = sel.value;
  }
}
function refreshAllGroupSelects() {
  refreshGroupSelect($('#modal-group'), $('#modal-group')?.value || '');
  refreshGroupSelect($('#edit-group'), $('#edit-group')?.value || '');
  // Keep the tree-view group filter in sync when groups are added/removed.
  if (typeof TreeFilters !== 'undefined' && TreeFilters.refreshGroupOptions) {
    TreeFilters.refreshGroupOptions();
  }
}

// Build a CSV from a 2D array (rows of cells), trigger browser download.
// Excel-friendly: includes BOM, CRLF line endings, quoted fields.
function downloadCSV(filename, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map(r => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
}

// resize image to a max edge as data URL (jpeg)
function resizeDataUrl(src, max = 480) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

// -------------------- BOOT --------------------
function enterApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  UserChip.refresh();
  refreshEventsNav();
  IdleMonitor.start();
  Canvas.init();
  reconcileSiblings();
  normalizeDivorced();
  inheritEthnicities();
  applyTheme();
  // v4.37: orientation toggle removed. Force-normalize any old archives
  // that were saved with 'horizontal' so the tree renders vertically.
  if (Store.state.orientation === 'horizontal') Store.state.orientation = 'vertical';
  Canvas.renderAll();
  setTimeout(() => { if (Store.membersList().length) Canvas.fit(); }, 60);
  // Push stored page emojis into the H2 slots and nav tabs.
  PageEmojis.applyAll();
  // Admins land on Dashboard; everyone else stays on the tree.
  if (Auth.isAdmin()) Views.show('dashboard');
}

async function init() {
  // Cache-first: render whatever's in localStorage immediately while we wait
  // for the network. The remote hydrate (after sign-in) overwrites this.
  Store.load();
  const backendOk = Backend.init();

  Drawer.init();
  MemberModal.init();
  UserChip.init();
  ChangePasswordModal.init();
  AdminView.init();
  MyFamilyView.init();
  TreeEditLayout.init();
  LinkFamilyModal.init();
  CropModal.init();
  EventsView.init();
  CalendarView.init();
  GiftsView.init();
  VaultView.init();
  RemindersModal.init();
  FriendModal.init();
  StorageView.init();
  DashboardView.init();
  MyKidsView.init();
  RecipesView.init();
  MemoriesView.init();
  AlbumsView.init();
  TimeCapsuleView.init();
  StoriesView.init();
  NewsletterView.init();
  PageEmojis.init();
  bindLogin();
  bindTreeToolbar();
  bindCredsModal();
  setLoginMode('signin');

  // Show the "Import data from this browser" button only when localStorage
  // has data to import.
  try {
    const localRaw = localStorage.getItem(STORAGE_KEY);
    const localState = localRaw ? JSON.parse(localRaw) : null;
    const hasLocalData = localState && (
      Object.keys(localState.members || {}).length > 0 ||
      (localState.events || []).length > 0 ||
      (localState.gifts || []).length > 0
    );
    $('#auth-import-row').hidden = !hasLocalData;
  } catch {}

  // When the user lands here via a password-reset email link, Supabase
  // creates a short-lived recovery session and fires PASSWORD_RECOVERY.
  // Show the "set new password" modal instead of auto-entering the app.
  Backend.onRecovery = () => ChangePasswordModal.open({ mode: 'recovery' });

  if (backendOk) {
    const session = await Backend.session();
    // Recovery wins over auto-sign-in. Open the modal directly here too — the
    // PASSWORD_RECOVERY event can fire before Backend.onRecovery is wired up,
    // so we can't rely on the listener alone. open() is idempotent.
    if (Backend.recoveryPending) {
      ChangePasswordModal.open({ mode: 'recovery' });
    } else if (session) {
      Backend.user = session.user;
      await onSignedIn();
    }
  }
}

// -------------------- CALENDAR REMINDERS --------------------
// Lightweight, recurring "calendar-only" items that never appear on the
// Events page. Stored in Store.state.reminders[].
//   id, title, startDate (YYYY-MM-DD),
//   recurrence: none|daily|weekly|biweekly|monthly|yearly|custom,
//   customInterval (number, custom only),
//   customUnit (day|week|month|year, custom only),
//   customDays (array of 0-6 for Sun..Sat — only used for custom + unit=week),
//   color (palette key), notes
function reminderOccursOn(r, iso) {
  if (!r || !r.startDate || !iso) return false;
  if (iso < r.startDate) return false;
  if (iso === r.startDate) return true;
  const start = new Date(r.startDate + 'T00:00:00');
  const day = new Date(iso + 'T00:00:00');
  const diffDays = Math.round((day - start) / 86400000);
  // Helper: month-difference (calendar months, not 30-day approximation).
  const monthsBetween = (a, b) =>
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  switch (r.recurrence) {
    case 'daily':    return diffDays >= 0;
    case 'weekly':   return diffDays % 7 === 0;
    case 'biweekly': return diffDays % 14 === 0;
    case 'monthly':  return start.getDate() === day.getDate();
    case 'yearly':   return start.getMonth() === day.getMonth() && start.getDate() === day.getDate();
    case 'custom': {
      const n = Math.max(1, parseInt(r.customInterval, 10) || 1);
      const unit = r.customUnit || 'day';
      if (unit === 'day') return diffDays % n === 0;
      if (unit === 'week') {
        const days = Array.isArray(r.customDays) ? r.customDays.map(Number) : [];
        if (days.length) {
          // Anniversaries on selected weekdays. Pick the start-of-week of the
          // first occurrence and require: same week-of-N pattern AND today's
          // weekday is one of the selected days.
          const weekOfStart = Math.floor(diffDays / 7);
          if (weekOfStart % n !== 0) return false;
          return days.includes(day.getDay());
        }
        return diffDays % (7 * n) === 0;
      }
      if (unit === 'month') {
        if (start.getDate() !== day.getDate()) return false;
        return monthsBetween(start, day) % n === 0;
      }
      if (unit === 'year') {
        if (start.getMonth() !== day.getMonth() || start.getDate() !== day.getDate()) return false;
        return (day.getFullYear() - start.getFullYear()) % n === 0;
      }
      return false;
    }
    case 'none':
    default:        return false;
  }
}

// Human-readable label for the upcoming list / dashboard sub-line.
function reminderRecurrenceLabel(r) {
  if (!r || !r.recurrence || r.recurrence === 'none') return '';
  if (r.recurrence === 'biweekly') return 'every 2 weeks';
  if (r.recurrence !== 'custom') return r.recurrence;
  const n = Math.max(1, parseInt(r.customInterval, 10) || 1);
  const unit = r.customUnit || 'day';
  const unitLabel = n === 1 ? unit : `${unit}s`;
  const base = n === 1 ? `every ${unit}` : `every ${n} ${unitLabel}`;
  if (unit === 'week' && Array.isArray(r.customDays) && r.customDays.length) {
    const names = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const days = r.customDays.slice().sort().map(d => names[d]).join(', ');
    return `${base} on ${days}`;
  }
  return base;
}

const RemindersModal = {
  editId: null,
  init() {
    const el = $('#reminder-modal'); if (!el) return;
    on(el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#reminder-form'), 'submit', (e) => { e.preventDefault(); this.save(); });
    on($('#reminder-delete'), 'click', () => this.delete());
    // Recurrence change → toggle the custom panel.
    on($('#reminder-recurrence'), 'change', () => this.syncCustomPanel());
    // Custom unit change → only "week" exposes the day-of-week chips.
    on($('#reminder-custom-unit'), 'change', () => this.syncCustomPanel());
    // Icon picker: same emoji-input pattern as the Events modal — typing into
    // the text field is allowed; the browse button opens the EmojiPicker
    // which writes back the chosen glyph.
    on($('#reminder-icon-browse'), 'click', (e) => {
      e.stopPropagation();
      EmojiPicker.open($('#reminder-icon'), $('#reminder-icon-browse'));
    });
  },
  syncCustomPanel() {
    const rec = $('#reminder-recurrence')?.value;
    const panel = $('#reminder-custom');
    const dows = $('#reminder-custom-days');
    if (!panel || !dows) return;
    panel.hidden = rec !== 'custom';
    dows.hidden  = !(rec === 'custom' && $('#reminder-custom-unit')?.value === 'week');
  },
  open(editId = null) {
    if (!Auth.isAdmin()) return;
    this.editId = editId;
    const f = $('#reminder-form'); f.reset();
    $('#reminder-modal-title').textContent = editId ? 'Edit reminder' : 'New calendar reminder';
    $('#reminder-delete').hidden = !editId;
    if (editId) {
      const r = (Store.state.reminders || []).find(x => x.id === editId);
      if (r) {
        f.title.value = r.title || '';
        f.startDate.value = r.startDate || '';
        f.recurrence.value = r.recurrence || 'none';
        f.color.value = r.color || 'amber';
        f.notes.value = r.notes || '';
        $('#reminder-hide-dashboard').checked = !!r.hideFromDashboard;
        $('#reminder-icon').value = r.icon || '🔔';
        // Custom recurrence fields: only restored when the saved value is 'custom'.
        if (r.recurrence === 'custom') {
          if (f.customInterval) f.customInterval.value = r.customInterval || 1;
          if (f.customUnit)     f.customUnit.value     = r.customUnit || 'day';
          const days = Array.isArray(r.customDays) ? r.customDays.map(String) : [];
          $$('#reminder-custom-days input[name="customDays"]').forEach(cb => {
            cb.checked = days.includes(cb.value);
          });
        }
      }
    } else {
      f.startDate.value = toIsoDate(new Date());
      f.recurrence.value = 'none';
      f.color.value = 'amber';
      if (f.customInterval) f.customInterval.value = 1;
      if (f.customUnit)     f.customUnit.value     = 'day';
      $('#reminder-hide-dashboard').checked = false;
      $('#reminder-icon').value = '🔔';
    }
    this.syncCustomPanel();
    $('#reminder-modal').setAttribute('aria-hidden', 'false');
    setTimeout(() => f.title.focus(), 30);
  },
  close() { $('#reminder-modal').setAttribute('aria-hidden', 'true'); this.editId = null; },
  save() {
    const f = $('#reminder-form');
    const fd = new FormData(f);
    const title = (fd.get('title') || '').toString().trim();
    if (!title) { toast('Give your reminder a title.', 'warn'); return; }
    const recurrence = (fd.get('recurrence') || 'none').toString();
    const data = {
      title,
      startDate: (fd.get('startDate') || '').toString(),
      recurrence,
      color: (fd.get('color') || 'amber').toString(),
      notes: (fd.get('notes') || '').toString().trim(),
      icon: ((fd.get('icon') || '🔔').toString().trim() || '🔔'),
      hideFromDashboard: !!fd.get('hideFromDashboard'),
    };
    // Custom recurrence: capture interval + unit, and the day-of-week selection
    // only when the unit is "week" (Google Calendar parity).
    if (recurrence === 'custom') {
      data.customInterval = Math.max(1, parseInt(fd.get('customInterval'), 10) || 1);
      data.customUnit     = (fd.get('customUnit') || 'day').toString();
      if (data.customUnit === 'week') {
        data.customDays = fd.getAll('customDays').map(v => parseInt(v, 10)).filter(n => !isNaN(n));
      } else {
        data.customDays = [];
      }
    }
    Store.state.reminders ||= [];
    if (this.editId) {
      const r = Store.state.reminders.find(x => x.id === this.editId);
      if (r) Object.assign(r, data);
    } else {
      Store.state.reminders.push({ id: uid('rem'), ...data });
    }
    Store.save();
    this.close();
    if (Views.current === 'calendar') CalendarView.render();
    if (Views.current === 'dashboard') DashboardView.render();
    toast(this.editId ? 'Reminder updated.' : 'Reminder added.');
  },
  delete() {
    if (!this.editId) return;
    if (!confirm('Delete this reminder?')) return;
    Store.state.reminders = (Store.state.reminders || []).filter(x => x.id !== this.editId);
    Store.save();
    this.close();
    if (Views.current === 'calendar') CalendarView.render();
    if (Views.current === 'dashboard') DashboardView.render();
    toast('Reminder deleted.');
  },
};

// -------------------- DASHBOARD VIEW (admin only) --------------------
// Landing page for admins. Pulls together:
//   • Las Vegas clock + current weather (Open-Meteo, no API key required)
//   • Upcoming birthdays / anniversaries / events / reminders in the next 30 days
//   • Quick gift tracker — checkbox-style purchased/sent flags on existing gifts
//   • Shared grocery list (realtime via the same Supabase channel as everything else)
const DashboardView = {
  clockTimer: null,
  weatherFetchedAt: 0,
  weatherCache: null,
  upcomingFilter: 'all',     // 'all' | 'birthday' | 'anniversary' | 'event' | 'holiday' | 'reminder'

  init() {
    on($('#dash-grocery-form'), 'submit', (e) => { e.preventDefault(); this.addGroceryItem(); });
    on($('#dash-add-gift'), 'click', () => {
      Views.show('gifts');
      // Open the gift modal directly so it feels like a one-click action.
      setTimeout(() => GiftsView.openModal && GiftsView.openModal(null, {}), 60);
    });
    on($('#dash-upcoming-filters'), 'click', (e) => {
      const b = e.target.closest('.dash-filter-chip'); if (!b) return;
      this.upcomingFilter = b.dataset.kind;
      $$('#dash-upcoming-filters .dash-filter-chip').forEach(c => c.classList.toggle('is-active', c === b));
      this.renderUpcoming();
    });
  },

  render() {
    this.renderClock();
    if (!this.clockTimer) {
      this.clockTimer = setInterval(() => this.renderClock(), 1000 * 30); // 30s is plenty for HH:MM display
    }
    this.refreshWeather();
    this.renderUpcoming();
    this.renderMonthTotals();
    this.renderGifts();
    this.renderGrocery();
    this.renderGreeting();
    // v4.53: family summary digest sits below the daily panels. No date
    // controls — NewsletterView.render() picks last-90-days defaults via
    // ensureDefaults() when no UI inputs are present.
    NewsletterView.render();
  },

  renderMonthTotals() {
    const now = new Date();
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthName = now.toLocaleString(undefined, { month: 'long', year: 'numeric' });
    $('#dash-month-title').textContent = `${monthName} gifts`;
    let received = 0, given = 0;
    (Store.state.gifts || []).forEach(g => {
      if (!g.date || !g.date.startsWith(ym)) return;
      const amt = Number(g.amount) || 0;
      if (g.direction === 'received') received += amt;
      else if (g.direction === 'given') given += amt;
    });
    const fmt = (n) => `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    $('#dash-month-received').textContent = fmt(received);
    $('#dash-month-given').textContent    = fmt(given);
    const net = received - given;
    $('#dash-month-net').textContent      = (net >= 0 ? '+' : '−') + fmt(Math.abs(net));
  },

  renderGreeting() {
    const h = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false });
    const hour = parseInt(h, 10);
    let greeting = 'Hello';
    if (!isNaN(hour)) {
      if (hour < 12) greeting = 'Good morning';
      else if (hour < 18) greeting = 'Good afternoon';
      else greeting = 'Good evening';
    }
    const name = (Auth.current && Auth.current !== 'admin-bootstrap') ? Auth.current.firstName : '';
    $('#dash-greeting').textContent = name ? `${greeting}, ${name}` : greeting;
  },

  renderClock() {
    const timeEl = $('#dash-time');
    // The dashboard may have been navigated away from between ticks; if its
    // nodes are gone, stop the interval instead of throwing on a null.
    if (!timeEl) { this.stopClock(); return; }
    const tz = 'America/Los_Angeles';
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const dateEl = $('#dash-date');
    if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }) + ' · Las Vegas, NV';
  },

  // Stop the 30s clock interval when the dashboard is not on screen, so it
  // doesn't keep firing (and re-querying absent nodes) forever.
  stopClock() {
    if (this.clockTimer) { clearInterval(this.clockTimer); this.clockTimer = null; }
  },

  // Open-Meteo: free, no API key. 5-day daily forecast for Las Vegas.
  // Refreshes at most every 30 minutes — the API returns daily highs/lows
  // which don't move minute-to-minute.
  async refreshWeather() {
    const FRESH_MS = 30 * 60 * 1000;
    if (this.weatherCache && Date.now() - this.weatherFetchedAt < FRESH_MS) {
      this.paintWeather(this.weatherCache);
      return;
    }
    try {
      const url = 'https://api.open-meteo.com/v1/forecast?latitude=36.1716&longitude=-115.1391&daily=temperature_2m_max,temperature_2m_min,weather_code&temperature_unit=fahrenheit&timezone=America%2FLos_Angeles&forecast_days=5';
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const d = j.daily || {};
      const days = (d.time || []).map((iso, i) => ({
        iso,
        high: d.temperature_2m_max?.[i],
        low:  d.temperature_2m_min?.[i],
        code: d.weather_code?.[i],
      }));
      this.weatherCache = { days };
      this.weatherFetchedAt = Date.now();
      this.paintWeather(this.weatherCache);
    } catch (e) {
      const el = $('#dash-forecast');
      if (el) el.innerHTML = '<div class="dash-forecast-loading muted small">forecast unavailable</div>';
    }
  },

  paintWeather({ days }) {
    const el = $('#dash-forecast'); if (!el || !days?.length) return;
    // WMO weather codes → emoji + label. Compact mapping for common cases.
    const map = {
      0:  ['☀', 'Clear sky'],
      1:  ['🌤', 'Mainly clear'],
      2:  ['⛅', 'Partly cloudy'],
      3:  ['☁', 'Overcast'],
      45: ['🌫', 'Fog'],
      48: ['🌫', 'Rime fog'],
      51: ['🌦', 'Light drizzle'],
      53: ['🌦', 'Drizzle'],
      55: ['🌧', 'Heavy drizzle'],
      61: ['🌧', 'Light rain'],
      63: ['🌧', 'Rain'],
      65: ['🌧', 'Heavy rain'],
      71: ['🌨', 'Light snow'],
      73: ['🌨', 'Snow'],
      75: ['❄', 'Heavy snow'],
      80: ['🌦', 'Rain showers'],
      81: ['🌧', 'Rain showers'],
      82: ['⛈', 'Violent showers'],
      95: ['⛈', 'Thunderstorm'],
      96: ['⛈', 'Thunder + hail'],
      99: ['⛈', 'Heavy thunder'],
    };
    el.innerHTML = days.slice(0, 5).map((day, i) => {
      const [icon, desc] = map[day.code] || ['🌡', ''];
      // Parse the iso date in local time (noon avoids DST edge cases).
      const date  = new Date(day.iso + 'T12:00:00');
      const label = i === 0 ? 'Today'
                  : date.toLocaleDateString('en-US', { weekday: 'short' });
      const hi = day.high != null ? `${Math.round(day.high)}°` : '—';
      const lo = day.low  != null ? `${Math.round(day.low)}°`  : '—';
      return `<div class="dash-forecast-day" title="${escape(desc)}">
        <div class="dash-forecast-label">${escape(label)}</div>
        <div class="dash-forecast-icon">${icon}</div>
        <div class="dash-forecast-temps">
          <span class="dash-forecast-hi">${hi}</span>
          <span class="dash-forecast-sep">/</span>
          <span class="dash-forecast-lo">${lo}</span>
        </div>
      </div>`;
    }).join('');
  },

  renderUpcoming() {
    const host = $('#dash-upcoming-list'); if (!host) return;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const horizon = new Date(today); horizon.setDate(horizon.getDate() + 60);
    const items = [];

    // US holidays — same source the Calendar uses. Pull this year and next
    // since the 60-day window can straddle a year boundary.
    [...usHolidaysForYear(today.getFullYear()), ...usHolidaysForYear(today.getFullYear() + 1)].forEach(h => {
      const d = new Date(h.date + 'T00:00:00');
      if (d < today || d > horizon) return;
      items.push({
        date: d, sort: d.getTime(), kind: 'holiday',
        title: h.name, sub: 'US holiday', icon: '🇺🇸',
        onClick: () => Views.show('calendar'),
      });
    });

    // Birthdays — annual recurrence on MM-DD
    Store.membersList().forEach(m => {
      if (!m.birthday || m.birthday.length < 10) return;
      const md = m.birthday.slice(5, 10);
      const occ = nextOccurrenceInWindow(today, horizon, md);
      if (!occ) return;
      const birthYear = parseInt(m.birthday.slice(0, 4), 10);
      const turning = Number.isFinite(birthYear) ? (occ.getFullYear() - birthYear) : null;
      items.push({
        date: occ, sort: occ.getTime(), kind: 'birthday',
        title: `${displayName(m)}'s birthday`,
        sub: turning != null && turning >= 0 ? `Turns ${turning}` : '',
        icon: '🎂',
        onClick: () => Drawer.open(m.id),
      });
    });
    // Anniversaries
    const seenPair = new Set();
    Store.membersList().forEach(m => {
      if (!m.spouseId) return;
      const sp = Store.byId(m.spouseId); if (!sp) return;
      const key = [m.id, sp.id].sort().join('|');
      if (seenPair.has(key)) return;
      seenPair.add(key);
      const aniso = m.anniversary || sp.anniversary;
      if (!aniso || aniso.length < 10) return;
      const md = aniso.slice(5, 10);
      const occ = nextOccurrenceInWindow(today, horizon, md);
      if (!occ) return;
      const aYear = parseInt(aniso.slice(0, 4), 10);
      const nth = Number.isFinite(aYear) ? (occ.getFullYear() - aYear) : null;
      const a = m.id < sp.id ? m : sp, b = m.id < sp.id ? sp : m;
      items.push({
        date: occ, sort: occ.getTime(), kind: 'anniversary',
        title: `${a.firstName} & ${b.firstName} anniversary`,
        sub: nth != null && nth > 0 ? `${nth}${nthSuffix(nth)} year` : '',
        icon: '💍',
        onClick: () => Drawer.open(a.id),
      });
    });
    // Events — also compute per-event gift totals (received - given) so the
    // row can show "+$X" or "−$X" next to each event.
    const fmtMoney = (n) => `$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const giftsByEvent = new Map();
    (Store.state.gifts || []).forEach(g => {
      if (!g.eventId) return;
      const cur = giftsByEvent.get(g.eventId) || { received: 0, given: 0 };
      const amt = Number(g.amount) || 0;
      if (g.direction === 'received') cur.received += amt;
      else if (g.direction === 'given') cur.given += amt;
      giftsByEvent.set(g.eventId, cur);
    });
    (Store.state.events || []).forEach(ev => {
      if (!ev.date) return;
      const d = new Date(ev.date + 'T00:00:00');
      if (d < today || d > horizon) return;
      const tot = giftsByEvent.get(ev.id);
      let extra = '';
      if (tot && (tot.received || tot.given)) {
        const net = tot.received - tot.given;
        const sign = net >= 0 ? '+' : '−';
        extra = ` · Gifts ${sign}${fmtMoney(net)} (in ${fmtMoney(tot.received)}, out ${fmtMoney(tot.given)})`;
      }
      items.push({
        date: d, sort: d.getTime(), kind: 'event',
        title: ev.name,
        sub: (ev.location || '') + extra,
        icon: ev.icon || '🎉',
        onClick: () => { EventsView.selectedId = ev.id; Views.show('events'); },
      });
    });
    // Reminders — expand each recurring rule into occurrences in the window.
    // Reminders marked hideFromDashboard never enter the upcoming list (they
    // still render on the Calendar). Keeps low-signal recurring chores like
    // trash day out of the Dashboard hero feed.
    (Store.state.reminders || []).forEach(r => {
      if (r.hideFromDashboard) return;
      const occs = expandReminder(r, today, horizon);
      occs.forEach(d => items.push({
        date: d, sort: d.getTime(), kind: 'reminder',
        title: r.title, sub: r.recurrence === 'none' ? '' : `Repeats ${reminderRecurrenceLabel(r)}`, icon: r.icon || '🔔',
        onClick: () => { Views.show('calendar'); setTimeout(() => RemindersModal.open(r.id), 60); },
      }));
    });

    items.sort((a, b) => a.sort - b.sort);
    const filtered = this.upcomingFilter === 'all'
      ? items
      : items.filter(it => it.kind === this.upcomingFilter);
    if (!filtered.length) {
      host.innerHTML = this.upcomingFilter === 'all'
        ? '<p class="muted small" style="margin:0;">Nothing in the next 60 days. Quiet stretch.</p>'
        : `<p class="muted small" style="margin:0;">No ${this.upcomingFilter}s in the next 60 days.</p>`;
      return;
    }
    // Rows for items happening today get a light-yellow accent so they
    // pop out of the upcoming list. Date comparison uses LA timezone-ish
    // via toIsoDate so a midnight rollover in the user's locale doesn't
    // flicker the highlight on/off.
    const todayIso = toIsoDate(today);
    host.innerHTML = filtered.map((it, i) => {
      const isToday = toIsoDate(it.date) === todayIso;
      return `
      <button type="button" class="dash-up-row${isToday ? ' is-today' : ''}" data-i="${i}">
        <div class="dash-up-date">
          <span class="dash-up-day">${it.date.getDate()}</span>
          <span class="dash-up-mon">${it.date.toLocaleString(undefined, { month: 'short' })}</span>
        </div>
        <div class="dash-up-icon">${escape(it.icon)}</div>
        <div class="dash-up-main">
          <div class="dash-up-title">${escape(it.title)}</div>
          ${it.sub ? `<div class="dash-up-sub">${escape(it.sub)}</div>` : ''}
        </div>
        <div class="dash-up-kind dash-up-kind-${it.kind}">${it.kind}</div>
      </button>
    `;}).join('');
    host.querySelectorAll('.dash-up-row').forEach((b, i) => on(b, 'click', () => filtered[i].onClick && filtered[i].onClick()));
  },

  renderGifts() {
    const host = $('#dash-gifts-list'); if (!host) return;
    // Tracker only shows gifts WE are giving and that aren't fully done.
    // Gifts received (direction='received') are records of stuff people gave
    // us — there's nothing to purchase or send, so they don't belong here.
    const all = (Store.state.gifts || []).filter(g =>
      g.direction === 'given' && !(g.purchased && g.sent)
    );
    all.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const top = all.slice(0, 8);
    if (!top.length) {
      host.innerHTML = '<p class="muted small" style="margin:0;">No gifts to track. Click "Log a gift" and pick "Given" to start tracking purchase &amp; send status.</p>';
      return;
    }
    const memberName = (id) => { const m = id ? Store.byId(id) : null; return m ? displayName(m) : ''; };
    host.innerHTML = top.map(g => {
      const to = memberName(g.toMemberId) || g.toText || '—';
      const from = (g.fromMemberIds || []).map(memberName).filter(Boolean).join(', ') || g.fromText || '';
      const item = g.item || g.occasion || '';
      const amt = g.amount != null ? `$${Number(g.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
      return `
        <div class="dash-gift-row" data-id="${g.id}">
          <div class="dash-gift-main">
            <div class="dash-gift-title">${escape(item || 'Gift')} <span class="muted small">→ ${escape(to)}</span></div>
            <div class="dash-gift-sub">${from ? `From ${escape(from)} · ` : ''}${g.date ? escape(formatDate(g.date)) : ''}${amt ? ' · ' + escape(amt) : ''}</div>
          </div>
          <div class="dash-gift-flags">
            <label class="dash-gift-flag"><input type="checkbox" data-flag="purchased" ${g.purchased ? 'checked' : ''}/><span>Purchased</span></label>
            <label class="dash-gift-flag"><input type="checkbox" data-flag="sent" ${g.sent ? 'checked' : ''}/><span>Sent</span></label>
          </div>
        </div>`;
    }).join('');
    host.querySelectorAll('.dash-gift-row').forEach(row => {
      row.querySelectorAll('input[type="checkbox"]').forEach(cb => on(cb, 'change', () => {
        const g = (Store.state.gifts || []).find(x => x.id === row.dataset.id); if (!g) return;
        g[cb.dataset.flag] = cb.checked;
        Store.save();
        this.renderGifts();
      }));
    });
  },

  renderGrocery() {
    const host = $('#dash-grocery-list'); if (!host) return;
    const list = Store.state.grocery || [];
    if (!list.length) {
      host.innerHTML = '<li class="muted small" style="padding:8px 4px;">List is empty. Add something above.</li>';
      return;
    }
    // Sort: open items first (newest at top), then done items.
    const open = list.filter(i => !i.done).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const done = list.filter(i => i.done).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const renderItem = (i) => `
      <li class="dash-grocery-item ${i.done ? 'is-done' : ''}" data-id="${i.id}">
        <label class="dash-grocery-check">
          <input type="checkbox" ${i.done ? 'checked' : ''}/>
          <span>${escape(i.text)}</span>
        </label>
        <button type="button" class="dash-grocery-del" title="Remove" aria-label="Remove">×</button>
      </li>`;
    host.innerHTML = open.map(renderItem).join('') + done.map(renderItem).join('');
    host.querySelectorAll('.dash-grocery-item').forEach(li => {
      const cb = li.querySelector('input[type="checkbox"]');
      const del = li.querySelector('.dash-grocery-del');
      on(cb, 'change', () => {
        const item = (Store.state.grocery || []).find(x => x.id === li.dataset.id); if (!item) return;
        item.done = cb.checked;
        Store.save();
        this.renderGrocery();
      });
      on(del, 'click', () => {
        Store.state.grocery = (Store.state.grocery || []).filter(x => x.id !== li.dataset.id);
        Store.save();
        this.renderGrocery();
      });
    });
  },

  addGroceryItem() {
    const input = $('#dash-grocery-input');
    const text = (input.value || '').trim();
    if (!text) return;
    Store.state.grocery ||= [];
    Store.state.grocery.unshift({ id: uid('g'), text, done: false, ts: Date.now() });
    Store.save();
    input.value = '';
    input.focus();
    this.renderGrocery();
  },
};

// Find the next occurrence of an annual MM-DD between today and horizon.
// Returns a Date (inclusive on both ends) or null.
function nextOccurrenceInWindow(today, horizon, md) {
  const [mm, dd] = md.split('-').map(n => parseInt(n, 10));
  if (!mm || !dd) return null;
  for (let y = today.getFullYear(); y <= horizon.getFullYear() + 1; y++) {
    const candidate = new Date(y, mm - 1, dd);
    candidate.setHours(0, 0, 0, 0);
    if (candidate < today) continue;
    if (candidate > horizon) return null;
    return candidate;
  }
  return null;
}

// Expand a reminder into Date objects whose iso falls between [today, horizon].
function expandReminder(r, today, horizon) {
  const out = [];
  if (!r || !r.startDate) return out;
  const start = new Date(r.startDate + 'T00:00:00');
  if (start > horizon) return out;
  // Walk days in the window — caps at 31 iterations so this stays cheap.
  for (let d = new Date(Math.max(today.getTime(), start.getTime())); d <= horizon; d.setDate(d.getDate() + 1)) {
    const iso = toIsoDate(d);
    if (reminderOccursOn(r, iso)) out.push(new Date(d));
  }
  return out;
}



// -------------------- HISTORY VIEW (admin only) --------------------
// Hand-maintained changelog of meaningful shipped changes. Bumped each time a
// new batch lands. Major version for big features / data-model changes;
// minor (decimal) for tweaks and fixes. Inlined here (instead of fetched
// from changelog.json) so deploys with caching weirdness still show the
// current version chip.
const CHANGELOG = [
  {
    version: '4.65',
    date: '2026-06-23',
    title: 'React to comments with emojis',
    changes: [
      'You can now react to individual comments on a Memories post — tap the “☺ +” button under a comment to pick an emoji, or tap an existing reaction to add/remove yours. Counts and who-reacted (on hover) work just like post reactions.',
    ],
  },
  {
    version: '4.64',
    date: '2026-06-23',
    title: 'Memories: who posted & who reacted · Recipes now family-only',
    changes: [
      'Memory posts now show who posted them (the author’s name next to the date).',
      'Reactions now show who reacted — each post lists the names under the emoji (e.g. “❤️ Mom, Dad · 🎉 Ted”), and hovering a reaction chip shows the same.',
      'The Recipes tab is now visible to Family and Admins only (previously any signed-in account could see it), matching how the Calendar tab is gated.',
    ],
  },
  {
    version: '4.63',
    date: '2026-06-22',
    title: 'Drag & drop photos into new posts too',
    changes: [
      'The “New post” composer now has the same drag-and-drop photo upload as albums — drag image files onto the “Drag photos here” zone (or click to choose). Up to 6 photos per post; non-image files are skipped.',
    ],
  },
  {
    version: '4.62',
    date: '2026-06-22',
    title: 'Drag & drop photos into albums',
    changes: [
      'Adding photos to an album now supports drag and drop: open an album and drag image files onto the “Drag photos here” zone (or click it to pick files, same as before). The upload progress bar shows while they save, and non-image files are skipped automatically.',
    ],
  },
  {
    version: '4.61',
    date: '2026-06-22',
    title: 'Albums gallery — uniform square covers',
    changes: [
      'The Albums gallery is now a clean grid of equal, square album covers — with a “Create album” tile up front and the photo count under each — instead of one large banner across the top. Covers no longer get awkwardly cropped, and more albums fit on screen at once.',
    ],
  },
  {
    version: '4.60',
    date: '2026-06-22',
    title: 'Albums polish — pick a cover, upload progress, smaller banner',
    changes: [
      'You can now choose an album’s cover photo: open an album and click “Set as cover” on any photo (the current cover shows a ★ Cover badge). That photo becomes the album’s showcase tile on the Albums gallery.',
      'Adding photos to an album now shows a live progress bar (“Uploading 3 of 5…”) so you can see the upload working instead of wondering whether anything happened.',
      'The album cover banner on the gallery is smaller — it no longer fills the screen, so more albums are visible at a glance.',
    ],
  },
  {
    version: '4.59',
    date: '2026-06-22',
    title: 'Memories + Albums combined into one page',
    changes: [
      'Memories and Albums now live under a single “Memories” tab with two sub-tabs — “Posts” (the feed) and “Albums” (the gallery) — instead of two separate top-level tabs. Same features, one less tab in the bar; the “+ New post” / “+ New album” button swaps to match whichever sub-tab you’re on.',
    ],
  },
  {
    version: '4.58',
    date: '2026-06-22',
    title: 'Albums + Memories opened to everyone',
    changes: [
      'New “Albums” tab: photo collections anyone signed in can create. Each album is owned by its creator — the owner (and admins) add photos, edit, and delete; everyone else can browse and comment. The gallery shows the newest album as a banner with the rest in a cover grid; opening one shows a photo grid with the same tap-to-enlarge lightbox the rest of the app uses. Comments are open on each album and on individual photos.',
      'Memories is now an open feed: anyone signed in can create posts, upload photos, react, and comment — previously only admins could post. You can edit and delete your own posts and comments; admins can still manage any.',
      'Under the hood: posts, albums, photos, reactions, and comments moved out of the single shared archive record into dedicated tables with per-person permissions, so many people can contribute at once without overwriting each other — and the family-tree data stays admin-only and protected. Photo uploads to the family-photos store are now open to any signed-in user (you can remove your own; admins can remove any). Existing Memories posts were migrated over without loss.',
    ],
  },
  {
    version: '4.57',
    date: '2026-06-13',
    title: 'Vault: Blood type always visible on Family cards',
    changes: [
      'The 🩸 Blood type row now shows on every member’s Vault > Family card, displaying “—” when it hasn’t been set yet, so it’s discoverable instead of hidden. (It was already editable via Edit → Health & legacy since v4.49 — it just stayed hidden until a value was entered.) Set a value the same way: open a member → Edit → 🩸 Health & legacy → Blood type.',
      'Side effect: the Health & legacy section header now appears on every Family card (previously hidden until some health field was filled). Allergies, medications, emergency contact, and primary doctor still only appear once they have a value.',
    ],
  },
  {
    version: '4.56',
    date: '2026-06-13',
    title: 'Refresh + Harden — re-unify the design, add depth, fix correctness & security landmines',
    changes: [
      'Visual re-unification: the indigo that had crept onto the newer pages (Recipes, Memories, My Kids, Stories, Documents — 26 occurrences) plus a stray blue on the 529-plan chips are gone, all replaced with the forest-green + copper brand. The app no longer looks like two products stitched together.',
      'Depth + tactility: panels, tree cards, and vault cards now sit on a real elevation ladder (forest-tinted shadows + a pressed-paper top highlight) instead of flat outlines. Buttons lift on hover and press down on click.',
      'Editorial typography: Fraunces optical sizing is now enabled (the font axis was already downloaded but unused), and each page gets one larger display masthead.',
      'Data surfaces: the Members table finally has a tinted sticky header, quiet zebra striping, and a green row-hover with a copper edge; the Calendar gets weekend-column tinting on top of the existing today marker and colored chips.',
      'Accessibility: added a global reduced-motion guard (animations were previously unconditional) and a keyboard focus-ring fallback across nav tabs, icon buttons, and chips.',
      'Correctness: failure toasts now actually look like failures (the severity argument was ignored at 57 call sites, so a failed save looked identical to a success); the Time Capsule and Documents lists no longer blank out on a single bad date; media-upload modals can no longer get permanently wedged; event-attendee edits are keyed to a stable id instead of array position; and a runaway dashboard clock timer is cleared on navigation.',
      'Security: the rich-text link sanitizer switched from a javascript:-only blocklist to a strict https/mailto/tel allowlist (closing vbscript:, data:, and tab-obfuscated bypasses); every photo background-image and every user-entered link (529, Google Drive, website, recipe/capsule/kid links) is now scheme-validated; and a Content-Security-Policy was added, with the public Supabase config moved into config.js so the policy can forbid inline scripts.',
      'Deferred (written, not yet applied): a Supabase migration under supabase/migrations/ that splits the private Vault into an admin-only table — today the Vault is technically readable by any signed-in account. It ships with a README describing the paired app change.',
      'CPU/memory: the visual work is almost entirely CSS tokens (no new render work) and the hardening adds only small per-render string helpers. Zero new SQL or realtime channels.',
    ],
  },
  {
    version: '4.55',
    date: '2026-05-15',
    title: 'My Kids — bigger photos, reactions & comments',
    changes: [
      'My Kids entries show larger photos and gained reactions + comments.',
      'Removed the "+ Add Member" button from the top bar.',
      '(Backfilled into this changelog in v4.56 — this release shipped before its History entry was written.)',
    ],
  },
  {
    version: '4.54',
    date: '2026-05-15',
    title: 'Family Tree — member ages visible to the User role',
    changes: [
      'The User role can now see member ages on the Family Tree cards.',
      '(Backfilled into this changelog in v4.56.)',
    ],
  },
  {
    version: '4.53',
    date: '2026-05-15',
    title: 'Dashboard regains its day-to-day panels',
    changes: [
      'Dashboard got its day-to-day panels back (clock/weather, upcoming dates, gift totals, gift tracker, grocery list), with the family summary digest tucked underneath — without the date/print controls.',
      '(Backfilled into this changelog in v4.56.)',
    ],
  },
  {
    version: '4.52',
    date: '2026-05-15',
    title: 'Hide the standalone Time Capsule nav tab',
    changes: [
      'The standalone Time Capsule nav tab is hidden — capsules now live under My Kids.',
      '(Backfilled into this changelog in v4.56.)',
    ],
  },
  {
    version: '4.51',
    date: '2026-05-15',
    title: 'Dashboard + Newsletter merge · Time Capsule moves under My Kids · Stories hidden',
    changes: [
      'Dashboard now IS the family newsletter. The previous Dashboard panels (clock/weather, upcoming-60-days chips, monthly gift totals, gift tracker, grocery list) have been replaced by the live newsletter digest — same date controls, same 🖨️ Print / 📋 Copy as email / 📧 Copy family emails actions, same compile pipeline. The standalone "Newsletter" nav tab is gone; everything lives on Dashboard.',
      'My Kids → new fifth tab per kid: "Time Capsule." Shows every capsule whose recipient is that kid, split into Opened / Sealed groupings (same envelope cards as the global Time Capsule page). The "+ Add capsule" button pre-selects the kid as recipient. Non-admins (the kid themselves) see only their unlocked capsules; admins see everything plus Reveal Early / Edit / Delete controls. The global Time Capsule page still exists for capsules addressed to non-kid people.',
      'Stories nav tab is hidden. The Stories view, data, and module remain — flipping a single attribute brings it back when needed.',
      'Nav reorder: Memories now sits between My Family and My Kids (previously after Recipes).',
      'Dead code: removed two unused dashboard-only helpers (nextOccurrenceInWindow + expandReminder) and ~350 lines of dashboard panel rendering. CalendarView keeps its own reminder logic via reminderOccursOn (still used).',
      'CPU/memory: zero new SQL or realtime channels. Per-kid Time Capsule tab is a read-side filter over the same state.timeCapsules array. Newsletter compile is the same in-memory walk.',
    ],
  },
  {
    version: '4.50',
    date: '2026-05-15',
    title: 'Family Newsletter (Wave 6 — final wave of the family-portal expansion)',
    changes: [
      'New "Newsletter" admin-only top-level nav tab. Compiles a date-bounded HTML digest from every other family-portal data source: upcoming birthdays + anniversaries (next 30 days from the "to" date), recent My Kids entries, recent Memories Wall posts, new recipes, new stories, and time capsules that opened in the range.',
      'Date range defaults to the last 90 days through today. Admin can edit From/To/Greeting on the fly and click Refresh preview.',
      'Three output paths: 🖨️ Print / Save as PDF (uses window.print() — modern OS print dialogs include "Save as PDF" as a destination so zero extra deps), 📋 Copy as email (plain-text version on the clipboard ready to paste into Gmail/Apple Mail), 📧 Copy family emails (every member + friend email comma-joined for the To: line in one click).',
      'Print-only CSS hides the toolbar/nav/chrome and lets the preview fill the page. Photos pre-resolve their signed URLs before render so the printed PDF actually includes the images.',
      'CPU/memory: pure read-side work. Zero new SQL or realtime channels. The compiler iterates the in-memory archive once and renders inline.',
    ],
  },
  {
    version: '4.49',
    date: '2026-05-15',
    title: 'Admin: Documents drawer + Health & Legacy locker (Wave 5)',
    changes: [
      'New "Documents" tab on the Admin/vault page (peer to Family / Finance / Benefits / Home). Admin-only end-to-end: family-documents Storage bucket from Wave 1 already has admin-only RLS on insert / select / delete.',
      'Each document: title (required), free-text category with auto-suggest from previously used values, optional member tag (or household-level), optional notes, and a file (PDF / images / Word / text). 25 MB cap matches the Wave 1 bucket file_size_limit.',
      'Documents list with member filter, category filter, and live search. Click "Open" — images render in the existing lightbox; PDFs and other formats open in a new tab via a signed URL.',
      'New Health & Legacy locker subsection inside each member\'s Family-tab card. Fields: blood type (select), allergies, medications, emergency contact (name + phone + relationship), primary doctor (name + practice + phone). Renders in the read view + the existing edit form; save handler updated to preserve the new fields.',
      'Phones in the health locker (emergency contact, doctor) format to (XXX) XXX-XXXX on save, matching the rest of the app.',
      'CPU/memory: zero new SQL or realtime channels. Documents live in state.documents as a flat list of refs; binaries are in Storage. Health fields are a nested object on each member\'s existing m.private record — negligible row growth.',
    ],
  },
  {
    version: '4.48',
    date: '2026-05-15',
    title: 'Voice / Video Stories (Wave 4b of family-portal expansion)',
    changes: [
      'New "Stories" top-level nav tab. Admin authors stories; everyone authenticated plays.',
      'Four source modes in the editor (pills switch between them): 🎤 Record audio in-browser via MediaRecorder, 📁 Upload audio, 🎬 Upload video, 🔗 Embed link (YouTube/Vimeo auto-detected).',
      'Recording: 5-minute cap (auto-stops at 5:00). Microphone permission requested the first time. Recorded blob preview lets you re-listen before saving. Upload bucket: family-audio.',
      'Upload audio cap: 20 MB. Upload video cap: 100 MB. Bucket caps from Wave 1.',
      'Embed URLs: YouTube short links (youtu.be), full watch URLs, embed URLs, and Shorts all parse to the same YouTube embed iframe. Vimeo too. Generic URLs render as a "▶ Watch on external site" button — we don\'t iframe arbitrary domains (XSS surface).',
      'Each story has: title, optional description, optional recorded date, multi-tag of people (members + friend household persons), kind (audio/video), source (upload/embed), durationSec (auto-captured from MediaRecorder + file metadata).',
      'Card grid: thumbnail + kind emoji + duration badge + title + tags. Click → opens player modal with the inline player (audio/video element for uploads, iframe for embeds, external link for generic).',
      'CPU/memory: zero new SQL or realtime channels. Media binaries stay in Storage; the JSONB row only carries { bucket, path, mimeType } refs or { embedUrl, embedKind, embedId } embed metadata. Both shapes are small.',
    ],
  },
  {
    version: '4.47',
    date: '2026-05-15',
    title: 'Time Capsule (Wave 4a of family-portal expansion)',
    changes: [
      'New "Time Capsule" top-level nav tab. Admin writes letters addressed to one family member or friend household person, sealed until an unlock date.',
      'Capsule shape: recipient (m:/f:/s:/k: ref) + unlock date + optional title + rich-text letter body + optional single photo + optional link. Author + sealed-on stamps auto-recorded.',
      'Two sections on the page: Opened (full content, click photo for lightbox, link chip below body) and Sealed (envelope-card preview showing only the unlock date + an optional title — body never renders until unlock).',
      'Lock check: capsule is locked when today\'s local date is before unlockDate. Once today catches up to the unlock date, the body becomes visible to the recipient automatically.',
      'Admin override: an admin sees a "Reveal early" button on any sealed capsule. Clicking stamps the capsule with revealedBy = admin user id and immediately makes it visible. The opened card displays an "(early reveal)" tag so the recipient knows the unlock wasn\'t strict.',
      'Permission: admin sees all capsules (locked + unlocked). A linked recipient sees only their own capsules; sealed ones show as a generic envelope (no "To: name" line for them — it\'s their letter). Non-admin, non-recipient viewers route back to Family Tree.',
      'CPU/memory: zero new SQL or realtime channels. Each capsule lives as one row in state.timeCapsules on the JSONB blob; only photo { bucket, path } refs live there. Photo binaries stay in the family-photos Storage bucket from Wave 1.',
    ],
  },
  {
    version: '4.46',
    date: '2026-05-15',
    title: 'Recipes + Memories polish — categories, bigger photos, reactions, comments',
    changes: [
      'Recipes detail: hero photo shrunk from 480px → 320px max so it doesn\'t dominate the page. Click-to-lightbox still works for the full-size view.',
      'Recipes grid: new category tab strip above the search box. "All" tab is always first; each unique category in your saved recipes becomes its own tab with a count chip. Click a tab → grid filters down. Modal Category field stays a free-text input (with datalist auto-suggest) so adding a new category is just typing a new word.',
      'Memories feed: photo tiles bumped from 110px → 180px min so each photo carries more weight (and reads more like a scrapbook, less like a thumb grid).',
      'Memories: emoji reactions on every post. 7 quick-pick chips (❤️ 😂 😮 😢 🎉 👍 🔥) plus a "+" button that opens the full emoji picker for one-off reactions. Tap a quick-pick or chip to react; tap the same emoji again to remove your reaction. Reactions roll up into per-emoji count chips above the picker.',
      'Memories: comments on every post. Plain-text composer at the bottom of each post. Comment header shows author display name + a relative timestamp ("5m ago", "2d ago", date for older). Author can delete their own comment; admin can delete any. Replies are intentionally NOT included — kept simple.',
      'Reactions + comments permission: Family + Admin roles can engage; User-role members see the counts + read comments but can\'t add. Matches the design decision to keep the wall family-curated.',
      'CPU/memory: zero new SQL or realtime channels. Reactions are { emoji, userId, createdAt } objects; comments are { id, body, authorId, authorName, createdAt }. Both arrays live on each memory record inside the existing JSONB blob — negligible row-size impact.',
    ],
  },
  {
    version: '4.45',
    date: '2026-05-15',
    title: 'Memories Wall (Wave 3b of family-portal expansion)',
    changes: [
      'New "Memories" top-level nav tab — a reverse-chrono family feed. Admin-only post; everyone authenticated can view.',
      'Post shape: date (required) + rich-text body (B/I/U/list/link/emoji) + up to 6 photos + multi-tag of people. Tags can be any family member or any friend household person (primary / spouse / kid).',
      'Live search box filters posts across body, date, and tagged-people names.',
      'Photos: same Wave 1 Storage pipeline as My Kids — 2400px downscale, uploaded to family-photos. The archive row only carries { bucket, path } refs per photo.',
      'Photo click → reuses MyKidsLightbox for full-screen + prev/next nav.',
      'CPU/memory: zero new SQL or realtime channels. Posts live as a flat JSONB list; photo binaries stay in Storage.',
    ],
  },
  {
    version: '4.44',
    date: '2026-05-15',
    title: 'Family Recipes (Wave 3a of family-portal expansion)',
    changes: [
      'New "Recipes" top-level nav tab. Admin-only CRUD; everyone authenticated can view — the family cookbook is meant to be read by everyone who can sign in.',
      'Recipe shape: name (required), category (free-form with auto-suggested datalist of previously used values), optional "from" attribution (single tag, picks from any family member OR any friend household person — primary, spouse, or kid — same picker shape the events page uses), optional free-text "from" override ("Korean cookbook"), single cropped photo, ingredients (one per line), instructions (rich text), notes (rich text), optional external link.',
      'Grid view: responsive recipe cards (auto-fill 220px). Cards show photo + name + category chip + "from" attribution.',
      'Detail view: hero photo (click → opens in lightbox), two-column ingredients + instructions, notes section below. Admin sees Edit / Delete in the header.',
      'Search box on the grid filters by name, category, attribution, and notes content.',
      'Photo flow: square crop via CropModal (same as members), uploaded to family-photos bucket (Wave 1 storage), signed URLs cached in-session for grid + detail render.',
      'CPU/memory: zero new SQL or realtime channels. Recipes live in the JSONB archive as a flat list — only the photo reference (32-ish bytes per record) lives in the row. Actual photo binaries are in Storage.',
    ],
  },
  {
    version: '4.43',
    date: '2026-05-15',
    title: 'Bug fix: emoji buttons on My Kids entry modal',
    changes: [
      'Title and Notes emoji buttons on the My Kids entry editor now actually open the picker. They were opening it and immediately closing it on the same click — the popover\'s document-level outside-click handler bails on elements marked [data-emoji-trigger], and the two new buttons were missing that attribute.',
    ],
  },
  {
    version: '4.42',
    date: '2026-05-15',
    title: 'My Kids — manual picker for when parent links aren\'t set up',
    changes: [
      'New "Pick my kids" picker on the My Kids page. The empty state now offers a clear primary action (a button) instead of pointing at the wrong page. Clicking it opens a checklist of every member — pick the ones whose growing-up archive should appear here.',
      'Selected ids are saved to state.myKidsRoster. The roster resolver checks that array first; if it\'s non-empty it overrides the parent-link auto-walk. Empty array falls back to the auto-walk (so users who properly link kids in Family Tree don\'t need to touch the picker).',
      'New "Manage kids" button in the My Kids page header (admin only) — lets you change the picks later from anywhere on the page.',
      'Picker has live name search, member photos + age + group meta, deceased members filtered out automatically.',
    ],
  },
  {
    version: '4.41',
    date: '2026-05-15',
    title: 'My Kids polish — nuclear-family roster + rich text + lightbox',
    changes: [
      'My Kids roster now scopes to the *current admin\'s* nuclear-family kids only — walks the family tree (parentIds) and includes members whose parents are both the admin and the admin\'s spouse. Cousins / nieces / nephews no longer surface. Adapts to whichever admin is logged in.',
      'Notes field is now a rich-text editor with a 6-button toolbar: Bold, Italic, Underline, Bulleted list, Link, Emoji insert. Output saved as sanitized HTML (whitelist: b/i/u/br/p/div/ul/ol/li/a; everything else stripped; <a> forced to target=_blank rel=noopener). Legacy plain-text bodies render unchanged.',
      'Title field has a 😊 button next to it that opens the same emoji picker used by events. Picked emoji appends to the title with a space separator.',
      'New optional Link field on Art + Letters entries — paste a Google Doc / Drive / album URL and the card renders a "🔗 Open link" chip below the body.',
      'Photo downscale bumped from 1600px max → 2400px max. ~600–900 KB per photo, ~1100 photos in the 1 GB free Supabase tier. Crisper in the lightbox.',
      'New full-screen photo lightbox: click any entry photo to open. Prev/Next arrow buttons (and keyboard Left/Right) cycle through that entry\'s photo set. Counter shows "n / total". Esc to close. Reuses the existing vault-lightbox overlay element with an .is-mykids flavor flag so the simpler single-image insurance-card flow stays intact.',
      'CPU/memory: zero new SQL or realtime channels. The rich-text save path stores a (small) HTML string in the same body field. Lightbox uses cached signed URLs already populated by the entry grid renderer — no extra Storage round-trips per click.',
    ],
  },
  {
    version: '4.40',
    date: '2026-05-15',
    title: 'My Kids + Annual Letters (Wave 2 of family-portal expansion)',
    changes: [
      'New admin-only "My Kids" page in the top nav. Roster auto-populates with every family member whose age < 18 (deceased excluded). Click a kid card → opens their detail page with four tabs.',
      'Per-kid tabs: Milestones (first steps, lost a tooth, etc.), School (year + grade + teacher + notes), Art (uploaded creations), Letters (one per year per kid).',
      'Each entry has date + title + body + up to 6 photos. Letters skip photos (it\'s written prose). Each entry can be edited or deleted; deletes also clean up the photo objects in Supabase Storage so the bucket doesn\'t accumulate orphans.',
      'Photos live in the family-photos bucket from Wave 1 (NOT inlined in the JSONB archive). Each photo downscaled to 1600px JPEG before upload — keeps Storage usage low while still high enough resolution to re-zoom later. The JSONB archive only stores { bucket, path } pointers per photo, so the row size stays bounded even with hundreds of entries.',
      'Photo display uses signed URLs (1-hour expiry) cached in-memory per session. Re-renders within the same session don\'t re-hit the Supabase API.',
      'Viewer access: admins always; the kid themselves once they have a linked Supabase login (auto-routes them to their own page, no roster). Other family roles are bounced to the Family Tree page.',
      'CPU/memory: zero new SQL queries beyond the existing JSONB upsert + a few Storage signed-URL requests on render. Photos no longer bloat the archive row.',
    ],
  },
  {
    version: '4.39',
    date: '2026-05-15',
    title: 'Storage foundation (Wave 1 of family-portal expansion)',
    changes: [
      'New supabase/storage.sql migration creates four private buckets — family-photos, family-audio, family-video, family-documents — with per-file size limits and RLS policies. Admin can upload/delete in all four; authenticated users can view photos/audio/video; documents are admin-only end-to-end. Run it once from the Supabase SQL Editor (see supabase/SETUP.md step 2b).',
      'Backend.uploadMedia() / getMediaUrl() / deleteMedia() helpers added. Uploads return { bucket, path } refs that get stored back in the JSONB archive; getMediaUrl resolves to a signed URL on display. Keeps the archive row small (the CPU pain point) while still letting features hold rich media.',
      'No visible UI changes — this PR is pure infrastructure for the upcoming My Kids, Annual Letter, Recipes, Memories Wall, Time Capsule, Voice/Video Stories, Documents, Health Locker, and Newsletter features.',
    ],
  },
  {
    version: '4.38',
    date: '2026-05-15',
    title: 'Login autofill fix + Members Event toggle + Friends address & photo crop',
    changes: [
      'Login: removed minlength="6" hint from the password field. Safari/iOS read minlength on a password input as a strong "this is a sign-up" signal and was offering "Use Suggested Password" on top of the real autofill. autocomplete="current-password" alone is the right signal for "fill from password manager."',
      'Members table: Edit column removed — clicking the row already opens the editor. Added a new "Event" column with an inline checkbox that toggles the "Do not show in events list" flag without opening the profile.',
      'Members → Last activity: app-side admin role is now auto-synced with the DB-side member_accounts.is_admin flag. The Last Activity column reads from a SECURITY DEFINER RPC gated on the DB flag, so promoting someone to admin in the UI now also gives them visibility into the column. Runs on every sign-in (bootstrap admin only) so existing admin-role members get backfilled automatically.',
      'Friends → Address column: street prints on the first line, "City, ST 90210" on the second so the address stops getting mashed into a single squished cell.',
      'Friends modal: photos for the primary friend, spouse, and every kid now route through the same square crop dialog that family members use (480px output, dedupes the visual language across the app).',
    ],
  },
  {
    version: '4.37',
    date: '2026-05-14',
    title: 'Friends list polish + bank masking + mobile responsive pass',
    changes: [
      'Friends tab: name cell now shows ethnicity flag(s) + age in parens after the name when both are filled in. Example: "Paul Cho 🇰🇷 (40)". Adults render as bare years; kids/babies render as "3" or "5mo".',
      'Friends tab: Edit column removed (clicking the row already opens the editor). Phone column locked to a single-line min-width so it stops wrapping into two rows; the Members page now uses a wider 1400px container so Address + Phone + 529 all fit comfortably on one line.',
      'Friend modal: phone fields format to (XXX) XXX-XXXX on blur for both the primary and spouse, matching the family-side member form.',
      'Friend modal: each kid row now has a Middle name field, consistent with the primary + spouse roster shape.',
      'Ethnicity picker: clears the search input after a pick so the next tag search starts fresh. Previously you had to manually backspace the old query.',
      'Family Tree: orientation toggle (horizontal/vertical) removed from the toolbar. The tree is always vertical now. Archives saved with the old "horizontal" preference are force-normalized on load.',
      'Admin → Finance: bank Account # + Routing # always render as "••••1234" everywhere. Edit inputs start blank with a "Current ends in 1234" hint — type a new number to replace, or leave blank to preserve. Utilities Account # masked the same way. No reveal toggle, no full value in any UI surface.',
      'Mobile (≤760px): top nav, Members tabs, and Vault tabs scroll horizontally; container padding shrinks; page heads stack; Dashboard / Events / admin-grid layouts collapse to a single column; modals + drawers go edge-to-edge; tables scroll horizontally inside their wrapper. Tighter pass at ≤480px hides the brand-name + user-chip text for max real-estate.',
    ],
  },
  {
    version: '4.36',
    date: '2026-05-14',
    title: 'Friend household polish + cross-archive events picker',
    changes: [
      'Friend modal: photo upload for spouse + each kid (kid photos use the same 720px @ 0.84 downscale as friend primaries — same archive footprint per face).',
      'Friend kids automatically inherit the union of primary + spouse ethnicities on save, dedupe-merged with anything the kid had manually. Matches how family-side children inherit (line 1623). Saving a flag onto a parent later propagates to the kid the next time you save the household.',
      'Friends tab UX: City column replaced by full Address (one-line postal). Address is shown only on the household primary row — spouse + kid sub-rows render em-dash there since they share the household address.',
      'Friends tab UX: copy-to-clipboard buttons added to the Email + Address columns. One click copies the value with a toast confirmation.',
      'Friends tab UX: bigger, more obvious expand caret (28px outlined button instead of 18px ghost icon). Default state is everyone-expanded so rosters are visible without clicking. New "Collapse all / Expand all" toggle in the panel header.',
      'Friends tab: dedicated "Export to Excel" button on the panel header. Same content as the page-level export when the tab is active, but discoverable without switching tabs first.',
      'New "Do not show in events list" flag on every member, friend primary, spouse, and kid. When checked, that person is filtered out of the events page "+ Add member" picker. Existing event rosters / RSVPs are untouched — this is a picker filter only, not a retroactive hide.',
      'Events page: "+ Add family member…" picker renamed to "+ Add member…" and now offers Family members + every friend household person (primary, spouse, each kid) grouped under Family / Friends optgroups. Already-attending people drop out of the dropdown the same way members already did. Friend household picks are pushed as customName + email attendees with a personRef tag so the link to the friend record is preserved.',
      'CPU/memory: zero new SQL queries, zero new realtime channels. The picker rebuilds in pure client-side JS once per renderDetail() (same as today). Sub-record photos add ~80–120 KB per kid to the friend JSONB blob — only when a photo is uploaded.',
    ],
  },
  {
    version: '4.35',
    date: '2026-05-14',
    title: 'Friends folded into Members page + household roster',
    changes: [
      'Removed the top-level "Friend Tree" nav tab and its card-grid view. Friends now live on the Members page as a sub-tab so they sit beside the family list and share the same list-row UI.',
      'New tab layout on the Members page: Family / Friends / All. Family is the existing members table unchanged. Friends is the new household list. All is a flat union of every person (family + each friend household member) designed for scanning + Excel export.',
      'Friends are now households. Each friend record can carry an optional spouse and a list of kids. In the Friends tab, a friend with family shows a caret in the leftmost cell — click to expand and see indented sub-rows for spouse + each child. Solo friends look like flat rows. Each household member carries their own 529 plan link, ethnicity (in the profile, not as a column), and birthday.',
      'Friend address mirrors how members do it now: split into Street + City + State + Zip with the same zip-lookup auto-fill for city/state. Existing single-line addresses are preserved in the Street field (no re-entry required). The Friends list shows just the City column to keep rows scannable; the All-tab and CSV export show the full postal address.',
      'New friend profile fields: 529 plan link (URL, surfaced as a chip in the 529 column), ethnicity (multi-select via the same picker used for members). These were already on the data schema but had no UI; they\'re now editable.',
      'Context-aware "Export to Excel" button on the Members page: exports family / friends / all rows depending on which tab is active. The All-tab export includes Name, Email, Phone, Address, Birthday, Group, and Type — ready for any mailing-list workflow.',
      'CPU/memory neutral: no new Supabase tables, queries, or realtime channels. Sub-records (spouse + kids) live inside the existing `friends` JSONB blob, so saves still go through the same debounced upsert and the same hashStringFast skip path. The only payload growth is a few hundred bytes per household — well below the noise floor on the archive row.',
    ],
  },
  {
    version: '4.34',
    date: '2026-05-14',
    title: 'CPU-tuned Supabase diagnostics + system-storage SQL',
    changes: [
      'After the user discovered that the Supabase pressure was CPU + system storage (WAL / replication slots / dead tuples) — not user-data size — both SQL helper files were reworked to be cheap to run on a constrained instance.',
      'supabase/queries/storage-breakdown.sql: rewritten. Replaced every `octet_length(jsonb::text)` (which fully re-serializes the JSONB on each call) with `pg_column_size(jsonb)`. Materialized the archive row in a single CTE per query so we don\'t re-fetch from disk per metric. Coalesced the 5-way UNION ALL photo scan into one pass. Demoted the casual VACUUM FULL recommendation behind a warning + prefers plain VACUUM first.',
      'New supabase/queries/system-storage-cpu.sql: ten ordered diagnostics — total DB split, top relations, WAL footprint, dead tuples + autovacuum freshness, the archive TOAST dead-tuple count, replication-slot lag (the usual smoking gun on Supabase free tier), pg_stat_statements top consumers, currently long-running queries, cache-hit ratios, and DDL to set aggressive per-table autovacuum + fillfactor=70 on public.archive and its TOAST partner.',
      'No app behavior changes — diagnostics only.',
    ],
  },
  {
    version: '4.33',
    date: '2026-05-14',
    title: 'Database storage diagnostic + one-click photo compression',
    changes: [
      'New "Database storage" panel at the top of the History page (admin only). Shows the in-memory state size, a per-area byte breakdown (members / friends / vault / events / gifts / …), a vault sub-section breakdown, and a per-source photo footprint table so you can see at a glance which area is eating disk.',
      'New "Compress all photos" button on the same panel. One click re-encodes every photo in the archive at smaller dimensions / lower quality (member 480px, friend 720px, insurance card 1000px, neighbor 800px). Skips photos that are already smaller than the recompressed result. Reports total bytes saved when it completes.',
      'New upload defaults for vault photos: insurance cards 1000px @ 0.78 (was 1400 / 0.85), neighbor photos 800px @ 0.80 (was 1400 / 0.85). Cards still render readably in the lightbox; the archive shrinks meaningfully on the next upload.',
      'Legacy passwordHash + mustChangePassword fields are now stripped from every member record on the next save. Supabase Auth has owned credentials since v4.16; carrying these around was dead weight (64 chars × N members).',
      'New supabase/queries/storage-breakdown.sql — copy-paste SQL block for the Supabase SQL Editor that gives the authoritative on-disk breakdown (archive heap + TOAST size, per-area JSON sizes, photo footprint, autovacuum / bloat stats, and a VACUUM FULL at the end to reclaim TOAST bloat).',
    ],
  },
  {
    version: '4.32',
    date: '2026-05-13',
    title: 'Supabase CPU optimization — fewer / smaller archive writes',
    changes: [
      'Bumped the archive save debounce from 500ms to 1500ms. Bursty interactions (typing in a form, dragging cards, rapid edits) now coalesce into one Supabase write instead of three. Trade-off: cross-device echo is ~1s slower, which nobody will notice on a family CRUD app.',
      'No-op write skip: every save now hashes the serialized state and short-circuits if the hash matches the last successfully-written one. Code paths that defensively call Store.save() when nothing actually mutated (UI re-renders, idempotent normalization, no-move tree pans) no longer hit Postgres at all.',
      'In-flight save coalescing: if a save is already mid-flight when the debounce fires, the next save waits for the in-flight one to complete before scheduling, instead of stacking overlapping writes against the same JSONB row.',
      'Tree pan: clicking the canvas empty space (pointerdown→up with no movement) no longer fires a redundant save. Saves now only run when the view actually moved.',
      'Net effect: a typical "open the app, click around for a minute, close" session now produces ~70-80% fewer database writes. Postgres CPU follows.',
    ],
  },
  {
    version: '4.31',
    date: '2026-05-13',
    title: 'New Friend Tree page + nav re-order (Calendar after Dashboard)',
    changes: [
      'New "Friend Tree" page (admin-only) for tracking people outside the family — neighbors, college friends, work, etc. Starts blank. Click "+ Add Friend" to add one. Each friend gets a card with name, photo, birthday, group, and notes; click into the card to edit. Same visual language as Family Tree cards.',
      'Friends live in a separate dataset from Family Members (state.friends), so they never appear in Family Tree, My Family, Gifts, Events, or the Members admin page. The Friend Tree is intentionally its own world.',
      'Nav re-ordered: Calendar now sits right after Dashboard. Family Tree → My Family → Friend Tree run as a group. The Events / Gifts / Members / Admin / History tabs follow.',
      'Note: this is v1 of Friend Tree — friends render in a responsive card grid. The full pan/zoom canvas + relationship lines from Family Tree will come later as the dataset grows; that\'s a follow-up.',
    ],
  },
  {
    version: '4.29',
    date: '2026-05-13',
    title: 'International name field — render names in another script under the Latin name',
    changes: [
      'New optional "International name" field on every member profile (admin edit + add-member modal), placed directly under Display name. Useful for Korean / Vietnamese / Chinese / Japanese / Cyrillic / Arabic etc. — anything you\'d want shown alongside the Latin name.',
      'Rendered under the name on Family Tree cards, My Family cards, the Members admin cards, and at the top of the profile drawer. Empty by default; existing members carry over unchanged.',
    ],
  },
  {
    version: '4.28',
    date: '2026-05-13',
    title: '529-plan quick-link chip on tree cards (Admin + Family)',
    changes: [
      'Family Tree + My Family cards: when a member has a 529 plan URL saved, a small 🎓 "529 plan" chip now renders directly on their card for the Admin and Family roles. Clicking the chip opens the plan portal in a new tab — no need to drill into the drawer first. Plain User role doesn\'t see the chip.',
    ],
  },
  {
    version: '4.27',
    date: '2026-05-13',
    title: 'Family role fixes — tree & My Family clickable, per-card Gifts visibility',
    changes: [
      'Family role can now click any profile card on the Family Tree to open the (read-only) drawer. Previously the click handler was admin-only, leaving the tree non-interactive for Family.',
      'Family role can now click any profile card on the My Family page. Previously they were stuck with the User-tier rule (only their own card + spouse\'s card opened).',
      'Drawer Gifts section is now per-card for Family role: it shows when the family member is viewing their own card or their spouse\'s card, and is hidden on every other relative\'s card. Admin still sees Gifts on every card; plain User behavior is unchanged.',
    ],
  },
  {
    version: '4.26',
    date: '2026-05-13',
    title: 'New "Family" role — read-only access to ages, profiles, and a filtered Calendar',
    changes: [
      'New role between User and Admin. Set a member\'s Role to "Family" in their profile edit form (admins only). Existing User and Admin roles unchanged.',
      'Family Tree: Family role sees age chips on every member\'s card (same as Admins). Plain Users still don\'t.',
      'Profile drawer for Family role: card details are visible, but the Gifts section is hidden, and the bottom-row actions (Edit profile, Link to family, Mark as divorced, Reset password, Remove from tree) are all hidden — even on the user\'s own card. Pure read-only.',
      'Calendar page is now accessible to Family role as read-only. Events show only if the family member is on the attendee list (same filter as the Events tab); birthdays, anniversaries, and US holidays always show; reminders, the "+ Reminder" button, the per-day "+" add-event button, and the Google Calendar sync button are all hidden. Event chips appear but aren\'t clickable; birthday / anniversary chips still open the read-only profile drawer.',
    ],
  },
  {
    version: '4.25',
    date: '2026-05-12',
    title: 'Admin polish — insurance emoji picker, larger bank details, Instagram link, Neighbors section, drag-reorder persistence',
    changes: [
      'Admin → Benefits: each insurance card now has its own Emoji picker (Health 🩺, Hospital 🏥, Rx 💊, Dental 🦷, Vision 👓, Auto 🚗, Home 🏠, Umbrella 🌂, Pet 🐶, Travel ✈️, Life 🦺, Mental health 🧠, Disability 🏃, Other 📄). Leaving it on "Auto" keeps the existing kind-based default so previously created cards are unchanged.',
      'Admin → Finance: bank-account details reformatted. Each fact (Account number, Routing number, Account holders) is on its own line with an emoji prefix, the value font is ~50% larger (19px) so it\'s readable at a glance, and Account holders are now explicitly labelled rather than tacked onto the end of the dense sub-line.',
      'Admin → Family: Instagram handles are now clickable links to https://www.instagram.com/<handle> instead of a plain @text label.',
      'Admin → Home: new "Neighbors" section. Each entry holds name, address, phone, a free-form "kids" note, an optional photo (uploaded inline, auto-downscaled), and notes. Same drag-to-reorder + click-to-enlarge photo behavior as the rest of the Admin page.',
      'Bug fix: drag-to-reorder on Finance / Benefits / Home lists now actually saves the new order. The previous version committed on the `drop` event, but Chrome refuses to fire `drop` if the cursor is over the dragged row at release time (which is the common case, since the row tracks the cursor). The new order is now committed on `dragend`, which always fires.',
    ],
  },
  {
    version: '4.24',
    date: '2026-05-12',
    title: 'Admin polish — utility emoji picker, in-page card photo lightbox, drag-to-reorder lists',
    changes: [
      'Admin → Home → Utilities: the emoji field is now a curated dropdown (Electricity / Gas / Water / Trash / Internet / Cable / Phone / Yard / Pest / Pool / Cleaning / Solar / Power / Security) instead of a freeform text input. Custom emojis set in earlier versions carry forward as a "(custom)" option so they aren\'t lost.',
      'Admin → Benefits: clicking an insurance card photo now opens it in an in-page lightbox overlay instead of trying to navigate a new tab to the data: URL (which Chrome refuses, leaving a blank page). Close via the × button, clicking the backdrop, or pressing Esc.',
      'Admin → Finance / Benefits / Home: every list (banks, insurance cards, utilities, HOAs, code sets) now has a six-dot drag handle on the left of each row. Drag a row up or down to reorder; the new order is saved immediately. The row you\'re dragging gets a subtle lift + dimming so you can see what you\'re moving.',
    ],
  },
  {
    version: '4.23',
    date: '2026-05-12',
    title: 'Admin page polish — Finance multi-holder + balance log, Benefits new fields + larger photos, multi-HOA/codes, structured birth fields',
    changes: [
      'Finance: bank accounts now support multiple account holders (checkbox list restricted to nuclear-family members), a Nickname field that renders inline with the bank name ("Chase — Joint checking"), and a Balance history log so a savings account\'s growth can be tracked over time. The account number is now shown in full (no more ••••) — these records are admin-only behind RLS anyway. View card shows the latest balance + an expandable history table.',
      'Benefits: added Car insurance as a Type option, plus four new fields per card — Plan #, NAIC #, Effective date, Expiration date. Insurance card photos render larger on the read-side view (up to 360px wide at credit-card aspect ratio) with a small caption tag so you can actually read what\'s on the card before clicking through to the full-size image.',
      'Home: HOA / Property management is now a list — each entry has a Property label (e.g. "Primary home", "Lake house") so multiple HOAs can coexist. Same for Gate / amenity codes — each code set has its own property label. Existing single-record HOAs and codes are auto-migrated into the first entry under the "Primary" label.',
      'Home: utilities get an emoji prefix field (e.g. ⚡ NV Energy, 🔥 Southwest Gas) shown before the name, and the saved-row layout was reformatted to match the HOA card style — separate lines with emoji-prefixed website/phone/account-# rather than a cramped single line.',
      'Family: structured birth-detail inputs — Time uses the native time picker, Weight splits into lbs + oz number inputs, Length is inches (number with decimal step). Legacy free-text "7 lbs 4 oz" strings are parsed and migrated automatically. Added a Google Drive URL field (type=url) per member, rendered as a clickable link in the view.',
    ],
  },
  {
    version: '4.22',
    date: '2026-05-12',
    title: 'New Admin (vault) page — household private records: family IDs, bank accounts, insurance cards, utilities, HOA, gate codes',
    changes: [
      'New "Admin" nav tab — a private records vault visible only to Ted Yoo, Doan Yoo, and the system admin (admin-bootstrap). Other admins and regular users can\'t see the tab or reach the page; Views.show bounces them back to the tree. Gated via Auth.canAccessVault(), surfaced on the body as is-vault-authorized.',
      'Family sub-tab: auto-populates a profile card for each member in the logged-in user\'s nuclear family (self + spouse + children). Each card holds the new private fields: Driver\'s Licenses (multi-state, add/remove rows), Passport #, Known Traveler #, Rapid Rewards, Instagram, and structured Birth details (place, hospital, time, weight, length, notes). Fields live under member.private — they do not surface in the regular profile drawer.',
      'Finance sub-tab: bank account list with add / inline-edit / delete. Each entry holds bank name, account #, routing #, type (Checking / Savings / Credit / Other), holder member, and notes. Tinted pill on the row shows the account type.',
      'Benefits sub-tab: insurance card list with add / inline-edit / delete. Each card holds type (Health / Dental / Vision / Other), insurer, policy #, group #, phone, covered member, notes, and front + back card photos (uploaded inline as auto-downscaled JPEGs via the new downscaleImageFile helper). Thumbnails open the full-size image in a new tab.',
      'Home sub-tab: utility account list (name, website, phone, account #, notes), HOA / property-management contact card, and gate / amenity codes (pedestrian gate, car gate, pool, clubhouse, plus a buildings list).',
      'Data model: archive grows a state.vault sub-tree { banks[], insurances[], utilities[], hoa{}, codes{} } and a state.vaultAccessIds[] escape hatch for granting access to other members by id. healMissingKeys backfills both on every load. Member records gain m.private = { driversLicenses[], passport, ktn, rapidRewards, instagram, birth{place,hospital,time,weight,length,notes} }.',
    ],
  },
  {
    version: '4.21',
    date: '2026-05-12',
    title: 'More profile emojis, Deceased-checkbox fix, bigger heart + memoriam tag, Gifts Reports dashboard',
    changes: [
      'Profile drawer: Life stage 🌱, Address 🏠, Group 👥, Ethnicity 🌍, Role 🔑, 529 plan 🎓 — added emoji glyphs to all remaining labels in both the view and edit modes. Notes label gets 📝 in the edit form.',
      'Bug fix: the "Deceased" checkbox now renders the native checkmark when toggled. The .field input { appearance: none } rule was stripping the indicator off checkboxes living inside a .field wrapper; the .field-check selector now explicitly restores appearance: auto.',
      'Family Tree: spouse-line heart marker scaled up (.8 → 1.1) with a proportionally larger halo so the connection reads more clearly at a glance, especially on dense layouts.',
      'Profile cards: "In loving memory" badge enlarged (9px → 11px font, more padding) and now leads with a 🕊️ glyph. The drawer-side "In loving memory" pill matches.',
      'Gifts → Log a gift: the To-member field is now a typeahead picker that defaults to the logged-in user\'s nuclear family (self + spouse + children) since received gifts almost always go to "us". A "Show all family members" button or typing any letter expands to the full list.',
      'Gifts bug fix: the From-member picker now clears its search box after each pick, so adding multiple givers in a row no longer leaves the previous query filtering the list (was masking later picks).',
      'Gifts → Reports: new tab with a visual dashboard. Headline cards for Received / Given / Net totals, a 12-month grouped bar chart, top recipients + top givers ranked by dollars, and a by-occasion breakdown with received/given segments per occasion. Multi-giver gifts split evenly across senders so the top-giver totals stay honest.',
    ],
  },
  {
    version: '4.20',
    date: '2026-05-12',
    title: 'Red spouse heart, profile-label emojis, deceased checkbox, Nickname→Display name, group-invite opt-out',
    changes: [
      'Family Tree: the spouse-line heart marker is now red (#dc2626) on both the main tree and My Family mini-tree, making current marriages pop. Broken-heart markers for ex-spouses stay muted gray to keep the past-tense read.',
      'Profile drawer: added emoji glyphs to the Birthday (🎂), Phone (📱), Email (📧), Anniversary (❤️), and Date of death (🕊️) labels for quick visual scan.',
      'Profile edit: "Date of death" is now gated behind a "Deceased" checkbox. The date input only appears when checked, so a stray click on the date picker can\'t accidentally mark someone as having passed away.',
      'Members: "Nickname" → "Display name". This optional field overrides what the app renders anywhere a member appears (tree cards, drawer headline, admin list, attendee rows, calendar chips, gift list, etc.). If left blank, it falls back to First + Middle + Last. Existing nicknames carry forward in the v4.20 migration. CSV export header updated.',
      'Groups: each member has a new "Include in group invites" checkbox in the profile edit form (default on). When unchecked, that person is skipped by Events → "+ Add by group…" — they can still be added one-by-one. Useful for someone who is part of a group socially but shouldn\'t get auto-invited to every event for it.',
    ],
  },
  {
    version: '4.19',
    date: '2026-05-12',
    title: 'Members: drop Role column, "Last activity" now sourced from Supabase auth',
    changes: [
      'Members page: removed the Role column. Role is already visible inside each member\'s profile drawer, so the table column was redundant.',
      'Members page: "Last activity" now reads auth.users.last_sign_in_at directly via a new SECURITY DEFINER RPC (public.member_last_seen). Every member with a linked Supabase login lights up — not just whoever happens to be in the current session. The previous in-archive lastLoginAt stamping (which only ever wrote for the viewer, and silently skipped admin-bootstrap accounts) is gone. Requires a one-time SQL migration: run the member_last_seen block in supabase/schema.sql.',
    ],
  },
  {
    version: '4.18',
    date: '2026-05-11',
    title: 'Tree favicon, Members "Last activity" column, Dashboard 5-day forecast + today highlight',
    changes: [
      'Favicon: browser tab now shows a 🌳 tree emoji via inline SVG favicon (no asset file needed).',
      'Members page: new "Last activity" column showing the date of each member\'s most recent visit. The timestamp is stamped on the member record (Auth.applyAccount sets lastLoginAt on resolve, debounced to once-per-minute to avoid noisy saves) and the cell carries a full-datetime tooltip on hover.',
      'Dashboard: the single-line current-weather chip is replaced with a 5-day Las Vegas forecast. Each day shows day-of-week → weather icon → high/low temp. Cache lifetime bumped to 30 min since daily forecasts don\'t move minute-to-minute.',
      'Dashboard: upcoming list rows for items happening today now render with a light-yellow background + amber border so the "today" row pops out of the cream stack.',
    ],
  },
  {
    version: '4.17',
    date: '2026-05-11',
    title: 'Bug fixes — event card net chip, own-profile click, My Family layout + half-sib coloring',
    changes: [
      'Events: the +/− gift summary chip on the event list card on the left side is now hidden for non-admin users (in addition to the attendee-table footer fixed in v4.16).',
      'My Family: non-admin user can now actually open their own profile card and their current spouse\'s. v4.16 treated Auth.current as a bare id, but it\'s the resolved member OBJECT — the set comparison never matched. The check now pulls the .id off the object.',
      'Family Tree: same bug fixed in the autoLayout root-sort heuristic. rootContainsAdminByBlood was always returning false because Auth.current (an object) was being compared to member ids (strings), so the admin\'s family wasn\'t actually sorting correctly. Now extracts .id properly.',
      'My Family: bumped the row gap from 100 to 160 so multi-group parent trunks (half-siblings routed under different parent pairs) have breathing room.',
      'My Family: half-sibling trunks now stagger their Y lanes (18px apart) so multi-group routings don\'t all collapse onto the same horizontal rail. Plus each parent-group gets a distinct hue applied to its kid card\'s top accent bar (only when 2+ groups are present), so it\'s visually obvious which kids share which parents.',
    ],
  },
  {
    version: '4.16',
    date: '2026-05-11',
    title: 'Tightened user-role permissions in My Family and Events',
    changes: [
      'My Family: a non-admin user can now only open their own profile card and their current spouse\'s. Clicking any other card (parents, siblings, children, in-laws) is a no-op — the read-only mini-tree stays visible but the drawer with private fields no longer opens.',
      'Events: the "Total gifts received" summary row in the attendees table is now admin-only. Non-admin users see the attendee list but not the money sum.',
    ],
  },
  {
    version: '4.15',
    date: '2026-05-11',
    title: 'Family Tree spouse line solid + ex dotted, My Family zoomed out 10%',
    changes: [
      'Family Tree: swapped the line styles between current spouse and ex spouse — current spouse line is now solid (with the heart marker), ex spouse line is dotted + muted opacity.',
      'My Family: scaled the mini-tree down 10% with a CSS transform so larger families don\'t feel as cramped horizontally. Top-center origin keeps the focus row in place visually.',
    ],
  },
  {
    version: '4.14',
    date: '2026-05-11',
    title: 'Family Tree — new members slot in next to their relative in manual layout',
    changes: [
      'Family Tree: when the layout is in manual mode and a new member is added with a relationship, the new card now drops in at a natural position relative to its target (child → below the parent or below the parent-couple midpoint, spouse/sibling → beside the target, parent → above the target). Previously the card landed at (0, 0) in the top-left corner.',
      'Family Tree: the placer nudges along the primary axis if the chosen slot would overlap an existing card, so adding multiple kids to the same parents stacks them in a row instead of dropping each on top of the last.',
    ],
  },
  {
    version: '4.13',
    date: '2026-05-11',
    title: 'Family Tree — manual layout: unlock to drag cards, lock to save',
    changes: [
      'Family Tree: new "Unlock layout" toggle in the toolbar (lock icon next to Auto-arrange). When unlocked, cards become directly draggable — pointerdown on a card and move it; the parent/child/spouse connectors redraw in real-time. Lock the layout again when finished and the positions stick across reloads + sync.',
      'Family Tree: while the layout is unlocked, autoLayout() becomes a no-op so adding or removing members never reshuffles your hand-placed cards. Locking the layout keeps that protection in place — positions persist. Clicking Auto-arrange wipes the manual flag and returns to the algorithm-driven layout.',
      'Family Tree: drag-to-reposition uses a 4px movement threshold to distinguish drags from clicks, so quickly tapping a card in edit mode still opens the profile drawer.',
    ],
  },
  {
    version: '4.12',
    date: '2026-05-11',
    title: 'Nav-tab INP fix — defer per-view renders out of the click handler',
    changes: [
      'Performance: Views.show() no longer runs the target view\'s render() synchronously inside the click handler. The visibility toggle still happens immediately so the active nav-tab + view-switch paint right away; the heavy per-view render (autoLayout, edges SVG, large innerHTML builds) is queued as a fresh task and runs on the next frame. Cuts INP on nav-tab clicks from ~200ms to <50ms on a populated archive.',
      'Performance: rapid nav-tab switches are coalesced — only the final tab\'s render runs.',
    ],
  },
  {
    version: '4.11',
    date: '2026-05-11',
    title: 'Family Tree ancestor roots land left of admin, reminders gain hide-from-Dashboard flag',
    changes: [
      'Family Tree: within the admin family group, roots that contain the admin by blood now sort to the RIGHT of surname-only roots. So Bong+Kum, Wonjoon Yoo, and any floating Grandpa/Grandma Yoo roots lay out to the left of Hee Yoo\'s cluster instead of stacking after it. Wiring those ancestor roots in as Hee\'s parents will still consolidate them into a single subtree above Hee.',
      'Calendar: reminders now have a "Hide from Dashboard" checkbox. Checked reminders still render on the Calendar but never enter the Dashboard upcoming list — useful for low-signal recurring chores like trash day.',
    ],
  },
  {
    version: '4.10',
    date: '2026-05-11',
    title: 'My Family — per-kid parent routing, step-sibling inclusion, dashed ex-connectors',
    changes: [
      'My Family: parent → kids lines are now routed per kid based on their actual visible bio parents. Half-siblings only connect to the parent(s) they actually share. In Suejin Chang\'s view, Jewelia Chang now drops only from her bio mother Mimi Morse instead of having a stray line from Tony Chang.',
      'My Family: step-siblings (children of a step-parent of focus) are now included in the siblings list. Jewelia surfaces in Suejin\'s view because Mimi is a step-parent; the per-kid router then keeps Jewelia connected only to Mimi.',
      'My Family: ex-couple heart-lines now render dashed (matching the main Family Tree). The dashed treatment applies to broken hearts between divorced bio parents, between a bio parent and an ex step-parent, and between the focus and their own ex-partners.',
    ],
  },
  {
    version: '4.9',
    date: '2026-05-11',
    title: 'Family Tree root sort — admin family on the left + bloodline detection fix',
    changes: [
      'Family Tree: root sorting now puts the admin\'s own family on the LEFT side of the canvas (was: right). For Ted\'s archive that means the Yoo branch — Bong/Kum, Grandpa/Grandma Yoo, Wonjoon Yoo — clusters on the left and the Nguyen branch (Doan\'s parents) clusters on the right.',
      'Family Tree: rewrote the "does this root contain the admin" check to walk children only, never spouses. The previous version walked through Doan\'s marriage to Ted, so Doan\'s parents\' subtree was getting classified as admin\'s family too and the sort never separated them.',
      'Family Tree: added a surname fallback for floating roots that aren\'t wired to the bloodline yet. A standalone Grandpa Yoo or Wonjoon Yoo now lands in the admin\'s cluster (left) because their last name matches the admin\'s. Once you wire them as Bong\'s parents / sibling, they\'ll slot in under the bloodline directly and the surname rule stops mattering for them.',
    ],
  },
  {
    version: '4.8',
    date: '2026-05-11',
    title: 'Anniversary on cards, admin-on-the-right root sort, My Family all-spouses display',
    changes: [
      'Family Tree: profile cards now show "X years together" (or "X months together" when under a year) underneath the age. The chip reads off the member or their current spouse so it appears on both halves of the couple.',
      'Family Tree: root sorting now puts whichever root subtree contains the admin on the right edge of the canvas. Doan\'s parents (Nguyen) layout on the left, Ted\'s parents/grandparents (Yoo) layout on the right — independent of the order members were added.',
      'My Family: bio parents now bring in every spouse — current AND ex — that isn\'t themselves a bio parent of the focus. Suejin Chang\'s view now surfaces all of Tony Chang\'s partners (including Heather Grisnik\'s mother Mimi Morse) so half-sibling parentage reads clearly.',
      'My Family: ex-step-parents render with a broken heart to the bio parent (current step-parents stay solid). Bio co-parent now interleaves directly after the bio parent so the bio-couple heart never gets stranded across step-parent cards.',
    ],
  },
  {
    version: '4.7',
    date: '2026-05-11',
    title: 'Reminder icons, My Family step-parent display, Family Tree side-by-side spouses + root order',
    changes: [
      'Calendar reminders: each reminder now has a customizable icon (defaults to 🔔). The Repeats modal got an Icon field with the same emoji-input + browse button used by Events. The chosen icon shows on the calendar chip and the Dashboard upcoming list.',
      'My Family: spouse-inferred bio parents are back — but only when the bio parent has no ex-spouses. Doan\'s mother Cuc Tran now appears automatically when viewing Doan, while Ted\'s view still does not falsely list Kimberly as a parent (Hee has an ex).',
      'My Family: a bio parent\'s current spouse who is not themselves a bio parent now appears as a step-parent in the parents row, with a solid heart connector to their bio-parent spouse and no parent-line down to the focus.',
      'My Family: divorced bio parents now show a broken heart between them in the parents row, matching how the main Family Tree page renders ex-couples.',
      'Family Tree: reverted v4.6\'s stacked-spouse layout. Current spouse, anchor, and ex(es) are all side-by-side again. The orphan-prevention behaviour is kept by pulling each ex\'s current spouse into the same cluster row immediately after the ex, so nobody ends up dumped far to the right.',
      'Family Tree: root iteration now filters to true top-of-tree members (a member with no parents whose spouses and exes also have no parents). Reversed the iteration order so Doan\'s parents (Nguyen) lay out on the left and Ted\'s parents/grandparents (Yoo) on the right, keeping the Ted+Doan marriage near the visual center.',
    ],
  },
  {
    version: '4.6',
    date: '2026-05-11',
    title: 'Family Tree stacked-spouse layout, line-style differentiation, Calendar custom recurrence, Gifts table fix, History chip fix, My Family step-parent fix',
    changes: [
      'Family Tree: when an anchor has both a current spouse and an ex-spouse, the current spouse now stacks vertically above the anchor (with a vertical heart-line) while the ex(es) stay beside. Fixes the case where the current spouse was getting dropped into the orphan bucket far to the right with no connector back.',
      'Family Tree: the same stacking rule applies when an ex is the layout root — that ex\'s current spouse is placed above the ex card, instead of being orphaned.',
      'Family Tree: parent → child lines are now thicker, rounder, and more opaque; sibling lines use a longer dash pattern. The three relationship types (solid bold = parent, long-dash = sibling, dotted + heart = spouse) read distinctly at a glance.',
      'Family Tree: family-children trunk now drops from the bottom of the lower card when the parent couple is stacked.',
      'Calendar: reminder recurrence now supports "Every 2 weeks" and a Google-style custom panel — pick an interval (every N), a unit (day/week/month/year), and for weekly: tap day-of-week chips (M T W T F S S).',
      'Gifts: removed the .gift-row flex layout from <tr> rows. The class was originally for the inline mini-gift list in the profile drawer; on the Gifts table it was turning each <tr> into a flex container, breaking column alignment between the header and the body. Scoped the flex layout to the inline list only.',
      'History: current-version chip background was using an undefined --brand-800 CSS variable, so the chip rendered transparent with paper-colored text (invisible). Pointed it at --brand-700 and the chip now shows up correctly.',
      'My Family: removed the "add each parent\'s current spouse" step from the parents collection. That heuristic was pulling step-parents in as bio parents (Kimberly was showing as Ted/Sarah\'s mother because she\'s Hee\'s current spouse). Parents now come from explicit parentIds + reverse-lookup only.',
      'My Family: parent-trunk now spans every parent\'s column, not just the first — fixes a gap where the second divorced parent\'s drop-line landed in empty space.',
    ],
  },
  {
    version: '4.5',
    date: '2026-05-11',
    title: 'My Family siblings, Dashboard chip colors, gift total dedupe, + button focus fix',
    changes: [
      'Family Tree: the "+" add-relative button no longer stays visible after the modal closes — clicking it now blurs the button and the modal\'s close() drops any lingering focus so :focus-within releases.',
      'Dashboard: Upcoming filter chips are now color-coded to match the Calendar legend (blue events, green birthdays, purple anniversaries, red holidays, amber reminders). Each chip also carries a thin matching left-border when idle.',
      'Events: attendees-table "Total gifts received" footer used to sum each attendee\'s gift credit, which double-counted joint gifts (Hee + Kim both got credit for the same $500 → footer showed $1000). The footer now iterates gifts directly and sums each gift once.',
      'My Family: siblings now appear on the focus row after the exes, branched off the same parent trunk as the focus.',
      'History: changelog is inlined in the bundle instead of fetched from changelog.json so the current-version chip always renders without depending on the static-file route.',
    ],
  },
  {
    version: '4.4',
    date: '2026-05-11',
    title: 'My Family parents fix, Dashboard filters and totals, Members rename, History page',
    changes: [
      'My Family: parents row unions focus.parentIds + reverse-lookup + each parent\'s current spouse, so a missing co-parent (the Doan Yoo\'s-mother case) surfaces automatically from the spouse link.',
      'My Family: children row interleaves each child\'s spouse next to them; grandchildren include kids of the in-law too.',
      'Family Tree: emoji slot in the toolbar is no longer hidden by the global data-admin-only rule.',
      'Dashboard: Birthdays / Anniversaries / Events / Holidays / Reminders are now clickable filter chips.',
      'Dashboard: "This month\'s gifts" panel — received, given, net for the current month.',
      'Dashboard: each event row in Upcoming shows its rolling gift totals.',
      'Dashboard: gift tracker now only shows direction=given gifts that aren\'t fully purchased + sent.',
      'Admin tab renamed to Members.',
      'New History page (this changelog).',
    ],
  },
  {
    version: '4.3',
    date: '2026-05-11',
    title: 'Family Tree card overflow, group filter ancestors, My Family per-child routing',
    changes: [
      'Family Tree: .node overflows visible so the "In loving memory" badge and the "+" button aren\'t clipped.',
      'Family Tree: removed the desaturate-on-death photo filter.',
      'Family Tree: Group filter keep-set walks every ancestor so the tree stays vertical instead of collapsing into a horizontal row.',
      'Family Tree: emoji slot moved out of a hidden floating position into the toolbar.',
      'My Family: per-child routing — each child\'s trunk drops from their actual visible bio parent(s).',
      'My Family: focus row order is [current spouse, focus, ex1, ex2, ...].',
      'My Family: added a 4th row for grandchildren.',
    ],
  },
  {
    version: '4.2',
    date: '2026-05-11',
    title: 'Family Tree polish, My Family ex-spouses, Dashboard tweaks, Admin sort and login column, page emojis',
    changes: [
      'Family Tree: "In loving memory" badge on the profile card when a date of death is set; age caps at date of death.',
      'Family Tree: Tree.relations does union-from-both-directions and healMissingKeys heals asymmetric links every load.',
      'My Family: renders current spouse + every ex on the focus row with broken-heart lines.',
      'Dashboard: Upcoming horizon 60 days; US holidays merged in.',
      'Dashboard: gift tracker hides rows where both purchased AND sent are checked.',
      'Members: Name column header click toggles between by-last and by-first sort; new Login column.',
      'Page emojis: admins can set an emoji per page; updates both the H2 and the nav tab.',
    ],
  },
  {
    version: '4.1',
    date: '2026-05-11',
    title: 'Dashboard, profile additions, calendar reminders, travel trips',
    changes: [
      'Profile drawer: date of death, 529 plan URL, notes, in-drawer gifts section.',
      'Members table: inline copy-email button per row.',
      'Calendar: birthday chip recolored green; legend updated.',
      'Calendar: new Calendar reminder type (recurring, calendar-only).',
      'Events: travel-trip toggle adds destination, end date, four budget categories, and a daily itinerary editor.',
      'New Dashboard page (admin-only): Las Vegas clock + weather (Open-Meteo), upcoming list, quick gift tracker, shared grocery list.',
      'Admins land on Dashboard after sign-in.',
    ],
  },
  {
    version: '4.0',
    date: '2026-05-11',
    title: 'Multiple ex-spouses, photo recrop, Group + My Family tree filters',
    changes: [
      'Multi-spouse data model: exSpouseIds[] on every member; canvas draws each ex with a long-dashed broken heart.',
      'healMissingKeys migrates legacy divorced-flag-on-current-spouse pairs into the new model.',
      'Profile edit drawer: "Crop photo" button re-runs the cropper on an existing photo.',
      'Family Tree toolbar: Group dropdown and My Family toggle as mutually-exclusive view filters.',
    ],
  },
  {
    version: '3.4',
    date: '2026-05-11',
    title: 'Edge Function for admin password reset',
    changes: [
      'New Supabase Edge Function admin-reset-password (service_role server-side) so admins can set a member\'s password directly from the website.',
      'Client toast surfaces a deploy-the-function hint when the call fails.',
    ],
  },
  {
    version: '3.3',
    date: '2026-05-11',
    title: 'Smart Reset PW handles missing logins; recovery modal fixes',
    changes: [
      'Admin Reset PW probes member_accounts first; if no login exists, it offers to create one on the spot.',
      'Open the recovery modal directly when the URL has a recovery hash.',
    ],
  },
  {
    version: '3.2',
    date: '2026-05-11',
    title: 'Mirror members into Supabase Auth on create',
    changes: [
      'Member-create form gains an Email field; saving creates a Supabase Auth user via a session-less throwaway client (admin stays logged in).',
      'member_accounts row links the auth user to the in-app member; credentials shown once for the admin to share.',
    ],
  },
  {
    version: '3.1',
    date: '2026-05-11',
    title: 'RLS policy fixes; admin password reset via email',
    changes: [
      'Split member_accounts policies per operation to break the infinite-recursion RLS error.',
      'Add INSERT policy on archive so PostgREST .upsert() works.',
      'Admin Reset PW uses resetPasswordForEmail and a recovery-mode change-password modal on the receiving end.',
    ],
  },
  {
    version: '3.0',
    date: '2026-05-11',
    title: 'Supabase backend wire-up + auth',
    changes: [
      'Replaced localStorage-only storage with Supabase: JSONB-blob single-row archive + member_accounts mapping + RLS.',
      'Auth flow switched from local username/passwordHash to Supabase email/password with realtime sync.',
    ],
  },
  {
    version: '2.0',
    date: '2026-05-11',
    title: 'Calendar, expenses, anniversaries, photo crop, profile fields',
    changes: [
      'Calendar page with events, birthdays, US holidays; Google Calendar sync; per-attendee expenses; anniversary tracking; photo crop modal; profile improvements.',
    ],
  },
  {
    version: '1.0',
    date: '2026-05-11',
    title: 'Initial commit',
    changes: [
      'Family Archive web app — vanilla JS, single index.html + app.js + styles.css.',
    ],
  },
];

// -------------------- VAULT / ADMIN VIEW --------------------
// Private records for the household. Strict access gate (Auth.canAccessVault)
// means only Ted, Doan, or the bootstrap-admin sentinel can land on this view
// in the first place — Views.show bounces everyone else back to the tree, and
// the nav tab itself is hidden via the [data-vault-only] CSS rule unless the
// body class `is-vault-authorized` is set.
//
// Data layout:
//   Per-member  → m.private = { driversLicenses[], passport, ktn, rapidRewards, instagram, birth{} }
//   Per-house   → state.vault = { banks[], insurances[], utilities[], hoa{}, codes{} }
const VaultView = {
  section: 'family',

  init() {
    $$('.vault-tab').forEach(t => on(t, 'click', () => {
      this.section = t.dataset.vaultSection;
      $$('.vault-tab').forEach(x => x.classList.toggle('is-active', x === t));
      $$('.vault-panel').forEach(p => { p.hidden = p.id !== `vault-${this.section}`; });
      this.render();
    }));
    DocumentsView.init();
    // Lightbox close affordances: × button, backdrop click, Esc key.
    document.querySelectorAll('[data-vault-lightbox-close]').forEach(el => {
      on(el, 'click', () => {
        // v4.41: the same lightbox element is reused by MyKidsLightbox.
        // If we're currently in the kids-mode flavor, defer the close to
        // it so the prev/next state + counter get cleaned up too.
        const lb = $('#vault-lightbox');
        if (lb?.classList.contains('is-mykids')) MyKidsLightbox.close();
        else this.closeLightbox();
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#vault-lightbox').hidden) {
        const lb = $('#vault-lightbox');
        if (lb?.classList.contains('is-mykids')) MyKidsLightbox.close();
        else this.closeLightbox();
      }
    });
  },

  // Returns the member ids whose profiles render in the Family tab. Self +
  // spouse + children of whoever's logged in. The bootstrap-admin sentinel
  // has no member record, so we fall back to looking up "Ted Yoo" by name
  // (that's whose household this app belongs to) and using his family.
  householdIds() {
    const me = Auth.current;
    const collect = (root) => {
      const ids = new Set([root.id]);
      if (root.spouseId) ids.add(root.spouseId);
      (root.childrenIds || []).forEach(id => ids.add(id));
      return [...ids];
    };
    if (me && me !== 'admin-bootstrap') return collect(me);
    const ted = Store.membersList().find(m =>
      (m.firstName || '').trim().toLowerCase() === 'ted' &&
      (m.lastName  || '').trim().toLowerCase() === 'yoo'
    );
    return ted ? collect(ted) : [];
  },

  render() {
    if (!Auth.canAccessVault()) return;
    if (this.section === 'family')    this.renderFamily();
    if (this.section === 'finance')   this.renderFinance();
    if (this.section === 'benefits')  this.renderBenefits();
    if (this.section === 'home')      this.renderHome();
    if (this.section === 'documents') DocumentsView.render();
  },

  // ---------------- Family section ----------------
  renderFamily() {
    const host = $('#vault-family');
    const ids = this.householdIds();
    if (!ids.length) {
      host.innerHTML = '<p class="muted" style="padding:24px; text-align:center;">No household members linked to your account yet. Link yourself to a member in Members → edit the row, or seed Ted/Doan/Olive/Harvey first.</p>';
      return;
    }
    // Order: self → spouse → children oldest-first.
    const me = Auth.current;
    const members = ids.map(id => Store.byId(id)).filter(Boolean);
    members.sort((a, b) => {
      if (me && me !== 'admin-bootstrap') {
        if (a.id === me.id) return -1;
        if (b.id === me.id) return 1;
        if (a.id === me.spouseId) return -1;
        if (b.id === me.spouseId) return 1;
      }
      return (a.birthday || '9999').localeCompare(b.birthday || '9999');
    });
    host.innerHTML = members.map(m => this.renderMemberCard(m)).join('');
    host.querySelectorAll('[data-vault-edit]').forEach(btn => {
      on(btn, 'click', () => this.startEditMember(btn.dataset.vaultEdit));
    });
  },

  renderMemberCard(m) {
    return `
      <article class="vault-card" data-mid="${m.id}">
        <header class="vault-card-head">
          <div class="vault-card-photo is-${m.gender}" ${m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : ''}>${m.photo ? '' : Silhouettes.for(m)}</div>
          <div class="vault-card-id">
            <h3>${escape(displayName(m))}</h3>
            <p class="muted small">${m.birthday ? formatDate(m.birthday) : 'No birthday'}${m.dateOfDeath ? ` — ${formatDate(m.dateOfDeath)}` : ''}</p>
          </div>
          <button class="btn btn-secondary btn-sm" data-vault-edit="${m.id}">Edit</button>
        </header>
        <div class="vault-card-body" data-vault-view="${m.id}">${this.renderMemberView(m)}</div>
        <form class="vault-card-edit" data-vault-form="${m.id}" hidden></form>
      </article>`;
  },

  renderMemberView(m) {
    const p = m.private || {};
    const rows = [];
    const dls = p.driversLicenses || [];
    if (dls.length) {
      dls.forEach(dl => rows.push(['🪪', `${dl.state || '—'} Driver's License`, dl.number || '—']));
    } else {
      rows.push(['🪪', "Driver's License", '—']);
    }
    rows.push(['📘', 'Passport', p.passport || '—']);
    rows.push(['✈️', 'Known Traveler #', p.ktn || '—']);
    rows.push(['🎁', 'Rapid Rewards', p.rapidRewards || '—']);
    // Instagram renders as a clickable link to https://www.instagram.com/<handle>.
    // The tuple value here is raw HTML (the renderer below special-cases this
    // row by skipping the escape() call), so any handle must be escaped here.
    const igHandle = (p.instagram || '').replace(/^@/, '').trim();
    const igHtml = igHandle
      ? `<a href="https://www.instagram.com/${encodeURIComponent(igHandle)}" target="_blank" rel="noopener">@${escape(igHandle)}</a>`
      : '—';
    rows.push(['📸', 'Instagram', igHtml, /*isHtml*/ true]);
    const b = p.birth || {};
    const formatTime = (t) => {
      if (!t) return '';
      const m = /^(\d{2}):(\d{2})$/.exec(t);
      if (!m) return t;
      let h = +m[1]; const mm = m[2];
      const ap = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${mm} ${ap}`;
    };
    const weightStr = b.weightLbs || b.weightOz ? `${b.weightLbs || 0} lbs ${b.weightOz || 0} oz` : '';
    const lengthStr = b.lengthIn ? `${b.lengthIn}"` : '';
    const bits = [
      b.place    && `📍 ${b.place}`,
      b.hospital && `🏥 ${b.hospital}`,
      b.time     && `🕐 ${formatTime(b.time)}`,
      weightStr  && `⚖️ ${weightStr}`,
      lengthStr  && `📏 ${lengthStr}`,
    ].filter(Boolean);
    const birthValue = bits.length || b.notes
      ? `<div class="vault-birth">${bits.map(x => `<span>${escape(x)}</span>`).join('')}${b.notes ? `<div class="muted small" style="margin-top:6px;">${escape(b.notes)}</div>` : ''}</div>`
      : '—';
    const gdriveValue = p.googleDrive
      ? `<a href="${escape(safeHttpUrl(p.googleDrive))}" target="_blank" rel="noopener">${escape(p.googleDrive)}</a>`
      : '—';
    // v4.49: Health & Legacy locker. Renders as a separate block under
    // the existing kv grid so emergency info doesn't get lost among the
    // member's other private fields. Blank when no health data is on
    // record, to avoid an empty block for childhood / extended-family
    // members where the locker would just be empty rows.
    const h = p.health || {};
    const ec = h.emergencyContact || {};
    const pd = h.primaryDoctor || {};
    // v4.57: the Health & legacy section now ALWAYS renders, because Blood type
    // is always shown on the card (— when unset) for discoverability. The other
    // rows (allergies, medications, contacts) stay conditional on having a value.
    const healthBlock = `
      <section class="vault-health">
        <h4 class="vault-health-title">Health &amp; legacy</h4>
        <dl class="vault-kv vault-kv-health">
          <div><dt><span class="kv-emoji" aria-hidden="true">🩸</span>Blood type</dt><dd>${h.bloodType ? escape(h.bloodType) : '—'}</dd></div>
          ${h.allergies   ? `<div style="grid-column: 1 / -1;"><dt><span class="kv-emoji" aria-hidden="true">⚠️</span>Allergies</dt><dd>${escape(h.allergies).replace(/\n/g, '<br>')}</dd></div>` : ''}
          ${h.medications ? `<div style="grid-column: 1 / -1;"><dt><span class="kv-emoji" aria-hidden="true">💊</span>Medications</dt><dd>${escape(h.medications).replace(/\n/g, '<br>')}</dd></div>` : ''}
          ${(ec.name || ec.phone || ec.relationship) ? `
            <div style="grid-column: 1 / -1;">
              <dt><span class="kv-emoji" aria-hidden="true">📞</span>Emergency contact</dt>
              <dd>${[ec.name, ec.relationship ? `(${ec.relationship})` : '', ec.phone].filter(Boolean).map(s => escape(s)).join(' · ')}</dd>
            </div>` : ''}
          ${(pd.name || pd.practice || pd.phone) ? `
            <div style="grid-column: 1 / -1;">
              <dt><span class="kv-emoji" aria-hidden="true">👩‍⚕️</span>Primary doctor</dt>
              <dd>${[pd.name, pd.practice, pd.phone].filter(Boolean).map(s => escape(s)).join(' · ')}</dd>
            </div>` : ''}
        </dl>
      </section>`;

    return `<dl class="vault-kv">
      ${rows.map(([emoji, label, value, isHtml]) => `
        <div>
          <dt><span class="kv-emoji" aria-hidden="true">${emoji}</span>${escape(label)}</dt>
          <dd>${isHtml ? value : escape(value)}</dd>
        </div>`).join('')}
      <div>
        <dt><span class="kv-emoji" aria-hidden="true">💾</span>Google Drive</dt>
        <dd>${gdriveValue}</dd>
      </div>
      <div style="grid-column: 1 / -1;">
        <dt><span class="kv-emoji" aria-hidden="true">👶</span>Birth details</dt>
        <dd>${birthValue}</dd>
      </div>
    </dl>
    ${healthBlock}`;
  },

  startEditMember(mid) {
    const m = Store.byId(mid); if (!m) return;
    const card = document.querySelector(`.vault-card[data-mid="${mid}"]`); if (!card) return;
    const viewBody = card.querySelector('[data-vault-view]');
    const form = card.querySelector('[data-vault-form]');
    viewBody.hidden = true;
    form.hidden = false;
    form.innerHTML = this.renderEditForm(m);
    on(form.querySelector('[data-action=save]'),   'click', () => this.saveMember(mid));
    on(form.querySelector('[data-action=cancel]'), 'click', () => {
      viewBody.hidden = false; form.hidden = true; form.innerHTML = '';
    });
    on(form.querySelector('[data-action=add-dl]'), 'click', () => {
      const wrap = form.querySelector('[data-role=dl-list]');
      wrap.insertAdjacentHTML('beforeend', this.renderDLRow({ state: '', number: '' }));
      this.wireDLRemovers(form);
    });
    this.wireDLRemovers(form);
  },

  wireDLRemovers(form) {
    form.querySelectorAll('[data-action=remove-dl]').forEach(btn => {
      btn.onclick = () => btn.closest('.vault-dl-row').remove();
    });
  },

  renderDLRow(dl) {
    return `<div class="vault-dl-row">
      <input name="dl-state"  placeholder="ST" maxlength="3" value="${escape(dl.state  || '')}" />
      <input name="dl-number" placeholder="License number" value="${escape(dl.number || '')}" />
      <button type="button" class="btn btn-ghost btn-sm vault-row-remove" data-action="remove-dl" aria-label="Remove">×</button>
    </div>`;
  },

  renderEditForm(m) {
    const p = m.private;
    const b = p.birth;
    const dls = p.driversLicenses.length ? p.driversLicenses : [{ state: '', number: '' }];
    return `
      <fieldset class="vault-edit-fieldset">
        <legend>🪪 Driver's Licenses</legend>
        <div data-role="dl-list" class="vault-dl-list">${dls.map(dl => this.renderDLRow(dl)).join('')}</div>
        <button type="button" class="btn btn-ghost btn-sm" data-action="add-dl">+ Add another state</button>
      </fieldset>
      <div class="vault-edit-grid">
        <label class="vault-edit-field">
          <span class="vault-edit-label">📘 Passport #</span>
          <input name="passport" value="${escape(p.passport)}" />
        </label>
        <label class="vault-edit-field">
          <span class="vault-edit-label">✈️ Known Traveler #</span>
          <input name="ktn" value="${escape(p.ktn)}" />
        </label>
        <label class="vault-edit-field">
          <span class="vault-edit-label">🎁 Rapid Rewards</span>
          <input name="rapidRewards" value="${escape(p.rapidRewards)}" />
        </label>
        <label class="vault-edit-field">
          <span class="vault-edit-label">📸 Instagram</span>
          <input name="instagram" placeholder="username (no @)" value="${escape(p.instagram)}" />
        </label>
        <label class="vault-edit-field" style="grid-column: 1 / -1;">
          <span class="vault-edit-label">💾 Google Drive</span>
          <input name="googleDrive" type="url" placeholder="https://drive.google.com/…" value="${escape(p.googleDrive || '')}" />
        </label>
      </div>
      <fieldset class="vault-edit-fieldset">
        <legend>👶 Birth details</legend>
        <div class="vault-edit-grid">
          <label class="vault-edit-field">
            <span class="vault-edit-label">Place of birth</span>
            <input name="birth-place" placeholder="City, State" value="${escape(b.place)}" />
          </label>
          <label class="vault-edit-field">
            <span class="vault-edit-label">Hospital</span>
            <input name="birth-hospital" value="${escape(b.hospital)}" />
          </label>
          <label class="vault-edit-field">
            <span class="vault-edit-label">Time of birth</span>
            <input name="birth-time" type="time" value="${escape(b.time)}" />
          </label>
          <label class="vault-edit-field">
            <span class="vault-edit-label">Weight</span>
            <div class="vault-unit-row">
              <input name="birth-weight-lbs" type="number" min="0" step="1" placeholder="0" value="${escape(b.weightLbs || '')}" />
              <span class="vault-unit-suffix">lbs</span>
              <input name="birth-weight-oz" type="number" min="0" max="15.9" step="0.1" placeholder="0" value="${escape(b.weightOz || '')}" />
              <span class="vault-unit-suffix">oz</span>
            </div>
          </label>
          <label class="vault-edit-field">
            <span class="vault-edit-label">Length</span>
            <div class="vault-unit-row">
              <input name="birth-length-in" type="number" min="0" max="100" step="0.25" placeholder="0" value="${escape(b.lengthIn || '')}" />
              <span class="vault-unit-suffix">in</span>
            </div>
          </label>
          <label class="vault-edit-field" style="grid-column: 1 / -1;">
            <span class="vault-edit-label">Notes</span>
            <textarea name="birth-notes" rows="2" placeholder="Anything else worth remembering">${escape(b.notes)}</textarea>
          </label>
        </div>
      </fieldset>
      <fieldset class="vault-edit-fieldset">
        <legend>🩸 Health &amp; legacy</legend>
        <div class="vault-edit-grid">
          <label class="vault-edit-field">
            <span class="vault-edit-label">Blood type</span>
            <select name="health-bloodType">
              <option value="">—</option>
              ${['O+','O−','A+','A−','B+','B−','AB+','AB−','Unknown'].map(bt => `<option value="${escape(bt)}" ${(p.health?.bloodType || '') === bt ? 'selected' : ''}>${bt}</option>`).join('')}
            </select>
          </label>
        </div>
        <label class="vault-edit-field" style="margin-top:8px;">
          <span class="vault-edit-label">⚠️ Allergies <span class="muted small">(one per line)</span></span>
          <textarea name="health-allergies" rows="2" placeholder="e.g. peanuts, penicillin">${escape(p.health?.allergies || '')}</textarea>
        </label>
        <label class="vault-edit-field">
          <span class="vault-edit-label">💊 Medications <span class="muted small">(one per line)</span></span>
          <textarea name="health-medications" rows="2" placeholder="e.g. levothyroxine 50 mcg daily">${escape(p.health?.medications || '')}</textarea>
        </label>
        <fieldset class="vault-edit-fieldset" style="margin-top:8px;">
          <legend>📞 Emergency contact</legend>
          <div class="vault-edit-grid">
            <label class="vault-edit-field"><span class="vault-edit-label">Name</span>
              <input name="health-ec-name" value="${escape(p.health?.emergencyContact?.name || '')}" />
            </label>
            <label class="vault-edit-field"><span class="vault-edit-label">Phone</span>
              <input name="health-ec-phone" type="tel" placeholder="(555) 123-4567" value="${escape(p.health?.emergencyContact?.phone || '')}" />
            </label>
            <label class="vault-edit-field"><span class="vault-edit-label">Relationship</span>
              <input name="health-ec-rel" placeholder="e.g. spouse, parent" value="${escape(p.health?.emergencyContact?.relationship || '')}" />
            </label>
          </div>
        </fieldset>
        <fieldset class="vault-edit-fieldset" style="margin-top:8px;">
          <legend>👩‍⚕️ Primary doctor</legend>
          <div class="vault-edit-grid">
            <label class="vault-edit-field"><span class="vault-edit-label">Name</span>
              <input name="health-pd-name" value="${escape(p.health?.primaryDoctor?.name || '')}" />
            </label>
            <label class="vault-edit-field"><span class="vault-edit-label">Practice</span>
              <input name="health-pd-practice" value="${escape(p.health?.primaryDoctor?.practice || '')}" />
            </label>
            <label class="vault-edit-field"><span class="vault-edit-label">Phone</span>
              <input name="health-pd-phone" type="tel" placeholder="(555) 123-4567" value="${escape(p.health?.primaryDoctor?.phone || '')}" />
            </label>
          </div>
        </fieldset>
      </fieldset>
      <div class="vault-edit-actions">
        <button class="btn btn-primary btn-sm" type="button" data-action="save">Save</button>
        <button class="btn btn-ghost btn-sm"   type="button" data-action="cancel">Cancel</button>
      </div>`;
  },

  saveMember(mid) {
    if (!Auth.canAccessVault()) return;
    const m = Store.byId(mid); if (!m) return;
    const form = document.querySelector(`[data-vault-form="${mid}"]`); if (!form) return;
    const v = (sel) => (form.querySelector(`[name="${sel}"]`)?.value || '').trim();
    const stateInputs  = [...form.querySelectorAll('input[name="dl-state"]')];
    const numberInputs = [...form.querySelectorAll('input[name="dl-number"]')];
    const dls = [];
    for (let i = 0; i < numberInputs.length; i++) {
      const num = numberInputs[i].value.trim();
      const st  = (stateInputs[i]?.value || '').trim().toUpperCase().slice(0, 3);
      if (num || st) dls.push({ id: uid('dl'), state: st, number: num });
    }
    m.private = {
      driversLicenses: dls,
      passport: v('passport'),
      ktn: v('ktn'),
      rapidRewards: v('rapidRewards'),
      instagram: v('instagram').replace(/^@/, ''),
      googleDrive: v('googleDrive'),
      birth: {
        place:     v('birth-place'),
        hospital:  v('birth-hospital'),
        time:      v('birth-time'),
        weightLbs: v('birth-weight-lbs'),
        weightOz:  v('birth-weight-oz'),
        lengthIn:  v('birth-length-in'),
        notes:     v('birth-notes'),
      },
      // v4.49: Health & Legacy locker fields. Phones go through the same
      // (XXX) XXX-XXXX formatter as other phone fields in the app.
      health: {
        bloodType:   v('health-bloodType'),
        allergies:   v('health-allergies'),
        medications: v('health-medications'),
        emergencyContact: {
          name:         v('health-ec-name'),
          phone:        formatPhoneUS(v('health-ec-phone')),
          relationship: v('health-ec-rel'),
        },
        primaryDoctor: {
          name:     v('health-pd-name'),
          practice: v('health-pd-practice'),
          phone:    formatPhoneUS(v('health-pd-phone')),
        },
      },
    };
    Store.save();
    toast('Profile saved.');
    this.renderFamily();
  },

  // ---------------- Finance section ----------------
  // Currency formatter for balance entries. Tabular-num font in CSS keeps
  // the column aligned regardless of value width.
  fmtMoney(n) {
    const num = parseFloat(n);
    if (!isFinite(num)) return '';
    return num.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  },

  renderFinance() {
    const host = $('#vault-finance');
    const banks = Store.state.vault.banks;
    const householdMembers = this.householdIds()
      .map(id => Store.byId(id))
      .filter(Boolean);
    host.innerHTML = `
      <header class="vault-section-head">
        <h3>💳 Bank accounts</h3>
        <button class="btn btn-primary btn-sm" data-action="add-bank">+ Add bank account</button>
      </header>
      ${banks.length ? `<div class="vault-list">
        ${banks.map(b => this.renderBankRow(b, householdMembers)).join('')}
      </div>` : '<p class="muted" style="padding:24px; text-align:center;">No bank accounts yet. Click + Add bank account to start.</p>'}
    `;
    on(host.querySelector('[data-action=add-bank]'), 'click', () => this.addBank());
    host.querySelectorAll('.vault-row').forEach(row => this.wireBankRow(row));
    this.enableDragReorder(host.querySelector('.vault-list'), 'data-bid', (newIds) => {
      Store.state.vault.banks = this.reorderById(Store.state.vault.banks, newIds);
      Store.save();
    });
  },

  // Bank row view + edit form. The "title" is "Bank — Nickname" so a single
  // glance distinguishes "Chase — Joint checking" from "Chase — Olive's 529".
  renderBankRow(b, householdMembers) {
    const holderNames = (b.holderIds || [])
      .map(id => Store.byId(id))
      .filter(Boolean)
      .map(m => displayName(m));
    const title = b.bankName
      ? (b.nickname ? `${b.bankName} — ${b.nickname}` : b.bankName)
      : 'Unnamed bank';
    const historyView = this.renderBalanceHistoryView(b);
    const historyEdit = this.renderBalanceHistoryEdit(b);
    return `
      <div class="vault-row" data-bid="${b.id}">
        ${this.renderDragHandle()}
        <div class="vault-row-view" data-role="view">
          <div class="vault-row-main">
            <div class="vault-row-title vault-bank-title">${escape(title)}</div>
            ${b.accountType ? `<div class="vault-bank-type"><span class="bank-type-pill ${b.accountType}">${capitalize(b.accountType)}</span></div>` : ''}
            <dl class="vault-bank-details">
              ${b.accountNumber ? `<div><dt><span class="kv-emoji">#️⃣</span>Account number</dt><dd class="masked-number" title="Only the last 4 digits are shown for security.">${escape(maskAccountNumber(b.accountNumber))}</dd></div>` : ''}
              ${b.routingNumber ? `<div><dt><span class="kv-emoji">🏦</span>Routing number</dt><dd class="masked-number" title="Only the last 4 digits are shown for security.">${escape(maskAccountNumber(b.routingNumber))}</dd></div>` : ''}
              ${holderNames.length ? `<div><dt><span class="kv-emoji">👥</span>Account holder${holderNames.length > 1 ? 's' : ''}</dt><dd>${escape(holderNames.join(', '))}</dd></div>` : ''}
            </dl>
            ${b.notes ? `<div class="vault-bank-notes muted">📝 ${escape(b.notes)}</div>` : ''}
            ${historyView}
          </div>
          <div class="vault-row-actions">
            <button class="btn btn-ghost btn-sm" data-action="edit-bank">Edit</button>
            <button class="btn btn-danger-ghost btn-sm" data-action="delete-bank">Delete</button>
          </div>
        </div>
        <form class="vault-row-edit" data-role="edit" hidden>
          <div class="vault-edit-grid">
            <label class="vault-edit-field"><span class="vault-edit-label">Bank name</span><input name="bankName" value="${escape(b.bankName || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Nickname <span class="muted small">(optional)</span></span><input name="nickname" placeholder="e.g. Joint checking" value="${escape(b.nickname || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Account type</span>
              <select name="accountType">
                <option value="checking" ${b.accountType === 'checking' ? 'selected' : ''}>Checking</option>
                <option value="savings"  ${b.accountType === 'savings'  ? 'selected' : ''}>Savings</option>
                <option value="credit"   ${b.accountType === 'credit'   ? 'selected' : ''}>Credit card</option>
                <option value="other"    ${b.accountType === 'other'    ? 'selected' : ''}>Other</option>
              </select>
            </label>
            <label class="vault-edit-field"><span class="vault-edit-label">Account number</span><input name="accountNumber" value="" placeholder="${b.accountNumber ? '••••' + escape(b.accountNumber.slice(-4)) : 'e.g. 123456789'}" /><span class="muted small" style="display:block; margin-top:4px;">${b.accountNumber ? escape(maskAccountHint(b.accountNumber)) : ''}</span></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Routing number</span><input name="routingNumber" value="" placeholder="${b.routingNumber ? '••••' + escape(b.routingNumber.slice(-4)) : 'e.g. 021000021'}" /><span class="muted small" style="display:block; margin-top:4px;">${b.routingNumber ? escape(maskAccountHint(b.routingNumber)) : ''}</span></label>
          </div>
          <fieldset class="vault-edit-fieldset">
            <legend>Account holder(s) <span class="muted small">— pick one or more</span></legend>
            ${householdMembers.length
              ? `<div class="vault-holder-grid">
                  ${householdMembers.map(m => `
                    <label class="vault-holder-check">
                      <input type="checkbox" name="holderIds" value="${m.id}" ${(b.holderIds || []).includes(m.id) ? 'checked' : ''} />
                      <span>${escape(displayName(m))}</span>
                    </label>`).join('')}
                </div>`
              : '<p class="muted small" style="margin:0;">No nuclear-family members resolved yet. Save without a holder for now.</p>'}
          </fieldset>
          <label class="vault-edit-field"><span class="vault-edit-label">Notes</span><textarea name="notes" rows="2">${escape(b.notes || '')}</textarea></label>
          ${historyEdit}
          <div class="vault-edit-actions">
            <button class="btn btn-primary btn-sm" type="button" data-action="save-bank">Save</button>
            <button class="btn btn-ghost btn-sm"   type="button" data-action="cancel-bank">Cancel</button>
          </div>
        </form>
      </div>`;
  },

  // Read-side balance history. Always shows the latest entry inline; the
  // full list is collapsed behind a <details> so old entries don't dominate
  // a tall stack of accounts.
  renderBalanceHistoryView(b) {
    const entries = [...(b.balanceHistory || [])].sort((a, z) => (z.date || '').localeCompare(a.date || ''));
    if (!entries.length) return '';
    const latest = entries[0];
    return `
      <div class="vault-balance-summary">
        <div class="vault-balance-latest">
          <span class="vault-balance-label">Latest balance:</span>
          <strong class="vault-balance-value">${escape(this.fmtMoney(latest.amount))}</strong>
          <span class="muted small">as of ${escape(latest.date ? formatDate(latest.date) : '—')}</span>
        </div>
        ${entries.length > 1 ? `<details class="vault-balance-log">
          <summary class="muted small">View history (${entries.length} entries)</summary>
          <table class="vault-balance-table">
            <thead><tr><th>Date</th><th>Amount</th><th>Notes</th></tr></thead>
            <tbody>
              ${entries.map(e => `<tr>
                <td>${escape(e.date ? formatDate(e.date) : '—')}</td>
                <td class="vault-balance-value">${escape(this.fmtMoney(e.amount))}</td>
                <td class="muted small">${escape(e.notes || '')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </details>` : ''}
      </div>`;
  },

  // Edit-side balance history. Each existing entry is its own row with a
  // remove button; the "Add entry" form at the bottom appends a fresh row
  // without a save round-trip (so the user can queue several before hitting
  // Save on the parent bank form).
  renderBalanceHistoryEdit(b) {
    const entries = [...(b.balanceHistory || [])].sort((a, z) => (z.date || '').localeCompare(a.date || ''));
    return `
      <fieldset class="vault-edit-fieldset">
        <legend>📈 Balance history</legend>
        <div data-role="balance-list" class="vault-balance-edit-list">
          ${entries.map(e => this.renderBalanceEditRow(e)).join('')}
        </div>
        <div class="vault-balance-add-row">
          <input type="date" data-role="new-balance-date" />
          <input type="number" step="0.01" placeholder="$ Amount" data-role="new-balance-amount" />
          <input type="text"  placeholder="Notes (optional)"     data-role="new-balance-notes" />
          <button type="button" class="btn btn-secondary btn-sm" data-action="add-balance-entry">+ Add</button>
        </div>
      </fieldset>`;
  },

  renderBalanceEditRow(e) {
    return `<div class="vault-balance-edit-row" data-eid="${e.id}">
      <input type="date" name="be-date"   value="${escape(e.date || '')}" />
      <input type="number" step="0.01" name="be-amount" value="${escape(e.amount || '')}" placeholder="0.00" />
      <input type="text"  name="be-notes" value="${escape(e.notes || '')}" placeholder="Notes" />
      <button type="button" class="btn btn-ghost btn-sm vault-row-remove" data-action="remove-balance-entry" aria-label="Remove">×</button>
    </div>`;
  },

  wireBalanceList(form) {
    const list = form.querySelector('[data-role=balance-list]');
    if (!list) return;
    list.querySelectorAll('[data-action=remove-balance-entry]').forEach(btn => {
      btn.onclick = () => btn.closest('.vault-balance-edit-row').remove();
    });
    const addBtn = form.querySelector('[data-action=add-balance-entry]');
    on(addBtn, 'click', () => {
      const date    = form.querySelector('[data-role=new-balance-date]').value;
      const amount  = form.querySelector('[data-role=new-balance-amount]').value;
      const notes   = form.querySelector('[data-role=new-balance-notes]').value;
      if (!date && !amount) { toast('Enter a date or amount.', 'warn'); return; }
      list.insertAdjacentHTML('afterbegin', this.renderBalanceEditRow({ id: uid('be'), date, amount, notes }));
      form.querySelector('[data-role=new-balance-date]').value = '';
      form.querySelector('[data-role=new-balance-amount]').value = '';
      form.querySelector('[data-role=new-balance-notes]').value = '';
      this.wireBalanceList(form);
    });
  },

  wireBankRow(row) {
    const bid = row.dataset.bid;
    const view = row.querySelector('[data-role=view]');
    const edit = row.querySelector('[data-role=edit]');
    on(row.querySelector('[data-action=edit-bank]'),    'click', () => { view.hidden = true; edit.hidden = false; this.wireBalanceList(edit); });
    on(row.querySelector('[data-action=cancel-bank]'),  'click', () => { view.hidden = false; edit.hidden = true; });
    on(row.querySelector('[data-action=save-bank]'),    'click', () => this.saveBank(bid));
    on(row.querySelector('[data-action=delete-bank]'),  'click', () => this.deleteBank(bid));
  },

  addBank() {
    if (!Auth.canAccessVault()) return;
    Store.state.vault.banks.push({
      id: uid('bank'),
      bankName: '', nickname: '', accountNumber: '', routingNumber: '',
      accountType: 'checking', holderIds: [], balanceHistory: [], notes: '',
    });
    Store.save();
    this.renderFinance();
    // Pop open edit on the newly-added row.
    const last = Store.state.vault.banks[Store.state.vault.banks.length - 1];
    const row = document.querySelector(`.vault-row[data-bid="${last.id}"]`);
    if (row) row.querySelector('[data-action=edit-bank]')?.click();
  },

  saveBank(bid) {
    if (!Auth.canAccessVault()) return;
    const b = Store.state.vault.banks.find(x => x.id === bid); if (!b) return;
    const row = document.querySelector(`.vault-row[data-bid="${bid}"]`);
    const v = (sel) => (row.querySelector(`[name="${sel}"]`)?.value || '').trim();
    b.bankName      = v('bankName');
    b.nickname      = v('nickname');
    b.accountType   = v('accountType') || 'checking';
    // v4.37: account + routing number inputs are blank by default to avoid
    // exposing the stored value. Only overwrite if the admin actually typed
    // a new number; leave the stored value untouched on blank submit.
    const newAcct = v('accountNumber');
    const newRtg  = v('routingNumber');
    if (newAcct) b.accountNumber = newAcct;
    if (newRtg)  b.routingNumber = newRtg;
    b.holderIds     = [...row.querySelectorAll('input[name="holderIds"]:checked')].map(i => i.value);
    b.notes         = v('notes');
    // Collect balance history rows. Skip blank rows so accidental "+ Add"
    // clicks with no values don't leave noise behind.
    const eids   = [...row.querySelectorAll('.vault-balance-edit-row')];
    b.balanceHistory = eids.map(rw => ({
      id:     rw.dataset.eid || uid('be'),
      date:   rw.querySelector('input[name="be-date"]').value,
      amount: rw.querySelector('input[name="be-amount"]').value,
      notes:  rw.querySelector('input[name="be-notes"]').value.trim(),
    })).filter(e => e.date || e.amount || e.notes);
    Store.save();
    toast('Bank account saved.');
    this.renderFinance();
  },

  deleteBank(bid) {
    if (!Auth.canAccessVault()) return;
    const b = Store.state.vault.banks.find(x => x.id === bid); if (!b) return;
    if (!confirm(`Delete ${b.bankName || 'this bank account'}?`)) return;
    Store.state.vault.banks = Store.state.vault.banks.filter(x => x.id !== bid);
    Store.save();
    this.renderFinance();
  },

  // ---------------- Benefits section ----------------
  renderBenefits() {
    const host = $('#vault-benefits');
    const items = Store.state.vault.insurances;
    const memberOptions = (selectedId) => {
      const opts = ['<option value="">(family plan / unassigned)</option>',
        ...sortMembers(Store.membersList()).map(m =>
          `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${escape(displayName(m))}</option>`)
      ];
      return opts.join('');
    };
    const kindIcon = { health: '🩺', dental: '🦷', vision: '👓', car: '🚗', other: '📄' };
    const kindLabel = { health: 'Health', dental: 'Dental', vision: 'Vision', car: 'Car insurance', other: 'Other' };
    // v4.25: the user can override the kind-based icon with a per-card emoji
    // (e.g. 🏥 for a hospital indemnity plan, 💊 for prescription, etc.).
    // Empty `i.emoji` falls back to the kind icon so older cards still render
    // their default sigil.
    const cardEmoji = (i) => i.emoji || kindIcon[i.kind] || '📄';
    host.innerHTML = `
      <header class="vault-section-head">
        <h3>🩺 Insurance &amp; benefits</h3>
        <button class="btn btn-primary btn-sm" data-action="add-ins">+ Add insurance card</button>
      </header>
      ${items.length ? `<div class="vault-list">
        ${items.map(i => `
          <div class="vault-row vault-row-ins" data-iid="${i.id}">
            ${this.renderDragHandle()}
            <div class="vault-row-view" data-role="view">
              <div class="vault-row-main">
                <div class="vault-row-title">${cardEmoji(i)} ${escape(i.insurer || 'Unnamed plan')} <span class="muted small">· ${escape(kindLabel[i.kind] || 'Other')}</span></div>
                <div class="vault-info-grid muted small">
                  ${i.policyNumber   ? `<div>📇 <strong>Member ID / Policy:</strong> ${escape(i.policyNumber)}</div>` : ''}
                  ${i.planNumber     ? `<div>📋 <strong>Plan #:</strong> ${escape(i.planNumber)}</div>` : ''}
                  ${i.groupNumber    ? `<div>👥 <strong>Group #:</strong> ${escape(i.groupNumber)}</div>` : ''}
                  ${i.naicNumber     ? `<div>🏷️ <strong>NAIC #:</strong> ${escape(i.naicNumber)}</div>` : ''}
                  ${i.phone          ? `<div>📞 ${escape(i.phone)}</div>` : ''}
                  ${i.memberId && Store.byId(i.memberId) ? `<div>👤 ${escape(displayName(Store.byId(i.memberId)))}</div>` : ''}
                  ${i.effectiveDate  ? `<div>📅 <strong>Effective:</strong> ${escape(formatDate(i.effectiveDate))}</div>` : ''}
                  ${i.expirationDate ? `<div>⌛ <strong>Expires:</strong> ${escape(formatDate(i.expirationDate))}</div>` : ''}
                </div>
                ${i.notes ? `<div class="muted small" style="margin-top:6px;">${escape(i.notes)}</div>` : ''}
                ${(i.frontPhoto || i.backPhoto) ? `<div class="vault-card-photos">
                  ${i.frontPhoto ? `<button type="button" class="vault-card-photo-large" data-lightbox-src="${escape(i.frontPhoto)}" style="background-image:url('${cssUrl(i.frontPhoto)}')" title="Front of card — click to enlarge"><span class="vault-card-photo-caption">Front</span></button>` : ''}
                  ${i.backPhoto  ? `<button type="button" class="vault-card-photo-large" data-lightbox-src="${escape(i.backPhoto)}"  style="background-image:url('${cssUrl(i.backPhoto)}')"  title="Back of card — click to enlarge"><span class="vault-card-photo-caption">Back</span></button>` : ''}
                </div>` : ''}
              </div>
              <div class="vault-row-actions">
                <button class="btn btn-ghost btn-sm" data-action="edit-ins">Edit</button>
                <button class="btn btn-danger-ghost btn-sm" data-action="delete-ins">Delete</button>
              </div>
            </div>
            <form class="vault-row-edit" data-role="edit" hidden>
              <div class="vault-edit-grid">
                <label class="vault-edit-field"><span class="vault-edit-label">Emoji</span>${this.renderInsuranceEmojiSelect(i.emoji)}</label>
                <label class="vault-edit-field"><span class="vault-edit-label">Type</span>
                  <select name="kind">
                    <option value="health" ${i.kind === 'health' ? 'selected' : ''}>Health</option>
                    <option value="dental" ${i.kind === 'dental' ? 'selected' : ''}>Dental</option>
                    <option value="vision" ${i.kind === 'vision' ? 'selected' : ''}>Vision</option>
                    <option value="car"    ${i.kind === 'car'    ? 'selected' : ''}>Car insurance</option>
                    <option value="other"  ${i.kind === 'other'  ? 'selected' : ''}>Other</option>
                  </select>
                </label>
                <label class="vault-edit-field"><span class="vault-edit-label">Insurance company</span><input name="insurer" value="${escape(i.insurer || '')}" /></label>
                <label class="vault-edit-field"><span class="vault-edit-label">Member ID / Policy #</span><input name="policyNumber" value="${escape(i.policyNumber || '')}" /></label>
                <label class="vault-edit-field"><span class="vault-edit-label">Plan #</span><input name="planNumber" value="${escape(i.planNumber || '')}" /></label>
                <label class="vault-edit-field"><span class="vault-edit-label">Group #</span><input name="groupNumber" value="${escape(i.groupNumber || '')}" /></label>
                <label class="vault-edit-field"><span class="vault-edit-label">NAIC #</span><input name="naicNumber" value="${escape(i.naicNumber || '')}" /></label>
                <label class="vault-edit-field"><span class="vault-edit-label">Effective date</span><input name="effectiveDate" type="date" value="${escape(i.effectiveDate || '')}" /></label>
                <label class="vault-edit-field"><span class="vault-edit-label">Expiration date</span><input name="expirationDate" type="date" value="${escape(i.expirationDate || '')}" /></label>
                <label class="vault-edit-field"><span class="vault-edit-label">Phone</span><input name="phone" type="tel" value="${escape(i.phone || '')}" /></label>
                <label class="vault-edit-field"><span class="vault-edit-label">Covers</span><select name="memberId">${memberOptions(i.memberId)}</select></label>
                <label class="vault-edit-field" style="grid-column: 1 / -1;"><span class="vault-edit-label">Notes</span><textarea name="notes" rows="2">${escape(i.notes || '')}</textarea></label>
              </div>
              <div class="vault-photo-row">
                <div class="vault-photo-slot" data-slot="frontPhoto">
                  <div class="vault-photo-label">Front of card</div>
                  <div class="vault-photo-preview" ${i.frontPhoto ? `style="background-image:url('${cssUrl(i.frontPhoto)}')"` : ''}></div>
                  <div class="vault-photo-actions">
                    <label class="btn btn-secondary btn-sm">Upload<input type="file" accept="image/*" data-photo-target="frontPhoto" hidden /></label>
                    <button type="button" class="btn btn-ghost btn-sm" data-action="clear-photo" data-photo-target="frontPhoto">Clear</button>
                  </div>
                </div>
                <div class="vault-photo-slot" data-slot="backPhoto">
                  <div class="vault-photo-label">Back of card</div>
                  <div class="vault-photo-preview" ${i.backPhoto ? `style="background-image:url('${cssUrl(i.backPhoto)}')"` : ''}></div>
                  <div class="vault-photo-actions">
                    <label class="btn btn-secondary btn-sm">Upload<input type="file" accept="image/*" data-photo-target="backPhoto" hidden /></label>
                    <button type="button" class="btn btn-ghost btn-sm" data-action="clear-photo" data-photo-target="backPhoto">Clear</button>
                  </div>
                </div>
              </div>
              <div class="vault-edit-actions">
                <button class="btn btn-primary btn-sm" type="button" data-action="save-ins">Save</button>
                <button class="btn btn-ghost btn-sm"   type="button" data-action="cancel-ins">Cancel</button>
              </div>
            </form>
          </div>`).join('')}
      </div>` : '<p class="muted" style="padding:24px; text-align:center;">No insurance cards yet. Click + Add insurance card to start.</p>'}
    `;
    on(host.querySelector('[data-action=add-ins]'), 'click', () => this.addInsurance());
    host.querySelectorAll('.vault-row-ins').forEach(row => this.wireInsuranceRow(row));
    this.enableDragReorder(host.querySelector('.vault-list'), 'data-iid', (newIds) => {
      Store.state.vault.insurances = this.reorderById(Store.state.vault.insurances, newIds);
      Store.save();
    });
    // Photo thumbs open the in-page lightbox instead of trying to navigate
    // a new tab to the data: URL (Chrome refuses, gives a blank page).
    host.querySelectorAll('[data-lightbox-src]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.openLightbox(el.dataset.lightboxSrc);
      });
    });
  },

  wireInsuranceRow(row) {
    const iid = row.dataset.iid;
    const view = row.querySelector('[data-role=view]');
    const edit = row.querySelector('[data-role=edit]');
    on(row.querySelector('[data-action=edit-ins]'),   'click', () => { view.hidden = true; edit.hidden = false; });
    on(row.querySelector('[data-action=cancel-ins]'), 'click', () => { view.hidden = false; edit.hidden = true; });
    on(row.querySelector('[data-action=save-ins]'),   'click', () => this.saveInsurance(iid));
    on(row.querySelector('[data-action=delete-ins]'), 'click', () => this.deleteInsurance(iid));
    // photo uploads — read file, downscale, store as data URL on the insurance record.
    row.querySelectorAll('input[type=file][data-photo-target]').forEach(input => {
      input.addEventListener('change', async () => {
        const file = input.files?.[0]; if (!file) return;
        const target = input.dataset.photoTarget;
        try {
          // v4.33: dropped 1400→1000 / 0.85→0.78 to keep insurance card
          // photos legible while shrinking the archive footprint. Cards
          // render at most ~360px wide in the UI, so 1000px is still ~3x
          // headroom for the lightbox zoom.
          const dataUrl = await downscaleImageFile(file, 1000, 0.78);
          const ins = Store.state.vault.insurances.find(x => x.id === iid);
          if (ins) { ins[target] = dataUrl; Store.save(); toast('Photo attached.'); this.renderBenefits(); }
        } catch (e) {
          toast('Could not load image: ' + e.message, 'warn');
        }
      });
    });
    row.querySelectorAll('[data-action=clear-photo]').forEach(btn => {
      on(btn, 'click', () => {
        const target = btn.dataset.photoTarget;
        const ins = Store.state.vault.insurances.find(x => x.id === iid);
        if (ins) { ins[target] = ''; Store.save(); this.renderBenefits(); }
      });
    });
  },

  addInsurance() {
    if (!Auth.canAccessVault()) return;
    Store.state.vault.insurances.push({
      id: uid('ins'), kind: 'health', emoji: '', insurer: '', memberId: '',
      policyNumber: '', planNumber: '', groupNumber: '', naicNumber: '',
      effectiveDate: '', expirationDate: '',
      phone: '', frontPhoto: '', backPhoto: '', notes: '',
    });
    Store.save();
    this.renderBenefits();
    const last = Store.state.vault.insurances[Store.state.vault.insurances.length - 1];
    const row = document.querySelector(`.vault-row[data-iid="${last.id}"]`);
    if (row) row.querySelector('[data-action=edit-ins]')?.click();
  },

  saveInsurance(iid) {
    if (!Auth.canAccessVault()) return;
    const i = Store.state.vault.insurances.find(x => x.id === iid); if (!i) return;
    const row = document.querySelector(`.vault-row[data-iid="${iid}"]`);
    const v = (sel) => (row.querySelector(`[name="${sel}"]`)?.value || '').trim();
    i.kind           = v('kind') || 'other';
    i.emoji          = v('emoji');
    i.insurer        = v('insurer');
    i.policyNumber   = v('policyNumber');
    i.planNumber     = v('planNumber');
    i.groupNumber    = v('groupNumber');
    i.naicNumber     = v('naicNumber');
    i.effectiveDate  = v('effectiveDate');
    i.expirationDate = v('expirationDate');
    i.phone          = v('phone');
    i.memberId       = v('memberId');
    i.notes          = v('notes');
    Store.save();
    toast('Insurance saved.');
    this.renderBenefits();
  },

  deleteInsurance(iid) {
    if (!Auth.canAccessVault()) return;
    const i = Store.state.vault.insurances.find(x => x.id === iid); if (!i) return;
    if (!confirm(`Delete ${i.insurer || 'this insurance card'}?`)) return;
    Store.state.vault.insurances = Store.state.vault.insurances.filter(x => x.id !== iid);
    Store.save();
    this.renderBenefits();
  },

  // ---------------- Home section ----------------
  renderHome() {
    const host = $('#vault-home');
    const utils     = Store.state.vault.utilities;
    const hoas      = Store.state.vault.hoas;
    const codeSets  = Store.state.vault.codeSets;
    const neighbors = Store.state.vault.neighbors;
    host.innerHTML = `
      <header class="vault-section-head">
        <h3>⚡ Utilities</h3>
        <button class="btn btn-primary btn-sm" data-action="add-util">+ Add utility</button>
      </header>
      ${utils.length
        ? `<div class="vault-list" data-list="utilities">${utils.map(u => this.renderUtilityRow(u)).join('')}</div>`
        : '<p class="muted" style="padding:16px; text-align:center;">No utilities yet.</p>'}

      <header class="vault-section-head" style="margin-top:28px;">
        <h3>🏢 HOA / Property management</h3>
        <button class="btn btn-primary btn-sm" data-action="add-hoa">+ Add HOA</button>
      </header>
      ${hoas.length
        ? `<div class="vault-list" data-list="hoas">${hoas.map(h => this.renderHOARow(h)).join('')}</div>`
        : '<p class="muted" style="padding:16px; text-align:center;">No HOAs yet. Click + Add HOA to record management contact info.</p>'}

      <header class="vault-section-head" style="margin-top:28px;">
        <h3>🔢 Gate / amenity codes</h3>
        <button class="btn btn-primary btn-sm" data-action="add-codes">+ Add property codes</button>
      </header>
      ${codeSets.length
        ? `<div class="vault-list" data-list="codeSets">${codeSets.map(c => this.renderCodeSetRow(c)).join('')}</div>`
        : '<p class="muted" style="padding:16px; text-align:center;">No code sets yet. Click + Add property codes to record gate / pool / clubhouse codes.</p>'}

      <header class="vault-section-head" style="margin-top:28px;">
        <h3>🏘️ Neighbors</h3>
        <button class="btn btn-primary btn-sm" data-action="add-neighbor">+ Add neighbor</button>
      </header>
      ${neighbors.length
        ? `<div class="vault-list" data-list="neighbors">${neighbors.map(n => this.renderNeighborRow(n)).join('')}</div>`
        : '<p class="muted" style="padding:16px; text-align:center;">No neighbors yet. Click + Add neighbor to track names, addresses, and contacts.</p>'}
    `;
    on(host.querySelector('[data-action=add-util]'),     'click', () => this.addUtility());
    on(host.querySelector('[data-action=add-hoa]'),      'click', () => this.addHOA());
    on(host.querySelector('[data-action=add-codes]'),    'click', () => this.addCodeSet());
    on(host.querySelector('[data-action=add-neighbor]'), 'click', () => this.addNeighbor());
    host.querySelectorAll('.vault-row[data-uid]').forEach(row => this.wireUtilityRow(row));
    host.querySelectorAll('.vault-row[data-hid]').forEach(row => this.wireHOARow(row));
    host.querySelectorAll('.vault-row[data-cid]').forEach(row => this.wireCodeSetRow(row));
    host.querySelectorAll('.vault-row[data-nid]').forEach(row => this.wireNeighborRow(row));
    // Each list is keyed by data-list (utilities|hoas|codeSets|neighbors)
    // rather than position so adding a new section in between doesn't shift
    // any of the existing wiring.
    const wireList = (key, dataAttr, stateKey) => {
      const el = host.querySelector(`.vault-list[data-list="${key}"]`);
      if (!el) return;
      this.enableDragReorder(el, dataAttr, (newIds) => {
        Store.state.vault[stateKey] = this.reorderById(Store.state.vault[stateKey], newIds);
        Store.save();
      });
    };
    wireList('utilities', 'data-uid', 'utilities');
    wireList('hoas',      'data-hid', 'hoas');
    wireList('codeSets',  'data-cid', 'codeSets');
    wireList('neighbors', 'data-nid', 'neighbors');
    // Neighbor photo thumbs open the in-page lightbox (same as benefits).
    host.querySelectorAll('[data-lightbox-src]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.openLightbox(el.dataset.lightboxSrc);
      });
    });
  },

  // Curated list of utility emojis. Used to build the picker dropdown for
  // u.emoji. If a member has an older custom emoji not in this list, it
  // gets prepended as a "Custom" option so it isn't silently dropped on
  // edit.
  UTILITY_EMOJI_PRESETS: [
    ['⚡',  'Electricity'],
    ['🔥',  'Gas'],
    ['💧',  'Water'],
    ['🗑️', 'Trash / waste'],
    ['🚿',  'Sewer'],
    ['📶',  'Internet'],
    ['📺',  'Cable / TV'],
    ['📞',  'Phone / landline'],
    ['🌳',  'Yard / landscaping'],
    ['🐛',  'Pest control'],
    ['🏊',  'Pool service'],
    ['🧹',  'Cleaning'],
    ['☀️', 'Solar'],
    ['🔌',  'Power / general'],
    ['🚪',  'Security'],
  ],

  renderUtilityEmojiSelect(current) {
    const presets = this.UTILITY_EMOJI_PRESETS;
    const presetEmojis = presets.map(p => p[0]);
    const customOpt = current && !presetEmojis.includes(current)
      ? `<option value="${escape(current)}" selected>${escape(current)} (custom)</option>`
      : '';
    return `<select name="emoji" class="vault-emoji-select">
      <option value="" ${!current ? 'selected' : ''}>— No emoji —</option>
      ${customOpt}
      ${presets.map(([e, label]) =>
        `<option value="${e}" ${current === e ? 'selected' : ''}>${e}  ${escape(label)}</option>`
      ).join('')}
    </select>`;
  },

  // v4.25: curated emoji choices for insurance cards. Defaults to "— Auto —"
  // which means "fall back to the kind icon" (🩺/🦷/👓/🚗/📄) so existing
  // cards don't need to be re-edited to keep their look.
  INSURANCE_EMOJI_PRESETS: [
    ['🩺',  'Health / general medical'],
    ['🏥',  'Hospital'],
    ['💊',  'Prescription / Rx'],
    ['🦷',  'Dental'],
    ['👓',  'Vision'],
    ['👁️', 'Eye care'],
    ['🚗',  'Auto'],
    ['🏠',  'Home / renters'],
    ['🌂',  'Umbrella'],
    ['🐶',  'Pet'],
    ['✈️', 'Travel'],
    ['🦺',  'Life / accident'],
    ['🧠',  'Mental health'],
    ['🏃',  'Disability / accident'],
    ['📄',  'Other'],
  ],

  renderInsuranceEmojiSelect(current) {
    const presets = this.INSURANCE_EMOJI_PRESETS;
    const presetEmojis = presets.map(p => p[0]);
    const customOpt = current && !presetEmojis.includes(current)
      ? `<option value="${escape(current)}" selected>${escape(current)} (custom)</option>`
      : '';
    return `<select name="emoji" class="vault-emoji-select">
      <option value="" ${!current ? 'selected' : ''}>— Auto (from Type) —</option>
      ${customOpt}
      ${presets.map(([e, label]) =>
        `<option value="${e}" ${current === e ? 'selected' : ''}>${e}  ${escape(label)}</option>`
      ).join('')}
    </select>`;
  },

  // -------- Drag-to-reorder + image lightbox plumbing --------

  // The small six-dot grip injected at the top-left of every reorderable
  // row. The button is the *only* draggable element so clicks elsewhere on
  // the row keep working normally (Edit / Delete buttons, form inputs).
  // The drag image is swapped to the whole row in dragstart so the visual
  // feedback isn't just a tiny handle floating around.
  renderDragHandle() {
    return `<button type="button" class="vault-drag-handle" draggable="true" title="Drag to reorder" aria-label="Drag to reorder" tabindex="-1">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
        <circle cx="6" cy="3.5" r="1.2"/><circle cx="10" cy="3.5" r="1.2"/>
        <circle cx="6" cy="8"   r="1.2"/><circle cx="10" cy="8"   r="1.2"/>
        <circle cx="6" cy="12.5" r="1.2"/><circle cx="10" cy="12.5" r="1.2"/>
      </svg>
    </button>`;
  },

  // Wire up drag-to-reorder on a list element. Each draggable child row
  // must have:
  //   - a `.vault-drag-handle` child (the only `draggable=true` element)
  //   - the `dataAttr` attribute holding its stable id (data-bid, data-iid, etc.)
  // After the user drops, `onReorder(newIdList)` is called so the caller
  // can re-sort the underlying state array and Store.save().
  enableDragReorder(listEl, dataAttr, onReorder) {
    if (!listEl) return;
    let dragged = null;
    // Snapshot the order at dragstart so dragend can detect whether anything
    // actually changed (avoids redundant Store.save() round-trips and avoids
    // overwriting state with a no-op when the user releases outside the list).
    let startOrder = [];
    const readOrder = () => [...listEl.querySelectorAll(`.vault-row[${dataAttr}]`)]
      .map(r => r.getAttribute(dataAttr));
    listEl.querySelectorAll('.vault-drag-handle').forEach(handle => {
      handle.addEventListener('dragstart', (e) => {
        const row = handle.closest('.vault-row');
        if (!row) return;
        dragged = row;
        startOrder = readOrder();
        row.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        // Some browsers require data to be set or the drag refuses to start.
        e.dataTransfer.setData('text/plain', row.getAttribute(dataAttr) || '');
        // Use the whole row as the drag image instead of the tiny handle.
        const rect = row.getBoundingClientRect();
        try { e.dataTransfer.setDragImage(row, e.clientX - rect.left, e.clientY - rect.top); } catch {}
      });
      // Commit on dragend rather than on `drop`. dragover only calls
      // preventDefault() when the cursor is over a *different* row, so when
      // the user releases the mouse over the dragged row itself (extremely
      // common — the row is moved around the cursor) the browser never fires
      // `drop`. dragend always fires, so we read the final DOM order here.
      handle.addEventListener('dragend', () => {
        if (dragged) dragged.classList.remove('is-dragging');
        if (dragged) {
          const newIds = readOrder();
          const changed = newIds.length !== startOrder.length
            || newIds.some((id, i) => id !== startOrder[i]);
          if (changed) onReorder(newIds);
        }
        dragged = null;
        startOrder = [];
      });
    });
    listEl.addEventListener('dragover', (e) => {
      if (!dragged) return;
      const overRow = e.target.closest('.vault-row');
      if (!overRow || overRow === dragged || overRow.parentNode !== listEl) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = overRow.getBoundingClientRect();
      const isAfter = e.clientY > rect.top + rect.height / 2;
      if (isAfter) {
        if (dragged.nextElementSibling !== overRow.nextElementSibling) {
          listEl.insertBefore(dragged, overRow.nextElementSibling);
        }
      } else {
        if (dragged.nextElementSibling !== overRow) {
          listEl.insertBefore(dragged, overRow);
        }
      }
    });
    // Keep the `drop` handler as a no-op preventDefault so the browser
    // doesn't try to "open" the drop as a navigation in browsers that
    // happen to fire it (Firefox sometimes does). The actual commit lives
    // in dragend above.
    listEl.addEventListener('drop', (e) => { if (dragged) e.preventDefault(); });
  },

  // Re-sort an array (in place) to match the order of `idList`. Items
  // missing from idList stay at the end in their existing order — defensive
  // against any DOM glitch that drops a row mid-drag.
  reorderById(arr, idList) {
    const byId = new Map(arr.map(x => [x.id, x]));
    const ordered = idList.map(id => byId.get(id)).filter(Boolean);
    const leftover = arr.filter(x => !idList.includes(x.id));
    return [...ordered, ...leftover];
  },

  // Insurance-card photo lightbox. Data URLs sometimes won't open in a
  // new tab (Chrome blocks top-frame navigation to data: URIs) so we
  // render the full-size image into an in-page overlay instead.
  openLightbox(src) {
    const el = $('#vault-lightbox');
    el.querySelector('img').src = src;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
  },
  closeLightbox() {
    const el = $('#vault-lightbox');
    el.hidden = true;
    el.querySelector('img').src = '';
    document.body.style.overflow = '';
  },

  // -------- Utility (formatted like HOA card, with emoji prefix on name) --------
  renderUtilityRow(u) {
    const titlePrefix = u.emoji ? `${u.emoji} ` : '';
    const websiteHref = safeHttpUrl(u.website);
    return `
      <div class="vault-row" data-uid="${u.id}">
        ${this.renderDragHandle()}
        <div class="vault-row-view" data-role="view">
          <div class="vault-row-main">
            <div class="vault-row-title">${escape(titlePrefix)}${escape(u.name || 'Unnamed utility')}</div>
            <div class="vault-info-grid muted small" style="margin-top:6px;">
              ${u.website       ? `<div>🌐 <a href="${escape(websiteHref)}" target="_blank" rel="noopener">${escape(u.website)}</a></div>` : ''}
              ${u.phone         ? `<div>📞 ${escape(u.phone)}</div>` : ''}
              ${u.accountNumber ? `<div>#️⃣ <strong>Account:</strong> <span class="masked-number" title="Only the last 4 digits are shown for security.">${escape(maskAccountNumber(u.accountNumber))}</span></div>` : ''}
            </div>
            ${u.notes ? `<div class="muted small" style="margin-top:6px;">${escape(u.notes)}</div>` : ''}
          </div>
          <div class="vault-row-actions">
            <button class="btn btn-ghost btn-sm" data-action="edit-util">Edit</button>
            <button class="btn btn-danger-ghost btn-sm" data-action="delete-util">Delete</button>
          </div>
        </div>
        <form class="vault-row-edit" data-role="edit" hidden>
          <div class="vault-edit-grid">
            <label class="vault-edit-field"><span class="vault-edit-label">Emoji</span>${this.renderUtilityEmojiSelect(u.emoji)}</label>
            <label class="vault-edit-field"><span class="vault-edit-label">Name</span><input name="name" placeholder="e.g. NV Energy" value="${escape(u.name || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Website</span><input name="website" type="url" placeholder="https://" value="${escape(u.website || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Phone</span><input name="phone" type="tel" value="${escape(u.phone || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Account #</span><input name="accountNumber" value="" placeholder="${u.accountNumber ? '••••' + escape(u.accountNumber.slice(-4)) : 'e.g. 1234567890'}" /><span class="muted small" style="display:block; margin-top:4px;">${u.accountNumber ? escape(maskAccountHint(u.accountNumber)) : ''}</span></label>
            <label class="vault-edit-field" style="grid-column: 1 / -1;"><span class="vault-edit-label">Notes</span><textarea name="notes" rows="2">${escape(u.notes || '')}</textarea></label>
          </div>
          <div class="vault-edit-actions">
            <button class="btn btn-primary btn-sm" type="button" data-action="save-util">Save</button>
            <button class="btn btn-ghost btn-sm"   type="button" data-action="cancel-util">Cancel</button>
          </div>
        </form>
      </div>`;
  },

  wireUtilityRow(row) {
    const uid_ = row.dataset.uid;
    const view = row.querySelector('[data-role=view]');
    const edit = row.querySelector('[data-role=edit]');
    on(row.querySelector('[data-action=edit-util]'),   'click', () => { view.hidden = true; edit.hidden = false; });
    on(row.querySelector('[data-action=cancel-util]'), 'click', () => { view.hidden = false; edit.hidden = true; });
    on(row.querySelector('[data-action=save-util]'),   'click', () => this.saveUtility(uid_));
    on(row.querySelector('[data-action=delete-util]'), 'click', () => this.deleteUtility(uid_));
  },

  addUtility() {
    if (!Auth.canAccessVault()) return;
    Store.state.vault.utilities.push({ id: uid('util'), emoji: '', name: '', website: '', phone: '', accountNumber: '', notes: '' });
    Store.save();
    this.renderHome();
    const last = Store.state.vault.utilities[Store.state.vault.utilities.length - 1];
    const row = document.querySelector(`.vault-row[data-uid="${last.id}"]`);
    if (row) row.querySelector('[data-action=edit-util]')?.click();
  },

  saveUtility(uid_) {
    if (!Auth.canAccessVault()) return;
    const u = Store.state.vault.utilities.find(x => x.id === uid_); if (!u) return;
    const row = document.querySelector(`.vault-row[data-uid="${uid_}"]`);
    const v = (sel) => (row.querySelector(`[name="${sel}"]`)?.value || '').trim();
    u.emoji         = v('emoji');
    u.name          = v('name');
    u.website       = v('website');
    u.phone         = v('phone');
    // v4.37: same blank-preserves-existing rule as bank accounts.
    const newAcct = v('accountNumber');
    if (newAcct) u.accountNumber = newAcct;
    u.notes         = v('notes');
    Store.save();
    toast('Utility saved.');
    this.renderHome();
  },

  deleteUtility(uid_) {
    if (!Auth.canAccessVault()) return;
    const u = Store.state.vault.utilities.find(x => x.id === uid_); if (!u) return;
    if (!confirm(`Delete ${u.name || 'this utility'}?`)) return;
    Store.state.vault.utilities = Store.state.vault.utilities.filter(x => x.id !== uid_);
    Store.save();
    this.renderHome();
  },

  // -------- HOAs (list) --------
  renderHOARow(h) {
    const websiteHref = safeHttpUrl(h.website);
    const hasAny = h.name || h.contact || h.address || h.email || h.phone;
    return `
      <div class="vault-row" data-hid="${h.id}">
        ${this.renderDragHandle()}
        <div class="vault-row-view" data-role="view">
          ${hasAny ? `
            <div class="vault-row-main">
              ${h.propertyLabel ? `<div class="vault-row-eyebrow">${escape(h.propertyLabel)}</div>` : ''}
              <div class="vault-row-title">${escape(h.name || 'HOA')}</div>
              ${h.contact || h.title ? `<div class="muted small" style="margin-top:4px;">${escape([h.contact, h.title].filter(Boolean).join(' · '))}</div>` : ''}
              ${h.address ? `<div class="muted small" style="white-space:pre-line;">${escape(h.address)}</div>` : ''}
              <div class="vault-info-grid muted small" style="margin-top:6px;">
                ${h.phone   ? `<div>📞 ${escape(h.phone)}${h.fax ? ` · fax ${escape(h.fax)}` : ''}</div>` : ''}
                ${h.website ? `<div>🌐 <a href="${escape(websiteHref)}" target="_blank" rel="noopener">${escape(h.website)}</a></div>` : ''}
                ${h.email   ? `<div>✉️ ${escape(h.email)}</div>` : ''}
              </div>
              ${h.notes ? `<div class="muted small" style="margin-top:6px;">${escape(h.notes)}</div>` : ''}
            </div>
          ` : `<div class="muted small" style="padding:8px;">No HOA info yet — click Edit to add.</div>`}
          <div class="vault-row-actions">
            <button class="btn btn-ghost btn-sm" data-action="edit-hoa">Edit</button>
            <button class="btn btn-danger-ghost btn-sm" data-action="delete-hoa">Delete</button>
          </div>
        </div>
        <form class="vault-row-edit" data-role="edit" hidden>
          <div class="vault-edit-grid">
            <label class="vault-edit-field"><span class="vault-edit-label">Property label <span class="muted small">(e.g. "Primary home", "Lake house")</span></span><input name="hoa-propertyLabel" placeholder="Primary home" value="${escape(h.propertyLabel || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">HOA / Property name</span><input name="hoa-name" value="${escape(h.name || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Contact person</span><input name="hoa-contact" value="${escape(h.contact || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Title</span><input name="hoa-title" value="${escape(h.title || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Phone</span><input name="hoa-phone" type="tel" value="${escape(h.phone || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Fax</span><input name="hoa-fax" value="${escape(h.fax || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Email</span><input name="hoa-email" type="email" value="${escape(h.email || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Website</span><input name="hoa-website" type="url" placeholder="https://" value="${escape(h.website || '')}" /></label>
            <label class="vault-edit-field" style="grid-column: 1 / -1;"><span class="vault-edit-label">Address</span><textarea name="hoa-address" rows="2">${escape(h.address || '')}</textarea></label>
            <label class="vault-edit-field" style="grid-column: 1 / -1;"><span class="vault-edit-label">Notes</span><textarea name="hoa-notes" rows="2">${escape(h.notes || '')}</textarea></label>
          </div>
          <div class="vault-edit-actions">
            <button class="btn btn-primary btn-sm" type="button" data-action="save-hoa">Save</button>
            <button class="btn btn-ghost btn-sm"   type="button" data-action="cancel-hoa">Cancel</button>
          </div>
        </form>
      </div>`;
  },

  wireHOARow(row) {
    const hid = row.dataset.hid;
    const view = row.querySelector('[data-role=view]');
    const edit = row.querySelector('[data-role=edit]');
    on(row.querySelector('[data-action=edit-hoa]'),   'click', () => { view.hidden = true; edit.hidden = false; });
    on(row.querySelector('[data-action=cancel-hoa]'), 'click', () => { view.hidden = false; edit.hidden = true; });
    on(row.querySelector('[data-action=save-hoa]'),   'click', () => this.saveHOA(hid));
    on(row.querySelector('[data-action=delete-hoa]'), 'click', () => this.deleteHOA(hid));
  },

  addHOA() {
    if (!Auth.canAccessVault()) return;
    Store.state.vault.hoas.push({
      id: uid('hoa'), propertyLabel: '', name: '', contact: '', title: '',
      address: '', phone: '', fax: '', website: '', email: '', notes: '',
    });
    Store.save();
    this.renderHome();
    const last = Store.state.vault.hoas[Store.state.vault.hoas.length - 1];
    const row = document.querySelector(`.vault-row[data-hid="${last.id}"]`);
    if (row) row.querySelector('[data-action=edit-hoa]')?.click();
  },

  saveHOA(hid) {
    if (!Auth.canAccessVault()) return;
    const h = Store.state.vault.hoas.find(x => x.id === hid); if (!h) return;
    const row = document.querySelector(`.vault-row[data-hid="${hid}"]`);
    const v = (sel) => (row.querySelector(`[name="${sel}"]`)?.value || '').trim();
    h.propertyLabel = v('hoa-propertyLabel');
    h.name    = v('hoa-name');
    h.contact = v('hoa-contact');
    h.title   = v('hoa-title');
    h.address = v('hoa-address');
    h.phone   = v('hoa-phone');
    h.fax     = v('hoa-fax');
    h.website = v('hoa-website');
    h.email   = v('hoa-email');
    h.notes   = v('hoa-notes');
    Store.save();
    toast('HOA saved.');
    this.renderHome();
  },

  deleteHOA(hid) {
    if (!Auth.canAccessVault()) return;
    const h = Store.state.vault.hoas.find(x => x.id === hid); if (!h) return;
    if (!confirm(`Delete ${h.name || h.propertyLabel || 'this HOA'}?`)) return;
    Store.state.vault.hoas = Store.state.vault.hoas.filter(x => x.id !== hid);
    Store.save();
    this.renderHome();
  },

  // -------- Code sets (list) --------
  renderCodeSetRow(c) {
    return `
      <div class="vault-row" data-cid="${c.id}">
        ${this.renderDragHandle()}
        <div class="vault-row-view" data-role="view">
          <div class="vault-row-main">
            ${c.propertyLabel ? `<div class="vault-row-eyebrow">${escape(c.propertyLabel)}</div>` : ''}
            <div class="vault-row-title">Gate &amp; amenity codes</div>
            <dl class="vault-kv" style="margin-top:8px;">
              <div><dt><span class="kv-emoji">🚪</span>Pedestrian gate</dt><dd>${escape(c.pedestrianGate || '—')}</dd></div>
              <div><dt><span class="kv-emoji">🚗</span>Car gate</dt><dd>${escape(c.carGate || '—')}</dd></div>
              <div><dt><span class="kv-emoji">🏊</span>Pool</dt><dd>${escape(c.pool || '—')}</dd></div>
              <div><dt><span class="kv-emoji">🏠</span>Clubhouse</dt><dd>${escape(c.clubhouse || '—')}</dd></div>
              ${(c.buildings || []).length ? `<div style="grid-column: 1 / -1;">
                <dt><span class="kv-emoji">🏢</span>Building codes</dt>
                <dd>${c.buildings.map(b => `<div><strong>${escape(b.label || '?')}:</strong> ${escape(b.code || '—')}</div>`).join('')}</dd>
              </div>` : ''}
              ${c.notes ? `<div style="grid-column: 1 / -1;"><dt>Notes</dt><dd>${escape(c.notes)}</dd></div>` : ''}
            </dl>
          </div>
          <div class="vault-row-actions">
            <button class="btn btn-ghost btn-sm" data-action="edit-codes">Edit</button>
            <button class="btn btn-danger-ghost btn-sm" data-action="delete-codes">Delete</button>
          </div>
        </div>
        <form class="vault-row-edit" data-role="edit" hidden>
          <label class="vault-edit-field"><span class="vault-edit-label">Property label <span class="muted small">(e.g. "Primary home", "Lake house")</span></span><input name="codes-propertyLabel" placeholder="Primary home" value="${escape(c.propertyLabel || '')}" /></label>
          <div class="vault-edit-grid">
            <label class="vault-edit-field"><span class="vault-edit-label">🚪 Pedestrian gate</span><input name="codes-pedestrianGate" value="${escape(c.pedestrianGate || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">🚗 Car gate</span><input name="codes-carGate" value="${escape(c.carGate || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">🏊 Pool</span><input name="codes-pool" value="${escape(c.pool || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">🏠 Clubhouse</span><input name="codes-clubhouse" value="${escape(c.clubhouse || '')}" /></label>
          </div>
          <fieldset class="vault-edit-fieldset">
            <legend>🏢 Building codes</legend>
            <div data-role="bld-list" class="vault-dl-list">${(c.buildings || []).map(b => this.renderBuildingRow(b)).join('')}</div>
            <button type="button" class="btn btn-ghost btn-sm" data-action="add-bld">+ Add building</button>
          </fieldset>
          <label class="vault-edit-field"><span class="vault-edit-label">Notes</span><textarea name="codes-notes" rows="2">${escape(c.notes || '')}</textarea></label>
          <div class="vault-edit-actions">
            <button class="btn btn-primary btn-sm" type="button" data-action="save-codes">Save</button>
            <button class="btn btn-ghost btn-sm"   type="button" data-action="cancel-codes">Cancel</button>
          </div>
        </form>
      </div>`;
  },

  renderBuildingRow(b) {
    return `<div class="vault-dl-row">
      <input name="bld-label" placeholder="Building #" value="${escape(b.label || '')}" />
      <input name="bld-code"  placeholder="Code" value="${escape(b.code  || '')}" />
      <button type="button" class="btn btn-ghost btn-sm vault-row-remove" data-action="remove-bld" aria-label="Remove">×</button>
    </div>`;
  },

  wireBuildingRows(scope) {
    scope.querySelectorAll('[data-action=remove-bld]').forEach(btn => {
      btn.onclick = () => btn.closest('.vault-dl-row').remove();
    });
  },

  wireCodeSetRow(row) {
    const cid = row.dataset.cid;
    const view = row.querySelector('[data-role=view]');
    const edit = row.querySelector('[data-role=edit]');
    on(row.querySelector('[data-action=edit-codes]'),   'click', () => { view.hidden = true; edit.hidden = false; this.wireBuildingRows(edit); });
    on(row.querySelector('[data-action=cancel-codes]'), 'click', () => { view.hidden = false; edit.hidden = true; });
    on(row.querySelector('[data-action=save-codes]'),   'click', () => this.saveCodeSet(cid));
    on(row.querySelector('[data-action=delete-codes]'), 'click', () => this.deleteCodeSet(cid));
    on(row.querySelector('[data-action=add-bld]'),      'click', () => {
      const wrap = row.querySelector('[data-role=bld-list]');
      wrap.insertAdjacentHTML('beforeend', this.renderBuildingRow({ label: '', code: '' }));
      this.wireBuildingRows(row);
    });
  },

  addCodeSet() {
    if (!Auth.canAccessVault()) return;
    Store.state.vault.codeSets.push({
      id: uid('cs'), propertyLabel: '',
      pedestrianGate: '', carGate: '', pool: '', clubhouse: '',
      buildings: [], notes: '',
    });
    Store.save();
    this.renderHome();
    const last = Store.state.vault.codeSets[Store.state.vault.codeSets.length - 1];
    const row = document.querySelector(`.vault-row[data-cid="${last.id}"]`);
    if (row) row.querySelector('[data-action=edit-codes]')?.click();
  },

  saveCodeSet(cid) {
    if (!Auth.canAccessVault()) return;
    const c = Store.state.vault.codeSets.find(x => x.id === cid); if (!c) return;
    const row = document.querySelector(`.vault-row[data-cid="${cid}"]`);
    const v = (sel) => (row.querySelector(`[name="${sel}"]`)?.value || '').trim();
    const labels = [...row.querySelectorAll('input[name="bld-label"]')];
    const codes  = [...row.querySelectorAll('input[name="bld-code"]')];
    const buildings = [];
    for (let i = 0; i < labels.length; i++) {
      const lbl = labels[i].value.trim();
      const cde = codes[i]?.value.trim() || '';
      if (lbl || cde) buildings.push({ id: uid('bld'), label: lbl, code: cde });
    }
    c.propertyLabel  = v('codes-propertyLabel');
    c.pedestrianGate = v('codes-pedestrianGate');
    c.carGate        = v('codes-carGate');
    c.pool           = v('codes-pool');
    c.clubhouse      = v('codes-clubhouse');
    c.buildings      = buildings;
    c.notes          = v('codes-notes');
    Store.save();
    toast('Codes saved.');
    this.renderHome();
  },

  deleteCodeSet(cid) {
    if (!Auth.canAccessVault()) return;
    const c = Store.state.vault.codeSets.find(x => x.id === cid); if (!c) return;
    if (!confirm(`Delete codes for ${c.propertyLabel || 'this property'}?`)) return;
    Store.state.vault.codeSets = Store.state.vault.codeSets.filter(x => x.id !== cid);
    Store.save();
    this.renderHome();
  },

  // -------- Neighbors (list) --------
  // Lightweight people-rolodex for the household: name, address, phone, a
  // free-form "kids" note, an optional photo, and free-form notes. Photo is
  // a downscaled JPEG data-URL (same pipeline as insurance card photos).
  renderNeighborRow(n) {
    return `
      <div class="vault-row vault-row-neighbor" data-nid="${n.id}">
        ${this.renderDragHandle()}
        <div class="vault-row-view" data-role="view">
          <div class="vault-neighbor-view">
            ${n.photo
              ? `<button type="button" class="vault-neighbor-photo" data-lightbox-src="${escape(n.photo)}" style="background-image:url('${cssUrl(n.photo)}')" title="Click to enlarge"></button>`
              : `<div class="vault-neighbor-photo is-empty" aria-hidden="true">👤</div>`}
            <div class="vault-row-main">
              <div class="vault-row-title">${escape(n.name || 'Unnamed neighbor')}</div>
              <dl class="vault-bank-details">
                ${n.address  ? `<div><dt><span class="kv-emoji">🏠</span>Address</dt><dd style="white-space:pre-line;">${escape(n.address)}</dd></div>` : ''}
                ${n.phone    ? `<div><dt><span class="kv-emoji">📞</span>Phone</dt><dd>${escape(n.phone)}</dd></div>` : ''}
                ${n.kidsNote ? `<div><dt><span class="kv-emoji">🧒</span>Kids</dt><dd>${escape(n.kidsNote)}</dd></div>` : ''}
              </dl>
              ${n.notes ? `<div class="vault-bank-notes muted">📝 ${escape(n.notes)}</div>` : ''}
            </div>
          </div>
          <div class="vault-row-actions">
            <button class="btn btn-ghost btn-sm" data-action="edit-neighbor">Edit</button>
            <button class="btn btn-danger-ghost btn-sm" data-action="delete-neighbor">Delete</button>
          </div>
        </div>
        <form class="vault-row-edit" data-role="edit" hidden>
          <div class="vault-edit-grid">
            <label class="vault-edit-field"><span class="vault-edit-label">Name</span><input name="nbr-name" placeholder="e.g. The Garcia family" value="${escape(n.name || '')}" /></label>
            <label class="vault-edit-field"><span class="vault-edit-label">Phone</span><input name="nbr-phone" type="tel" value="${escape(n.phone || '')}" /></label>
            <label class="vault-edit-field" style="grid-column: 1 / -1;"><span class="vault-edit-label">Address</span><textarea name="nbr-address" rows="2" placeholder="Street, city, state, zip">${escape(n.address || '')}</textarea></label>
            <label class="vault-edit-field" style="grid-column: 1 / -1;"><span class="vault-edit-label">Kids <span class="muted small">(names, ages, anything worth remembering)</span></span><input name="nbr-kidsNote" placeholder="e.g. Sofia (8), Mateo (5)" value="${escape(n.kidsNote || '')}" /></label>
            <label class="vault-edit-field" style="grid-column: 1 / -1;"><span class="vault-edit-label">Notes</span><textarea name="nbr-notes" rows="2">${escape(n.notes || '')}</textarea></label>
          </div>
          <div class="vault-photo-row">
            <div class="vault-photo-slot vault-photo-slot-neighbor" data-slot="photo">
              <div class="vault-photo-label">Photo</div>
              <div class="vault-photo-preview vault-photo-preview-neighbor" ${n.photo ? `style="background-image:url('${cssUrl(n.photo)}')"` : ''}></div>
              <div class="vault-photo-actions">
                <label class="btn btn-secondary btn-sm">Upload<input type="file" accept="image/*" data-photo-target="photo" hidden /></label>
                <button type="button" class="btn btn-ghost btn-sm" data-action="clear-photo" data-photo-target="photo">Clear</button>
              </div>
            </div>
          </div>
          <div class="vault-edit-actions">
            <button class="btn btn-primary btn-sm" type="button" data-action="save-neighbor">Save</button>
            <button class="btn btn-ghost btn-sm"   type="button" data-action="cancel-neighbor">Cancel</button>
          </div>
        </form>
      </div>`;
  },

  wireNeighborRow(row) {
    const nid = row.dataset.nid;
    const view = row.querySelector('[data-role=view]');
    const edit = row.querySelector('[data-role=edit]');
    on(row.querySelector('[data-action=edit-neighbor]'),   'click', () => { view.hidden = true; edit.hidden = false; });
    on(row.querySelector('[data-action=cancel-neighbor]'), 'click', () => { view.hidden = false; edit.hidden = true; });
    on(row.querySelector('[data-action=save-neighbor]'),   'click', () => this.saveNeighbor(nid));
    on(row.querySelector('[data-action=delete-neighbor]'), 'click', () => this.deleteNeighbor(nid));
    // Photo upload — read file, downscale, store as data URL.
    row.querySelectorAll('input[type=file][data-photo-target]').forEach(input => {
      input.addEventListener('change', async () => {
        const file = input.files?.[0]; if (!file) return;
        try {
          // v4.33: dropped 1400→800 / 0.85→0.80 for neighbor photos.
          // These render at ~96px on cards and ~95vw in the lightbox;
          // 800px is plenty without bloating the archive.
          const dataUrl = await downscaleImageFile(file, 800, 0.80);
          const n = Store.state.vault.neighbors.find(x => x.id === nid);
          if (n) { n.photo = dataUrl; Store.save(); toast('Photo attached.'); this.renderHome(); }
        } catch (e) {
          toast('Could not load image: ' + e.message, 'warn');
        }
      });
    });
    row.querySelectorAll('[data-action=clear-photo]').forEach(btn => {
      on(btn, 'click', () => {
        const n = Store.state.vault.neighbors.find(x => x.id === nid);
        if (n) { n.photo = ''; Store.save(); this.renderHome(); }
      });
    });
  },

  addNeighbor() {
    if (!Auth.canAccessVault()) return;
    Store.state.vault.neighbors.push({
      id: uid('nbr'), name: '', address: '', phone: '', kidsNote: '', photo: '', notes: '',
    });
    Store.save();
    this.renderHome();
    const last = Store.state.vault.neighbors[Store.state.vault.neighbors.length - 1];
    const row = document.querySelector(`.vault-row[data-nid="${last.id}"]`);
    if (row) row.querySelector('[data-action=edit-neighbor]')?.click();
  },

  saveNeighbor(nid) {
    if (!Auth.canAccessVault()) return;
    const n = Store.state.vault.neighbors.find(x => x.id === nid); if (!n) return;
    const row = document.querySelector(`.vault-row[data-nid="${nid}"]`);
    const v = (sel) => (row.querySelector(`[name="${sel}"]`)?.value || '').trim();
    n.name     = v('nbr-name');
    n.address  = v('nbr-address');
    n.phone    = v('nbr-phone');
    n.kidsNote = v('nbr-kidsNote');
    n.notes    = v('nbr-notes');
    Store.save();
    toast('Neighbor saved.');
    this.renderHome();
  },

  deleteNeighbor(nid) {
    if (!Auth.canAccessVault()) return;
    const n = Store.state.vault.neighbors.find(x => x.id === nid); if (!n) return;
    if (!confirm(`Delete ${n.name || 'this neighbor'}?`)) return;
    Store.state.vault.neighbors = Store.state.vault.neighbors.filter(x => x.id !== nid);
    Store.save();
    this.renderHome();
  },
};

// Read an image File, draw it onto a canvas downscaled to `maxDim` (longest
// v4.38: read a File into a data URL. Tiny shim around FileReader so callers
// (CropModal handoff in particular) don't need to spell out the Promise
// wrapper themselves. Resolves with the data URL; rejects on read error.
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read file'));
    r.onload  = () => resolve(r.result);
    r.readAsDataURL(file);
  });
}

// edge), and return a JPEG data URL. Used by the vault to store insurance
// card photos inline in the archive blob without bloating it with 5MB
// originals.
function downscaleImageFile(file, maxDim = 1400, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image'));
      img.onload = () => {
        const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.round(img.width * ratio);
        const h = Math.round(img.height * ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

const HistoryView = {
  render() {
    const list = $('#history-list'); if (!list) return;
    const entries = CHANGELOG;
    const current = $('#history-current-version');
    if (current) current.textContent = entries.length ? `v${entries[0].version}` : '—';
    if (entries.length) {
      list.innerHTML = entries.map(e => `
        <article class="history-entry">
          <header class="history-entry-head">
            <span class="history-version">v${escape(String(e.version))}</span>
            <span class="history-date">${escape(e.date || '')}</span>
          </header>
          <h3 class="history-title">${escape(e.title || '')}</h3>
          <ul class="history-changes">
            ${(e.changes || []).map(c => `<li>${escape(c)}</li>`).join('')}
          </ul>
        </article>
      `).join('');
    } else {
      list.innerHTML = '<p class="muted small">No history entries yet.</p>';
    }
    // Storage panel only runs for admins (the panel itself is gated by
    // data-admin-only at the CSS layer, but no point computing sizes if
    // the panel is hidden).
    if (Auth.isAdmin()) StorageView.render();
  },
};

// -------------------- STORAGE DIAGNOSTIC --------------------
// Breakdown of the in-memory state by area + a one-click compressor for
// existing photos. Built in v4.33 after the user hit Supabase's free-tier
// disk quota — photos uploaded prior to the v4.31/v4.29 sizing constants
// got encoded at 1400px / 0.85, which adds up fast across insurance cards
// and neighbor photos.
const StorageView = {
  // Recompression targets — same dim/quality as the *current* upload
  // defaults so we converge on one consistent encoding. Re-running this
  // on already-small photos is a near-no-op (encoder produces ≈same size).
  TARGETS: {
    member:     { maxDim: 480,  quality: 0.85 },
    friend:     { maxDim: 720,  quality: 0.84 },
    insurance:  { maxDim: 1000, quality: 0.78 },
    neighbor:   { maxDim: 800,  quality: 0.80 },
  },

  init() {
    on($('#btn-storage-refresh'), 'click', () => this.render());
    on($('#btn-storage-compress'), 'click', () => this.compressAll());
  },

  // Approximate the byte size of any JSON-serializable value the way it
  // would land in Postgres (close enough — Postgres's compressed JSONB is
  // usually within 20% of this, and the relative breakdown is what
  // matters).
  bytesOf(v) {
    try { return new Blob([JSON.stringify(v)]).size; } catch { return 0; }
  },

  fmt(bytes) {
    if (!bytes && bytes !== 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  },

  render() {
    if (!Auth.isAdmin()) return;
    const summary = $('#storage-summary');
    const areaEl  = $('#storage-area-table');
    const vaultEl = $('#storage-vault-table');
    const photoEl = $('#storage-photo-table');
    if (!summary || !areaEl || !vaultEl || !photoEl) return;

    const state = Store.state || {};
    const total = this.bytesOf(state);

    // 1) Headline numbers.
    summary.innerHTML = `
      <div class="storage-headline">
        <div><span class="muted small">Total state</span><strong>${this.fmt(total)}</strong></div>
        <div><span class="muted small">Members</span><strong>${Object.keys(state.members || {}).length}</strong></div>
        <div><span class="muted small">Friends</span><strong>${Object.keys(state.friends || {}).length}</strong></div>
        <div><span class="muted small">Events</span><strong>${(state.events || []).length}</strong></div>
        <div><span class="muted small">Gifts</span><strong>${(state.gifts || []).length}</strong></div>
      </div>
    `;

    // 2) Top-level area breakdown. Sorted biggest-first, with optional
    // delete affordance hinted via Notes column.
    const areaRows = Object.entries(state)
      .map(([k, v]) => {
        let count = '';
        if (Array.isArray(v)) count = v.length + ' items';
        else if (v && typeof v === 'object') count = Object.keys(v).length + ' keys';
        return { key: k, bytes: this.bytesOf(v), count };
      })
      .sort((a, b) => b.bytes - a.bytes);

    areaEl.innerHTML = `
      <table class="storage-grid">
        <thead><tr><th>Area</th><th>Size</th><th>Count</th><th>% of total</th></tr></thead>
        <tbody>
          ${areaRows.map(r => `<tr>
            <td><code>${escape(r.key)}</code></td>
            <td>${this.fmt(r.bytes)}</td>
            <td class="muted small">${escape(r.count)}</td>
            <td>${total ? ((r.bytes / total) * 100).toFixed(1) + '%' : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    // 3) Vault sub-section breakdown.
    const vault = state.vault || {};
    const vaultRows = Object.entries(vault)
      .map(([k, v]) => ({ key: k, bytes: this.bytesOf(v), count: Array.isArray(v) ? v.length : null }))
      .sort((a, b) => b.bytes - a.bytes);
    vaultEl.innerHTML = `
      <table class="storage-grid">
        <thead><tr><th>Section</th><th>Size</th><th>Items</th></tr></thead>
        <tbody>
          ${vaultRows.map(r => `<tr>
            <td><code>vault.${escape(r.key)}</code></td>
            <td>${this.fmt(r.bytes)}</td>
            <td class="muted small">${r.count == null ? '—' : r.count}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;

    // 4) Photos — count + total bytes per source. Friends and members
    // each have a single .photo; insurance cards have frontPhoto +
    // backPhoto; neighbors have .photo.
    const photoSummary = [
      this.photoStatsForMap(state.members,  'photo', 'Member photos'),
      this.photoStatsForMap(state.friends,  'photo', 'Friend photos'),
      this.photoStatsForArr(vault.insurances || [], 'frontPhoto', 'Insurance front photos'),
      this.photoStatsForArr(vault.insurances || [], 'backPhoto',  'Insurance back photos'),
      this.photoStatsForArr(vault.neighbors  || [], 'photo',      'Neighbor photos'),
    ];
    const photosTotal = photoSummary.reduce((s, r) => s + r.bytes, 0);
    photoEl.innerHTML = `
      <table class="storage-grid">
        <thead><tr><th>Source</th><th># with photo</th><th>Total bytes</th><th>Avg size</th></tr></thead>
        <tbody>
          ${photoSummary.map(r => `<tr>
            <td>${escape(r.label)}</td>
            <td class="muted small">${r.count} of ${r.total}</td>
            <td><strong>${this.fmt(r.bytes)}</strong></td>
            <td class="muted small">${r.count ? this.fmt(Math.round(r.bytes / r.count)) : '—'}</td>
          </tr>`).join('')}
          <tr><td><strong>All photos</strong></td><td></td><td><strong>${this.fmt(photosTotal)}</strong></td><td class="muted small">${photosTotal && total ? ((photosTotal / total) * 100).toFixed(0) + '% of state' : ''}</td></tr>
        </tbody>
      </table>`;
  },

  photoStatsForMap(map, key, label) {
    const all = Object.values(map || {});
    let bytes = 0, count = 0;
    for (const m of all) {
      const v = m && m[key];
      if (v && typeof v === 'string') { bytes += v.length; count++; }
    }
    return { label, count, total: all.length, bytes };
  },
  photoStatsForArr(arr, key, label) {
    let bytes = 0, count = 0;
    for (const r of (arr || [])) {
      const v = r && r[key];
      if (v && typeof v === 'string') { bytes += v.length; count++; }
    }
    return { label, count, total: (arr || []).length, bytes };
  },

  // One-click pass that walks every photo in the state, re-encodes it at
  // smaller dimensions / quality, and writes back. Reports before/after.
  // Skips photos that are already smaller than the recompressed result.
  async compressAll() {
    if (!Auth.isAdmin()) return;
    if (!confirm('Recompress every photo in the database? Existing photos may lose a bit of sharpness, but the database row will shrink. This is a one-time pass — re-running it on already-compressed photos is safe but unnecessary.')) return;
    const btn = $('#btn-storage-compress');
    if (btn) { btn.disabled = true; btn.textContent = 'Compressing…'; }
    let before = 0, after = 0, touched = 0, skipped = 0;
    const state = Store.state;

    const handle = async (host, key, target) => {
      const src = host[key];
      if (!src || typeof src !== 'string' || !src.startsWith('data:image')) return;
      before += src.length;
      try {
        const out = await recompressDataUrl(src, target.maxDim, target.quality);
        if (out && out.length < src.length * 0.95) {
          host[key] = out;
          after += out.length;
          touched++;
        } else {
          // No meaningful savings — keep the original.
          after += src.length;
          skipped++;
        }
      } catch {
        after += src.length;
        skipped++;
      }
    };

    // Members
    for (const m of Object.values(state.members || {})) {
      await handle(m, 'photo', this.TARGETS.member);
    }
    // Friends
    for (const f of Object.values(state.friends || {})) {
      await handle(f, 'photo', this.TARGETS.friend);
    }
    // Insurances (front + back)
    for (const ins of (state.vault?.insurances || [])) {
      await handle(ins, 'frontPhoto', this.TARGETS.insurance);
      await handle(ins, 'backPhoto',  this.TARGETS.insurance);
    }
    // Neighbors
    for (const n of (state.vault?.neighbors || [])) {
      await handle(n, 'photo', this.TARGETS.neighbor);
    }

    Store.save();
    // Flush immediately so the user sees the network call complete rather
    // than wait for the 1500ms debounce.
    try { await Backend.flushSaveArchive(state); } catch {}

    if (btn) { btn.disabled = false; btn.textContent = 'Compress all photos'; }
    const saved = before - after;
    toast(`${touched} photo${touched === 1 ? '' : 's'} recompressed — saved ${this.fmt(saved)} (${skipped} skipped).`);
    this.render();
  },
};

// Re-encode an existing JPEG / PNG data URL at a smaller dim + quality.
// Mirrors downscaleImageFile but takes a data URL instead of a File.
// Returns a new data URL string (or the original on any decode failure).
function recompressDataUrl(dataUrl, maxDim = 800, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(dataUrl);
    img.onload = () => {
      try {
        const ratio = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * ratio));
        const h = Math.max(1, Math.round(img.height * ratio));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch {
        resolve(dataUrl);
      }
    };
    img.src = dataUrl;
  });
}

// -------------------- PAGE EMOJIS --------------------
// Admins can pin an emoji to each page. The emoji shows in the page H2 and
// gets prepended to the corresponding nav tab so the toolbar stays in sync.
// Storage: Store.state.pageEmojis = { dashboard, tree, myfamily, calendar,
// events, gifts, admin }. Empty string clears the emoji.
const PageEmojis = {
  // Hidden input the EmojiPicker writes back into; we listen for change and
  // route the result to whichever page initiated the pick.
  _picking: null,

  init() {
    // Click any page-emoji slot → open the existing emoji popover. Capture
    // phase + stopPropagation so we beat the global "click outside → close"
    // listener registered inside EmojiPicker, which would otherwise close
    // the popover the same tick we opened it.
    document.addEventListener('click', (e) => {
      const slot = e.target.closest('[data-page-emoji]');
      if (!slot) return;
      if (!Auth.isAdmin()) return;
      e.stopPropagation();
      const page = slot.dataset.pageEmoji;
      this.openPickerFor(page, slot);
    }, true);
  },

  // Open the EmojiPicker. The picker writes into a sacrificial hidden input
  // so we can capture the chosen emoji via 'change' without modifying the
  // picker itself.
  openPickerFor(page, anchor) {
    let proxy = document.getElementById('page-emoji-proxy');
    if (!proxy) {
      proxy = document.createElement('input');
      proxy.id = 'page-emoji-proxy';
      proxy.type = 'text';
      proxy.style.position = 'absolute';
      proxy.style.opacity = '0';
      proxy.style.pointerEvents = 'none';
      proxy.style.width = '0';
      proxy.style.height = '0';
      document.body.appendChild(proxy);
      proxy.addEventListener('change', () => {
        if (this._picking) this.set(this._picking, proxy.value);
        this._picking = null;
      });
    }
    this._picking = page;
    proxy.value = '';
    EmojiPicker.open(proxy, anchor);
    // Add a small "clear" affordance once per session inside the popover.
    setTimeout(() => {
      const pop = EmojiPicker.popover; if (!pop) return;
      if (!pop.querySelector('.emoji-clear')) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'emoji-clear';
        btn.textContent = 'Clear emoji';
        btn.addEventListener('click', () => {
          if (this._picking) this.set(this._picking, '');
          this._picking = null;
          EmojiPicker.close();
        });
        pop.appendChild(btn);
      }
    }, 0);
  },

  set(page, emoji) {
    Store.state.pageEmojis = Store.state.pageEmojis || {};
    Store.state.pageEmojis[page] = emoji;
    Store.save();
    this.applyAll();
  },

  // Push the current emojis into the DOM: every page slot + every nav tab.
  applyAll() {
    const map = (Store.state && Store.state.pageEmojis) || {};
    document.querySelectorAll('[data-page-emoji]').forEach(el => {
      const page = el.dataset.pageEmoji;
      const e = map[page] || '';
      el.textContent = e;
      el.classList.toggle('is-empty', !e);
    });
    document.querySelectorAll('.nav-tab[data-view]').forEach(tab => {
      const page = tab.dataset.view;
      const e = map[page] || '';
      let prefix = tab.querySelector('.nav-emoji');
      if (!prefix) {
        prefix = document.createElement('span');
        prefix.className = 'nav-emoji';
        tab.insertBefore(prefix, tab.firstChild);
      }
      prefix.textContent = e;
      prefix.style.marginRight = e ? '6px' : '0';
    });
  },
};

// -------------------- FRIENDS TAB (Members > Friends) --------------------
// v4.35: Friends now live as a sub-tab on the Members page. Each friend
// record represents a household — primary contact + optional spouse + kids.
// Rendered as expandable list rows so the household roster is scannable
// without opening a modal. CPU-friendly: all rendering is innerHTML batches
// against in-memory Store.state, no extra Supabase queries or subscriptions
// beyond what was already in place for the old card-grid Friend Tree.
const FriendsTabView = {
  searchQuery: '',
  // v4.36: inverted semantics. We track which household ids are *collapsed*
  // instead of which are expanded — this way the default (empty set) means
  // "everything expanded", matching the user's preference for a roster-first
  // view. Expand-all clears the set; collapse-all fills it.
  collapsed: new Set(),
  init() {
    on($('#btn-friend-add'),       'click', () => FriendModal.openAdd());
    on($('#btn-friend-add-first'), 'click', () => FriendModal.openAdd());
    const search = $('#friends-search');
    if (search) {
      on(search, 'input', () => {
        this.searchQuery = (search.value || '').trim().toLowerCase();
        this.render();
      });
    }
    on($('#btn-friends-expand-toggle'), 'click', () => this.toggleAll());
    on($('#btn-friends-export'),        'click', () => AdminView.exportFriendsCSV());
  },
  list() {
    return Object.values(Store.state.friends || {});
  },
  filtered() {
    const q = this.searchQuery;
    let list = this.list();
    if (q) {
      list = list.filter(f => {
        if (friendMatchesQuery(f, q)) return true;
        if (f.spouse && friendMatchesQuery(f.spouse, q)) return true;
        return (f.kids || []).some(k => friendMatchesQuery(k, q));
      });
    }
    return sortFriends(list);
  },
  // Households with a spouse or kids are eligible to be (un)collapsed.
  // Solo friends are always "flat" so the toggle button only acts on real
  // households.
  rosterIds() {
    return this.filtered()
      .filter(f => !!f.spouse || (f.kids && f.kids.length > 0))
      .map(f => f.id);
  },
  toggleAll() {
    const ids = this.rosterIds();
    if (!ids.length) return;
    // "All currently collapsed" → expand all; otherwise collapse all.
    const allCollapsed = ids.every(id => this.collapsed.has(id));
    if (allCollapsed) this.collapsed.clear();
    else ids.forEach(id => this.collapsed.add(id));
    this.render();
  },
  render() {
    const tbody = $('#friends-rows');
    const empty = $('#friends-empty');
    if (!tbody || !empty) return;
    const list = this.filtered();
    const note = $('#friends-filter-note');
    if (note) {
      note.textContent = this.searchQuery
        ? `Showing ${list.length} friend${list.length === 1 ? '' : 's'} matching "${this.searchQuery}"`
        : `Showing all friends (${list.length})`;
    }
    if (!list.length && !this.searchQuery) {
      tbody.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    const rowsHTML = list.map(f => this.householdRowsHTML(f)).join('');
    tbody.innerHTML = rowsHTML || `<tr><td colspan="9" class="muted" style="padding:24px; text-align:center;">No friends matching "${escape(this.searchQuery)}".</td></tr>`;

    // Update the Expand/Collapse-all toggle button to reflect current state.
    const toggleBtn = $('#btn-friends-expand-toggle');
    const toggleLab = $('#btn-friends-expand-label');
    if (toggleBtn && toggleLab) {
      const ids = this.rosterIds();
      const allCollapsed = ids.length > 0 && ids.every(id => this.collapsed.has(id));
      toggleBtn.disabled = !ids.length;
      toggleBtn.title = allCollapsed ? 'Expand all households' : 'Collapse all households';
      toggleBtn.setAttribute('aria-pressed', allCollapsed ? 'false' : 'true');
      toggleLab.textContent = allCollapsed ? 'Expand all' : 'Collapse all';
    }

    tbody.querySelectorAll('[data-friend-toggle]').forEach(btn => {
      on(btn, 'click', (e) => {
        e.stopPropagation();
        const fid = btn.dataset.friendToggle;
        if (this.collapsed.has(fid)) this.collapsed.delete(fid);
        else this.collapsed.add(fid);
        this.render();
      });
    });
    tbody.querySelectorAll('[data-friend-row]').forEach(tr => {
      on(tr, 'click', (e) => {
        if (e.target.closest('button')) return;
        if (e.target.closest('a')) return;
        const fid = tr.dataset.friendRow;
        if (fid) FriendModal.openEdit(fid);
      });
    });
    tbody.querySelectorAll('[data-friend-action="edit"]').forEach(btn => {
      on(btn, 'click', (e) => { e.stopPropagation(); FriendModal.openEdit(btn.dataset.fid); });
    });
    tbody.querySelectorAll('[data-friend-action="delete"]').forEach(btn => {
      on(btn, 'click', (e) => { e.stopPropagation(); FriendsTabView.delete(btn.dataset.fid); });
    });
    // Wire all copy-to-clipboard buttons in this scope.
    tbody.querySelectorAll('[data-copy]').forEach(btn => {
      on(btn, 'click', async (e) => {
        e.stopPropagation();
        const val = btn.dataset.copy || '';
        if (!val) return;
        try { await navigator.clipboard.writeText(val); toast(`${btn.dataset.copyLabel || 'Copied'}.`); }
        catch { toast('Copy failed.', 'warn'); }
      });
    });
  },
  householdRowsHTML(f) {
    const hasRoster = !!f.spouse || (f.kids && f.kids.length > 0);
    const isOpen = hasRoster && !this.collapsed.has(f.id);
    const toggle = hasRoster
      ? `<button type="button" class="friend-expand ${isOpen ? 'is-open' : ''}" data-friend-toggle="${f.id}" aria-label="${isOpen ? 'Collapse' : 'Expand'} household">
           <svg viewBox="0 0 16 16" width="14" height="14"><path d="M5 4l5 4-5 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
         </button>`
      : '';
    // v4.38: address now renders on two lines — street on the first, then
    // "City, ST 90210" on the second. Use the raw split-field address so we
    // don't have to round-trip through a single-line string just to split it
    // again. The full postal string is still used for the copy-to-clipboard
    // payload so admins can paste a complete address into mail/labels apps.
    const fullAddress = formatPostalAddress(f).replace(/\n/g, ', ');
    const primaryRow = `
      <tr data-friend-row="${f.id}" class="friend-row ${hasRoster ? 'has-roster' : ''}">
        <td class="friend-expand-cell">${toggle}</td>
        <td>${nameCellHTML(f, 'primary')}</td>
        <td>${emailCellHTML(f.email, { copy: true })}</td>
        <td>${addressCellHTML({ street: f.address, city: f.city, state: f.state, zip: f.zip, copy: fullAddress })}</td>
        <td style="white-space:nowrap;">${escape(f.phone || '—')}</td>
        <td style="white-space:nowrap;">${f.birthday ? formatDate(f.birthday) : '—'}</td>
        <td>${escape(f.group || '—')}</td>
        <td>${plan529CellHTML(f.plan529)}</td>
        <td style="text-align:right; white-space:nowrap;">
          <button class="btn btn-danger-ghost btn-sm" type="button" data-friend-action="delete" data-fid="${f.id}" title="Delete this household">Delete</button>
        </td>
      </tr>`;
    if (!hasRoster || !isOpen) return primaryRow;

    const subRows = [];
    if (f.spouse) {
      subRows.push(this.subRowHTML(f, f.spouse, 'spouse'));
    }
    (f.kids || []).forEach(k => {
      subRows.push(this.subRowHTML(f, k, 'child'));
    });
    return primaryRow + subRows.join('');
  },
  subRowHTML(parent, person, role) {
    // v4.36: only the primary row shows the address. Spouse + kids inherit
    // the household address conceptually, but we render em-dash for that
    // cell to keep the list visually clean (no duplicated street/city on
    // every household member). Group also stays as an em-dash on sub-rows.
    const phone = role === 'spouse' ? (person.phone || '') : '';
    const email = role === 'spouse' ? (person.email || '') : '';
    return `
      <tr class="friend-subrow friend-subrow-${role}" data-friend-row="${parent.id}">
        <td></td>
        <td>${nameCellHTML(person, role)}</td>
        <td>${email ? emailCellHTML(email, { copy: true }) : '<span class="muted">—</span>'}</td>
        <td><span class="muted">—</span></td>
        <td>${phone ? escape(phone) : '<span class="muted">—</span>'}</td>
        <td>${person.birthday ? formatDate(person.birthday) : '—'}</td>
        <td><span class="muted">—</span></td>
        <td>${plan529CellHTML(person.plan529)}</td>
        <td></td>
      </tr>`;
  },
  delete(fid) {
    if (!Auth.isAdmin()) return;
    const f = Store.state.friends[fid]; if (!f) return;
    if (!confirm(`Remove ${displayName(f)} (and any spouse/kids on this household) from your Friends list?`)) return;
    delete Store.state.friends[fid];
    Store.save();
    toast('Friend removed.');
    this.render();
    if (AdminView.activeTab === 'all') AllTabView.render();
  },
};

// Pure helper: does `person` match the lowercased search query against any
// of their searchable fields? Used by both the Friends tab and the All tab.
function friendMatchesQuery(person, q) {
  if (!person || !q) return true;
  const haystack = [
    displayName(person), fullName(person),
    person.email, person.phone,
    person.firstName, person.lastName,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(q);
}

// Friends are sorted by last name then first, matching the Family Tree's
// Members panel ordering. Empty last names fall to the end of the list.
function sortFriends(list) {
  return [...list].sort((a, b) => {
    const al = (a.lastName  || '~').toLowerCase();
    const bl = (b.lastName  || '~').toLowerCase();
    if (al !== bl) return al.localeCompare(bl);
    const af = (a.firstName || '').toLowerCase();
    const bf = (b.firstName || '').toLowerCase();
    return af.localeCompare(bf);
  });
}

// Small avatar + name cell shared across Friends and All tabs. `role` is one
// of 'primary' | 'spouse' | 'child' | 'family' — controls a tiny inline
// badge so admins can tell sub-rows apart at a glance.
// v4.37: append ethnicity flag + age in parens after the name when both are
// present — e.g. "Paul Cho 🇰🇷 (40)". Either field can be missing; the
// suffix only renders for what's actually filled in.
function nameCellHTML(person, role) {
  const bg = person.photo ? `style="background-image:url('${cssUrl(person.photo)}')"` : '';
  const sub = (() => {
    if (role === 'spouse') return '<span class="friend-role-pill is-spouse">Spouse</span>';
    if (role === 'child')  return '<span class="friend-role-pill is-child">Child</span>';
    return '';
  })();
  const intl = person.internationalName
    ? `<div class="muted small">${escape(person.internationalName)}</div>`
    : '';
  // Ethnicity flags: up to 2 inline next to the name (more would get noisy
  // in a row). `flagFor()` returns the country emoji for an ISO code.
  const eths = Array.isArray(person.ethnicities) ? person.ethnicities : [];
  const flagsHTML = eths.length
    ? eths.slice(0, 2).map(c => `<span class="row-name-flag" title="${escape(ETH_BY_CODE[c]?.name || c)}">${flagFor(c) || '🏳️'}</span>`).join('')
    : '';
  // Age in parens. Only render when a birthday exists. Use a short form
  // ("40") for adults, fall back to ageLabel for kids/babies which renders
  // "3 years" / "5 months".
  const ageSuffix = (() => {
    if (!person.birthday) return '';
    const parts = ageParts(person.birthday, person.dateOfDeath);
    if (!parts) return '';
    const short = parts.years >= 1 ? `${parts.years}` : `${parts.months}mo`;
    return `<span class="row-name-age">(${short})</span>`;
  })();
  return `
    <div class="row-name">
      <div class="row-avatar is-${person.gender || 'female'}" ${bg}></div>
      <div>
        <div class="row-name-line">
          <span class="row-name-text">${escape(displayName(person))}</span>
          ${flagsHTML}
          ${ageSuffix}
          ${sub}
        </div>
        ${intl}
      </div>
    </div>`;
}

// Email cell with optional copy-to-clipboard button. `opts.copy=true` swaps
// the old member-table's data-action="copy-email" attribute for the generic
// `data-copy` handler wired by FriendsTabView.render — same UX, but the
// click handler is bound where the helper is used so it doesn't depend on
// the Members table's older copy-email wiring.
function emailCellHTML(email, opts = {}) {
  if (!email) return '<span class="muted">—</span>';
  if (opts.copy) {
    return `<span class="admin-email-cell"><code>${escape(email)}</code><button class="admin-email-copy" type="button" data-copy="${escape(email)}" data-copy-label="Email copied" title="Copy email"><svg viewBox="0 0 16 16" width="12" height="12" fill="none"><rect x="4" y="3" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3 11V4a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></span>`;
  }
  return `<span class="admin-email-cell"><code>${escape(email)}</code><button class="admin-email-copy" type="button" data-action="copy-email" data-email="${escape(email)}" title="Copy email"><svg viewBox="0 0 16 16" width="12" height="12" fill="none"><rect x="4" y="3" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3 11V4a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></span>`;
}

// v4.38: address cell can now render the split-field shape on two lines
// (street top / "City, ST Zip" below). Pass either a plain string (legacy
// one-line caller) or an object { street, city, state, zip, copy }. The
// `copy` payload is what lands on the clipboard if a copy button is rendered.
function addressCellHTML(input, opts = {}) {
  // Legacy: single string. Keep one-line rendering.
  if (typeof input === 'string') {
    const address = input;
    if (!address) return '<span class="muted">—</span>';
    if (opts.copy) {
      return `<span class="admin-email-cell"><span title="${escape(address)}">${escape(address)}</span><button class="admin-email-copy" type="button" data-copy="${escape(address)}" data-copy-label="Address copied" title="Copy address"><svg viewBox="0 0 16 16" width="12" height="12" fill="none"><rect x="4" y="3" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3 11V4a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></span>`;
    }
    return escape(address);
  }
  // Object: split-field rendering — street on top, City/State/Zip below.
  const street = (input.street || '').trim();
  const city   = (input.city   || '').trim();
  const state  = (input.state  || '').trim();
  const zip    = (input.zip    || '').trim();
  const cityLine = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (!street && !cityLine) return '<span class="muted">—</span>';
  const copyText = input.copy || [street, cityLine].filter(Boolean).join(', ');
  const lines = [
    street    ? `<div>${escape(street)}</div>`   : '',
    cityLine  ? `<div>${escape(cityLine)}</div>` : '',
  ].join('');
  return `<span class="admin-email-cell address-multiline" title="${escape(copyText)}">
    <span class="address-lines">${lines}</span>
    <button class="admin-email-copy" type="button" data-copy="${escape(copyText)}" data-copy-label="Address copied" title="Copy address"><svg viewBox="0 0 16 16" width="12" height="12" fill="none"><rect x="4" y="3" width="9" height="11" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M3 11V4a1 1 0 0 1 1-1h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>
  </span>`;
}

function plan529CellHTML(url) {
  if (!url) return '<span class="muted">—</span>';
  // No inline onclick (would violate the CSP's script-src). The friend-row
  // click handler already ignores clicks on <a>, and the All table has no row
  // click — so the chip opens its link without triggering a row action.
  return `<a href="${escape(safeHttpUrl(url))}" target="_blank" rel="noopener" class="plan529-chip" title="${escape(url)}">🎓 Open</a>`;
}

// -------------------- ALL TAB (Members > All) --------------------
// Flat union of every person: family members + friend household primaries +
// friend spouses + friend kids. One row per *person*, designed for scanning
// and Excel export. Type pill disambiguates rows.
const AllTabView = {
  searchQuery: '',
  init() {
    const search = $('#all-search');
    if (search) {
      on(search, 'input', () => {
        this.searchQuery = (search.value || '').trim().toLowerCase();
        this.render();
      });
    }
  },
  // Build a flat list of { person, type, parent, postalAddress, group }
  // tuples. Members are rendered as-is; each friend household contributes
  // 1 (primary) + (0 or 1)(spouse) + N (kids) entries. parent is non-null
  // for spouse/child rows so we can inherit address/group from the primary.
  rows() {
    const out = [];
    // Members
    for (const m of Store.membersList()) {
      out.push({
        person: m,
        type: 'family',
        parent: null,
        postalAddress: formatPostalAddress(m).replace(/\n/g, ', '),
        group: m.group || '',
        phone: m.phone || '',
        email: m.email || '',
        sortKey: nameSortKey(m),
      });
    }
    // Friends (household-aware)
    for (const f of Object.values(Store.state.friends || {})) {
      const postal = formatPostalAddress(f).replace(/\n/g, ', ');
      out.push({
        person: f, type: 'friend', parent: null,
        postalAddress: postal, group: f.group || '',
        phone: f.phone || '', email: f.email || '',
        sortKey: nameSortKey(f),
      });
      if (f.spouse) {
        out.push({
          person: f.spouse, type: 'spouse', parent: f,
          postalAddress: postal, group: f.group || '',
          phone: f.spouse.phone || '', email: f.spouse.email || '',
          sortKey: nameSortKey(f) + ' a',
        });
      }
      (f.kids || []).forEach((k, i) => {
        out.push({
          person: k, type: 'child', parent: f,
          postalAddress: postal, group: f.group || '',
          phone: '', email: '',
          sortKey: nameSortKey(f) + ' b' + String(i).padStart(3, '0'),
        });
      });
    }
    return out.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  },
  filtered() {
    const q = this.searchQuery;
    let rows = this.rows();
    if (q) {
      rows = rows.filter(r => {
        if (friendMatchesQuery(r.person, q)) return true;
        // Phone/email might come from a parent (for spouse) — but we already
        // promote spouse phone/email onto the row, so this is sufficient.
        return (r.phone || '').toLowerCase().includes(q)
            || (r.email || '').toLowerCase().includes(q);
      });
    }
    return rows;
  },
  render() {
    const tbody = $('#all-rows');
    if (!tbody) return;
    const rows = this.filtered();
    const note = $('#all-filter-note');
    if (note) {
      note.textContent = this.searchQuery
        ? `Showing ${rows.length} match${rows.length === 1 ? '' : 'es'} for "${this.searchQuery}"`
        : `Showing everyone in the archive (${rows.length})`;
    }
    tbody.innerHTML = rows.map(r => {
      const pillClass = `type-pill is-${r.type}`;
      const pillLabel = r.type === 'family' ? 'Family' : r.type === 'friend' ? 'Friend' : r.type === 'spouse' ? 'Spouse' : 'Child';
      const role = r.type === 'spouse' ? 'spouse' : r.type === 'child' ? 'child' : 'primary';
      return `
        <tr>
          <td>${nameCellHTML(r.person, role)}</td>
          <td>${emailCellHTML(r.email)}</td>
          <td>${r.phone ? escape(r.phone) : '<span class="muted">—</span>'}</td>
          <td>${r.postalAddress ? escape(r.postalAddress) : '<span class="muted">—</span>'}</td>
          <td>${r.person.birthday ? formatDate(r.person.birthday) : '—'}</td>
          <td>${escape(r.group || '—')}</td>
          <td><span class="${pillClass}">${pillLabel}</span></td>
        </tr>`;
    }).join('') || `<tr><td colspan="7" class="muted" style="padding:24px; text-align:center;">No people match "${escape(this.searchQuery)}".</td></tr>`;
  },
  // Export the visible (filtered) rows. Columns chosen to match the on-screen
  // layout so what you see is what you export.
  exportCSV() {
    const rows = this.filtered();
    if (!rows.length) { toast('Nothing to export.', 'warn'); return; }
    const data = [
      ['Name', 'Email', 'Phone', 'Address', 'Birthday', 'Group', 'Type'],
      ...rows.map(r => {
        const pillLabel = r.type === 'family' ? 'Family' : r.type === 'friend' ? 'Friend' : r.type === 'spouse' ? 'Spouse' : 'Child';
        return [
          fullName(r.person),
          r.email || '',
          r.phone || '',
          r.postalAddress || '',
          r.person.birthday || '',
          r.group || '',
          pillLabel,
        ];
      }),
    ];
    downloadCSV(`archive-all-${new Date().toISOString().slice(0, 10)}.csv`, data);
  },
};

// Used by AllTabView to keep "spouse follows primary, then kids" ordering
// across the global sort. Same shape as sortFriends() but exposed as a
// string so spouse/kid rows can extend it.
function nameSortKey(p) {
  const last  = (p.lastName  || '~').toLowerCase();
  const first = (p.firstName || '').toLowerCase();
  return `${last} ${first}`;
}

// -------------------- FRIEND MODAL --------------------
// Add / edit a single friend household. The friend record is the *primary
// contact*; spouse + kids are stored as sub-objects on the same record so
// the household model stays single-write and CPU-cheap (no relationship
// graph traversal, no separate tables). Photo upload reuses the existing
// downscaleImageFile pipeline for inline JPEG storage on the primary only.
const FriendModal = {
  editingId: null,
  tempPhoto: '',          // primary in-flight photo
  _clearPhoto: false,
  spouseTempPhoto: '',    // spouse in-flight photo
  _clearSpousePhoto: false,
  // Working copies of the roster so the user can add/remove sub-records
  // before saving without mutating Store.state. Persisted to the friend on
  // save (or discarded on close). Kid photos live directly on
  // kidsDraft[i].photo since drafts are full copies — no separate temp map
  // is needed, which keeps state simple.
  spouseDraft: null,   // null = "no spouse on record"
  kidsDraft:   [],     // array of kid objects (each may carry .photo)
  init() {
    const el = $('#friend-modal'); if (!el) return;
    on(el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#friend-form'), 'submit', (e) => { e.preventDefault(); this.save(); });
    on($('#friend-delete'), 'click', () => this.deleteCurrent());
    on($('#friend-photo-input'), 'change', (e) => this.onPhotoUpload(e));
    on($('#friend-photo-clear'), 'click', () => this.clearPhoto());
    on($('#friend-spouse-photo-input'), 'change', (e) => this.onSpousePhotoUpload(e));
    on($('#friend-spouse-photo-clear'), 'click', () => this.clearSpousePhoto());
    on($('#friend-spouse-add'),    'click', () => { this.spouseDraft = this.emptySpouse(); this.spouseTempPhoto = ''; this._clearSpousePhoto = false; this.syncRoster(); });
    on($('#friend-spouse-remove'), 'click', () => {
      if (!confirm('Remove the spouse from this household? Their record will be deleted on save.')) return;
      this.spouseDraft = null;
      this.spouseTempPhoto = '';
      this._clearSpousePhoto = false;
      this.syncRoster();
    });
    on($('#friend-kid-add'), 'click', () => {
      this.captureKidsFromDOM();
      this.kidsDraft.push(this.emptyKid());
      this.syncRoster();
    });
    // Mount the primary ethnicity picker once on init. Spouse + kid pickers
    // are mounted on demand inside syncRoster() since their containers may
    // not exist (spouse hidden, kid list dynamic).
    const ePicker = $('[data-picker="friend-ethnicity"]');
    if (ePicker) EthnicityPicker.mount(ePicker);
    // v4.37: format phone fields on blur so the saved value matches the
    // (XXX) XXX-XXXX shape immediately. Save-time formatting was already
    // doing this, but visually-mid-typing values looked ragged before save.
    const fm = $('#friend-form');
    if (fm) {
      on(fm.phone, 'blur', () => { fm.phone.value = formatPhoneUS(fm.phone.value); });
      // spouse phone may not exist in the DOM until syncRoster renders the
      // spouse fields — defensive optional chain handles that.
      const sp = fm.spousePhone;
      if (sp) on(sp, 'blur', () => { sp.value = formatPhoneUS(sp.value); });
    }
    // Zip → city/state autofill, mirrors the member drawer wiring.
    on($('#friend-zip'), 'blur', async () => {
      const zip = $('#friend-zip').value.trim();
      const status = $('#friend-zip-status');
      if (!zip) { status.hidden = true; return; }
      if (!/^\d{5}$/.test(zip)) { status.hidden = true; return; }
      status.hidden = false; status.textContent = 'Looking up zip…';
      const r = await lookupZipUS(zip);
      if (r) {
        $('#friend-city').value  = r.city;
        $('#friend-state').value = r.state;
        status.textContent = `Auto-filled from ${zip} — edit if needed.`;
      } else {
        status.textContent = `Couldn't find ${zip}. Enter city and state manually.`;
      }
    });
  },
  emptySpouse() {
    return { id: uid('sps'), firstName: '', middleName: '', lastName: '', displayName: '',
             birthday: '', phone: '', email: '', gender: 'female', ethnicities: [],
             plan529: '', photo: '', excludeFromEventsList: false };
  },
  emptyKid() {
    return { id: uid('kid'), firstName: '', middleName: '', lastName: '', displayName: '',
             birthday: '', gender: 'female', ethnicities: [], plan529: '',
             photo: '', excludeFromEventsList: false };
  },
  openAdd() {
    if (!Auth.isAdmin()) return;
    this.editingId = null;
    this.tempPhoto = '';
    this._clearPhoto = false;
    this.spouseTempPhoto = '';
    this._clearSpousePhoto = false;
    this.spouseDraft = null;
    this.kidsDraft = [];
    $('#friend-modal-title').textContent = 'Add a friend';
    $('#friend-delete').hidden = true;
    $('#friend-submit').textContent = 'Save friend';
    $('#friend-form').reset();
    EthnicityPicker.write($('[data-picker="friend-ethnicity"]'), []);
    $('#friend-zip-status').hidden = true;
    this.renderPhoto({ photo: '', gender: 'female' });
    this.syncRoster();
    this.open();
    setTimeout(() => $('#friend-form').firstName.focus(), 50);
  },
  openEdit(fid) {
    if (!Auth.isAdmin()) return;
    const f = Store.state.friends[fid]; if (!f) return;
    this.editingId = fid;
    this.tempPhoto = '';
    this._clearPhoto = false;
    this.spouseTempPhoto = '';
    this._clearSpousePhoto = false;
    // Deep-clone the spouse/kids so cancellation truly cancels.
    this.spouseDraft = f.spouse ? JSON.parse(JSON.stringify(f.spouse)) : null;
    this.kidsDraft   = (f.kids || []).map(k => JSON.parse(JSON.stringify(k)));
    $('#friend-modal-title').textContent = `Edit ${displayName(f)}`;
    $('#friend-delete').hidden = false;
    $('#friend-submit').textContent = 'Save changes';
    const fm = $('#friend-form');
    fm.firstName.value         = f.firstName || '';
    fm.middleName.value        = f.middleName || '';
    fm.lastName.value          = f.lastName || '';
    fm.displayName.value       = f.displayName || '';
    fm.internationalName.value = f.internationalName || '';
    fm.birthday.value          = f.birthday || '';
    fm.phone.value             = formatPhoneUS(f.phone || '');
    fm.email.value             = f.email || '';
    fm.group.value             = f.group || '';
    fm.plan529.value           = f.plan529 || '';
    fm.address.value           = f.address || '';
    fm.zip.value               = f.zip || '';
    fm.city.value              = f.city || '';
    fm.state.value             = f.state || '';
    fm.notes.value             = f.notes || '';
    fm.gender.value            = f.gender || 'female';
    if (fm.excludeFromEventsList) fm.excludeFromEventsList.checked = !!f.excludeFromEventsList;
    EthnicityPicker.write($('[data-picker="friend-ethnicity"]'), f.ethnicities || []);
    $('#friend-zip-status').hidden = true;
    this.renderPhoto(f);
    this.syncRoster();
    this.open();
  },
  // Render the spouse + kids sections from the current draft state. Called
  // after add/remove buttons fire so the DOM matches in-memory drafts.
  syncRoster() {
    // Spouse
    const sFields = $('#friend-spouse-fields');
    const sAdd    = $('#friend-spouse-add');
    const sRem    = $('#friend-spouse-remove');
    if (this.spouseDraft) {
      sFields.hidden = false;
      sAdd.hidden = true;
      sRem.hidden = false;
      const fm = $('#friend-form');
      fm.spouseFirstName.value  = this.spouseDraft.firstName || '';
      fm.spouseMiddleName.value = this.spouseDraft.middleName || '';
      fm.spouseLastName.value   = this.spouseDraft.lastName || '';
      fm.spouseBirthday.value   = this.spouseDraft.birthday || '';
      fm.spouseGender.value     = this.spouseDraft.gender || 'female';
      fm.spousePhone.value      = formatPhoneUS(this.spouseDraft.phone || '');
      fm.spouseEmail.value      = this.spouseDraft.email || '';
      fm.spousePlan529.value    = this.spouseDraft.plan529 || '';
      if (fm.spouseExcludeFromEventsList) {
        fm.spouseExcludeFromEventsList.checked = !!this.spouseDraft.excludeFromEventsList;
      }
      const sePicker = $('[data-picker="friend-spouse-ethnicity"]');
      if (sePicker) {
        EthnicityPicker.mount(sePicker);
        EthnicityPicker.write(sePicker, this.spouseDraft.ethnicities || []);
      }
      this.renderSpousePhoto();
    } else {
      sFields.hidden = true;
      sAdd.hidden = false;
      sRem.hidden = true;
    }

    // Kids
    const kidsList = $('#friend-kids-list');
    if (!kidsList) return;
    kidsList.innerHTML = this.kidsDraft.map((k, i) => `
      <div class="kid-row" data-kid-index="${i}">
        <div class="grid-3">
          <label class="field"><span>First name</span><input data-kid-field="firstName" value="${escape(k.firstName || '')}" /></label>
          <label class="field"><span>Middle name</span><input data-kid-field="middleName" value="${escape(k.middleName || '')}" placeholder="(optional)" /></label>
          <label class="field"><span>Last name</span><input data-kid-field="lastName" value="${escape(k.lastName || '')}" /></label>
        </div>
        <label class="field"><span>Display name <span class="muted small">(optional)</span></span><input data-kid-field="displayName" value="${escape(k.displayName || '')}" placeholder="e.g. Jin" /></label>
        <div class="grid-2">
          <label class="field"><span><span class="kv-emoji" aria-hidden="true">🎂</span>Birthday</span><input data-kid-field="birthday" type="date" value="${escape(k.birthday || '')}" /></label>
          <label class="field"><span>Gender</span>
            <select data-kid-field="gender">
              <option value="female" ${k.gender === 'female' ? 'selected' : ''}>Female</option>
              <option value="male"   ${k.gender === 'male'   ? 'selected' : ''}>Male</option>
            </select>
          </label>
        </div>
        <label class="field"><span><span class="kv-emoji" aria-hidden="true">🎓</span>529 plan link <span class="muted small">(URL)</span></span><input data-kid-field="plan529" type="url" value="${escape(k.plan529 || '')}" placeholder="https://…" /></label>
        <label class="field">
          <span><span class="kv-emoji" aria-hidden="true">🌍</span>Ethnicity <span class="muted small">(auto-inherits parents' on save)</span></span>
          <div class="ethnicity-picker" data-kid-ethnicity="${i}"></div>
        </label>
        <div class="field">
          <span>Photo</span>
          <div class="photo-row">
            <div class="photo-preview" data-kid-photo-preview="${i}" ${k.photo ? `style="background-image:url('${cssUrl(k.photo)}')"` : ''}>${k.photo ? '' : Silhouettes.for(k)}</div>
            <div class="photo-actions">
              <label class="btn btn-secondary btn-sm">
                Upload photo
                <input type="file" accept="image/*" data-kid-photo-input="${i}" hidden />
              </label>
              <button type="button" class="btn btn-ghost btn-sm" data-kid-photo-clear="${i}">Clear photo</button>
            </div>
          </div>
        </div>
        <label class="field-check">
          <input type="checkbox" data-kid-field="excludeFromEventsList" ${k.excludeFromEventsList ? 'checked' : ''} />
          <span>Do not show in events list</span>
          <small>Hides this child from the "+ Add member" picker on events.</small>
        </label>
        <div class="kid-row-actions">
          <button type="button" class="btn btn-danger-ghost btn-sm" data-kid-remove="${i}">Remove child</button>
        </div>
      </div>
    `).join('');
    // Mount each kid's ethnicity picker and seed its value.
    this.kidsDraft.forEach((k, i) => {
      const picker = kidsList.querySelector(`[data-kid-ethnicity="${i}"]`);
      if (picker) {
        EthnicityPicker.mount(picker);
        EthnicityPicker.write(picker, k.ethnicities || []);
      }
    });
    // Remove-child wiring.
    kidsList.querySelectorAll('[data-kid-remove]').forEach(btn => {
      on(btn, 'click', () => {
        this.captureKidsFromDOM();
        const idx = Number(btn.dataset.kidRemove);
        if (!confirm(`Remove ${this.kidsDraft[idx]?.firstName || 'this child'}? The record will be deleted on save.`)) return;
        this.kidsDraft.splice(idx, 1);
        this.syncRoster();
      });
    });
    // Per-kid photo upload + clear.
    kidsList.querySelectorAll('[data-kid-photo-input]').forEach(input => {
      on(input, 'change', async (e) => {
        const i = Number(input.dataset.kidPhotoInput);
        const file = e.target.files?.[0]; if (!file) return;
        try {
          // v4.38: route through the same square CropModal members use so
          // every face on the card grid lines up identically. 480px output
          // matches the canonical photo size in the rest of the app.
          this.captureKidsFromDOM();
          const dataUrl = await readFileAsDataURL(file);
          const cropped = await CropModal.open(dataUrl, { size: 480 });
          if (!cropped) return; // user cancelled the crop dialog
          this.kidsDraft[i].photo = cropped;
          this.renderKidPhoto(i);
        } catch (err) {
          toast('Could not load image: ' + err.message, 'warn');
        } finally {
          e.target.value = '';
        }
      });
    });
    kidsList.querySelectorAll('[data-kid-photo-clear]').forEach(btn => {
      on(btn, 'click', () => {
        this.captureKidsFromDOM();
        const i = Number(btn.dataset.kidPhotoClear);
        this.kidsDraft[i].photo = '';
        this.renderKidPhoto(i);
      });
    });
  },
  // Re-render just one kid's photo preview without nuking the whole roster.
  renderKidPhoto(i) {
    const k = this.kidsDraft[i]; if (!k) return;
    const preview = $(`[data-kid-photo-preview="${i}"]`);
    if (!preview) return;
    if (k.photo) {
      preview.style.backgroundImage = `url('${cssUrl(k.photo)}')`;
      preview.innerHTML = '';
    } else {
      preview.style.backgroundImage = '';
      preview.innerHTML = Silhouettes.for(k);
    }
  },
  // Spouse photo: draws from spouseTempPhoto (new upload) or spouseDraft.photo
  // (existing). _clearSpousePhoto wins over both when set.
  renderSpousePhoto() {
    const preview = $('#friend-spouse-photo-preview');
    if (!preview) return;
    const src = this._clearSpousePhoto ? '' : (this.spouseTempPhoto || this.spouseDraft?.photo || '');
    if (src) { preview.style.backgroundImage = `url('${cssUrl(src)}')`; preview.innerHTML = ''; }
    else { preview.style.backgroundImage = ''; preview.innerHTML = Silhouettes.for(this.spouseDraft || { gender: 'female' }); }
  },
  async onSpousePhotoUpload(e) {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const dataUrl = await readFileAsDataURL(file);
      const cropped = await CropModal.open(dataUrl, { size: 480 });
      if (!cropped) return; // cancelled
      this.spouseTempPhoto = cropped;
      this._clearSpousePhoto = false;
      this.renderSpousePhoto();
    } catch (err) {
      toast('Could not load image: ' + err.message, 'warn');
    } finally {
      e.target.value = '';
    }
  },
  clearSpousePhoto() {
    this.spouseTempPhoto = '';
    this._clearSpousePhoto = true;
    this.renderSpousePhoto();
  },
  // Copy whatever's in the kid-row inputs back into kidsDraft so the next
  // syncRoster() rebuild doesn't blow away in-flight edits.
  captureKidsFromDOM() {
    const list = $('#friend-kids-list');
    if (!list) return;
    list.querySelectorAll('.kid-row').forEach(row => {
      const i = Number(row.dataset.kidIndex);
      if (!this.kidsDraft[i]) return;
      row.querySelectorAll('[data-kid-field]').forEach(input => {
        const field = input.dataset.kidField;
        if (input.type === 'checkbox') this.kidsDraft[i][field] = input.checked;
        else this.kidsDraft[i][field] = input.value;
      });
      const picker = row.querySelector('.ethnicity-picker');
      if (picker) this.kidsDraft[i].ethnicities = EthnicityPicker.read(picker);
    });
  },
  // Copy spouse inputs back into spouseDraft for the same reason.
  captureSpouseFromDOM() {
    if (!this.spouseDraft) return;
    const fm = $('#friend-form');
    this.spouseDraft.firstName  = fm.spouseFirstName.value.trim();
    this.spouseDraft.middleName = fm.spouseMiddleName.value.trim();
    this.spouseDraft.lastName   = fm.spouseLastName.value.trim();
    this.spouseDraft.birthday   = fm.spouseBirthday.value;
    this.spouseDraft.gender     = fm.spouseGender.value || 'female';
    this.spouseDraft.phone      = formatPhoneUS(fm.spousePhone.value || '');
    this.spouseDraft.email      = fm.spouseEmail.value.trim();
    this.spouseDraft.plan529    = fm.spousePlan529.value.trim();
    this.spouseDraft.excludeFromEventsList = !!fm.spouseExcludeFromEventsList?.checked;
    const picker = $('[data-picker="friend-spouse-ethnicity"]');
    if (picker) this.spouseDraft.ethnicities = EthnicityPicker.read(picker);
    // Apply photo resolutions: tempPhoto overrides; clearPhoto wipes.
    if (this._clearSpousePhoto) this.spouseDraft.photo = '';
    else if (this.spouseTempPhoto) this.spouseDraft.photo = this.spouseTempPhoto;
  },
  open() {
    const el = $('#friend-modal'); if (!el) return;
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('is-open');
    $('#friend-error').hidden = true;
  },
  close() {
    const el = $('#friend-modal'); if (!el) return;
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-open');
    this.editingId = null;
    this.tempPhoto = '';
    this._clearPhoto = false;
    this.spouseTempPhoto = '';
    this._clearSpousePhoto = false;
    this.spouseDraft = null;
    this.kidsDraft = [];
  },
  renderPhoto(f) {
    const preview = $('#friend-photo-preview');
    if (!preview) return;
    const src = this.tempPhoto || f.photo;
    if (src) { preview.style.backgroundImage = `url('${cssUrl(src)}')`; preview.innerHTML = ''; }
    else { preview.style.backgroundImage = ''; preview.innerHTML = Silhouettes.for(f); }
  },
  async onPhotoUpload(e) {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const dataUrl = await readFileAsDataURL(file);
      const cropped = await CropModal.open(dataUrl, { size: 480 });
      if (!cropped) return; // cancelled
      this.tempPhoto = cropped;
      this.renderPhoto({ gender: $('#friend-form').gender.value });
    } catch (err) {
      toast('Could not load image: ' + err.message, 'warn');
    } finally {
      e.target.value = '';
    }
  },
  clearPhoto() {
    this.tempPhoto = '';
    $('#friend-photo-preview').style.backgroundImage = '';
    $('#friend-photo-preview').innerHTML = Silhouettes.for({ gender: $('#friend-form').gender.value });
    this._clearPhoto = true;
  },
  save() {
    if (!Auth.isAdmin()) return;
    const fm = $('#friend-form');
    const fd = new FormData(fm);
    const firstName = (fd.get('firstName') || '').toString().trim();
    if (!firstName) {
      $('#friend-error').textContent = 'First name is required.';
      $('#friend-error').hidden = false;
      return;
    }
    // Capture any in-flight roster edits before reading them.
    this.captureSpouseFromDOM();
    this.captureKidsFromDOM();

    const id = this.editingId || uid('frd');
    const existing = this.editingId ? (Store.state.friends[id] || {}) : {};
    const ethPicker = $('[data-picker="friend-ethnicity"]');

    // Resolve final primary ethnicities once so we can compute the union for
    // each kid below. (Spouse ethnicities are read off the captured draft.)
    const primaryEthnicities = ethPicker ? EthnicityPicker.read(ethPicker) : (existing.ethnicities || []);
    const spouseEthnicities  = this.spouseDraft ? (this.spouseDraft.ethnicities || []) : [];

    // Per-kid: keep manually-added ethnicities, then merge in the union of
    // primary + spouse (deduplicated). Mirrors the family-side rule at
    // line 1623 — kid inherits parents' flags but can also have their own.
    const finalKids = (this.kidsDraft || [])
      .filter(k => (k.firstName || '').trim())
      .map(k => {
        const set = new Set(Array.isArray(k.ethnicities) ? k.ethnicities : []);
        primaryEthnicities.forEach(e => set.add(e));
        spouseEthnicities.forEach(e => set.add(e));
        return {
          ...k,
          firstName: k.firstName.trim(),
          ethnicities: [...set],
          // Make sure newly-added kids that never went through hydration
          // still carry the photo + exclude flag fields (so render code can
          // assume they exist).
          photo: k.photo || '',
          excludeFromEventsList: !!k.excludeFromEventsList,
        };
      });

    const friend = {
      ...existing,
      id,
      firstName,
      middleName:        (fd.get('middleName')        || '').toString().trim(),
      lastName:          (fd.get('lastName')          || '').toString().trim(),
      displayName:       (fd.get('displayName')       || '').toString().trim(),
      internationalName: (fd.get('internationalName') || '').toString().trim(),
      birthday:          (fd.get('birthday')          || '').toString(),
      phone:             formatPhoneUS((fd.get('phone') || '').toString()),
      email:             (fd.get('email')             || '').toString().trim(),
      group:             (fd.get('group')             || '').toString().trim(),
      plan529:           (fd.get('plan529')           || '').toString().trim(),
      address:           (fd.get('address')           || '').toString().trim(),
      city:              (fd.get('city')              || '').toString().trim(),
      state:             (fd.get('state')             || '').toString().toUpperCase().slice(0, 3),
      zip:               (fd.get('zip')               || '').toString().trim().slice(0, 10),
      notes:             (fd.get('notes')             || '').toString(),
      gender:            (fd.get('gender')            || 'female').toString(),
      ageGroup:          existing.ageGroup || ageGroupForBirthday((fd.get('birthday') || '').toString()) || 'adult',
      photo:             this._clearPhoto ? '' : (this.tempPhoto || existing.photo || ''),
      dateOfDeath:       existing.dateOfDeath || '',
      ethnicities:       primaryEthnicities,
      excludeFromEventsList: !!fd.get('excludeFromEventsList'),
      // Household roster — derived from drafts. Empty kids (no firstName) are
      // dropped so accidentally added rows don't clutter the list.
      spouse:            this.spouseDraft && (this.spouseDraft.firstName || '').trim()
                           ? {
                               ...this.spouseDraft,
                               firstName: this.spouseDraft.firstName.trim(),
                               photo: this.spouseDraft.photo || '',
                               excludeFromEventsList: !!this.spouseDraft.excludeFromEventsList,
                             }
                           : null,
      kids:              finalKids,
      createdAt:         existing.createdAt || Date.now(),
    };
    Store.state.friends[id] = friend;
    Store.save();
    toast(this.editingId ? 'Friend saved.' : 'Friend added.');
    this._clearPhoto = false;
    this.close();
    FriendsTabView.render();
    if (AdminView.activeTab === 'all') AllTabView.render();
  },
  deleteCurrent() {
    if (!this.editingId) return;
    const fid = this.editingId;
    this.close();
    FriendsTabView.delete(fid);
  },
};

// -------------------- MY KIDS VIEW (v4.40 Wave 2) --------------------
// Per-kid growing-up archive. The kid roster auto-derives from family
// members under 18 — no per-member flag. Each kid has four sections
// (milestones / school / art / letters) stored in `state.myKids[memberId]`.
// Photos live in Supabase Storage (family-photos bucket), referenced by
// `{ bucket, path }` pointers in the entry — keeps the JSONB archive row
// small (Postgres CPU is the limiting resource).
const MyKidsView = {
  selectedKidId: null,            // null = show roster; member id = show detail
  activeTab: 'milestones',        // 'milestones' | 'school' | 'art' | 'letters'
  signedUrlCache: new Map(),      // `${bucket}|${path}` → { url, expiresAt }

  init() {
    on($('#btn-mykids-back'),   'click', () => this.openRoster());
    on($('#btn-mykids-add'),    'click', () => {
      if (this.activeTab === 'capsule') {
        TimeCapsuleModal.openAdd(`m:${this.selectedKidId}`);
      } else {
        MyKidsEntryModal.openAdd(this.selectedKidId, this.activeTab);
      }
    });
    on($('#btn-mykids-pick'),   'click', () => MyKidsPickerModal.open());
    on($('#btn-mykids-manage'), 'click', () => MyKidsPickerModal.open());
    $$('.mykids-tab').forEach(btn => {
      on(btn, 'click', () => this.setTab(btn.dataset.mykidsTab));
    });
    MyKidsEntryModal.init();
    MyKidsPickerModal.init();
  },

  // True when the current viewer is allowed to use the page at all. Admins
  // always pass. Non-admins are allowed only when they have a linked
  // member that's a kid in the (now nuclear-family-scoped) roster of any
  // admin in the archive — i.e. they're viewing their own page.
  canViewerAccess() {
    if (Auth.isAdmin()) return true;
    const me = Auth.current;
    if (!me || me === 'admin-bootstrap') return false;
    if (typeof me !== 'object') return false;
    // The viewer is allowed if they appear in the nuclear-family roster
    // of at least one admin-role member. We don't have a global "kid?"
    // bit, so just check membership: am I one of any admin's kids?
    return Store.membersList().some(adminMember => {
      if (adminMember.role !== 'admin') return false;
      const kids = adminMember.childrenIds || [];
      if (!kids.includes(me.id)) return false;
      const spouseId = adminMember.spouseId;
      if (!spouseId) return true;
      const myParents = me.parentIds || [];
      return myParents.includes(adminMember.id) && myParents.includes(spouseId);
    });
  },

  // v4.41/v4.42: roster resolution order:
  //   1. If `state.myKidsRoster` has any ids, treat that as a manual
  //      override — show exactly those members. Lets admins pick their
  //      kids directly when the Family Tree parent-link graph isn't set
  //      up (the most common state on a fresh archive).
  //   2. Otherwise auto-walk: include members whose parentIds contain
  //      the current admin and the admin's spouse. Falls back to "admin
  //      alone as parent" when no spouse is on file.
  rosterMembers() {
    const overrideIds = Array.isArray(Store.state.myKidsRoster) ? Store.state.myKidsRoster : [];
    if (overrideIds.length) {
      return overrideIds
        .map(id => Store.byId(id))
        .filter(Boolean)
        .filter(m => !m.dateOfDeath)
        .sort((a, b) => (b.birthday || '').localeCompare(a.birthday || ''));
    }
    const me = Auth.current;
    if (!me || me === 'admin-bootstrap' || typeof me !== 'object') return [];
    const myId = me.id;
    const spouseId = me.spouseId || null;
    return Store.membersList()
      .filter(m => {
        if (m.dateOfDeath) return false;
        const parents = Array.isArray(m.parentIds) ? m.parentIds : [];
        if (!parents.includes(myId)) return false;
        if (spouseId) return parents.includes(spouseId);
        return true;
      })
      .sort((a, b) => (b.birthday || '').localeCompare(a.birthday || ''));
  },

  render() {
    if (!Auth.isAdmin()) {
      // Non-admin (the kid themselves) auto-routes to their own detail
      // page. canViewerAccess() has already validated they're someone's
      // nuclear-family kid; just point at their own id.
      const me = Auth.current;
      if (me && typeof me === 'object') {
        this.selectedKidId = me.id;
      }
    }
    const detail  = $('#mykids-detail');
    const roster  = $('#mykids-roster');
    const back    = $('#btn-mykids-back');
    const manage  = $('#btn-mykids-manage');
    if (!detail || !roster) return;
    const showDetail = !!this.selectedKidId && Store.byId(this.selectedKidId);
    detail.hidden = !showDetail;
    roster.hidden = !!showDetail;
    if (back)   back.hidden   = !showDetail || !Auth.isAdmin();
    if (manage) manage.hidden = showDetail || !Auth.isAdmin();
    if (showDetail) {
      this.renderDetail();
    } else {
      this.renderRoster();
    }
  },

  renderRoster() {
    const grid  = $('#mykids-roster-grid');
    const empty = $('#mykids-empty');
    if (!grid || !empty) return;
    const list = this.rosterMembers();
    if (!list.length) {
      grid.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    grid.innerHTML = list.map(m => {
      const bg = m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : '';
      const age = ageLabel(m.birthday) || '';
      const entries = this.totalEntriesFor(m.id);
      return `
        <button class="mykids-roster-card" type="button" data-kid="${m.id}">
          <div class="mykids-roster-avatar is-${m.gender || 'female'}" ${bg}>${m.photo ? '' : Silhouettes.for(m)}</div>
          <div class="mykids-roster-name">${escape(displayName(m))}</div>
          <div class="muted small">${escape(age)}</div>
          <div class="mykids-roster-stat">${entries} ${entries === 1 ? 'entry' : 'entries'}</div>
        </button>`;
    }).join('');
    grid.querySelectorAll('[data-kid]').forEach(btn => {
      on(btn, 'click', () => this.openKid(btn.dataset.kid));
    });
  },

  totalEntriesFor(kidId) {
    const k = Store.state.myKids?.[kidId];
    if (!k) return 0;
    return (k.milestones?.length || 0) + (k.school?.length || 0) + (k.art?.length || 0) + (k.letters?.length || 0);
  },

  openKid(kidId) {
    this.selectedKidId = kidId;
    this.activeTab = 'milestones';
    this.render();
  },
  openRoster() {
    this.selectedKidId = null;
    this.render();
  },
  setTab(tab) {
    if (!['milestones','school','art','letters','capsule'].includes(tab)) return;
    this.activeTab = tab;
    this.render();
  },

  // v4.51: every capsule whose recipient is this kid. Uses the same
  // `m:<memberId>` ref shape the rest of the app already produces. Admins
  // see everything; the kid themselves still gets filtered by visibility
  // (locked vs opened) inside the render path.
  capsulesForKid(kidId) {
    const myRef = `m:${kidId}`;
    return (Store.state.timeCapsules || []).filter(c => c.recipientRef === myRef);
  },

  renderDetail() {
    const kid = Store.byId(this.selectedKidId);
    if (!kid) { this.openRoster(); return; }
    const bg = kid.photo ? `style="background-image:url('${cssUrl(kid.photo)}')"` : '';
    $('#mykids-kid-avatar').className = `mykids-kid-avatar is-${kid.gender || 'female'}`;
    $('#mykids-kid-avatar').setAttribute('style', kid.photo ? `background-image:url('${cssUrl(kid.photo)}')` : '');
    $('#mykids-kid-avatar').innerHTML = kid.photo ? '' : Silhouettes.for(kid);
    $('#mykids-kid-name').textContent = displayName(kid);
    const sub = [];
    if (kid.birthday) sub.push(ageLabel(kid.birthday));
    if (kid.group)    sub.push(escape(kid.group));
    $('#mykids-kid-sub').textContent = sub.filter(Boolean).join(' · ') || '—';
    // Active tab UI
    $$('.mykids-tab').forEach(btn => btn.classList.toggle('is-active', btn.dataset.mykidsTab === this.activeTab));
    // Show/hide Add button based on viewer permissions. Only admins can add.
    $('#btn-mykids-add').hidden = !Auth.isAdmin();
    // The capsule tab borrows TimeCapsuleView's rendering and uses
    // its own "+ Add capsule" wording on the add button.
    if (this.activeTab === 'capsule') {
      $('#btn-mykids-add').textContent = '+ Add capsule';
      this.renderCapsules();
      return;
    }
    $('#btn-mykids-add').textContent = '+ Add entry';

    const k = Store.state.myKids[this.selectedKidId] || {};
    const entries = [...(k[this.activeTab] || [])].sort((a, z) => (z.date || '').localeCompare(a.date || ''));
    const host = $('#mykids-entries');
    if (!entries.length) {
      host.innerHTML = `<p class="muted" style="padding:24px; text-align:center;">No ${escape(this.activeTab)} entries yet. ${Auth.isAdmin() ? 'Click <strong>+ Add entry</strong> to start.' : ''}</p>`;
      return;
    }
    host.innerHTML = entries.map(e => this.entryCardHTML(e)).join('');
    // Wire actions per card.
    host.querySelectorAll('[data-mk-edit]').forEach(btn => {
      on(btn, 'click', () => MyKidsEntryModal.openEdit(this.selectedKidId, this.activeTab, btn.dataset.mkEdit));
    });
    host.querySelectorAll('[data-mk-delete]').forEach(btn => {
      on(btn, 'click', () => this.deleteEntry(btn.dataset.mkDelete));
    });
    // v4.55: reactions + comments wiring — mirrors MemoriesView.
    host.querySelectorAll('[data-mk-react]').forEach(btn => {
      on(btn, 'click', () => this.toggleReaction(btn.dataset.mkId, btn.dataset.mkReact));
    });
    host.querySelectorAll('[data-mk-react-more]').forEach(btn => {
      on(btn, 'click', () => this.openReactionPicker(btn));
    });
    host.querySelectorAll('[data-mk-comment-submit]').forEach(form => {
      on(form, 'submit', (ev) => { ev.preventDefault(); this.addComment(form.dataset.mkCommentSubmit); });
    });
    host.querySelectorAll('[data-mk-comment-delete]').forEach(btn => {
      on(btn, 'click', () => this.deleteComment(btn.dataset.mkId, btn.dataset.mkCommentDelete));
    });
    // Lazy-resolve signed URLs for every photo placeholder in this view.
    host.querySelectorAll('[data-mk-photo]').forEach(img => this.resolvePhotoSrc(img));
    // v4.41: clicking a photo opens the full-screen lightbox. We bind once
    // per render — handlers go on the tile elements directly so we can
    // capture the entry id + photo index without delegated walking.
    host.querySelectorAll('[data-mk-photo]').forEach(tile => {
      on(tile, 'click', () => this.openLightboxFromTile(tile));
      on(tile, 'keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openLightboxFromTile(tile);
        }
      });
    });
  },

  // v4.51: render the Time Capsule tab for the currently-selected kid.
  // Mirrors the structure of the global Time Capsule page (sealed +
  // opened sections) but scoped to capsules where recipientRef == this
  // kid. Reuses TimeCapsuleView's card HTML so the look stays identical
  // and we don't fork the template. Non-admin viewers (the kid themselves)
  // only see opened capsules — locked ones are hidden until their date.
  renderCapsules() {
    const host = $('#mykids-entries');
    if (!host) return;
    const isAdmin = Auth.isAdmin();
    const all = this.capsulesForKid(this.selectedKidId);
    // Non-admins see only capsules already revealed.
    const visible = isAdmin ? all : all.filter(c => !TimeCapsuleView.isLocked(c) || c.revealedBy);
    const sealed  = visible.filter(c => TimeCapsuleView.isLocked(c) && !c.revealedBy);
    const opened  = visible.filter(c => !TimeCapsuleView.isLocked(c) || c.revealedBy);
    sealed.sort((a, b) => (a.unlockDate || '').localeCompare(b.unlockDate || ''));
    opened.sort((a, b) => (b.unlockDate || '').localeCompare(a.unlockDate || ''));

    if (!visible.length) {
      host.innerHTML = `<p class="muted" style="padding:24px; text-align:center;">No capsules for this kid yet. ${isAdmin ? 'Click <strong>+ Add capsule</strong> to write one.' : ''}</p>`;
      return;
    }

    const openedHTML = opened.length
      ? `<section class="mykids-capsule-section"><h4 class="mykids-capsule-heading">Opened — ready to read</h4><div class="tcp-list">${opened.map(c => TimeCapsuleView.openedCardHTML(c)).join('')}</div></section>`
      : '';
    const sealedHTML = sealed.length
      ? `<section class="mykids-capsule-section"><h4 class="mykids-capsule-heading">Sealed — waiting</h4><div class="tcp-list">${sealed.map(c => TimeCapsuleView.sealedCardHTML(c)).join('')}</div></section>`
      : '';
    host.innerHTML = openedHTML + sealedHTML;

    // Wire up the same action handlers TimeCapsuleView.render() does so
    // edit/delete/reveal-early all work from inside the kid's tab.
    host.querySelectorAll('[data-tcp-reveal]').forEach(btn => {
      on(btn, 'click', () => { TimeCapsuleView.revealNow(btn.dataset.tcpReveal); this.render(); });
    });
    host.querySelectorAll('[data-tcp-edit]').forEach(btn => {
      on(btn, 'click', () => TimeCapsuleModal.openEdit(btn.dataset.tcpEdit));
    });
    host.querySelectorAll('[data-tcp-delete]').forEach(btn => {
      on(btn, 'click', async () => { await TimeCapsuleView.deleteCapsule(btn.dataset.tcpDelete); this.render(); });
    });
    host.querySelectorAll('[data-tcp-photo]').forEach(el => TimeCapsuleView.resolvePhotoSrc(el));
    host.querySelectorAll('[data-tcp-photo]').forEach(tile => {
      on(tile, 'click', () => {
        const c = all.find(x => x.id === tile.dataset.tcpPhotoCap);
        if (c?.photo) MyKidsLightbox.open([c.photo], 0);
      });
    });
  },

  // Resolve a photo tile back to its parent entry's photo set, then open
  // the lightbox starting at the right index. Reading from the DOM rather
  // than re-looking-up the entry keeps this resilient against re-sorts.
  openLightboxFromTile(tile) {
    const entryId  = tile.dataset.entryId;
    const photoIdx = Number(tile.dataset.photoIdx) || 0;
    const k = Store.state.myKids[this.selectedKidId];
    if (!k) return;
    const list = k[this.activeTab] || [];
    const entry = list.find(x => x.id === entryId);
    if (!entry || !entry.photos?.length) return;
    MyKidsLightbox.open(entry.photos, photoIdx);
  },

  // Render one entry card. Letters skip the photo grid. School entries
  // show the schoolYear meta line. All show date + title + body + actions.
  // v4.41: body renders as sanitized HTML (rich text); Art + Letters show
  // an optional link chip; clicking any photo opens the lightbox.
  entryCardHTML(e, entryIdx) {
    const photos = (e.photos || []).map((p, i) => `
      <div class="mykids-photo" data-mk-photo data-bucket="${escape(p.bucket || 'family-photos')}" data-path="${escape(p.path || '')}" data-photo-idx="${i}" data-entry-id="${escape(e.id)}" tabindex="0" aria-label="Photo ${i + 1}"></div>
    `).join('');
    const meta = [
      e.date ? `<time>${formatDate(e.date)}</time>` : '',
      (this.activeTab === 'school' && e.schoolYear) ? `<span class="muted small">${escape(e.schoolYear)}</span>` : '',
    ].filter(Boolean).join(' · ');
    const actions = Auth.isAdmin()
      ? `<div class="mykids-entry-actions">
           <button class="btn btn-ghost btn-sm" type="button" data-mk-edit="${e.id}">Edit</button>
           <button class="btn btn-danger-ghost btn-sm" type="button" data-mk-delete="${e.id}">Delete</button>
         </div>`
      : '';
    // v4.41: body is sanitized HTML. RichText.sanitize() is safe to render
    // straight (no script tags, attrs stripped). Legacy plain-text bodies
    // get auto-escaped + newline-converted at write-time; on the read path
    // we just trust the stored content.
    const bodyHTML = e.body
      ? (/<[a-z][^>]*>/i.test(e.body)
          ? `<div class="mykids-entry-body rich">${RichText.sanitize(e.body)}</div>`
          : `<div class="mykids-entry-body">${escape(e.body).replace(/\n/g, '<br>')}</div>`)
      : '';
    const linkChip = e.link
      ? `<a href="${escape(safeHttpUrl(e.link))}" target="_blank" rel="noopener noreferrer" class="mykids-link-chip" title="${escape(e.link)}">🔗 Open link</a>`
      : '';
    // v4.55: reactions + comments live below the photo row.
    const reactionsHTML = this.reactionsHTML(e);
    const commentsHTML = this.commentsHTML(e);
    return `
      <article class="mykids-entry" data-id="${e.id}">
        <header class="mykids-entry-head">
          <div>
            <h4 class="mykids-entry-title">${escape(e.title || 'Untitled')}</h4>
            <div class="mykids-entry-meta muted small">${meta}</div>
          </div>
          ${actions}
        </header>
        ${bodyHTML}
        ${linkChip}
        ${this.activeTab !== 'letters' && photos ? `<div class="mykids-entry-photos">${photos}</div>` : ''}
        ${reactionsHTML}
        ${commentsHTML}
      </article>`;
  },

  // ---------- Engagement helpers (v4.55) ----------
  // Reactions + comments mirror the Memories implementation. Family and
  // Admin can react/comment; User role sees the chips + reads comments
  // but the composer + quick-pick row are hidden.
  canEngage() { return Auth.isAdmin() || Auth.isFamily(); },
  currentUserId() { return Backend.user?.id || null; },
  currentAuthorName() {
    const me = Auth.current;
    if (me && me !== 'admin-bootstrap' && typeof me === 'object') return displayName(me);
    return Backend.user?.email || 'Admin';
  },
  QUICK_REACTIONS: ['❤️', '😂', '😮', '😢', '🎉', '👍', '🔥'],

  // Walk the current kid + section to find an entry by id. Used by every
  // reaction/comment handler so the mutation lands on the right object.
  findEntry(entryId) {
    const k = Store.state.myKids?.[this.selectedKidId];
    if (!k) return null;
    const list = k[this.activeTab];
    if (!Array.isArray(list)) return null;
    return list.find(x => x.id === entryId) || null;
  },

  reactionsRolledUp(e) {
    const out = new Map();
    for (const r of (e.reactions || [])) {
      if (!r || !r.emoji) continue;
      if (!out.has(r.emoji)) out.set(r.emoji, []);
      out.get(r.emoji).push(r);
    }
    return out;
  },
  myReactionEmojis(e) {
    const me = this.currentUserId();
    if (!me) return new Set();
    return new Set((e.reactions || []).filter(r => r.userId === me).map(r => r.emoji));
  },

  toggleReaction(entryId, emoji) {
    if (!this.canEngage()) {
      toast('Sign in with a Family or Admin role to react.', 'warn');
      return;
    }
    const e = this.findEntry(entryId); if (!e) return;
    const me = this.currentUserId(); if (!me) return;
    if (!Array.isArray(e.reactions)) e.reactions = [];
    const idx = e.reactions.findIndex(r => r.userId === me && r.emoji === emoji);
    if (idx >= 0) e.reactions.splice(idx, 1);
    else e.reactions.push({ emoji, userId: me, createdAt: Date.now() });
    Store.save();
    this.render();
  },

  // Hidden proxy input + EmojiPicker, same pattern Memories uses.
  openReactionPicker(btn) {
    if (!this.canEngage()) {
      toast('Sign in with a Family or Admin role to react.', 'warn');
      return;
    }
    const entryId = btn.dataset.mkId;
    let proxy = $('#mykids-reaction-proxy');
    if (!proxy) {
      proxy = document.createElement('input');
      proxy.type = 'hidden';
      proxy.id = 'mykids-reaction-proxy';
      proxy.dataset.entryId = entryId;
      document.body.appendChild(proxy);
      proxy.addEventListener('change', () => {
        const ch = proxy.value;
        if (!ch) return;
        proxy.value = '';
        this.toggleReaction(proxy.dataset.entryId, ch);
      });
    }
    proxy.dataset.entryId = entryId;
    EmojiPicker.open(proxy, btn);
  },

  addComment(entryId) {
    if (!this.canEngage()) return;
    const form = document.querySelector(`form[data-mk-comment-submit="${entryId}"]`);
    if (!form) return;
    const textarea = form.querySelector('textarea');
    const body = (textarea.value || '').trim();
    if (!body) return;
    const e = this.findEntry(entryId); if (!e) return;
    if (!Array.isArray(e.comments)) e.comments = [];
    e.comments.push({
      id: uid('cmt'),
      body,
      authorId:   this.currentUserId(),
      authorName: this.currentAuthorName(),
      createdAt:  Date.now(),
    });
    Store.save();
    textarea.value = '';
    this.render();
  },

  deleteComment(entryId, commentId) {
    const e = this.findEntry(entryId); if (!e) return;
    const c = (e.comments || []).find(x => x.id === commentId); if (!c) return;
    const me = this.currentUserId();
    const isOwn = c.authorId && me && c.authorId === me;
    if (!isOwn && !Auth.isAdmin()) return;
    if (!confirm('Delete this comment?')) return;
    e.comments = e.comments.filter(x => x.id !== commentId);
    Store.save();
    this.render();
  },

  // Reuses .memory-* CSS classes so reactions render identically to the
  // Memories feed. The data attributes are scoped to mk- so the
  // delegated handlers above don't double-fire on the Memories view.
  reactionsHTML(e) {
    if (!this.canEngage() && !(e.reactions || []).length) return '';
    const rolled = this.reactionsRolledUp(e);
    const mine = this.myReactionEmojis(e);
    const chips = [...rolled.entries()]
      .sort((a, z) => z[1].length - a[1].length)
      .map(([emoji, list]) => `
        <button type="button" class="memory-reaction-chip ${mine.has(emoji) ? 'is-mine' : ''} ${this.canEngage() ? '' : 'is-readonly'}" data-mk-react="${escape(emoji)}" data-mk-id="${escape(e.id)}" ${this.canEngage() ? '' : 'disabled'} title="${list.length} reaction${list.length === 1 ? '' : 's'}">
          <span class="memory-reaction-emoji">${emoji}</span>
          <span class="memory-reaction-count">${list.length}</span>
        </button>`).join('');
    const quickPicks = this.canEngage() ? `
      <div class="memory-react-picks">
        ${this.QUICK_REACTIONS.map(em => `
          <button type="button" class="memory-react-pick ${mine.has(em) ? 'is-mine' : ''}" data-mk-react="${escape(em)}" data-mk-id="${escape(e.id)}" title="React with ${em}">${em}</button>
        `).join('')}
        <button type="button" class="memory-react-more" data-mk-react-more data-mk-id="${escape(e.id)}" data-emoji-trigger title="More emojis">＋</button>
      </div>` : '';
    return `
      <div class="memory-reactions">
        ${chips ? `<div class="memory-reaction-chips">${chips}</div>` : ''}
        ${quickPicks}
      </div>`;
  },

  commentsHTML(e) {
    const comments = (e.comments || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const me = this.currentUserId();
    const canDelete = (c) => (c.authorId && me && c.authorId === me) || Auth.isAdmin();
    const items = comments.map(c => `
      <li class="memory-comment">
        <div class="memory-comment-head">
          <strong class="memory-comment-author">${escape(c.authorName || 'Someone')}</strong>
          <time class="memory-comment-date muted small">${relativeTime(c.createdAt)}</time>
          ${canDelete(c) ? `<button type="button" class="memory-comment-x" data-mk-comment-delete="${escape(c.id)}" data-mk-id="${escape(e.id)}" aria-label="Delete comment">×</button>` : ''}
        </div>
        <div class="memory-comment-body">${escape(c.body).replace(/\n/g, '<br>')}</div>
      </li>`).join('');
    const composer = this.canEngage()
      ? `<form class="memory-comment-add" data-mk-comment-submit="${escape(e.id)}">
          <textarea rows="2" placeholder="Write a comment…" maxlength="2000"></textarea>
          <button type="submit" class="btn btn-secondary btn-sm">Post</button>
        </form>`
      : '';
    if (!items && !composer) return '';
    return `
      <section class="memory-comments">
        ${items ? `<ul class="memory-comment-list">${items}</ul>` : ''}
        ${composer}
      </section>`;
  },

  // Resolve a single photo placeholder's signed URL and apply it as the
  // background image. Cached for ~50 min per session so flipping between
  // tabs doesn't re-hit the Supabase API.
  async resolvePhotoSrc(el) {
    const bucket = el.dataset.bucket;
    const path   = el.dataset.path;
    if (!bucket || !path) return;
    const key = `${bucket}|${path}`;
    const now = Date.now();
    const cached = this.signedUrlCache.get(key);
    if (cached && cached.expiresAt > now) {
      el.style.backgroundImage = `url('${cssUrl(cached.url)}')`;
      return;
    }
    const url = await Backend.getMediaUrl(bucket, path, 3600);
    if (!url) { el.style.backgroundImage = ''; el.classList.add('is-missing'); return; }
    this.signedUrlCache.set(key, { url, expiresAt: now + 50 * 60 * 1000 });
    el.style.backgroundImage = `url('${cssUrl(url)}')`;
  },

  async deleteEntry(entryId) {
    if (!Auth.isAdmin()) return;
    if (!confirm('Delete this entry? Photos attached to it will also be deleted from storage. This can\'t be undone.')) return;
    const k = Store.state.myKids[this.selectedKidId];
    if (!k) return;
    const list = k[this.activeTab];
    const idx = list.findIndex(e => e.id === entryId);
    if (idx < 0) return;
    const entry = list[idx];
    // Best-effort: delete attached photos from Storage so the bucket doesn't
    // accumulate orphans. Errors are logged but don't block the JSONB delete.
    for (const p of (entry.photos || [])) {
      await Backend.deleteMedia(p.bucket, p.path);
    }
    list.splice(idx, 1);
    Store.save();
    toast('Entry deleted.');
    this.render();
  },
};

// -------------------- RICH TEXT HELPER (v4.41) --------------------
// Tiny wrapper around a contenteditable div + a small toolbar. Exposes
// .mount / .read / .write / .focus so the Notes editor in MyKidsEntryModal
// can stay declarative. Output is sanitized HTML restricted to a small
// whitelist (b, i, u, br, p, ul, ol, li, a). document.execCommand is
// deprecated but still ubiquitously supported, and is the cheapest way to
// get a working bold/italic/list editor without pulling in a library.
const RichText = {
  // Tags allowed in stored HTML. Anything else gets unwrapped to text.
  ALLOWED_TAGS: new Set(['B','STRONG','I','EM','U','BR','P','DIV','UL','OL','LI','A']),
  // Attributes allowed per tag. `*` covers any element.
  ALLOWED_ATTRS: { 'A': new Set(['href']) },

  mount(container) {
    if (container.dataset.rtMounted) return;
    container.dataset.rtMounted = '1';
    const surface = container.querySelector('[data-rt-surface]');
    if (!surface) return;
    const toolbar = container.querySelector('.rt-toolbar');
    if (toolbar) {
      toolbar.addEventListener('mousedown', (e) => {
        // Prevent the toolbar from stealing selection focus when clicked.
        if (e.target.closest('[data-rt-cmd]')) e.preventDefault();
      });
      toolbar.querySelectorAll('[data-rt-cmd]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const cmd = btn.dataset.rtCmd;
          surface.focus();
          if (cmd === 'createLink') {
            const url = prompt('Link URL:');
            if (!url) return;
            try { document.execCommand('createLink', false, url); } catch {}
          } else if (cmd === 'emoji') {
            // Caller wires this — the emoji-insert flow is handled by the
            // entry modal (it opens the global EmojiPicker and writes back
            // the chosen character at the saved selection).
            const ev = new CustomEvent('rt-emoji', { bubbles: true, detail: { surface } });
            container.dispatchEvent(ev);
          } else {
            try { document.execCommand(cmd, false, null); } catch {}
          }
          surface.focus();
        });
      });
    }
    // Plain-text paste only — avoids inheriting Google Docs / Word styling.
    surface.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      document.execCommand('insertText', false, text);
    });
  },

  // Read the current HTML, sanitized for storage. Empty content (a single
  // <br> from a blank contenteditable) collapses to ''.
  read(container) {
    const surface = container.querySelector('[data-rt-surface]');
    if (!surface) return '';
    const html = this.sanitize(surface.innerHTML || '');
    // Strip "<br>" only / whitespace-only output so empty editors save as ''.
    const stripped = html.replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/gi, '').trim();
    return stripped ? html : '';
  },

  // Write content into the editor. Accepts either sanitized HTML (preferred)
  // or plain text (will be HTML-escaped with newline → <br>).
  write(container, content) {
    const surface = container.querySelector('[data-rt-surface]');
    if (!surface) return;
    if (!content) { surface.innerHTML = ''; return; }
    // Detect plain text vs HTML by presence of a tag. Plain text gets
    // escaped + newline-converted; HTML gets sanitized.
    if (/<[a-z][^>]*>/i.test(content)) {
      surface.innerHTML = this.sanitize(content);
    } else {
      surface.innerHTML = escape(content).replace(/\n/g, '<br>');
    }
  },

  focus(container) {
    container.querySelector('[data-rt-surface]')?.focus();
  },

  // Sanitize HTML: walks the tree, strips disallowed tags (unwrapping their
  // children into text), removes all attributes except a whitelist, and
  // forces <a href> to open safely. Returns a fresh HTML string.
  sanitize(html) {
    const doc = new DOMParser().parseFromString('<div>' + html + '</div>', 'text/html');
    const root = doc.body.firstChild;
    this._scrub(root);
    return root.innerHTML;
  },
  _scrub(node) {
    // Iterate children in reverse so removals don't break indexing.
    const kids = [...node.childNodes];
    for (const child of kids) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); continue; }
      const tag = child.tagName;
      if (!this.ALLOWED_TAGS.has(tag)) {
        // Unwrap: move children up to the parent, then drop this node.
        while (child.firstChild) child.parentNode.insertBefore(child.firstChild, child);
        child.remove();
        continue;
      }
      // Strip attributes except whitelist.
      const allowed = this.ALLOWED_ATTRS[tag] || new Set();
      [...child.attributes].forEach(attr => {
        if (!allowed.has(attr.name)) child.removeAttribute(attr.name);
      });
      if (tag === 'A') {
        // Scheme ALLOWLIST (replaces the old javascript:-only blacklist, which
        // let vbscript:, data:, and tab/newline-obfuscated "java&#9;script:"
        // through). First strip the control chars browsers ignore mid-scheme,
        // then permit only http/https/mailto/tel. Write the cleaned value back
        // so storage never holds the raw payload.
        const href = (child.getAttribute('href') || '').replace(/[\u0000-\u001F\u007F]/g, '').trim();
        if (/^(https?:|mailto:|tel:)/i.test(href)) {
          child.setAttribute('href', href);
          child.setAttribute('target', '_blank');
          child.setAttribute('rel', 'noopener noreferrer');
        } else {
          child.removeAttribute('href');
        }
      }
      this._scrub(child);
    }
  },
};

// -------------------- MY KIDS PICKER MODAL (v4.42) --------------------
// Pops a checkbox list of all members so the admin can pick exactly which
// ones appear on the My Kids roster. Selected ids land in
// state.myKidsRoster — which the roster resolver checks first before
// falling back to the parent-link auto-walk. Solves the common case of
// "I added my kids as members but never wired up parent links."
const MyKidsPickerModal = {
  searchQuery: '',
  workingIds: new Set(),

  init() {
    const el = $('#mykids-picker-modal'); if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    on(el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#mykids-picker-form'), 'submit', (e) => { e.preventDefault(); this.save(); });
    on($('#mykids-picker-search'), 'input', (e) => {
      this.searchQuery = (e.target.value || '').trim().toLowerCase();
      this.renderList();
    });
  },

  open() {
    if (!Auth.isAdmin()) return;
    this.workingIds = new Set(Store.state.myKidsRoster || []);
    this.searchQuery = '';
    $('#mykids-picker-search').value = '';
    this.renderList();
    const el = $('#mykids-picker-modal');
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('is-open');
    setTimeout(() => $('#mykids-picker-search')?.focus(), 50);
  },
  close() {
    const el = $('#mykids-picker-modal');
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-open');
  },

  renderList() {
    const list = $('#mykids-picker-list'); if (!list) return;
    const q = this.searchQuery;
    const members = sortMembers(Store.membersList())
      .filter(m => !m.dateOfDeath)
      .filter(m => {
        if (!q) return true;
        return `${m.firstName} ${m.middleName || ''} ${m.lastName} ${m.displayName || ''}`
          .toLowerCase().includes(q);
      });
    if (!members.length) {
      list.innerHTML = `<p class="muted small" style="padding:18px; text-align:center;">No members match "${escape(q)}".</p>`;
      return;
    }
    list.innerHTML = members.map(m => {
      const bg = m.photo ? `style="background-image:url('${cssUrl(m.photo)}')"` : '';
      const checked = this.workingIds.has(m.id) ? 'checked' : '';
      const age = ageLabel(m.birthday);
      const meta = [age, m.group].filter(Boolean).join(' · ');
      return `
        <label class="mykids-picker-row">
          <input type="checkbox" data-mk-pick="${m.id}" ${checked} />
          <div class="mykids-picker-avatar is-${m.gender || 'female'}" ${bg}></div>
          <div class="mykids-picker-info">
            <div class="mykids-picker-name">${escape(displayName(m))}</div>
            ${meta ? `<div class="muted small">${escape(meta)}</div>` : ''}
          </div>
        </label>`;
    }).join('');
    list.querySelectorAll('[data-mk-pick]').forEach(cb => {
      on(cb, 'change', () => {
        const id = cb.dataset.mkPick;
        if (cb.checked) this.workingIds.add(id);
        else this.workingIds.delete(id);
      });
    });
  },

  save() {
    if (!Auth.isAdmin()) return;
    Store.state.myKidsRoster = [...this.workingIds];
    Store.save();
    toast(this.workingIds.size
      ? `Saved — ${this.workingIds.size} kid${this.workingIds.size === 1 ? '' : 's'} on My Kids.`
      : 'Cleared — falling back to auto-walk from parent links.');
    this.close();
    MyKidsView.openRoster();
    MyKidsView.render();
  },
};

// -------------------- MY KIDS LIGHTBOX (v4.41) --------------------
// Click any photo in a kid's entry → full-screen lightbox with prev/next
// navigation through the entry's photo set. Reuses the existing dark
// overlay from the vault lightbox (#vault-lightbox) so we don't double
// up on z-index / overflow management — just swap the image source and
// attach prev/next buttons on demand.
const MyKidsLightbox = {
  photos: [],          // [{ bucket, path }]
  index: 0,
  bound: false,
  open(photos, startIndex) {
    if (!photos?.length) return;
    this.photos = photos;
    this.index = Math.max(0, Math.min(startIndex || 0, photos.length - 1));
    this.bind();
    const el = $('#vault-lightbox');
    if (!el) return;
    el.hidden = false;
    el.classList.add('is-mykids');
    document.body.style.overflow = 'hidden';
    this.update();
  },
  close() {
    const el = $('#vault-lightbox');
    if (!el) return;
    el.hidden = true;
    el.classList.remove('is-mykids');
    el.querySelector('img').src = '';
    document.body.style.overflow = '';
    this.photos = [];
  },
  bind() {
    if (this.bound) return;
    this.bound = true;
    // Inject prev/next/counter once. They only show when .is-mykids is set
    // on the lightbox root so the vault flow stays single-image.
    const el = $('#vault-lightbox');
    if (!el) return;
    if (!el.querySelector('.mk-lb-prev')) {
      const prev    = document.createElement('button');
      const next    = document.createElement('button');
      const counter = document.createElement('div');
      prev.type    = 'button';
      next.type    = 'button';
      prev.className    = 'mk-lb-prev';
      next.className    = 'mk-lb-next';
      counter.className = 'mk-lb-counter';
      prev.setAttribute('aria-label', 'Previous photo');
      next.setAttribute('aria-label', 'Next photo');
      prev.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M15 6l-6 6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      next.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      el.appendChild(prev);
      el.appendChild(next);
      el.appendChild(counter);
      prev.addEventListener('click', (e) => { e.stopPropagation(); this.step(-1); });
      next.addEventListener('click', (e) => { e.stopPropagation(); this.step(+1); });
    }
    document.addEventListener('keydown', (e) => {
      if ($('#vault-lightbox')?.hidden) return;
      if (!$('#vault-lightbox')?.classList.contains('is-mykids')) return;
      if (e.key === 'Escape')      this.close();
      if (e.key === 'ArrowLeft')   this.step(-1);
      if (e.key === 'ArrowRight')  this.step(+1);
    });
  },
  step(delta) {
    if (!this.photos.length) return;
    this.index = (this.index + delta + this.photos.length) % this.photos.length;
    this.update();
  },
  async update() {
    const el = $('#vault-lightbox');
    if (!el) return;
    const photo = this.photos[this.index];
    const url = await Backend.getMediaUrl(photo.bucket, photo.path, 3600);
    el.querySelector('img').src = url || '';
    const counter = el.querySelector('.mk-lb-counter');
    if (counter) counter.textContent = `${this.index + 1} / ${this.photos.length}`;
    // Hide nav controls when there's only one photo.
    const single = this.photos.length <= 1;
    el.querySelector('.mk-lb-prev')?.toggleAttribute('hidden', single);
    el.querySelector('.mk-lb-next')?.toggleAttribute('hidden', single);
    if (counter) counter.hidden = single;
  },
};

// -------------------- MY KIDS ENTRY MODAL (v4.40 Wave 2) --------------------
// Add / edit one entry on a kid's timeline. The kid id + section are
// captured at open() time; the form is reused across all 4 sections,
// hiding/showing fields per section (e.g. Letters have no photos).
const MyKidsEntryModal = {
  editingId: null,         // entry id, or null for "add"
  kidId: null,
  section: 'milestones',
  pendingPhotos: [],       // photos queued to upload OR already on the entry
                           //   each: { bucket, path, status: 'saved' | 'uploading' | 'failed', file? }
  uploading: 0,

  init() {
    const el = $('#mykids-entry-modal'); if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    on(el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#mykids-entry-form'), 'submit', (e) => { e.preventDefault(); this.save(); });
    on($('#mykids-entry-delete'), 'click', () => this.deleteCurrent());
    on($('#mykids-photo-input'), 'change', (e) => this.onPhotoPick(e));
    // v4.41: mount the rich-text editor once on init.
    RichText.mount($('#mykids-notes-editor'));
    // Title emoji button: reuse the EmojiPicker that gift / event icons use.
    on($('#mykids-title-emoji'), 'click', () => this.insertTitleEmoji());
    // Notes emoji button — wired via the RichText 'rt-emoji' event.
    $('#mykids-notes-editor')?.addEventListener('rt-emoji', () => this.insertNotesEmoji());
  },

  // Pop the global EmojiPicker, wait for a selection, then append it to
  // the Title input. We use the existing picker by giving it a hidden
  // sacrificial input and an anchor (the title-emoji button).
  insertTitleEmoji() {
    const fm = $('#mykids-entry-form');
    if (!fm) return;
    const anchor = $('#mykids-title-emoji');
    // Create-or-reuse a hidden proxy so EmojiPicker has somewhere to write.
    let proxy = $('#mykids-title-emoji-proxy');
    if (!proxy) {
      proxy = document.createElement('input');
      proxy.type = 'hidden';
      proxy.id = 'mykids-title-emoji-proxy';
      document.body.appendChild(proxy);
      // First-time: listen for the value flip and splice it into the title.
      proxy.addEventListener('change', () => {
        const ch = proxy.value;
        if (!ch) return;
        const t = fm.title;
        t.value = (t.value ? t.value + ' ' : '') + ch;
        proxy.value = '';
        t.focus();
      });
    }
    EmojiPicker.open(proxy, anchor);
  },

  // Same idea for Notes: open EmojiPicker, splice the chosen char into the
  // rich-text surface at the current caret position (using insertText so
  // we don't dirty the HTML structure).
  insertNotesEmoji() {
    const surface = $('#mykids-notes-editor [data-rt-surface]');
    if (!surface) return;
    let proxy = $('#mykids-notes-emoji-proxy');
    if (!proxy) {
      proxy = document.createElement('input');
      proxy.type = 'hidden';
      proxy.id = 'mykids-notes-emoji-proxy';
      document.body.appendChild(proxy);
      proxy.addEventListener('change', () => {
        const ch = proxy.value;
        if (!ch) return;
        proxy.value = '';
        surface.focus();
        // execCommand("insertText") puts the char at the caret — works
        // inside contenteditable, respects current selection, and undo.
        try { document.execCommand('insertText', false, ch); } catch {
          surface.appendChild(document.createTextNode(ch));
        }
      });
    }
    EmojiPicker.open(proxy, $('#mykids-notes-emoji'));
  },

  openAdd(kidId, section) {
    if (!Auth.isAdmin()) return;
    this.editingId = null;
    this.kidId     = kidId;
    this.section   = section;
    this.pendingPhotos = [];
    this.reset();
    $('#mykids-entry-title').textContent = this.titleFor(section, 'add');
    $('#mykids-entry-submit').textContent = 'Save entry';
    $('#mykids-entry-delete').hidden = true;
    $('#mykids-school-year-wrap').hidden = section !== 'school';
    $('#mykids-photos-wrap').hidden = section === 'letters';
    // v4.41: Link field shown only for Art + Letters.
    $('#mykids-link-wrap').hidden = !(section === 'art' || section === 'letters');
    RichText.write($('#mykids-notes-editor'), '');
    // Default the date to today so common case is "log today's event".
    const today = new Date(); const iso = today.toISOString().slice(0, 10);
    $('#mykids-entry-form').date.value = iso;
    this.renderPhotoGrid();
    this.open();
    setTimeout(() => $('#mykids-entry-form').title.focus(), 50);
  },

  openEdit(kidId, section, entryId) {
    if (!Auth.isAdmin()) return;
    const k = Store.state.myKids[kidId]; if (!k) return;
    const list = k[section] || [];
    const e = list.find(x => x.id === entryId); if (!e) return;
    this.editingId = entryId;
    this.kidId     = kidId;
    this.section   = section;
    // Pending list seeded with already-saved photos so removals on this
    // session can flag them for deletion on save.
    this.pendingPhotos = (e.photos || []).map(p => ({ bucket: p.bucket, path: p.path, status: 'saved' }));
    this.reset();
    $('#mykids-entry-title').textContent = this.titleFor(section, 'edit');
    $('#mykids-entry-submit').textContent = 'Save changes';
    $('#mykids-entry-delete').hidden = false;
    $('#mykids-school-year-wrap').hidden = section !== 'school';
    $('#mykids-photos-wrap').hidden = section === 'letters';
    $('#mykids-link-wrap').hidden = !(section === 'art' || section === 'letters');
    const fm = $('#mykids-entry-form');
    fm.date.value       = e.date || '';
    fm.title.value      = e.title || '';
    RichText.write($('#mykids-notes-editor'), e.body || '');
    if (fm.link) fm.link.value = e.link || '';
    if (section === 'school') fm.schoolYear.value = e.schoolYear || '';
    this.renderPhotoGrid();
    this.open();
  },

  titleFor(section, mode) {
    const labels = { milestones: 'Milestone', school: 'School entry', art: 'Artwork', letters: 'Letter' };
    const noun = labels[section] || 'Entry';
    return `${mode === 'add' ? 'Add' : 'Edit'} ${noun}`;
  },

  reset() {
    $('#mykids-entry-form').reset();
    $('#mykids-entry-error').hidden = true;
    $('#mykids-photo-status').textContent = '';
  },
  open() {
    const el = $('#mykids-entry-modal');
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('is-open');
  },
  close() {
    const el = $('#mykids-entry-modal');
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-open');
    this.editingId = null;
    this.kidId = null;
    this.pendingPhotos = [];
    this.uploading = 0; // abandon any in-flight count so a reopen isn't wedged
  },

  // Photo picker: each file goes through a downscale (no crop — multi-photo
  // crop is too clunky), then an upload to family-photos. The pendingPhotos
  // entry tracks each one's status so the grid can show "uploading…" tags.
  async onPhotoPick(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    const room = 6 - this.pendingPhotos.length;
    if (room <= 0) {
      toast('Max 6 photos per entry.', 'warn');
      return;
    }
    const toUpload = files.slice(0, room);
    if (files.length > room) toast(`Only first ${room} added — max 6 per entry.`, 'warn');
    for (const file of toUpload) {
      const placeholder = { status: 'uploading', file };
      this.pendingPhotos.push(placeholder);
      this.renderPhotoGrid();
      this.uploading++;
      try {
        // v4.41: downscale to 2400px (bumped from 1600). Gives the lightbox
        // view enough resolution to look crisp on retina displays and to
        // re-zoom later, while staying under ~900 KB per JPEG.
        const blob = await downscaleImageToBlob(file, 2400, 0.85);
        const folder = `kids/${this.kidId || 'unknown'}/${this.section || 'misc'}`;
        const result = await Backend.uploadMedia(
          new File([blob], file.name, { type: 'image/jpeg' }),
          { bucket: 'family-photos', folder, maxBytes: 10 * 1024 * 1024 }
        );
        if (!result.ok) throw new Error(result.reason);
        placeholder.status = 'saved';
        placeholder.bucket = result.bucket;
        placeholder.path = result.path;
        delete placeholder.file;
      } catch (err) {
        placeholder.status = 'failed';
        placeholder.error = err.message || String(err);
        toast(`Photo upload failed: ${placeholder.error}`, 'warn');
      } finally {
        this.uploading = Math.max(0, this.uploading - 1);
        this.renderPhotoGrid();
      }
    }
  },

  renderPhotoGrid() {
    const grid = $('#mykids-photo-grid');
    if (!grid) return;
    grid.innerHTML = this.pendingPhotos.map((p, i) => {
      const status = p.status === 'uploading' ? '<span class="mk-photo-badge">Uploading…</span>'
                   : p.status === 'failed'    ? '<span class="mk-photo-badge is-fail">Failed</span>'
                   : '';
      return `
        <div class="mykids-photo mk-photo-pending ${p.status === 'failed' ? 'is-failed' : ''}" data-i="${i}">
          ${p.status === 'saved' ? `<div class="mk-photo-img" data-mk-photo data-bucket="${escape(p.bucket || '')}" data-path="${escape(p.path || '')}"></div>` : ''}
          ${status}
          <button type="button" class="mk-photo-remove" data-remove-photo="${i}" aria-label="Remove photo">×</button>
        </div>`;
    }).join('');
    grid.querySelectorAll('[data-remove-photo]').forEach(btn => {
      on(btn, 'click', () => {
        const i = Number(btn.dataset.removePhoto);
        // Saved photos: delete from Storage immediately (unsaved entry would
        // leak the upload otherwise). For pending/failed placeholders just
        // drop from the list.
        const p = this.pendingPhotos[i];
        if (p?.status === 'saved' && p.bucket && p.path) {
          Backend.deleteMedia(p.bucket, p.path);
        }
        this.pendingPhotos.splice(i, 1);
        this.renderPhotoGrid();
      });
    });
    // Resolve signed URLs for any saved photos already in the grid.
    grid.querySelectorAll('[data-mk-photo]').forEach(el => MyKidsView.resolvePhotoSrc(el));
    // Toggle the "+ Add photo" affordance when full.
    const lbl = $('#mykids-photo-add-label');
    if (lbl) lbl.style.display = (this.pendingPhotos.length >= 6 ? 'none' : '');
  },

  async save() {
    if (!Auth.isAdmin()) return;
    if (this.uploading > 0) {
      $('#mykids-entry-error').textContent = 'Wait for photos to finish uploading.';
      $('#mykids-entry-error').hidden = false;
      return;
    }
    const fm = $('#mykids-entry-form');
    const fd = new FormData(fm);
    const title = (fd.get('title') || '').toString().trim();
    const date  = (fd.get('date')  || '').toString().trim();
    if (!title) {
      $('#mykids-entry-error').textContent = 'Title is required.';
      $('#mykids-entry-error').hidden = false;
      return;
    }
    if (!date) {
      $('#mykids-entry-error').textContent = 'Date is required.';
      $('#mykids-entry-error').hidden = false;
      return;
    }
    const k = Store.state.myKids[this.kidId] = Store.state.myKids[this.kidId] || {
      milestones: [], school: [], art: [], letters: [],
    };
    if (!Array.isArray(k[this.section])) k[this.section] = [];
    const list = k[this.section];
    const existing = this.editingId ? list.find(x => x.id === this.editingId) : null;
    const photos = this.pendingPhotos
      .filter(p => p.status === 'saved' && p.bucket && p.path)
      .map(p => ({ bucket: p.bucket, path: p.path }));
    const record = {
      ...(existing || {}),
      id: this.editingId || uid('mk'),
      date,
      title,
      // v4.41: body is now sanitized HTML from the rich-text editor.
      // Legacy entries (plain-text strings) still load correctly thanks
      // to RichText.write's text-vs-HTML detection.
      body: RichText.read($('#mykids-notes-editor')),
      photos: this.section === 'letters' ? [] : photos,
      createdAt: existing?.createdAt || Date.now(),
      createdBy: existing?.createdBy || Backend.user?.id || null,
    };
    if (this.section === 'school') {
      record.schoolYear = (fd.get('schoolYear') || '').toString().trim();
    }
    // v4.41: optional link on Art + Letters entries.
    if (this.section === 'art' || this.section === 'letters') {
      record.link = (fd.get('link') || '').toString().trim();
    } else {
      // Strip on entries that moved between sections.
      delete record.link;
    }
    if (existing) {
      const idx = list.findIndex(x => x.id === this.editingId);
      list[idx] = record;
    } else {
      list.push(record);
    }
    Store.save();
    toast(this.editingId ? 'Entry saved.' : 'Entry added.');
    this.close();
    MyKidsView.render();
  },

  async deleteCurrent() {
    if (!this.editingId) return;
    const id = this.editingId;
    this.close();
    MyKidsView.activeTab = this.section;
    MyKidsView.deleteEntry(id);
  },
};

// Downscale a File into a Blob. Mirrors downscaleImageFile() but returns a
// Blob (so we can upload it directly to Storage without a base64 round-trip).
function downscaleImageToBlob(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Image decode failed'));
      img.onload = () => {
        const w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const dw = Math.round(w * scale);
        const dh = Math.round(h * scale);
        const canvas = document.createElement('canvas');
        canvas.width = dw; canvas.height = dh;
        canvas.getContext('2d').drawImage(img, 0, 0, dw, dh);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob returned null')), 'image/jpeg', quality);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// -------------------- RECIPES VIEW (v4.44 — Wave 3a) --------------------
// Family cookbook. Admin-only CRUD; any authenticated user can view.
// Each recipe optionally references one "from" person (member id, or a
// friend household person via the m: / f: / s: / k: ref shape used by the
// events picker) plus an optional free-text attribution. Photos live in
// the family-photos Supabase Storage bucket from Wave 1 — the recipe row
// only carries { bucket, path }, so the archive JSONB row stays small.
const RecipesView = {
  selectedRecipeId: null,   // null = show grid; recipe id = show detail
  searchQuery: '',
  activeCategory: '',       // v4.46: '' = All; otherwise exact match against r.category
  signedUrlCache: new Map(),

  init() {
    on($('#btn-recipe-add'),         'click', () => RecipeModal.openAdd());
    on($('#btn-recipe-add-first'),   'click', () => RecipeModal.openAdd());
    on($('#btn-recipes-back'),       'click', () => this.openGrid());
    const search = $('#recipes-search');
    if (search) {
      on(search, 'input', () => {
        this.searchQuery = (search.value || '').trim().toLowerCase();
        this.render();
      });
    }
    RecipeModal.init();
  },

  // Distinct category list, sorted alphabetically, dedup case-insensitively.
  // Used to build the filter tab strip above the grid.
  categories() {
    const seen = new Map();
    for (const r of this.list()) {
      const c = (r.category || '').trim();
      if (!c) continue;
      const key = c.toLowerCase();
      if (!seen.has(key)) seen.set(key, c);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  },

  list() {
    return Array.isArray(Store.state.recipes) ? Store.state.recipes : [];
  },

  filtered() {
    const q = this.searchQuery;
    let list = this.list();
    // v4.46: category filter via the tab strip. '' = All.
    if (this.activeCategory) {
      const targetKey = this.activeCategory.toLowerCase();
      list = list.filter(r => (r.category || '').trim().toLowerCase() === targetKey);
    }
    if (q) {
      list = list.filter(r => {
        const hay = [
          r.name, r.category, r.fromText,
          this.formatFromRef(r.fromRef),
          (r.notes || '').replace(/<[^>]+>/g, ''),
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    // Sort: alphabetical by name (case-insensitive). Most cookbooks index
    // that way; an as-modified sort hides older recipes too aggressively.
    return list.slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
  },

  // Resolve a fromRef string to a renderable person object. Returns null
  // for non-people sources (use fromText for those). The ref shape mirrors
  // the events picker: m:<memberId> / f:<friendId> / s:<friendId> / k:<friendId>:<kidId>.
  resolveFromRef(ref) {
    if (!ref || typeof ref !== 'string') return null;
    if (ref.startsWith('m:')) return Store.byId(ref.slice(2));
    if (ref.startsWith('f:')) return Store.state.friends?.[ref.slice(2)] || null;
    if (ref.startsWith('s:')) {
      const f = Store.state.friends?.[ref.slice(2)];
      return f?.spouse || null;
    }
    if (ref.startsWith('k:')) {
      const parts = ref.split(':');
      const f = Store.state.friends?.[parts[1]];
      return (f?.kids || []).find(k => k.id === parts[2]) || null;
    }
    return null;
  },
  formatFromRef(ref) {
    const p = this.resolveFromRef(ref);
    return p ? displayName(p) : '';
  },

  render() {
    const isDetail = !!this.selectedRecipeId && this.list().some(r => r.id === this.selectedRecipeId);
    $('#recipes-grid-panel').hidden  = isDetail;
    $('#recipe-detail-panel').hidden = !isDetail;
    $('#btn-recipes-back').hidden = !isDetail;
    $('#btn-recipe-add').hidden   = isDetail || !Auth.isAdmin();
    if (isDetail) this.renderDetail();
    else          this.renderGrid();
  },

  renderGrid() {
    const grid  = $('#recipes-grid');
    const empty = $('#recipes-empty');
    if (!grid || !empty) return;

    // v4.46: category filter tabs. "All" is always present + every unique
    // category becomes its own tab. If the previously selected category
    // has since been removed (last recipe of that category deleted), fall
    // back to "All" so we don't show an empty filter result silently.
    this.renderCategoryTabs();

    const list = this.filtered();
    const title = $('#recipes-grid-title');
    if (title) {
      const catSuffix = this.activeCategory ? ` · ${this.activeCategory}` : '';
      title.textContent = this.searchQuery
        ? `Matches for "${this.searchQuery}" (${list.length})${catSuffix}`
        : (this.activeCategory ? `${this.activeCategory} (${list.length})` : `All recipes (${list.length})`);
    }
    const totalUnfiltered = this.list().length;
    if (!totalUnfiltered) {
      grid.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    grid.innerHTML = list.map(r => this.cardHTML(r)).join('') ||
      `<p class="muted" style="padding:24px; text-align:center;">No recipes ${this.searchQuery ? `matching "${escape(this.searchQuery)}"` : `in ${escape(this.activeCategory)}`}.</p>`;
    grid.querySelectorAll('[data-recipe]').forEach(card => {
      on(card, 'click', () => this.openRecipe(card.dataset.recipe));
    });
    // Resolve photo signed URLs lazily.
    grid.querySelectorAll('[data-recipe-photo]').forEach(el => this.resolvePhotoSrc(el));
  },

  renderCategoryTabs() {
    const host = $('#recipes-category-tabs'); if (!host) return;
    const cats = this.categories();
    // Drop the active filter back to All if its category vanished.
    if (this.activeCategory && !cats.some(c => c.toLowerCase() === this.activeCategory.toLowerCase())) {
      this.activeCategory = '';
    }
    const tabs = [
      `<button type="button" class="recipes-cat-tab ${this.activeCategory === '' ? 'is-active' : ''}" data-cat="">All <span class="recipes-cat-count">${this.list().length}</span></button>`,
      ...cats.map(c => {
        const count = this.list().filter(r => (r.category || '').toLowerCase() === c.toLowerCase()).length;
        return `<button type="button" class="recipes-cat-tab ${this.activeCategory.toLowerCase() === c.toLowerCase() ? 'is-active' : ''}" data-cat="${escape(c)}">${escape(c)} <span class="recipes-cat-count">${count}</span></button>`;
      }),
    ];
    host.innerHTML = tabs.join('');
    host.querySelectorAll('[data-cat]').forEach(btn => {
      on(btn, 'click', () => {
        this.activeCategory = btn.dataset.cat;
        this.render();
      });
    });
  },

  cardHTML(r) {
    const fromPerson = this.resolveFromRef(r.fromRef);
    const fromLabel = fromPerson ? displayName(fromPerson) : (r.fromText || '');
    return `
      <button type="button" class="recipe-card" data-recipe="${escape(r.id)}">
        <div class="recipe-card-photo" data-recipe-photo data-bucket="${escape(r.photo?.bucket || '')}" data-path="${escape(r.photo?.path || '')}">
          ${!r.photo?.path ? '<span class="recipe-card-no-photo" aria-hidden="true">🍽️</span>' : ''}
        </div>
        <div class="recipe-card-body">
          <div class="recipe-card-name">${escape(r.name || 'Untitled')}</div>
          <div class="recipe-card-meta muted small">
            ${r.category ? `<span class="recipe-card-cat">${escape(r.category)}</span>` : ''}
            ${fromLabel ? `<span class="recipe-card-from">from ${escape(fromLabel)}</span>` : ''}
          </div>
        </div>
      </button>`;
  },

  renderDetail() {
    const r = this.list().find(x => x.id === this.selectedRecipeId);
    if (!r) { this.openGrid(); return; }
    const host = $('#recipe-detail');
    if (!host) return;
    const fromPerson = this.resolveFromRef(r.fromRef);
    const fromLabel  = fromPerson ? displayName(fromPerson) : (r.fromText || '');
    const ingredientsList = (r.ingredients || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => `<li>${escape(line)}</li>`)
      .join('');
    const instructionsHTML = r.instructions
      ? (/<[a-z][^>]*>/i.test(r.instructions)
          ? RichText.sanitize(r.instructions)
          : escape(r.instructions).replace(/\n/g, '<br>'))
      : '';
    const notesHTML = r.notes
      ? (/<[a-z][^>]*>/i.test(r.notes)
          ? RichText.sanitize(r.notes)
          : escape(r.notes).replace(/\n/g, '<br>'))
      : '';
    const adminActions = Auth.isAdmin() ? `
      <div class="recipe-detail-actions">
        <button class="btn btn-ghost btn-sm"        type="button" id="btn-recipe-edit">Edit</button>
        <button class="btn btn-danger-ghost btn-sm" type="button" id="btn-recipe-delete">Delete</button>
      </div>` : '';
    host.innerHTML = `
      <div class="recipe-detail">
        ${r.photo?.path
          ? `<div class="recipe-detail-photo" data-recipe-photo data-bucket="${escape(r.photo.bucket)}" data-path="${escape(r.photo.path)}"></div>`
          : ''}
        <header class="recipe-detail-head">
          <div>
            <h3 class="recipe-detail-name">${escape(r.name || 'Untitled')}</h3>
            <div class="recipe-detail-meta muted small">
              ${r.category ? `<span class="recipe-card-cat">${escape(r.category)}</span>` : ''}
              ${fromLabel ? `<span>from <strong>${escape(fromLabel)}</strong></span>` : ''}
            </div>
          </div>
          ${adminActions}
        </header>
        ${r.link ? `<a href="${escape(safeHttpUrl(r.link))}" target="_blank" rel="noopener noreferrer" class="mykids-link-chip">🔗 Open link</a>` : ''}
        <div class="recipe-detail-grid">
          ${ingredientsList ? `
            <section>
              <h4>Ingredients</h4>
              <ul class="recipe-ingredients">${ingredientsList}</ul>
            </section>` : ''}
          ${instructionsHTML ? `
            <section>
              <h4>Instructions</h4>
              <div class="recipe-instructions rich">${instructionsHTML}</div>
            </section>` : ''}
        </div>
        ${notesHTML ? `
          <section class="recipe-notes">
            <h4>Notes</h4>
            <div class="rich">${notesHTML}</div>
          </section>` : ''}
      </div>`;
    if (r.photo?.path) {
      host.querySelectorAll('[data-recipe-photo]').forEach(el => this.resolvePhotoSrc(el));
      // Clicking the hero photo opens it in the lightbox.
      host.querySelector('.recipe-detail-photo')?.addEventListener('click', () => {
        MyKidsLightbox.open([r.photo], 0);
      });
    }
    if (Auth.isAdmin()) {
      on($('#btn-recipe-edit'),   'click', () => RecipeModal.openEdit(r.id));
      on($('#btn-recipe-delete'), 'click', () => this.deleteRecipe(r.id));
    }
  },

  openRecipe(id) { this.selectedRecipeId = id; this.render(); },
  openGrid()     { this.selectedRecipeId = null; this.render(); },

  // Same signed-URL cache pattern as MyKidsView. 50-minute TTL so flipping
  // between grid and detail doesn't re-hit Supabase for every render.
  async resolvePhotoSrc(el) {
    const bucket = el.dataset.bucket;
    const path   = el.dataset.path;
    if (!bucket || !path) return;
    const key = `${bucket}|${path}`;
    const cached = this.signedUrlCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      el.style.backgroundImage = `url('${cssUrl(cached.url)}')`;
      return;
    }
    const url = await Backend.getMediaUrl(bucket, path, 3600);
    if (!url) { el.classList.add('is-missing'); return; }
    this.signedUrlCache.set(key, { url, expiresAt: now + 50 * 60 * 1000 });
    el.style.backgroundImage = `url('${cssUrl(url)}')`;
  },

  async deleteRecipe(id) {
    if (!Auth.isAdmin()) return;
    const r = this.list().find(x => x.id === id); if (!r) return;
    if (!confirm(`Delete "${r.name}"? The photo is also removed from storage.`)) return;
    if (r.photo?.bucket && r.photo.path) {
      await Backend.deleteMedia(r.photo.bucket, r.photo.path);
    }
    Store.state.recipes = this.list().filter(x => x.id !== id);
    Store.save();
    toast('Recipe deleted.');
    this.openGrid();
  },
};

// -------------------- RECIPE MODAL (Wave 3a) --------------------
const RecipeModal = {
  editingId: null,
  tempPhoto: null,     // { bucket, path } once uploaded; null otherwise
  _clearPhoto: false,
  uploading: 0,

  init() {
    const el = $('#recipe-modal'); if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    on(el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#recipe-form'), 'submit', (e) => { e.preventDefault(); this.save(); });
    on($('#recipe-delete'), 'click', () => this.deleteCurrent());
    on($('#recipe-photo-input'), 'change', (e) => this.onPhotoPick(e));
    on($('#recipe-photo-clear'), 'click', () => this.clearPhoto());
    RichText.mount($('#recipe-instructions-editor'));
    RichText.mount($('#recipe-notes-editor'));
    // Wire emoji buttons (similar to MyKids modal — proxy input + EmojiPicker).
    this.bindRichTextEmoji('#recipe-instructions-editor', '#recipe-instructions-emoji', 'recipe-instr-emoji-proxy');
    this.bindRichTextEmoji('#recipe-notes-editor',         '#recipe-notes-emoji-btn',    'recipe-notes-emoji-proxy');
  },

  bindRichTextEmoji(editorSel, btnSel, proxyId) {
    const editor = $(editorSel);
    if (!editor) return;
    editor.addEventListener('rt-emoji', () => {
      const surface = editor.querySelector('[data-rt-surface]');
      if (!surface) return;
      let proxy = document.getElementById(proxyId);
      if (!proxy) {
        proxy = document.createElement('input');
        proxy.type = 'hidden';
        proxy.id = proxyId;
        document.body.appendChild(proxy);
        proxy.addEventListener('change', () => {
          const ch = proxy.value;
          if (!ch) return;
          proxy.value = '';
          surface.focus();
          try { document.execCommand('insertText', false, ch); }
          catch { surface.appendChild(document.createTextNode(ch)); }
        });
      }
      EmojiPicker.open(proxy, $(btnSel));
    });
  },

  // Build the from-ref <select> options once per open. The list is the
  // same set the events picker uses, minus the optgroup separation — a
  // single-select <select> with optgroups works well here too.
  populateFromRefSelect(currentRef) {
    const sel = $('#recipe-from-ref'); if (!sel) return;
    const memberOpts = sortMembers(Store.membersList())
      .filter(m => !m.dateOfDeath)
      .map(m => `<option value="m:${m.id}">${escape(displayName(m))}</option>`);
    const friendOpts = [];
    sortFriends(Object.values(Store.state.friends || {})).forEach(f => {
      friendOpts.push(`<option value="f:${f.id}">${escape(displayName(f))}</option>`);
      if (f.spouse) friendOpts.push(`<option value="s:${f.id}">${escape(displayName(f.spouse))} (spouse of ${escape(displayName(f))})</option>`);
      (f.kids || []).forEach(k => {
        friendOpts.push(`<option value="k:${f.id}:${k.id}">${escape(displayName(k))} (child of ${escape(displayName(f))})</option>`);
      });
    });
    sel.innerHTML = `
      <option value="">— None —</option>
      ${memberOpts.length ? `<optgroup label="Family">${memberOpts.join('')}</optgroup>` : ''}
      ${friendOpts.length ? `<optgroup label="Friends">${friendOpts.join('')}</optgroup>` : ''}
    `;
    sel.value = currentRef || '';
  },

  // Populate the <datalist> with already-used categories so quick-pick
  // is one click. Dedupes case-insensitively, sorts alphabetically.
  populateCategoryDatalist() {
    const datalist = $('#recipe-categories'); if (!datalist) return;
    const seen = new Map();
    for (const r of (Store.state.recipes || [])) {
      const c = (r.category || '').trim();
      if (!c) continue;
      const key = c.toLowerCase();
      if (!seen.has(key)) seen.set(key, c);
    }
    const cats = [...seen.values()].sort((a, b) => a.localeCompare(b));
    datalist.innerHTML = cats.map(c => `<option value="${escape(c)}"></option>`).join('');
  },

  openAdd() {
    if (!Auth.isAdmin()) return;
    this.editingId = null;
    this.tempPhoto = null;
    this._clearPhoto = false;
    this.reset();
    this.populateFromRefSelect('');
    this.populateCategoryDatalist();
    $('#recipe-modal-title').textContent = 'Add recipe';
    $('#recipe-submit').textContent = 'Save recipe';
    $('#recipe-delete').hidden = true;
    RichText.write($('#recipe-instructions-editor'), '');
    RichText.write($('#recipe-notes-editor'), '');
    this.renderPhotoPreview(null);
    this.open();
    setTimeout(() => $('#recipe-form').name.focus(), 50);
  },

  openEdit(id) {
    if (!Auth.isAdmin()) return;
    const r = (Store.state.recipes || []).find(x => x.id === id); if (!r) return;
    this.editingId = id;
    this.tempPhoto = null;
    this._clearPhoto = false;
    this.reset();
    this.populateFromRefSelect(r.fromRef || '');
    this.populateCategoryDatalist();
    $('#recipe-modal-title').textContent = `Edit ${r.name || 'recipe'}`;
    $('#recipe-submit').textContent = 'Save changes';
    $('#recipe-delete').hidden = false;
    const fm = $('#recipe-form');
    fm.name.value         = r.name || '';
    fm.category.value     = r.category || '';
    fm.link.value         = r.link || '';
    fm.fromText.value     = r.fromText || '';
    fm.ingredients.value  = r.ingredients || '';
    RichText.write($('#recipe-instructions-editor'), r.instructions || '');
    RichText.write($('#recipe-notes-editor'), r.notes || '');
    this.renderPhotoPreview(r.photo || null);
    this.open();
  },

  reset() {
    $('#recipe-form').reset();
    $('#recipe-error').hidden = true;
  },
  open() {
    const el = $('#recipe-modal');
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('is-open');
  },
  close() {
    const el = $('#recipe-modal');
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-open');
    this.editingId = null;
    this.tempPhoto = null;
    this._clearPhoto = false;
    this.uploading = 0; // abandon any in-flight count so a reopen isn't wedged
  },

  // Show either the most recent in-flight photo or the persisted one. If
  // the user clicked Clear, render the empty placeholder instead.
  async renderPhotoPreview(existing) {
    const el = $('#recipe-photo-preview');
    if (!el) return;
    const ref = this._clearPhoto ? null : (this.tempPhoto || existing || null);
    if (!ref) {
      el.style.backgroundImage = '';
      el.innerHTML = '<span class="recipe-photo-placeholder">🍽️</span>';
      return;
    }
    const url = await Backend.getMediaUrl(ref.bucket, ref.path, 3600);
    if (url) {
      el.style.backgroundImage = `url('${cssUrl(url)}')`;
      el.innerHTML = '';
    }
  },

  async onPhotoPick(e) {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    this.uploading++;
    try {
      // 1) Crop square via existing CropModal, 2) downscale to 2400, 3) upload.
      const dataUrl = await readFileAsDataURL(file);
      const cropped = await CropModal.open(dataUrl, { size: 800 });
      if (!cropped) return;
      // CropModal returns a data URL of a fixed square JPEG (~800px). For
      // recipes we keep it as-is — the square photo looks good in both
      // the grid card and the detail header without needing extra resize.
      const blob = await (await fetch(cropped)).blob();
      const result = await Backend.uploadMedia(
        new File([blob], `recipe-${Date.now()}.jpg`, { type: 'image/jpeg' }),
        { bucket: 'family-photos', folder: 'recipes', maxBytes: 10 * 1024 * 1024 }
      );
      if (!result.ok) throw new Error(result.reason);
      // If we're replacing an existing in-flight upload, clean it up.
      if (this.tempPhoto?.bucket) await Backend.deleteMedia(this.tempPhoto.bucket, this.tempPhoto.path);
      this.tempPhoto = { bucket: result.bucket, path: result.path };
      this._clearPhoto = false;
      this.renderPhotoPreview(null);
    } catch (err) {
      toast(`Photo upload failed: ${err.message || err}`, 'warn');
    } finally {
      this.uploading = Math.max(0, this.uploading - 1);
    }
  },

  async clearPhoto() {
    if (this.tempPhoto?.bucket) {
      // Wipe the just-uploaded but-never-saved photo from storage.
      await Backend.deleteMedia(this.tempPhoto.bucket, this.tempPhoto.path);
    }
    this.tempPhoto = null;
    this._clearPhoto = true;
    this.renderPhotoPreview(null);
  },

  async save() {
    if (!Auth.isAdmin()) return;
    if (this.uploading > 0) {
      $('#recipe-error').textContent = 'Wait for the photo to finish uploading.';
      $('#recipe-error').hidden = false;
      return;
    }
    const fm = $('#recipe-form');
    const fd = new FormData(fm);
    const name = (fd.get('name') || '').toString().trim();
    if (!name) {
      $('#recipe-error').textContent = 'Recipe name is required.';
      $('#recipe-error').hidden = false;
      return;
    }
    const existing = this.editingId
      ? (Store.state.recipes || []).find(r => r.id === this.editingId)
      : null;

    // Photo resolution: explicit clear → null. Brand new upload → use it
    // (and delete the previous one if we were editing). Otherwise inherit
    // the existing record's photo unchanged.
    let photo = null;
    if (this._clearPhoto) {
      if (existing?.photo?.bucket) await Backend.deleteMedia(existing.photo.bucket, existing.photo.path);
      photo = null;
    } else if (this.tempPhoto) {
      if (existing?.photo?.bucket && existing.photo.path !== this.tempPhoto.path) {
        await Backend.deleteMedia(existing.photo.bucket, existing.photo.path);
      }
      photo = this.tempPhoto;
    } else {
      photo = existing?.photo || null;
    }

    const record = {
      ...(existing || {}),
      id: this.editingId || uid('rcp'),
      name,
      category:     (fd.get('category')     || '').toString().trim(),
      fromRef:      (fd.get('fromRef')      || '').toString().trim(),
      fromText:     (fd.get('fromText')     || '').toString().trim(),
      link:         (fd.get('link')         || '').toString().trim(),
      ingredients:  (fd.get('ingredients')  || '').toString(),
      instructions: RichText.read($('#recipe-instructions-editor')),
      notes:        RichText.read($('#recipe-notes-editor')),
      photo,
      createdAt:    existing?.createdAt || Date.now(),
      createdBy:    existing?.createdBy || Backend.user?.id || null,
    };

    if (!Array.isArray(Store.state.recipes)) Store.state.recipes = [];
    if (existing) {
      const idx = Store.state.recipes.findIndex(r => r.id === this.editingId);
      Store.state.recipes[idx] = record;
    } else {
      Store.state.recipes.push(record);
    }
    Store.save();
    toast(this.editingId ? 'Recipe saved.' : 'Recipe added.');
    const newId = record.id;
    this.close();
    RecipesView.openRecipe(newId);
  },

  async deleteCurrent() {
    if (!this.editingId) return;
    const id = this.editingId;
    this.close();
    RecipesView.deleteRecipe(id);
  },
};

// -------------------- MEMORIES WALL (v4.45 — Wave 3b) --------------------
// Reverse-chrono feed of memory posts. Each post: date + rich-text body
// + up to 6 photos + multi-tag of people. Admin-only write, everyone
// authenticated can read. Tags use the same m:/f:/s:/k: ref shape as
// the events picker, so a tagged person resolves to a member or any
// friend household person consistently across the app.
const MemoriesView = {
  searchQuery: '',
  signedUrlCache: new Map(),
  subtab: 'posts',                 // v4.58: 'posts' (feed) | 'albums' (gallery)

  init() {
    on($('#btn-memory-add'),       'click', () => MemoryModal.openAdd());
    on($('#btn-memory-add-first'), 'click', () => MemoryModal.openAdd());
    const search = $('#memories-search');
    if (search) {
      on(search, 'input', () => {
        this.searchQuery = (search.value || '').trim().toLowerCase();
        this.render();
      });
    }
    // v4.58: Posts | Albums sub-tabs share one page.
    $$('[data-mem-subtab]').forEach(b => on(b, 'click', () => this.showSubtab(b.dataset.memSubtab)));
    MemoryModal.init();
  },

  // Switch between the Posts feed and the Albums gallery sub-panels, toggling
  // the matching "+ New …" action button + subtitle, then render that panel.
  showSubtab(which) {
    this.subtab = (which === 'albums') ? 'albums' : 'posts';
    $$('[data-mem-subtab]').forEach(b => b.classList.toggle('is-active', b.dataset.memSubtab === this.subtab));
    const postsPanel  = $('#memories-subpanel');
    const albumsPanel = $('#albums-subpanel');
    if (postsPanel)  postsPanel.hidden  = this.subtab !== 'posts';
    if (albumsPanel) albumsPanel.hidden = this.subtab !== 'albums';
    const addPost  = $('#btn-memory-add'); if (addPost)  addPost.hidden  = this.subtab !== 'posts';
    const addAlbum = $('#btn-album-add');  if (addAlbum) addAlbum.hidden = this.subtab !== 'albums';
    const sub = $('#memories-subtitle');
    if (sub) sub.textContent = this.subtab === 'albums'
      ? 'Photo collections — trips, birthdays, everyday moments. Make an album, add your photos.'
      : 'Moments worth holding on to — quick notes, a few photos, who was there.';
    if (this.subtab === 'albums') AlbumsView.render();
    else this.refresh();
  },

  // v4.58: memories now live in dedicated tables (open feed). The view holds
  // a cache loaded from MemoriesApi; render() draws from it. Mutations call
  // refresh() (load + render); the search box calls render() (no refetch).
  _items: [],
  list() { return this._items; },
  async load() { this._items = await MemoriesApi.list(); },
  async refresh() { await this.load(); this.render(); },

  // Filter + sort. Sort by date descending (newest first), falling back
  // to createdAt for posts that share a date.
  filtered() {
    const q = this.searchQuery;
    let list = this.list();
    if (q) {
      list = list.filter(m => {
        const hay = [
          (m.body || '').replace(/<[^>]+>/g, ''),
          m.date,
          (m.tags || []).map(t => resolvePersonRefLabel(t)).join(' '),
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    return list.slice().sort((a, z) => {
      const cmp = (z.date || '').localeCompare(a.date || '');
      if (cmp !== 0) return cmp;
      return (z.createdAt || 0) - (a.createdAt || 0);
    });
  },

  render() {
    const feed  = $('#memories-feed');
    const empty = $('#memories-empty');
    if (!feed || !empty) return;
    const list = this.filtered();
    const title = $('#memories-list-title');
    if (title) {
      title.textContent = this.searchQuery
        ? `Matches for "${this.searchQuery}" (${list.length})`
        : `All memories (${list.length})`;
    }
    const totalUnfiltered = this.list().length;
    if (!totalUnfiltered) {
      feed.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    if (!list.length) {
      feed.innerHTML = `<p class="muted" style="padding:24px; text-align:center;">No posts matching "${escape(this.searchQuery)}".</p>`;
      return;
    }
    feed.innerHTML = list.map(m => this.postHTML(m)).join('');
    feed.querySelectorAll('[data-mem-edit]').forEach(btn => {
      on(btn, 'click', () => MemoryModal.openEdit(btn.dataset.memEdit));
    });
    feed.querySelectorAll('[data-mem-delete]').forEach(btn => {
      on(btn, 'click', () => this.deletePost(btn.dataset.memDelete));
    });
    feed.querySelectorAll('[data-mem-photo]').forEach(el => this.resolvePhotoSrc(el));
    feed.querySelectorAll('[data-mem-photo]').forEach(tile => {
      on(tile, 'click', () => this.openLightboxFromTile(tile));
      on(tile, 'keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.openLightboxFromTile(tile);
        }
      });
    });
    // v4.46: reactions + comments wiring.
    feed.querySelectorAll('[data-react]').forEach(btn => {
      on(btn, 'click', () => this.toggleReaction(btn.dataset.memId, btn.dataset.react));
    });
    feed.querySelectorAll('[data-react-more]').forEach(btn => {
      on(btn, 'click', () => this.openReactionPicker(btn));
    });
    feed.querySelectorAll('[data-comment-submit]').forEach(form => {
      on(form, 'submit', (e) => { e.preventDefault(); this.addComment(form.dataset.commentSubmit); });
    });
    feed.querySelectorAll('[data-comment-delete]').forEach(btn => {
      on(btn, 'click', () => this.deleteComment(btn.dataset.memId, btn.dataset.commentDelete));
    });
    // v4.65: comment reactions
    feed.querySelectorAll('[data-creact]').forEach(btn => {
      on(btn, 'click', () => this.toggleCommentReaction(btn.dataset.memId, btn.dataset.commentId, btn.dataset.creact));
    });
    feed.querySelectorAll('[data-creact-more]').forEach(btn => {
      on(btn, 'click', () => this.openCommentReactionPicker(btn));
    });
  },

  // ---------- Permission helpers (v4.46) ----------
  // Per design decision: Family + Admin can react and comment; User role
  // can view but not engage. Bootstrap admin (no member record) still
  // passes because isAdmin() handles that case.
  // v4.58: open feed — any signed-in user can react & comment (was Admin+Family).
  canEngage() {
    return !!Backend.user;
  },
  currentUserId() {
    return Backend.user?.id || null;
  },
  currentAuthorName() {
    // Prefer the in-app member display name; fall back to auth email.
    const me = Auth.current;
    if (me && me !== 'admin-bootstrap' && typeof me === 'object') return displayName(me);
    return Backend.user?.email || 'Admin';
  },

  // ---------- Reactions (v4.46) ----------
  // 7 quick-pick emojis below each post + a "more" button that opens the
  // shared EmojiPicker. Each entry in `reactions` is { emoji, userId,
  // createdAt }. Clicking the same emoji again removes your own reaction.
  QUICK_REACTIONS: ['❤️', '😂', '😮', '😢', '🎉', '👍', '🔥'],

  reactionsRolledUp(m) {
    const out = new Map();
    for (const r of (m.reactions || [])) {
      if (!r || !r.emoji) continue;
      if (!out.has(r.emoji)) out.set(r.emoji, []);
      out.get(r.emoji).push(r);
    }
    return out;
  },

  myReactionEmojis(m) {
    const me = this.currentUserId();
    if (!me) return new Set();
    return new Set((m.reactions || []).filter(r => r.userId === me).map(r => r.emoji));
  },

  async toggleReaction(memId, emoji) {
    if (!this.canEngage()) {
      toast('Sign in to react.', 'warn');
      return;
    }
    const m = this.list().find(x => x.id === memId); if (!m) return;
    const me = this.currentUserId();
    if (!me) return;
    if (!Array.isArray(m.reactions)) m.reactions = [];
    const existingIdx = m.reactions.findIndex(r => r.userId === me && r.emoji === emoji);
    if (existingIdx >= 0) {
      m.reactions.splice(existingIdx, 1);          // optimistic
      this.render();
      const res = await MemoriesApi.removeReaction(memId, emoji);
      if (!res.ok) this.refresh();                 // reconcile on failure
    } else {
      m.reactions.push({ emoji, userId: me, createdAt: Date.now() });  // optimistic
      this.render();
      const res = await MemoriesApi.addReaction(memId, emoji);
      if (!res.ok) this.refresh();
    }
  },

  // Open the shared EmojiPicker. Picked emoji goes through toggleReaction
  // for the same add/remove semantics. The "more" button on the post is
  // marked data-emoji-trigger so the picker's outside-click handler
  // doesn't close it instantly.
  openReactionPicker(btn) {
    if (!this.canEngage()) {
      toast('Sign in to react.', 'warn');
      return;
    }
    const memId = btn.dataset.memId;
    let proxy = $('#memory-reaction-proxy');
    if (!proxy) {
      proxy = document.createElement('input');
      proxy.type = 'hidden';
      proxy.id = 'memory-reaction-proxy';
      proxy.dataset.memId = memId;
      document.body.appendChild(proxy);
      proxy.addEventListener('change', () => {
        const ch = proxy.value;
        if (!ch) return;
        proxy.value = '';
        this.toggleReaction(proxy.dataset.memId, ch);
      });
    }
    proxy.dataset.memId = memId;
    EmojiPicker.open(proxy, btn);
  },

  // ---------- Comment reactions (v4.65) ----------
  async toggleCommentReaction(memId, commentId, emoji) {
    if (!this.canEngage()) { toast('Sign in to react.', 'warn'); return; }
    const m = this.list().find(x => x.id === memId); if (!m) return;
    const c = (m.comments || []).find(x => x.id === commentId); if (!c) return;
    const me = this.currentUserId(); if (!me) return;
    if (!Array.isArray(c.reactions)) c.reactions = [];
    const idx = c.reactions.findIndex(r => r.userId === me && r.emoji === emoji);
    if (idx >= 0) {
      c.reactions.splice(idx, 1);                    // optimistic
      this.render();
      const res = await MemoriesApi.removeCommentReaction(commentId, emoji);
      if (!res.ok) this.refresh();
    } else {
      c.reactions.push({ emoji, userId: me });        // optimistic
      this.render();
      const res = await MemoriesApi.addCommentReaction(commentId, emoji);
      if (!res.ok) this.refresh();
    }
  },

  // Open the shared EmojiPicker for a comment; picked emoji toggles via the proxy.
  openCommentReactionPicker(btn) {
    if (!this.canEngage()) { toast('Sign in to react.', 'warn'); return; }
    let proxy = $('#memory-creaction-proxy');
    if (!proxy) {
      proxy = document.createElement('input');
      proxy.type = 'hidden';
      proxy.id = 'memory-creaction-proxy';
      document.body.appendChild(proxy);
      proxy.addEventListener('change', () => {
        const ch = proxy.value;
        if (!ch) return;
        proxy.value = '';
        this.toggleCommentReaction(proxy.dataset.memId, proxy.dataset.commentId, ch);
      });
    }
    proxy.dataset.memId = btn.dataset.memId;
    proxy.dataset.commentId = btn.dataset.commentId;
    EmojiPicker.open(proxy, btn);
  },

  // ---------- Comments (v4.46; tables in v4.58) ----------
  async addComment(memId) {
    if (!this.canEngage()) return;
    const form = document.querySelector(`form[data-comment-submit="${memId}"]`);
    if (!form) return;
    const textarea = form.querySelector('textarea');
    const body = (textarea.value || '').trim();
    if (!body) return;
    const res = await MemoriesApi.addComment(memId, body);
    if (!res.ok) { toast('Could not post comment.', 'warn'); return; }
    textarea.value = '';
    await this.refresh();
  },

  async deleteComment(memId, commentId) {
    const m = this.list().find(x => x.id === memId); if (!m) return;
    const c = (m.comments || []).find(x => x.id === commentId); if (!c) return;
    const me = this.currentUserId();
    const isOwn = c.authorId && me && c.authorId === me;
    if (!isOwn && !Auth.isAdmin()) return;
    if (!confirm('Delete this comment?')) return;
    const res = await MemoriesApi.deleteComment(commentId);
    if (!res.ok) { toast('Could not delete comment.', 'warn'); return; }
    await this.refresh();
  },

  postHTML(m) {
    const photos = (m.photos || []).map((p, i) => `
      <div class="mykids-photo" data-mem-photo data-bucket="${escape(p.bucket || 'family-photos')}" data-path="${escape(p.path || '')}" data-mem-id="${escape(m.id)}" data-photo-idx="${i}" tabindex="0" aria-label="Photo ${i + 1}"></div>
    `).join('');
    const bodyHTML = m.body
      ? (/<[a-z][^>]*>/i.test(m.body)
          ? `<div class="memory-body rich">${RichText.sanitize(m.body)}</div>`
          : `<div class="memory-body">${escape(m.body).replace(/\n/g, '<br>')}</div>`)
      : '';
    const tagsHTML = (m.tags || []).length
      ? `<div class="memory-tags">${(m.tags || []).map(t => {
          const label = resolvePersonRefLabel(t);
          return label ? `<span class="memory-tag">${escape(label)}</span>` : '';
        }).join('')}</div>`
      : '';
    // v4.58: a post's author can edit/delete their own; admin can manage any.
    const meId = this.currentUserId();
    const canManage = (m.createdBy && meId && m.createdBy === meId) || Auth.isAdmin();
    const actions = canManage ? `
      <div class="memory-actions">
        <button class="btn btn-ghost btn-sm"        type="button" data-mem-edit="${escape(m.id)}">Edit</button>
        <button class="btn btn-danger-ghost btn-sm" type="button" data-mem-delete="${escape(m.id)}">Delete</button>
      </div>` : '';
    // v4.46: reactions row.
    const reactionsHTML = this.reactionsHTML(m);
    // v4.46: comments section.
    const commentsHTML = this.commentsHTML(m);
    return `
      <article class="memory-post" data-id="${escape(m.id)}">
        <header class="memory-head">
          <div class="memory-byline">
            <strong class="memory-author">${escape(AuthorNames.nameFor(m.createdBy))}</strong>
            <time class="memory-date">${m.date ? formatDate(m.date) : '—'}</time>
          </div>
          ${actions}
        </header>
        ${bodyHTML}
        ${tagsHTML}
        ${photos ? `<div class="memory-photos">${photos}</div>` : ''}
        ${reactionsHTML}
        ${commentsHTML}
      </article>`;
  },

  // Render the reaction chip row. Each emoji that has at least one
  // reaction shows a chip with the count; the chip is "is-mine" when the
  // current user is among the reactors. Below the chips, the 7 quick-
  // picks live in a compact row + a "more" button opens the full picker.
  reactionsHTML(m) {
    if (!this.canEngage() && !(m.reactions || []).length) return '';
    const rolled = this.reactionsRolledUp(m);
    const mine = this.myReactionEmojis(m);
    const namesFor = (list) => list.map(r => AuthorNames.nameFor(r.userId)).filter(Boolean);
    const chips = [...rolled.entries()]
      .sort((a, z) => z[1].length - a[1].length)
      .map(([emoji, list]) => `
        <button type="button" class="memory-reaction-chip ${mine.has(emoji) ? 'is-mine' : ''} ${this.canEngage() ? '' : 'is-readonly'}" data-react="${escape(emoji)}" data-mem-id="${escape(m.id)}" ${this.canEngage() ? '' : 'disabled'} title="${escape(namesFor(list).join(', '))}">
          <span class="memory-reaction-emoji">${emoji}</span>
          <span class="memory-reaction-count">${list.length}</span>
        </button>`).join('');
    // v4.64: visibly show who reacted with which emoji.
    const whoLine = rolled.size ? `
      <div class="memory-reaction-who">
        ${[...rolled.entries()].sort((a, z) => z[1].length - a[1].length).map(([emoji, list]) =>
          `<span class="mrw-item"><span class="mrw-emoji">${emoji}</span> ${escape(namesFor(list).join(', '))}</span>`).join('')}
      </div>` : '';
    const quickPicks = this.canEngage() ? `
      <div class="memory-react-picks">
        ${this.QUICK_REACTIONS.map(e => `
          <button type="button" class="memory-react-pick ${mine.has(e) ? 'is-mine' : ''}" data-react="${escape(e)}" data-mem-id="${escape(m.id)}" title="React with ${e}">${e}</button>
        `).join('')}
        <button type="button" class="memory-react-more" data-react-more data-mem-id="${escape(m.id)}" data-emoji-trigger title="More emojis">＋</button>
      </div>` : '';
    return `
      <div class="memory-reactions">
        ${chips ? `<div class="memory-reaction-chips">${chips}</div>` : ''}
        ${whoLine}
        ${quickPicks}
      </div>`;
  },

  commentsHTML(m) {
    const comments = (m.comments || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const me = this.currentUserId();
    const canDelete = (c) => (c.authorId && me && c.authorId === me) || Auth.isAdmin();
    const items = comments.map(c => `
      <li class="memory-comment">
        <div class="memory-comment-head">
          <strong class="memory-comment-author">${escape(c.authorName || 'Someone')}</strong>
          <time class="memory-comment-date muted small">${relativeTime(c.createdAt)}</time>
          ${canDelete(c) ? `<button type="button" class="memory-comment-x" data-comment-delete="${escape(c.id)}" data-mem-id="${escape(m.id)}" aria-label="Delete comment">×</button>` : ''}
        </div>
        <div class="memory-comment-body">${escape(c.body).replace(/\n/g, '<br>')}</div>
        ${this.commentReactionsHTML(m, c)}
      </li>`).join('');
    const composer = this.canEngage()
      ? `<form class="memory-comment-add" data-comment-submit="${escape(m.id)}">
          <textarea rows="2" placeholder="Write a comment…" maxlength="2000"></textarea>
          <button type="submit" class="btn btn-secondary btn-sm">Post</button>
        </form>`
      : '';
    if (!items && !composer) return '';
    return `
      <section class="memory-comments">
        ${items ? `<ul class="memory-comment-list">${items}</ul>` : ''}
        ${composer}
      </section>`;
  },

  // v4.65: emoji reactions on an individual comment — existing reaction chips
  // (with who-reacted in the tooltip) + a "react" button that opens the picker.
  commentReactionsHTML(m, c) {
    const me = this.currentUserId();
    const rolled = new Map();
    for (const r of (c.reactions || [])) {
      if (!r || !r.emoji) continue;
      if (!rolled.has(r.emoji)) rolled.set(r.emoji, []);
      rolled.get(r.emoji).push(r);
    }
    const mine = new Set((c.reactions || []).filter(r => r.userId === me).map(r => r.emoji));
    const namesFor = (list) => list.map(r => AuthorNames.nameFor(r.userId)).filter(Boolean);
    const chips = [...rolled.entries()]
      .sort((a, z) => z[1].length - a[1].length)
      .map(([emoji, list]) => `
        <button type="button" class="memory-creaction-chip ${mine.has(emoji) ? 'is-mine' : ''}" data-creact="${escape(emoji)}" data-comment-id="${escape(c.id)}" data-mem-id="${escape(m.id)}" ${this.canEngage() ? '' : 'disabled'} title="${escape(namesFor(list).join(', '))}">
          <span>${emoji}</span><span class="memory-creaction-count">${list.length}</span>
        </button>`).join('');
    const reactBtn = this.canEngage()
      ? `<button type="button" class="memory-creaction-more" data-creact-more data-comment-id="${escape(c.id)}" data-mem-id="${escape(m.id)}" data-emoji-trigger title="React to this comment">☺ +</button>`
      : '';
    if (!chips && !reactBtn) return '';
    return `<div class="memory-creactions">${chips}${reactBtn}</div>`;
  },

  async resolvePhotoSrc(el) {
    const bucket = el.dataset.bucket;
    const path   = el.dataset.path;
    if (!bucket || !path) return;
    const key = `${bucket}|${path}`;
    const now = Date.now();
    const cached = this.signedUrlCache.get(key);
    if (cached && cached.expiresAt > now) {
      el.style.backgroundImage = `url('${cssUrl(cached.url)}')`;
      return;
    }
    const url = await Backend.getMediaUrl(bucket, path, 3600);
    if (!url) { el.classList.add('is-missing'); return; }
    this.signedUrlCache.set(key, { url, expiresAt: now + 50 * 60 * 1000 });
    el.style.backgroundImage = `url('${cssUrl(url)}')`;
  },

  openLightboxFromTile(tile) {
    const memId = tile.dataset.memId;
    const idx   = Number(tile.dataset.photoIdx) || 0;
    const m = this.list().find(x => x.id === memId);
    if (!m || !m.photos?.length) return;
    MyKidsLightbox.open(m.photos, idx);
  },

  async deletePost(id) {
    const m = this.list().find(x => x.id === id); if (!m) return;
    const me = this.currentUserId();
    const canManage = (m.createdBy && me && m.createdBy === me) || Auth.isAdmin();
    if (!canManage) return;
    if (!confirm('Delete this post? Photos attached to it are also removed from storage.')) return;
    for (const p of (m.photos || [])) {
      await Backend.deleteMedia(p.bucket, p.path);
    }
    const res = await MemoriesApi.remove(id);
    if (!res.ok) { toast('Could not delete post.', 'warn'); return; }
    toast('Post deleted.');
    await this.refresh();
  },
};

// Resolve a person ref (m:/f:/s:/k:) to a display label. Used by the
// memories feed for tag chips + search. Centralized so other features
// can reuse the same shape (e.g. recipes already does this inline).
function resolvePersonRefLabel(ref) {
  if (!ref || typeof ref !== 'string') return '';
  if (ref.startsWith('m:')) {
    const m = Store.byId(ref.slice(2));
    return m ? displayName(m) : '';
  }
  if (ref.startsWith('f:')) {
    const f = Store.state.friends?.[ref.slice(2)];
    return f ? displayName(f) : '';
  }
  if (ref.startsWith('s:')) {
    const f = Store.state.friends?.[ref.slice(2)];
    return f?.spouse ? displayName(f.spouse) : '';
  }
  if (ref.startsWith('k:')) {
    const parts = ref.split(':');
    const f = Store.state.friends?.[parts[1]];
    const k = (f?.kids || []).find(x => x.id === parts[2]);
    return k ? displayName(k) : '';
  }
  return '';
}

// -------------------- MEMORY MODAL (v4.45) --------------------
const MemoryModal = {
  editingId: null,
  pendingPhotos: [],
  workingTags: [],
  uploading: 0,

  init() {
    const el = $('#memory-modal'); if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    on(el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#memory-form'), 'submit', (e) => { e.preventDefault(); this.save(); });
    on($('#memory-delete'), 'click', () => this.deleteCurrent());
    on($('#memory-photo-input'), 'change', (e) => this.onPhotoPick(e));
    const dz = $('#memory-dropzone');
    if (dz) {
      const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
      on(dz, 'dragenter', (e) => { stop(e); dz.classList.add('is-dragover'); });
      on(dz, 'dragover',  (e) => { stop(e); dz.classList.add('is-dragover'); });
      on(dz, 'dragleave', (e) => { if (e.target === dz) dz.classList.remove('is-dragover'); });
      on(dz, 'drop',      (e) => { stop(e); dz.classList.remove('is-dragover'); this.uploadFiles(e.dataTransfer && e.dataTransfer.files); });
    }
    on($('#memory-tag-picker'),  'change', (e) => this.onTagPick(e));
    RichText.mount($('#memory-body-editor'));
    // Emoji button in body editor → reuse the same proxy pattern other
    // editors use.
    $('#memory-body-editor')?.addEventListener('rt-emoji', () => {
      const surface = $('#memory-body-editor [data-rt-surface]');
      let proxy = $('#memory-body-emoji-proxy');
      if (!proxy) {
        proxy = document.createElement('input');
        proxy.type = 'hidden';
        proxy.id = 'memory-body-emoji-proxy';
        document.body.appendChild(proxy);
        proxy.addEventListener('change', () => {
          const ch = proxy.value; if (!ch) return;
          proxy.value = '';
          surface?.focus();
          try { document.execCommand('insertText', false, ch); }
          catch { surface?.appendChild(document.createTextNode(ch)); }
        });
      }
      EmojiPicker.open(proxy, $('#memory-body-emoji'));
    });
  },

  populateTagPicker() {
    const sel = $('#memory-tag-picker'); if (!sel) return;
    const taken = new Set(this.workingTags);
    const memberOpts = sortMembers(Store.membersList())
      .filter(m => !m.dateOfDeath && !taken.has('m:' + m.id))
      .map(m => `<option value="m:${m.id}">${escape(displayName(m))}</option>`);
    const friendOpts = [];
    sortFriends(Object.values(Store.state.friends || {})).forEach(f => {
      if (!taken.has('f:' + f.id)) friendOpts.push(`<option value="f:${f.id}">${escape(displayName(f))}</option>`);
      if (f.spouse && !taken.has('s:' + f.id)) {
        friendOpts.push(`<option value="s:${f.id}">${escape(displayName(f.spouse))} (spouse of ${escape(displayName(f))})</option>`);
      }
      (f.kids || []).forEach(k => {
        if (!taken.has(`k:${f.id}:${k.id}`)) {
          friendOpts.push(`<option value="k:${f.id}:${k.id}">${escape(displayName(k))} (child of ${escape(displayName(f))})</option>`);
        }
      });
    });
    sel.innerHTML = `
      <option value="">+ Add person to tag…</option>
      ${memberOpts.length ? `<optgroup label="Family">${memberOpts.join('')}</optgroup>` : ''}
      ${friendOpts.length ? `<optgroup label="Friends">${friendOpts.join('')}</optgroup>` : ''}
    `;
    sel.value = '';
  },

  renderTagChips() {
    const host = $('#memory-tag-chips'); if (!host) return;
    host.innerHTML = this.workingTags.map(ref => {
      const label = resolvePersonRefLabel(ref) || '(unknown)';
      return `<span class="memory-tag-chip"><span>${escape(label)}</span><button type="button" class="memory-tag-x" data-remove-tag="${escape(ref)}" aria-label="Remove tag">×</button></span>`;
    }).join('') || '<span class="muted small">Nobody tagged yet.</span>';
    host.querySelectorAll('[data-remove-tag]').forEach(btn => {
      on(btn, 'click', () => {
        this.workingTags = this.workingTags.filter(t => t !== btn.dataset.removeTag);
        this.renderTagChips();
        this.populateTagPicker();
      });
    });
  },

  onTagPick(e) {
    const v = e.target.value; if (!v) return;
    if (!this.workingTags.includes(v)) this.workingTags.push(v);
    this.renderTagChips();
    this.populateTagPicker();
  },

  openAdd() {
    if (!Backend.user) { toast('Sign in to post.', 'warn'); return; }   // v4.58: open to all
    this.editingId = null;
    this.pendingPhotos = [];
    this.workingTags = [];
    this.reset();
    $('#memory-modal-title').textContent = 'New post';
    $('#memory-submit').textContent = 'Save post';
    $('#memory-delete').hidden = true;
    RichText.write($('#memory-body-editor'), '');
    $('#memory-form').date.value = new Date().toISOString().slice(0, 10);
    this.populateTagPicker();
    this.renderTagChips();
    this.renderPhotoGrid();
    this.open();
    setTimeout(() => $('#memory-form').date.focus(), 50);
  },

  openEdit(id) {
    const m = MemoriesView.list().find(x => x.id === id); if (!m) return;
    const me = Backend.user?.id;
    const canManage = (m.createdBy && me && m.createdBy === me) || Auth.isAdmin();
    if (!canManage) return;   // v4.58: author or admin only
    this.editingId = id;
    this.pendingPhotos = (m.photos || []).map(p => ({ status: 'saved', bucket: p.bucket, path: p.path }));
    this.workingTags = (m.tags || []).slice();
    this.reset();
    $('#memory-modal-title').textContent = 'Edit post';
    $('#memory-submit').textContent = 'Save changes';
    $('#memory-delete').hidden = false;
    RichText.write($('#memory-body-editor'), m.body || '');
    $('#memory-form').date.value = m.date || '';
    this.populateTagPicker();
    this.renderTagChips();
    this.renderPhotoGrid();
    this.open();
  },

  reset() {
    const fm = $('#memory-form');
    if (fm) { fm.reset(); }
    $('#memory-error').hidden = true;
  },
  open() {
    const el = $('#memory-modal');
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('is-open');
  },
  close() {
    const el = $('#memory-modal');
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-open');
    this.editingId = null;
    this.pendingPhotos = [];
    this.workingTags = [];
    this.uploading = 0; // abandon any in-flight count so a reopen isn't wedged
  },

  async onPhotoPick(e) {
    const list = e.target.files;
    e.target.value = '';
    await this.uploadFiles(list);
  },

  // Shared by the file picker and drag-and-drop. Images only, max 6 per post.
  async uploadFiles(fileList) {
    const all = [...(fileList || [])];
    if (!all.length) return;
    const imgs = all.filter(f => f && f.type && f.type.startsWith('image/'));
    if (!imgs.length) { toast('Only image files can be added.', 'warn'); return; }
    if (imgs.length < all.length) toast(`Skipped ${all.length - imgs.length} non-image file(s).`, 'warn');
    const room = 6 - this.pendingPhotos.length;
    if (room <= 0) { toast('Max 6 photos per post.', 'warn'); return; }
    const toUpload = imgs.slice(0, room);
    if (imgs.length > room) toast(`Only ${room} added — max 6 per post.`, 'warn');
    for (const file of toUpload) {
      const placeholder = { status: 'uploading' };
      this.pendingPhotos.push(placeholder);
      this.renderPhotoGrid();
      this.uploading++;
      try {
        const blob = await downscaleImageToBlob(file, 2400, 0.85);
        const result = await Backend.uploadMedia(
          new File([blob], file.name, { type: 'image/jpeg' }),
          { bucket: 'family-photos', folder: 'memories', maxBytes: 10 * 1024 * 1024 }
        );
        if (!result.ok) throw new Error(result.reason);
        placeholder.status = 'saved';
        placeholder.bucket = result.bucket;
        placeholder.path = result.path;
      } catch (err) {
        placeholder.status = 'failed';
        toast(`Photo upload failed: ${err.message || err}`, 'warn');
      } finally {
        this.uploading = Math.max(0, this.uploading - 1);
        this.renderPhotoGrid();
      }
    }
  },

  renderPhotoGrid() {
    const grid = $('#memory-photo-grid');
    if (!grid) return;
    grid.innerHTML = this.pendingPhotos.map((p, i) => {
      const badge = p.status === 'uploading' ? '<span class="mk-photo-badge">Uploading…</span>'
                  : p.status === 'failed'    ? '<span class="mk-photo-badge is-fail">Failed</span>'
                  : '';
      return `
        <div class="mykids-photo mk-photo-pending ${p.status === 'failed' ? 'is-failed' : ''}">
          ${p.status === 'saved' ? `<div class="mk-photo-img" data-mem-photo-preview data-bucket="${escape(p.bucket || '')}" data-path="${escape(p.path || '')}"></div>` : ''}
          ${badge}
          <button type="button" class="mk-photo-remove" data-remove-photo="${i}" aria-label="Remove photo">×</button>
        </div>`;
    }).join('');
    grid.querySelectorAll('[data-remove-photo]').forEach(btn => {
      on(btn, 'click', () => {
        const i = Number(btn.dataset.removePhoto);
        const p = this.pendingPhotos[i];
        if (p?.status === 'saved' && p.bucket && p.path) Backend.deleteMedia(p.bucket, p.path);
        this.pendingPhotos.splice(i, 1);
        this.renderPhotoGrid();
      });
    });
    grid.querySelectorAll('[data-mem-photo-preview]').forEach(el => MemoriesView.resolvePhotoSrc(el));
    const dz = $('#memory-dropzone');
    if (dz) dz.style.display = (this.pendingPhotos.length >= 6 ? 'none' : '');
  },

  async save() {
    if (!Backend.user) return;   // v4.58: any signed-in user
    if (this.uploading > 0) {
      $('#memory-error').textContent = 'Wait for photos to finish uploading.';
      $('#memory-error').hidden = false;
      return;
    }
    const fm = $('#memory-form');
    const fd = new FormData(fm);
    const date = (fd.get('date') || '').toString().trim();
    if (!date) {
      $('#memory-error').textContent = 'Date is required.';
      $('#memory-error').hidden = false;
      return;
    }
    const body = RichText.read($('#memory-body-editor'));
    const photos = this.pendingPhotos
      .filter(p => p.status === 'saved' && p.bucket && p.path)
      .map(p => ({ bucket: p.bucket, path: p.path }));
    if (!body && !photos.length) {
      $('#memory-error').textContent = 'Add a few words or at least one photo.';
      $('#memory-error').hidden = false;
      return;
    }
    // v4.58: persist via the memories tables (RLS enforces author/admin).
    const payload = { date, body, tags: this.workingTags.slice(), photos };
    const res = this.editingId
      ? await MemoriesApi.update(this.editingId, payload)
      : await MemoriesApi.create(payload);
    if (!res.ok) {
      $('#memory-error').textContent = res.reason || 'Could not save your post.';
      $('#memory-error').hidden = false;
      return;
    }
    toast(this.editingId ? 'Post saved.' : 'Post added.');
    this.close();
    await MemoriesView.refresh();
  },

  async deleteCurrent() {
    if (!this.editingId) return;
    const id = this.editingId;
    this.close();
    MemoriesView.deletePost(id);
  },
};

// -------------------- ALBUMS VIEW (v4.58) --------------------
// Owned photo collections, open to every signed-in user. Gallery = newest
// album as a hero banner + a cover-card grid below (layout B). Detail = a
// photo grid with the shared lightbox, plus album- and photo-level comments.
// Data lives in the albums/* tables via AlbumsApi; photos in family-photos.
const AlbumsView = {
  signedUrlCache: new Map(),   // bucket|path -> { url, expiresAt }
  albums: [],                   // cached list for the gallery
  coverByAlbum: new Map(),      // album_id -> { bucket, path } | null
  countByAlbum: new Map(),      // album_id -> photo count
  current: null,                // { album, photos, comments } when a detail is open
  _activePhotoId: null,

  // Drop cached cover + count for an album so the gallery re-resolves them.
  _invalidateAlbum(id) { this.coverByAlbum.delete(id); this.countByAlbum.delete(id); },

  init() {
    on($('#btn-album-add'),       'click', () => AlbumModal.openAdd());
    on($('#btn-album-add-first'), 'click', () => AlbumModal.openAdd());
    AlbumModal.init();
  },

  canCreate() { return !!Backend.user; },          // any logged-in user
  isOwner(album) { return album && Backend.user && album.created_by === Backend.user.id; },
  canManage(album) { return this.isOwner(album) || Auth.isAdmin(); },

  // ---------- Gallery (layout B: hero + grid) ----------
  async render() {
    // Always return to the gallery (not a stale detail view) on tab entry.
    this.current = null;
    this._activePhotoId = null;
    const detail = $('#album-detail');
    if (detail) { detail.hidden = true; detail.innerHTML = ''; }
    const gallery = $('#albums-gallery');
    const empty   = $('#albums-empty');
    if (!gallery) return;
    this.albums = await AlbumsApi.listAlbums();
    await this._resolveCovers();
    const canCreate = this.canCreate();
    // Uniform square-cover grid (Meta-style), with a "Create album" tile first.
    if (!this.albums.length && !canCreate) { gallery.innerHTML = ''; if (empty) empty.hidden = false; return; }
    if (empty) empty.hidden = true;
    const createTile = canCreate ? this.createTileHTML() : '';
    gallery.innerHTML = `<div class="albums-grid">${createTile}${this.albums.map(a => this.cardHTML(a)).join('')}</div>`;
    const ct = gallery.querySelector('[data-album-create]');
    if (ct) on(ct, 'click', () => AlbumModal.openAdd());
    gallery.querySelectorAll('[data-album-open]').forEach(el => {
      on(el, 'click', () => this.openAlbum(el.dataset.albumOpen));
      on(el, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openAlbum(el.dataset.albumOpen); } });
    });
    gallery.querySelectorAll('[data-album-cover]').forEach(el => this.resolvePhotoSrc(el));
  },

  // For each album, resolve a cover ref (explicit cover_photo_id, else newest
  // photo). One light query per album; albums are few. Cached across renders.
  async _resolveCovers() {
    for (const a of this.albums) {
      if (this.coverByAlbum.has(a.id)) continue;
      let ref = null, count = 0;
      if (Backend.client) {
        // photo count (light head query — failure here doesn't hide the album)
        const cnt = await Backend.client.from('album_photos').select('id', { count: 'exact', head: true }).eq('album_id', a.id);
        count = cnt.count || 0;
        // cover ref: explicit cover_photo_id, else newest photo
        let q = Backend.client.from('album_photos').select('bucket, path').eq('album_id', a.id);
        q = a.cover_photo_id ? q.eq('id', a.cover_photo_id) : q.order('created_at', { ascending: false }).limit(1);
        const { data } = await q;
        if (data && data[0]) ref = { bucket: data[0].bucket, path: data[0].path };
      }
      this.coverByAlbum.set(a.id, ref);
      this.countByAlbum.set(a.id, count);
    }
  },

  metaLine(a) {
    const count = this.countByAlbum.get(a.id) || 0;
    const by = AuthorNames.nameFor(a.created_by);
    return `${count} photo${count === 1 ? '' : 's'} · by ${escape(by)}`;
  },

  coverAttrs(a) {
    const ref = this.coverByAlbum.get(a.id);
    return ref
      ? `data-album-cover data-bucket="${escape(ref.bucket)}" data-path="${escape(ref.path)}"`
      : 'data-album-cover'; // no photo → placeholder via CSS .is-missing
  },

  // First grid tile: create a new album (Meta-style).
  createTileHTML() {
    return `
      <button type="button" class="album-card album-create-tile" data-album-create aria-label="Create a new album">
        <div class="album-create-box"><span class="album-create-plus" aria-hidden="true">+</span></div>
        <div class="album-card-body"><h4 class="album-card-title">Create album</h4></div>
      </button>`;
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

  // ---------- Detail ----------
  async openAlbum(id) {
    const data = await AlbumsApi.getAlbum(id);
    if (!data) { toast("Couldn't open that album.", 'warn'); return; }
    this.current = data;
    this._activePhotoId = null;
    $('#albums-gallery').innerHTML = '';
    const empty = $('#albums-empty'); if (empty) empty.hidden = true;
    this.renderDetail();
  },

  backToGallery() { this.current = null; this._activePhotoId = null; this.render(); },

  renderDetail() {
    const wrap = $('#album-detail');
    if (!wrap || !this.current) return;
    const { album, photos } = this.current;
    const albumComments = this.current.comments.filter(c => !c.photo_id);
    const manage = this.canManage(album);
    const photosHTML = photos.map((p, i) => {
      const isCover = album.cover_photo_id === p.id;
      return `
      <div class="album-photo ${isCover ? 'is-cover' : ''}" data-album-photo data-bucket="${escape(p.bucket)}" data-path="${escape(p.path)}" data-photo-idx="${i}" data-photo-id="${escape(p.id)}" tabindex="0" role="button" aria-label="Photo ${i + 1}${isCover ? ' (album cover)' : ''}">
        ${isCover ? '<span class="album-photo-coverbadge">★ Cover</span>' : ''}
        ${manage ? `<button type="button" class="album-photo-x" data-remove-photo="${escape(p.id)}" aria-label="Remove photo">×</button>` : ''}
        ${manage && !isCover ? `<button type="button" class="album-photo-setcover" data-set-cover="${escape(p.id)}">Set as cover</button>` : ''}
      </div>`;
    }).join('');
    wrap.hidden = false;
    wrap.innerHTML = `
      <button type="button" class="btn btn-ghost btn-sm album-back" id="album-back">← All albums</button>
      <header class="album-detail-head">
        <div>
          <h3 class="album-detail-title">${escape(album.title)}</h3>
          <p class="album-detail-meta">${photos.length} photo${photos.length === 1 ? '' : 's'} · by ${escape(AuthorNames.nameFor(album.created_by))}</p>
          ${album.description ? `<p class="album-detail-desc">${escape(album.description).replace(/\n/g, '<br>')}</p>` : ''}
        </div>
        ${manage ? `
          <div class="album-detail-actions">
            <button class="btn btn-ghost btn-sm"        type="button" id="album-edit">Edit</button>
            <button class="btn btn-danger-ghost btn-sm" type="button" id="album-delete">Delete album</button>
          </div>` : ''}
      </header>
      ${manage ? `
        <label class="photo-dropzone" id="album-dropzone">
          <input type="file" accept="image/*" id="album-photo-input" hidden multiple />
          <span class="photo-dropzone-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5"/><path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3"/></svg>
          </span>
          <span class="photo-dropzone-text">Drag photos here, or <span class="photo-dropzone-link">click to choose</span></span>
        </label>` : ''}
      <div id="album-upload-progress" class="album-upload-progress" hidden>
        <div class="aup-bar"><div class="aup-fill"></div></div>
        <span class="aup-label"></span>
      </div>
      ${photos.length ? `<div class="album-photo-grid">${photosHTML}</div>`
                      : `<p class="muted" style="padding:24px;text-align:center;">No photos yet${manage ? ' — add the first one.' : '.'}</p>`}
      ${this.commentsHTML(album, null, albumComments)}
      <div id="album-photo-comments"></div>
    `;
    on($('#album-back'), 'click', () => this.backToGallery());
    if (manage) {
      on($('#album-photo-input'), 'change', (e) => this.onPhotoPick(e));
      const dz = $('#album-dropzone');
      if (dz) {
        const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
        on(dz, 'dragenter', (e) => { stop(e); dz.classList.add('is-dragover'); });
        on(dz, 'dragover',  (e) => { stop(e); dz.classList.add('is-dragover'); });
        on(dz, 'dragleave', (e) => { if (e.target === dz) dz.classList.remove('is-dragover'); });
        on(dz, 'drop',      (e) => { stop(e); dz.classList.remove('is-dragover'); this.uploadFiles(e.dataTransfer && e.dataTransfer.files); });
      }
      on($('#album-edit'),   'click', () => AlbumModal.openEdit(album));
      on($('#album-delete'), 'click', () => this.deleteAlbum());
      wrap.querySelectorAll('[data-remove-photo]').forEach(btn =>
        on(btn, 'click', (e) => { e.stopPropagation(); this.removePhoto(btn.dataset.removePhoto); }));
      wrap.querySelectorAll('[data-set-cover]').forEach(btn =>
        on(btn, 'click', (e) => { e.stopPropagation(); this.setCover(btn.dataset.setCover); }));
    }
    wrap.querySelectorAll('[data-album-photo]').forEach(el => this.resolvePhotoSrc(el));
    wrap.querySelectorAll('[data-album-photo]').forEach(tile => {
      on(tile, 'click', () => this.openLightbox(Number(tile.dataset.photoIdx)));
      on(tile, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openLightbox(Number(tile.dataset.photoIdx)); } });
    });
    this.wireComments(album);
    this._renderPhotoComments();
  },

  openLightbox(idx) {
    const photos = (this.current?.photos || []);
    if (!photos.length) return;
    MyKidsLightbox.open(photos.map(p => ({ bucket: p.bucket, path: p.path })), idx || 0);
    // Surface the selected photo's comment thread beneath the grid.
    this._activePhotoId = photos[idx]?.id || null;
    this._renderPhotoComments();
  },

  // Show/update the inline upload progress bar. done = files finished so far.
  _setUploadProgress(done, total) {
    const prog = $('#album-upload-progress');
    if (!prog) return;
    prog.hidden = false;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const fill = prog.querySelector('.aup-fill');
    const label = prog.querySelector('.aup-label');
    if (fill) fill.style.width = pct + '%';
    if (label) label.textContent = done < total ? `Uploading ${done + 1} of ${total}…` : `Saving ${total} photo${total === 1 ? '' : 's'}…`;
  },
  _hideUploadProgress() { const p = $('#album-upload-progress'); if (p) p.hidden = true; },

  async onPhotoPick(e) {
    const list = e.target.files;
    e.target.value = '';
    await this.uploadFiles(list);
  },

  // Shared by the file picker and drag-and-drop. Images only.
  async uploadFiles(fileList) {
    if (!this.current) return;
    const all = [...(fileList || [])];
    if (!all.length) return;   // nothing selected (e.g. picker cancelled)
    const files = all.filter(f => f && f.type && f.type.startsWith('image/'));
    if (!files.length) { toast('Only image files can be added to an album.', 'warn'); return; }
    if (files.length < all.length) toast(`Skipped ${all.length - files.length} non-image file(s).`, 'warn');
    const album = this.current.album;
    const uploaded = [];
    let done = 0;
    this._setUploadProgress(0, files.length);   // immediate feedback
    for (const file of files) {
      try {
        const blob = await downscaleImageToBlob(file, 2400, 0.85);
        const r = await Backend.uploadMedia(new File([blob], file.name, { type: 'image/jpeg' }),
          { bucket: 'family-photos', folder: 'albums', maxBytes: 10 * 1024 * 1024 });
        if (!r.ok) throw new Error(r.reason);
        uploaded.push({ bucket: r.bucket, path: r.path });
      } catch (err) { toast(`Photo upload failed: ${err.message || err}`, 'warn'); }
      done++;
      this._setUploadProgress(done, files.length);
    }
    if (uploaded.length) {
      const res = await AlbumsApi.addPhotos(album.id, uploaded);
      if (!res.ok) { this._hideUploadProgress(); toast('Could not save photos.', 'warn'); return; }
      this._invalidateAlbum(album.id);   // cover may have changed
      await this.openAlbum(album.id);        // re-fetch + re-render (rebuilds the panel, clearing the bar)
      toast(`${uploaded.length} photo${uploaded.length === 1 ? '' : 's'} added.`);
    } else {
      this._hideUploadProgress();
    }
  },

  // Set which photo is the album's showcase cover (used on the gallery card).
  async setCover(photoId) {
    if (!this.current) return;
    const album = this.current.album;
    const res = await AlbumsApi.updateAlbum(album.id, { cover_photo_id: photoId });
    if (!res.ok) { toast('Could not set the cover.', 'warn'); return; }
    this.current.album.cover_photo_id = photoId;
    this._invalidateAlbum(album.id);   // gallery re-resolves the cover next render
    toast('Cover photo updated.');
    this.renderDetail();
  },

  async removePhoto(photoId) {
    if (!this.current) return;
    if (!confirm('Remove this photo from the album?')) return;
    const photo = this.current.photos.find(p => p.id === photoId);
    const res = await AlbumsApi.removePhoto(photoId);
    if (!res.ok) { toast('Could not remove photo.', 'warn'); return; }
    if (photo) await Backend.deleteMedia(photo.bucket, photo.path);  // best-effort storage cleanup
    this._invalidateAlbum(this.current.album.id);
    await this.openAlbum(this.current.album.id);
  },

  async deleteAlbum() {
    if (!this.current) return;
    const album = this.current.album;
    if (!confirm('Delete this whole album and its photos? This cannot be undone.')) return;
    for (const p of this.current.photos) await Backend.deleteMedia(p.bucket, p.path); // best-effort
    const res = await AlbumsApi.deleteAlbum(album.id);
    if (!res.ok) { toast('Could not delete album.', 'warn'); return; }
    this._invalidateAlbum(album.id);
    toast('Album deleted.');
    this.backToGallery();
  },

  // ---------- Comments (album-level + per-photo) ----------
  canComment() { return !!Backend.user; },
  canDeleteComment(c, album) {
    const me = Backend.user?.id;
    return (c.author && me && c.author === me) || this.isOwner(album) || Auth.isAdmin();
  },

  // photoId null → album-level comments. `list` is the pre-filtered subset.
  commentsHTML(album, photoId, list) {
    const items = (list || []).slice()
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).map(c => `
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
    if (!wrap) return;
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

  // Render the active photo's comment thread (if a photo is selected) into the
  // dedicated host beneath the grid.
  _renderPhotoComments() {
    const host = $('#album-photo-comments');
    if (!host || !this.current) return;
    if (!this._activePhotoId) { host.innerHTML = ''; return; }
    const album = this.current.album;
    const list = this.current.comments.filter(c => c.photo_id === this._activePhotoId);
    const inner = this.commentsHTML(album, this._activePhotoId, list)
      .replace('<h4 class="album-comments-title">Comments</h4>', '<h4 class="album-comments-title">Comments on the selected photo</h4>');
    host.innerHTML = `<div class="album-photo-comments-inner">${inner}</div>`;
    this.wireComments(album);
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
};

// -------------------- ALBUM MODAL (v4.58) --------------------
// Create / edit album metadata (title, date, description). Photos are added
// from the detail view, so creating an album drops you straight into it.
const AlbumModal = {
  editing: null,   // album object when editing, else null
  init() {
    const fm = $('#album-form');
    if (fm) on(fm, 'submit', (e) => { e.preventDefault(); this.save(); });
    const modal = $('#album-modal');
    if (modal) modal.querySelectorAll('[data-close]').forEach(el => on(el, 'click', () => this.close()));
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

// -------------------- TIME CAPSULE (v4.47 — Wave 4a) --------------------
// Sealed letters addressed to a family member, locked until an admin-chosen
// unlock date. Admin writes; the recipient sees a "sealed envelope" card
// until the date passes (admin can override and reveal early — admin
// override policy chosen in v4.47). Capsules with photo/link attach
// through the same Wave 1 Storage pipeline as everything else.
const TimeCapsuleView = {
  signedUrlCache: new Map(),

  init() {
    on($('#btn-tcp-add'),       'click', () => TimeCapsuleModal.openAdd());
    on($('#btn-tcp-add-first'), 'click', () => TimeCapsuleModal.openAdd());
    TimeCapsuleModal.init();
  },

  list() {
    return Array.isArray(Store.state.timeCapsules) ? Store.state.timeCapsules : [];
  },

  // Lock check: today's date is compared lexicographically against the
  // capsule's unlockDate (both YYYY-MM-DD strings, both in local time).
  // Capsule is locked when today < unlockDate.
  isLocked(c) {
    if (!c.unlockDate) return false;
    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    return todayIso < c.unlockDate;
  },

  // Permission: who's allowed on this view at all. Admin always. Non-admin
  // members allowed when at least one capsule is addressed to them (their
  // own).
  canViewerAccess() {
    if (Auth.isAdmin()) return true;
    const me = Auth.current;
    if (!me || me === 'admin-bootstrap' || typeof me !== 'object') return false;
    const myRef = 'm:' + me.id;
    return this.list().some(c => c.recipientRef === myRef);
  },

  // Visible-to-this-user capsules. Admin sees everything; recipients see
  // only the capsules addressed to them.
  visibleCapsules() {
    if (Auth.isAdmin()) return this.list();
    const me = Auth.current;
    if (!me || typeof me !== 'object') return [];
    const myRef = 'm:' + me.id;
    return this.list().filter(c => c.recipientRef === myRef);
  },

  render() {
    const visible = this.visibleCapsules();
    const sealed  = visible.filter(c => this.isLocked(c) && !c.revealedBy);
    const opened  = visible.filter(c => !this.isLocked(c) || c.revealedBy);

    // Newest unlock-date first within each bucket.
    sealed.sort((a, b) => (a.unlockDate || '').localeCompare(b.unlockDate || ''));
    opened.sort((a, b) => (b.unlockDate || '').localeCompare(a.unlockDate || ''));

    $('#tcp-opened-list').innerHTML = opened.map(c => this.openedCardHTML(c)).join('');
    $('#tcp-sealed-list').innerHTML = sealed.map(c => this.sealedCardHTML(c)).join('');
    $('#tcp-opened-empty').hidden = opened.length > 0;
    $('#tcp-sealed-empty').hidden = sealed.length > 0;
    $('#tcp-empty').hidden = visible.length > 0;
    // Add button visible only to admins.
    $('#btn-tcp-add').hidden = !Auth.isAdmin();

    // Wire actions
    document.querySelectorAll('[data-tcp-reveal]').forEach(btn => {
      on(btn, 'click', () => this.revealNow(btn.dataset.tcpReveal));
    });
    document.querySelectorAll('[data-tcp-edit]').forEach(btn => {
      on(btn, 'click', () => TimeCapsuleModal.openEdit(btn.dataset.tcpEdit));
    });
    document.querySelectorAll('[data-tcp-delete]').forEach(btn => {
      on(btn, 'click', () => this.deleteCapsule(btn.dataset.tcpDelete));
    });
    document.querySelectorAll('[data-tcp-photo]').forEach(el => this.resolvePhotoSrc(el));
    document.querySelectorAll('[data-tcp-photo]').forEach(tile => {
      on(tile, 'click', () => {
        const c = this.list().find(x => x.id === tile.dataset.tcpPhotoCap);
        if (c?.photo) MyKidsLightbox.open([c.photo], 0);
      });
    });
  },

  // SEALED envelope card. Admins see who it's for + the unlock date +
  // a "Reveal early" override; recipients see just the unlock date and
  // a generic envelope.
  sealedCardHTML(c) {
    const isAdmin = Auth.isAdmin();
    const recipient = resolvePersonRefLabel(c.recipientRef) || 'someone';
    const adminControls = isAdmin ? `
      <div class="tcp-card-actions">
        <button class="btn btn-secondary btn-sm" type="button" data-tcp-reveal="${escape(c.id)}" title="Force-reveal this capsule now (admin override)">Reveal early</button>
        <button class="btn btn-ghost btn-sm"     type="button" data-tcp-edit="${escape(c.id)}">Edit</button>
        <button class="btn btn-danger-ghost btn-sm" type="button" data-tcp-delete="${escape(c.id)}">Delete</button>
      </div>` : '';
    return `
      <article class="tcp-card is-sealed" data-id="${escape(c.id)}">
        <div class="tcp-envelope">
          <div class="tcp-envelope-flap"></div>
          <div class="tcp-envelope-body">
            <div class="tcp-envelope-lock">🔒</div>
            <div class="tcp-envelope-meta">
              ${isAdmin ? `<div class="tcp-envelope-to">To: <strong>${escape(recipient)}</strong></div>` : ''}
              <div class="tcp-envelope-when">Opens on <strong>${escape(formatDate(c.unlockDate))}</strong></div>
              ${c.title ? `<div class="tcp-envelope-title muted small">${escape(c.title)}</div>` : ''}
            </div>
          </div>
        </div>
        ${adminControls}
      </article>`;
  },

  // OPENED card — full content visible. Title + body + photo + link.
  // Author + sealed-on stamp at the bottom; if force-revealed, that's
  // also called out so the recipient knows the unlock wasn't strict.
  openedCardHTML(c) {
    const isAdmin = Auth.isAdmin();
    const recipient = resolvePersonRefLabel(c.recipientRef) || 'someone';
    const author = c.authorName || 'someone';
    const bodyHTML = c.body
      ? (/<[a-z][^>]*>/i.test(c.body)
          ? `<div class="tcp-body rich">${RichText.sanitize(c.body)}</div>`
          : `<div class="tcp-body">${escape(c.body).replace(/\n/g, '<br>')}</div>`)
      : '';
    const wasOverride = !!c.revealedBy && this.isLocked(c);
    const photoHTML = c.photo?.path
      ? `<div class="tcp-photo" data-tcp-photo data-bucket="${escape(c.photo.bucket)}" data-path="${escape(c.photo.path)}" data-tcp-photo-cap="${escape(c.id)}" tabindex="0"></div>`
      : '';
    const adminControls = isAdmin ? `
      <div class="tcp-card-actions">
        <button class="btn btn-ghost btn-sm"        type="button" data-tcp-edit="${escape(c.id)}">Edit</button>
        <button class="btn btn-danger-ghost btn-sm" type="button" data-tcp-delete="${escape(c.id)}">Delete</button>
      </div>` : '';
    return `
      <article class="tcp-card is-opened" data-id="${escape(c.id)}">
        <header class="tcp-card-head">
          <div>
            <div class="muted small">To <strong>${escape(recipient)}</strong> · From <strong>${escape(author)}</strong></div>
            ${c.title ? `<h3 class="tcp-card-title">${escape(c.title)}</h3>` : ''}
            <div class="muted small">Sealed ${escape(formatDate(isoDay(c.sealedAt)))} · Opened ${escape(formatDate(c.unlockDate))}${wasOverride ? ' <span class="tcp-override-tag">(early reveal)</span>' : ''}</div>
          </div>
          ${adminControls}
        </header>
        ${bodyHTML}
        ${photoHTML}
        ${c.link ? `<a href="${escape(safeHttpUrl(c.link))}" target="_blank" rel="noopener noreferrer" class="mykids-link-chip">🔗 Open link</a>` : ''}
      </article>`;
  },

  async resolvePhotoSrc(el) {
    const bucket = el.dataset.bucket;
    const path   = el.dataset.path;
    if (!bucket || !path) return;
    const key = `${bucket}|${path}`;
    const now = Date.now();
    const cached = this.signedUrlCache.get(key);
    if (cached && cached.expiresAt > now) {
      el.style.backgroundImage = `url('${cssUrl(cached.url)}')`;
      return;
    }
    const url = await Backend.getMediaUrl(bucket, path, 3600);
    if (!url) { el.classList.add('is-missing'); return; }
    this.signedUrlCache.set(key, { url, expiresAt: now + 50 * 60 * 1000 });
    el.style.backgroundImage = `url('${cssUrl(url)}')`;
  },

  // Admin override: stamp the capsule as force-revealed by this admin so
  // the recipient sees "(early reveal)" instead of being misled into
  // thinking the unlock date had passed.
  revealNow(id) {
    if (!Auth.isAdmin()) return;
    const c = this.list().find(x => x.id === id); if (!c) return;
    if (!confirm(`Reveal "${c.title || 'this capsule'}" early? The recipient will be able to read it now.`)) return;
    c.revealedBy = Backend.user?.id || 'admin';
    Store.save();
    toast('Capsule revealed.');
    this.render();
  },

  async deleteCapsule(id) {
    if (!Auth.isAdmin()) return;
    const c = this.list().find(x => x.id === id); if (!c) return;
    if (!confirm('Delete this capsule? The photo is also removed from storage.')) return;
    if (c.photo?.bucket && c.photo.path) await Backend.deleteMedia(c.photo.bucket, c.photo.path);
    Store.state.timeCapsules = this.list().filter(x => x.id !== id);
    Store.save();
    toast('Capsule deleted.');
    this.render();
  },
};

// -------------------- TIME CAPSULE MODAL (v4.47) --------------------
const TimeCapsuleModal = {
  editingId: null,
  tempPhoto: null,
  _clearPhoto: false,
  uploading: 0,

  init() {
    const el = $('#tcp-modal'); if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    on(el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#tcp-form'), 'submit', (e) => { e.preventDefault(); this.save(); });
    on($('#tcp-delete'), 'click', () => this.deleteCurrent());
    on($('#tcp-photo-input'), 'change', (e) => this.onPhotoPick(e));
    on($('#tcp-photo-clear'), 'click', () => this.clearPhoto());
    RichText.mount($('#tcp-body-editor'));
    // Emoji button → proxy + EmojiPicker (same pattern as Memories /
    // My Kids notes editors).
    $('#tcp-body-editor')?.addEventListener('rt-emoji', () => {
      const surface = $('#tcp-body-editor [data-rt-surface]');
      let proxy = $('#tcp-body-emoji-proxy');
      if (!proxy) {
        proxy = document.createElement('input');
        proxy.type = 'hidden';
        proxy.id = 'tcp-body-emoji-proxy';
        document.body.appendChild(proxy);
        proxy.addEventListener('change', () => {
          const ch = proxy.value; if (!ch) return;
          proxy.value = '';
          surface?.focus();
          try { document.execCommand('insertText', false, ch); }
          catch { surface?.appendChild(document.createTextNode(ch)); }
        });
      }
      EmojiPicker.open(proxy, $('#tcp-body-emoji'));
    });
  },

  // Same recipient picker shape we use for recipes + memories tags.
  populateRecipientPicker(currentRef) {
    const sel = $('#tcp-recipient'); if (!sel) return;
    const memberOpts = sortMembers(Store.membersList())
      .filter(m => !m.dateOfDeath)
      .map(m => `<option value="m:${m.id}">${escape(displayName(m))}</option>`);
    const friendOpts = [];
    sortFriends(Object.values(Store.state.friends || {})).forEach(f => {
      friendOpts.push(`<option value="f:${f.id}">${escape(displayName(f))}</option>`);
      if (f.spouse) friendOpts.push(`<option value="s:${f.id}">${escape(displayName(f.spouse))} (spouse of ${escape(displayName(f))})</option>`);
      (f.kids || []).forEach(k => {
        friendOpts.push(`<option value="k:${f.id}:${k.id}">${escape(displayName(k))} (child of ${escape(displayName(f))})</option>`);
      });
    });
    sel.innerHTML = `
      <option value="">— Pick recipient —</option>
      ${memberOpts.length ? `<optgroup label="Family">${memberOpts.join('')}</optgroup>` : ''}
      ${friendOpts.length ? `<optgroup label="Friends">${friendOpts.join('')}</optgroup>` : ''}
    `;
    sel.value = currentRef || '';
  },

  openAdd(presetRecipientRef = '') {
    if (!Auth.isAdmin()) return;
    this.editingId = null;
    this.tempPhoto = null;
    this._clearPhoto = false;
    this.reset();
    this.populateRecipientPicker(presetRecipientRef || '');
    $('#tcp-modal-title').textContent = 'New capsule';
    $('#tcp-submit').textContent = 'Seal capsule';
    $('#tcp-delete').hidden = true;
    RichText.write($('#tcp-body-editor'), '');
    // Default the unlock date to one year out — most capsule use cases
    // are "open in N years," not "open tomorrow."
    const d = new Date(); d.setFullYear(d.getFullYear() + 1);
    $('#tcp-form').unlockDate.value = d.toISOString().slice(0, 10);
    this.renderPhotoPreview(null);
    this.open();
    // When opened from a kid's Time Capsule tab, the recipient is already
    // set — focus the title field instead so the writer can dive in.
    setTimeout(() => {
      const focusTarget = presetRecipientRef ? $('#tcp-form [name="title"]') : $('#tcp-recipient');
      focusTarget?.focus();
    }, 50);
  },

  openEdit(id) {
    if (!Auth.isAdmin()) return;
    const c = (Store.state.timeCapsules || []).find(x => x.id === id); if (!c) return;
    this.editingId = id;
    this.tempPhoto = null;
    this._clearPhoto = false;
    this.reset();
    this.populateRecipientPicker(c.recipientRef || '');
    $('#tcp-modal-title').textContent = `Edit capsule`;
    $('#tcp-submit').textContent = 'Save changes';
    $('#tcp-delete').hidden = false;
    const fm = $('#tcp-form');
    fm.unlockDate.value = c.unlockDate || '';
    fm.title.value      = c.title || '';
    fm.link.value       = c.link || '';
    RichText.write($('#tcp-body-editor'), c.body || '');
    this.renderPhotoPreview(c.photo || null);
    this.open();
  },

  reset() {
    $('#tcp-form').reset();
    $('#tcp-error').hidden = true;
  },
  open() {
    const el = $('#tcp-modal');
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('is-open');
  },
  close() {
    const el = $('#tcp-modal');
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-open');
    this.editingId = null;
    this.tempPhoto = null;
    this._clearPhoto = false;
    this.uploading = 0; // abandon any in-flight count so a reopen isn't wedged
  },

  async renderPhotoPreview(existing) {
    const el = $('#tcp-photo-preview');
    if (!el) return;
    const ref = this._clearPhoto ? null : (this.tempPhoto || existing || null);
    if (!ref) { el.style.backgroundImage = ''; el.innerHTML = '<span style="opacity:.45; font-size:36px;">📷</span>'; return; }
    const url = await Backend.getMediaUrl(ref.bucket, ref.path, 3600);
    if (url) { el.style.backgroundImage = `url('${cssUrl(url)}')`; el.innerHTML = ''; }
  },

  async onPhotoPick(e) {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    this.uploading++;
    try {
      const blob = await downscaleImageToBlob(file, 2400, 0.85);
      const result = await Backend.uploadMedia(
        new File([blob], `tcp-${Date.now()}.jpg`, { type: 'image/jpeg' }),
        { bucket: 'family-photos', folder: 'timecapsules', maxBytes: 10 * 1024 * 1024 }
      );
      if (!result.ok) throw new Error(result.reason);
      if (this.tempPhoto?.bucket) await Backend.deleteMedia(this.tempPhoto.bucket, this.tempPhoto.path);
      this.tempPhoto = { bucket: result.bucket, path: result.path };
      this._clearPhoto = false;
      this.renderPhotoPreview(null);
    } catch (err) {
      toast(`Photo upload failed: ${err.message || err}`, 'warn');
    } finally {
      this.uploading = Math.max(0, this.uploading - 1);
    }
  },

  async clearPhoto() {
    if (this.tempPhoto?.bucket) await Backend.deleteMedia(this.tempPhoto.bucket, this.tempPhoto.path);
    this.tempPhoto = null;
    this._clearPhoto = true;
    this.renderPhotoPreview(null);
  },

  async save() {
    if (!Auth.isAdmin()) return;
    if (this.uploading > 0) {
      $('#tcp-error').textContent = 'Wait for the photo to finish uploading.';
      $('#tcp-error').hidden = false;
      return;
    }
    const fm = $('#tcp-form');
    const fd = new FormData(fm);
    const recipientRef = (fd.get('recipientRef') || '').toString().trim();
    const unlockDate   = (fd.get('unlockDate')   || '').toString().trim();
    if (!recipientRef) { this.error('Pick a recipient.'); return; }
    if (!unlockDate)   { this.error('Pick an unlock date.'); return; }
    const body = RichText.read($('#tcp-body-editor'));
    if (!body) { this.error('Write something for the recipient to read.'); return; }
    const existing = this.editingId
      ? (Store.state.timeCapsules || []).find(c => c.id === this.editingId)
      : null;

    let photo = existing?.photo || null;
    if (this._clearPhoto) {
      if (existing?.photo?.bucket) await Backend.deleteMedia(existing.photo.bucket, existing.photo.path);
      photo = null;
    } else if (this.tempPhoto) {
      if (existing?.photo?.bucket && existing.photo.path !== this.tempPhoto.path) {
        await Backend.deleteMedia(existing.photo.bucket, existing.photo.path);
      }
      photo = this.tempPhoto;
    }

    const record = {
      ...(existing || {}),
      id: this.editingId || uid('tcp'),
      recipientRef,
      unlockDate,
      title:    (fd.get('title') || '').toString().trim(),
      body,
      link:     (fd.get('link')  || '').toString().trim(),
      photo,
      authorId:   existing?.authorId   ?? (Backend.user?.id || null),
      authorName: existing?.authorName ?? this.currentAuthorName(),
      sealedAt:   existing?.sealedAt   ?? Date.now(),
      // Editing a previously-revealed capsule keeps it revealed.
      revealedBy: existing?.revealedBy || null,
    };
    if (!Array.isArray(Store.state.timeCapsules)) Store.state.timeCapsules = [];
    if (existing) {
      const idx = Store.state.timeCapsules.findIndex(c => c.id === this.editingId);
      Store.state.timeCapsules[idx] = record;
    } else {
      Store.state.timeCapsules.push(record);
    }
    Store.save();
    toast(this.editingId ? 'Capsule saved.' : 'Capsule sealed.');
    this.close();
    TimeCapsuleView.render();
    // v4.51: if the capsule modal was opened from a kid's Time Capsule
    // tab, that view needs to refresh too so the new card shows up
    // without a manual nav round-trip.
    if (MyKidsView.activeTab === 'capsule' && MyKidsView.selectedKidId) MyKidsView.render();
  },

  currentAuthorName() {
    const me = Auth.current;
    if (me && me !== 'admin-bootstrap' && typeof me === 'object') return displayName(me);
    return Backend.user?.email || 'Admin';
  },

  error(msg) {
    $('#tcp-error').textContent = msg;
    $('#tcp-error').hidden = false;
  },

  async deleteCurrent() {
    if (!this.editingId) return;
    const id = this.editingId;
    this.close();
    TimeCapsuleView.deleteCapsule(id);
  },
};

// -------------------- STORIES (v4.48 — Wave 4b) --------------------
// Voice + video stories. Admin uploads (audio/video), records audio in-
// browser via MediaRecorder, or pastes a YouTube/Vimeo embed URL. All
// authenticated users can play. Uploads land in family-audio /
// family-video Storage buckets (Wave 1); the JSONB archive only carries
// the { bucket, path } ref so the row stays small. Embed URLs are
// stored as-is plus a detected `embedKind`.

const StoriesView = {
  searchQuery: '',
  signedUrlCache: new Map(),

  init() {
    on($('#btn-story-add'),       'click', () => StoryModal.openAdd());
    on($('#btn-story-add-first'), 'click', () => StoryModal.openAdd());
    const search = $('#stories-search');
    if (search) {
      on(search, 'input', () => {
        this.searchQuery = (search.value || '').trim().toLowerCase();
        this.render();
      });
    }
    StoryModal.init();
    // Player modal close affordances.
    const player = $('#story-player-modal');
    if (player && !player.dataset.bound) {
      player.dataset.bound = '1';
      on(player, 'click', (e) => { if (e.target.closest('[data-close]')) this.closePlayer(); });
    }
  },

  list() {
    return Array.isArray(Store.state.stories) ? Store.state.stories : [];
  },

  filtered() {
    const q = this.searchQuery;
    let list = this.list();
    if (q) {
      list = list.filter(s => {
        const hay = [
          s.title, s.description,
          (s.tags || []).map(t => resolvePersonRefLabel(t)).join(' '),
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    return list.slice().sort((a, z) => (z.createdAt || 0) - (a.createdAt || 0));
  },

  render() {
    const grid  = $('#stories-grid');
    const empty = $('#stories-empty');
    if (!grid || !empty) return;
    const list = this.filtered();
    const title = $('#stories-list-title');
    if (title) {
      title.textContent = this.searchQuery
        ? `Matches for "${this.searchQuery}" (${list.length})`
        : `All stories (${list.length})`;
    }
    if (!this.list().length) { grid.innerHTML = ''; empty.hidden = false; return; }
    empty.hidden = true;
    grid.innerHTML = list.map(s => this.cardHTML(s)).join('') ||
      `<p class="muted" style="padding:24px; text-align:center;">No stories matching "${escape(this.searchQuery)}".</p>`;
    grid.querySelectorAll('[data-story-card]').forEach(card => {
      on(card, 'click', () => this.openPlayer(card.dataset.storyCard));
    });
  },

  cardHTML(s) {
    const kindLabel = s.kind === 'video' ? '🎬 Video' : '🎤 Audio';
    const sourceLabel = s.source === 'embed' ? '🔗 Embed' : 'Uploaded';
    const tags = (s.tags || []).slice(0, 3)
      .map(t => resolvePersonRefLabel(t))
      .filter(Boolean);
    const tagsHTML = tags.length
      ? `<div class="story-card-tags">${tags.map(label => `<span class="memory-tag">${escape(label)}</span>`).join('')}${(s.tags || []).length > 3 ? ` <span class="muted small">+${(s.tags || []).length - 3}</span>` : ''}</div>`
      : '';
    const duration = s.durationSec ? this.formatDuration(s.durationSec) : '';
    return `
      <button type="button" class="story-card" data-story-card="${escape(s.id)}">
        <div class="story-card-thumb is-${escape(s.kind || 'audio')}">
          <span class="story-card-kind-emoji" aria-hidden="true">${s.kind === 'video' ? '🎬' : '🎤'}</span>
          ${duration ? `<span class="story-card-duration">${duration}</span>` : ''}
        </div>
        <div class="story-card-body">
          <div class="story-card-title">${escape(s.title || 'Untitled')}</div>
          <div class="story-card-meta muted small">${kindLabel} · ${sourceLabel}${s.recordedDate ? ` · ${escape(formatDate(s.recordedDate))}` : ''}</div>
          ${tagsHTML}
        </div>
      </button>`;
  },

  formatDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  },

  // Open the dedicated player modal. Renders the right element based on
  // story type: <audio> for uploaded audio, <video> for uploaded video,
  // iframe for YouTube/Vimeo, plain link chip for generic URLs (we don't
  // iframe arbitrary URLs — XSS surface).
  async openPlayer(id) {
    const s = this.list().find(x => x.id === id); if (!s) return;
    const modal = $('#story-player-modal');
    const body  = $('#story-player-body');
    $('#story-player-title').textContent = s.title || 'Story';

    const descHTML = s.description ? `<p class="story-player-desc">${escape(s.description).replace(/\n/g, '<br>')}</p>` : '';
    const tagsHTML = (s.tags || []).length
      ? `<div class="memory-tags">${(s.tags || []).map(t => `<span class="memory-tag">${escape(resolvePersonRefLabel(t))}</span>`).join('')}</div>`
      : '';
    const adminControls = Auth.isAdmin() ? `
      <div class="story-player-actions">
        <button class="btn btn-ghost btn-sm"        type="button" data-story-edit="${escape(s.id)}">Edit</button>
        <button class="btn btn-danger-ghost btn-sm" type="button" data-story-delete="${escape(s.id)}">Delete</button>
      </div>` : '';

    // Build the player element.
    let playerHTML = '';
    if (s.source === 'upload' && s.media?.bucket && s.media?.path) {
      const url = await Backend.getMediaUrl(s.media.bucket, s.media.path, 3600);
      if (!url) playerHTML = '<p class="muted">Media unavailable. Try again in a moment.</p>';
      else if (s.kind === 'video') {
        playerHTML = `<video controls preload="metadata" class="story-player-video" src="${escape(url)}"></video>`;
      } else {
        playerHTML = `<audio controls preload="metadata" class="story-player-audio" src="${escape(url)}"></audio>`;
      }
    } else if (s.source === 'embed') {
      const embed = parseEmbedUrl(s.embedUrl || '');
      if (embed.kind === 'youtube') {
        playerHTML = `<iframe class="story-player-iframe" src="https://www.youtube.com/embed/${escape(embed.id)}" title="${escape(s.title || 'Video')}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
      } else if (embed.kind === 'vimeo') {
        playerHTML = `<iframe class="story-player-iframe" src="https://player.vimeo.com/video/${escape(embed.id)}" title="${escape(s.title || 'Video')}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`;
      } else {
        // Generic URL — we don't iframe arbitrary domains (clickjacking /
        // XSS risk). Render as a Watch link chip instead.
        playerHTML = `<a href="${escape(safeHttpUrl(s.embedUrl))}" target="_blank" rel="noopener noreferrer" class="btn btn-primary">▶ Watch on external site</a>`;
      }
    }

    body.innerHTML = `
      ${playerHTML}
      ${descHTML}
      ${tagsHTML}
      ${adminControls}
    `;
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('is-open');

    body.querySelectorAll('[data-story-edit]').forEach(btn => {
      on(btn, 'click', () => { this.closePlayer(); StoryModal.openEdit(btn.dataset.storyEdit); });
    });
    body.querySelectorAll('[data-story-delete]').forEach(btn => {
      on(btn, 'click', () => this.deleteStory(btn.dataset.storyDelete));
    });
  },

  closePlayer() {
    const modal = $('#story-player-modal');
    if (!modal) return;
    modal.setAttribute('aria-hidden', 'true');
    modal.classList.remove('is-open');
    // Stop any playing media when closing.
    const body = $('#story-player-body');
    body?.querySelectorAll('audio, video').forEach(el => { try { el.pause(); } catch {} });
    if (body) body.innerHTML = '';
  },

  async deleteStory(id) {
    if (!Auth.isAdmin()) return;
    const s = this.list().find(x => x.id === id); if (!s) return;
    if (!confirm(`Delete "${s.title}"? The media file is also removed from storage.`)) return;
    if (s.media?.bucket && s.media.path) {
      await Backend.deleteMedia(s.media.bucket, s.media.path);
    }
    Store.state.stories = this.list().filter(x => x.id !== id);
    Store.save();
    toast('Story deleted.');
    this.closePlayer();
    this.render();
  },
};

// Detect what kind of embed URL we're looking at. Returns
// { kind: 'youtube'|'vimeo'|'generic', id }. YouTube IDs come from
// youtu.be/<id>, youtube.com/watch?v=<id>, or youtube.com/embed/<id>.
// Vimeo: vimeo.com/<digits>. Anything else is generic — we won't iframe
// those.
function parseEmbedUrl(raw) {
  const url = (raw || '').trim();
  if (!url) return { kind: 'generic', id: '' };
  // YouTube short URL: https://youtu.be/<id>
  let m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
  if (m) return { kind: 'youtube', id: m[1] };
  // YouTube watch: https://www.youtube.com/watch?v=<id>
  m = url.match(/youtube\.com\/watch\?[^#]*?v=([a-zA-Z0-9_-]{6,})/);
  if (m) return { kind: 'youtube', id: m[1] };
  // YouTube embed: https://www.youtube.com/embed/<id>
  m = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{6,})/);
  if (m) return { kind: 'youtube', id: m[1] };
  // YouTube Shorts: https://www.youtube.com/shorts/<id>
  m = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{6,})/);
  if (m) return { kind: 'youtube', id: m[1] };
  // Vimeo: https://vimeo.com/<id>
  m = url.match(/vimeo\.com\/(\d+)/);
  if (m) return { kind: 'vimeo', id: m[1] };
  return { kind: 'generic', id: '' };
}

// -------------------- STORY MODAL (v4.48) --------------------
const StoryModal = {
  editingId: null,
  sourceMode: 'record-audio',     // one of: 'record-audio' | 'upload-audio' | 'upload-video' | 'embed-url'

  // Recorder state: chunks accumulate while recording, blob is the final
  // audio when stop is called.
  recorder: null,
  recorderStream: null,
  recorderChunks: [],
  recorderTimer: null,
  recorderStart: 0,
  recordedBlob: null,
  recordedDuration: 0,

  // Pending upload from picker (audio or video). Set when the user picks
  // a file; consumed on save.
  pendingFile: null,
  pendingFileKind: '',   // 'audio' | 'video'
  pendingFileDuration: 0,

  // Saved media ref (after upload succeeds). The previous one gets
  // deleted from Storage if a new upload replaces it during the same
  // editor session.
  uploadedMedia: null,   // { bucket, path, mimeType }
  workingTags: [],
  uploading: 0,

  // 5-minute max per audio clip + 100MB hard limit on video (matches the
  // Storage bucket file_size_limit from Wave 1).
  MAX_AUDIO_SEC: 5 * 60,
  MAX_VIDEO_BYTES: 100 * 1024 * 1024,
  MAX_AUDIO_BYTES: 20 * 1024 * 1024,

  init() {
    const el = $('#story-modal'); if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    on(el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#story-form'), 'submit', (e) => { e.preventDefault(); this.save(); });
    on($('#story-delete'), 'click', () => this.deleteCurrent());

    // Source pill switching
    $$('.story-pill').forEach(pill => {
      on(pill, 'click', () => this.switchSource(pill.dataset.source));
    });

    // Recorder
    on($('#story-rec-toggle'), 'click', () => this.toggleRecording());

    // File pickers
    on($('#story-audio-input'), 'change', (e) => this.onFilePick(e, 'audio'));
    on($('#story-video-input'), 'change', (e) => this.onFilePick(e, 'video'));

    // Embed URL live detection
    on($('#story-embed-url'), 'input', () => this.updateEmbedStatus());

    // Tag picker
    on($('#story-tag-picker'), 'change', (e) => this.onTagPick(e));
  },

  switchSource(mode) {
    if (mode === this.sourceMode) return;
    // If we're switching away from a mode with pending media, that media
    // becomes obsolete. We don't auto-delete it because the user might
    // switch back — but it's worth clearing the preview so the new mode
    // starts fresh.
    this.sourceMode = mode;
    $$('.story-pill').forEach(p => p.classList.toggle('is-active', p.dataset.source === mode));
    document.querySelectorAll('.story-source-panel').forEach(p => {
      p.hidden = p.dataset.panel !== mode;
    });
    // Reset feedback line on each switch.
    $('#story-upload-status').textContent = '';
  },

  // ---------- Recorder ----------
  async toggleRecording() {
    if (this.recorder && this.recorder.state === 'recording') {
      this.stopRecording();
    } else {
      await this.startRecording();
    }
  },

  async startRecording() {
    try {
      this.recorderStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast('Microphone permission denied or unavailable.', 'warn');
      return;
    }
    this.recorderChunks = [];
    this.recordedBlob = null;
    this.recordedDuration = 0;
    // The browser picks an appropriate audio mimeType. webm/opus is most
    // common on Chromium; Safari may produce mp4/aac.
    this.recorder = new MediaRecorder(this.recorderStream);
    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recorderChunks.push(e.data);
    };
    this.recorder.onstop = () => {
      const mimeType = this.recorder.mimeType || 'audio/webm';
      this.recordedBlob = new Blob(this.recorderChunks, { type: mimeType });
      this.recordedDuration = Math.round((Date.now() - this.recorderStart) / 1000);
      // Release the mic.
      this.recorderStream?.getTracks().forEach(t => t.stop());
      this.recorderStream = null;
      // Preview the recording.
      const preview = $('#story-rec-preview');
      if (preview) {
        preview.src = URL.createObjectURL(this.recordedBlob);
        preview.hidden = false;
      }
      $('#story-rec-toggle').textContent = 'Start recording';
      $('#story-rec-status').textContent = `Recorded ${StoriesView.formatDuration(this.recordedDuration)}. Save to upload.`;
      clearInterval(this.recorderTimer);
      this.recorderTimer = null;
    };
    this.recorderStart = Date.now();
    this.recorder.start();
    $('#story-rec-toggle').textContent = 'Stop recording';
    $('#story-rec-status').textContent = 'Recording… 0:00';
    // Tick status + auto-stop at the 5-minute cap.
    this.recorderTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - this.recorderStart) / 1000);
      $('#story-rec-status').textContent = `Recording… ${StoriesView.formatDuration(elapsed)}`;
      if (elapsed >= this.MAX_AUDIO_SEC) this.stopRecording();
    }, 500);
  },

  stopRecording() {
    try { this.recorder?.stop(); } catch {}
  },

  // ---------- File pickers ----------
  onFilePick(e, kind) {
    const file = e.target.files?.[0]; if (!file) {
      this.pendingFile = null; this.pendingFileKind = ''; return;
    }
    if (kind === 'video' && file.size > this.MAX_VIDEO_BYTES) {
      toast(`Video too large: ${(file.size / 1024 / 1024).toFixed(1)} MB. Max is ${this.MAX_VIDEO_BYTES / 1024 / 1024} MB.`, 'warn');
      e.target.value = '';
      return;
    }
    if (kind === 'audio' && file.size > this.MAX_AUDIO_BYTES) {
      toast(`Audio too large: ${(file.size / 1024 / 1024).toFixed(1)} MB. Max is ${this.MAX_AUDIO_BYTES / 1024 / 1024} MB.`, 'warn');
      e.target.value = '';
      return;
    }
    this.pendingFile = file;
    this.pendingFileKind = kind;
    // Read duration from the preview element. Useful for the card UI's
    // duration badge.
    const previewId = kind === 'audio' ? '#story-audio-preview' : '#story-video-preview';
    const preview = $(previewId);
    if (preview) {
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
      preview.onloadedmetadata = () => {
        this.pendingFileDuration = Math.round(preview.duration || 0);
      };
    }
  },

  // ---------- Embed ----------
  updateEmbedStatus() {
    const url = ($('#story-embed-url').value || '').trim();
    const status = $('#story-embed-status');
    if (!url) { status.textContent = ''; return; }
    const parsed = parseEmbedUrl(url);
    if (parsed.kind === 'youtube') status.textContent = `Detected: YouTube (id ${parsed.id})`;
    else if (parsed.kind === 'vimeo')   status.textContent = `Detected: Vimeo (id ${parsed.id})`;
    else status.textContent = 'Generic link — will open in a new tab when clicked (not embedded inline for security).';
  },

  // ---------- Tags ----------
  populateTagPicker() {
    const sel = $('#story-tag-picker'); if (!sel) return;
    const taken = new Set(this.workingTags);
    const memberOpts = sortMembers(Store.membersList())
      .filter(m => !m.dateOfDeath && !taken.has('m:' + m.id))
      .map(m => `<option value="m:${m.id}">${escape(displayName(m))}</option>`);
    const friendOpts = [];
    sortFriends(Object.values(Store.state.friends || {})).forEach(f => {
      if (!taken.has('f:' + f.id)) friendOpts.push(`<option value="f:${f.id}">${escape(displayName(f))}</option>`);
      if (f.spouse && !taken.has('s:' + f.id)) friendOpts.push(`<option value="s:${f.id}">${escape(displayName(f.spouse))} (spouse of ${escape(displayName(f))})</option>`);
      (f.kids || []).forEach(k => {
        if (!taken.has(`k:${f.id}:${k.id}`)) friendOpts.push(`<option value="k:${f.id}:${k.id}">${escape(displayName(k))} (child of ${escape(displayName(f))})</option>`);
      });
    });
    sel.innerHTML = `
      <option value="">+ Add person to tag…</option>
      ${memberOpts.length ? `<optgroup label="Family">${memberOpts.join('')}</optgroup>` : ''}
      ${friendOpts.length ? `<optgroup label="Friends">${friendOpts.join('')}</optgroup>` : ''}
    `;
    sel.value = '';
  },

  renderTagChips() {
    const host = $('#story-tag-chips'); if (!host) return;
    host.innerHTML = this.workingTags.map(ref => {
      const label = resolvePersonRefLabel(ref) || '(unknown)';
      return `<span class="memory-tag-chip"><span>${escape(label)}</span><button type="button" class="memory-tag-x" data-remove-tag="${escape(ref)}" aria-label="Remove tag">×</button></span>`;
    }).join('') || '<span class="muted small">Nobody tagged yet.</span>';
    host.querySelectorAll('[data-remove-tag]').forEach(btn => {
      on(btn, 'click', () => {
        this.workingTags = this.workingTags.filter(t => t !== btn.dataset.removeTag);
        this.renderTagChips();
        this.populateTagPicker();
      });
    });
  },

  onTagPick(e) {
    const v = e.target.value; if (!v) return;
    if (!this.workingTags.includes(v)) this.workingTags.push(v);
    this.renderTagChips();
    this.populateTagPicker();
  },

  // ---------- Open / Close ----------
  openAdd() {
    if (!Auth.isAdmin()) return;
    this.editingId = null;
    this.reset();
    this.workingTags = [];
    this.populateTagPicker();
    this.renderTagChips();
    $('#story-modal-title').textContent = 'New story';
    $('#story-submit').textContent = 'Save story';
    $('#story-delete').hidden = true;
    this.switchSource('record-audio');
    this.open();
    setTimeout(() => $('#story-form').title.focus(), 50);
  },

  openEdit(id) {
    if (!Auth.isAdmin()) return;
    const s = (Store.state.stories || []).find(x => x.id === id); if (!s) return;
    this.editingId = id;
    this.reset();
    this.workingTags = (s.tags || []).slice();
    this.uploadedMedia = s.media || null;
    $('#story-modal-title').textContent = `Edit story`;
    $('#story-submit').textContent = 'Save changes';
    $('#story-delete').hidden = false;
    const fm = $('#story-form');
    fm.title.value        = s.title || '';
    fm.description.value  = s.description || '';
    fm.recordedDate.value = s.recordedDate || '';
    this.populateTagPicker();
    this.renderTagChips();
    // Match source mode to what's already on the record. For edits with
    // an existing upload, default to the matching upload panel so the
    // admin can replace it; embed-URL edits land on the embed panel.
    if (s.source === 'embed') {
      this.switchSource('embed-url');
      $('#story-embed-url').value = s.embedUrl || '';
      this.updateEmbedStatus();
    } else {
      this.switchSource(s.kind === 'video' ? 'upload-video' : 'upload-audio');
      $('#story-upload-status').textContent = 'Existing file kept unless you pick or record a new one.';
    }
    this.open();
  },

  reset() {
    $('#story-form').reset();
    $('#story-error').hidden = true;
    $('#story-upload-status').textContent = '';
    $('#story-embed-status').textContent = '';
    this.pendingFile = null;
    this.pendingFileKind = '';
    this.pendingFileDuration = 0;
    this.recordedBlob = null;
    this.recordedDuration = 0;
    this.uploadedMedia = null;
    // Reset preview elements.
    ['#story-rec-preview', '#story-audio-preview', '#story-video-preview'].forEach(sel => {
      const el = $(sel);
      if (el) { try { el.pause(); } catch {} el.removeAttribute('src'); el.load?.(); el.hidden = true; }
    });
    $('#story-rec-toggle').textContent = 'Start recording';
    $('#story-rec-status').textContent = 'Click to start. 5-minute max.';
  },

  open() {
    const el = $('#story-modal');
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('is-open');
  },
  close() {
    // Best-effort release of recorder/stream if user closed mid-record.
    try { if (this.recorder?.state === 'recording') this.recorder.stop(); } catch {}
    this.recorderStream?.getTracks().forEach(t => t.stop());
    this.recorderStream = null;
    clearInterval(this.recorderTimer);
    this.recorderTimer = null;
    const el = $('#story-modal');
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-open');
    this.editingId = null;
    this.workingTags = [];
    this.uploading = 0; // abandon any in-flight count so a reopen isn't wedged
  },

  // ---------- Save ----------
  async save() {
    if (!Auth.isAdmin()) return;
    const fm = $('#story-form');
    const fd = new FormData(fm);
    const title = (fd.get('title') || '').toString().trim();
    if (!title) { this.error('Title is required.'); return; }

    const description  = (fd.get('description')  || '').toString().trim();
    const recordedDate = (fd.get('recordedDate') || '').toString().trim();
    const existing = this.editingId
      ? (Store.state.stories || []).find(s => s.id === this.editingId)
      : null;

    // Source-specific media resolution.
    let kind     = '';
    let source   = '';
    let media    = existing?.media || null;
    let embedUrl = '';
    let embedKind = '';
    let embedId  = '';
    let durationSec = existing?.durationSec || 0;

    try {
      if (this.sourceMode === 'record-audio') {
        if (this.recordedBlob) {
          this.uploading++;
          $('#story-upload-status').textContent = 'Uploading recording…';
          const file = new File([this.recordedBlob], `recording-${Date.now()}.webm`, { type: this.recordedBlob.type });
          const result = await Backend.uploadMedia(file, {
            bucket: 'family-audio', folder: 'stories', maxBytes: this.MAX_AUDIO_BYTES,
          });
          // Throw BEFORE decrementing so a failed upload doesn't decrement here
          // and again in the catch (the old double-decrement). The catch owns
          // the failure decrement; this line owns the success decrement.
          if (!result.ok) throw new Error(result.reason);
          this.uploading = Math.max(0, this.uploading - 1);
          // Replace existing upload — clean up the previous one in Storage.
          if (existing?.media?.bucket) await Backend.deleteMedia(existing.media.bucket, existing.media.path);
          media = { bucket: result.bucket, path: result.path, mimeType: result.contentType || 'audio/webm' };
          durationSec = this.recordedDuration;
        } else if (!existing?.media) {
          this.error('Record audio first, or pick a different source.');
          return;
        }
        kind = 'audio'; source = 'upload';
      } else if (this.sourceMode === 'upload-audio' || this.sourceMode === 'upload-video') {
        const isVideo = this.sourceMode === 'upload-video';
        const bucket  = isVideo ? 'family-video' : 'family-audio';
        if (this.pendingFile) {
          this.uploading++;
          $('#story-upload-status').textContent = `Uploading ${isVideo ? 'video' : 'audio'}…`;
          const result = await Backend.uploadMedia(this.pendingFile, {
            bucket, folder: 'stories',
            maxBytes: isVideo ? this.MAX_VIDEO_BYTES : this.MAX_AUDIO_BYTES,
          });
          if (!result.ok) throw new Error(result.reason);
          this.uploading = Math.max(0, this.uploading - 1);
          if (existing?.media?.bucket) await Backend.deleteMedia(existing.media.bucket, existing.media.path);
          media = { bucket: result.bucket, path: result.path, mimeType: result.contentType || (isVideo ? 'video/mp4' : 'audio/mp3') };
          if (this.pendingFileDuration) durationSec = this.pendingFileDuration;
        } else if (!existing?.media) {
          this.error(`Pick ${isVideo ? 'a video' : 'an audio'} file first, or pick a different source.`);
          return;
        }
        kind = isVideo ? 'video' : 'audio';
        source = 'upload';
      } else if (this.sourceMode === 'embed-url') {
        const url = ($('#story-embed-url').value || '').trim();
        if (!url) { this.error('Paste a video URL, or pick a different source.'); return; }
        const parsed = parseEmbedUrl(url);
        // Clean up any previous upload if we're flipping from upload → embed.
        if (existing?.media?.bucket) await Backend.deleteMedia(existing.media.bucket, existing.media.path);
        media = null;
        embedUrl  = url;
        embedKind = parsed.kind;
        embedId   = parsed.id;
        kind = 'video';     // embed paths are video-shaped (YouTube/Vimeo)
        source = 'embed';
        durationSec = 0;    // unknown for external embeds
      }
    } catch (err) {
      this.uploading = Math.max(0, this.uploading - 1);
      $('#story-upload-status').textContent = '';
      this.error(`Upload failed: ${err.message || err}`);
      return;
    }

    $('#story-upload-status').textContent = '';

    const record = {
      ...(existing || {}),
      id: this.editingId || uid('sto'),
      title,
      description,
      kind,
      source,
      media,
      embedUrl,
      embedKind,
      embedId,
      durationSec,
      tags: this.workingTags.slice(),
      recordedDate,
      createdAt: existing?.createdAt || Date.now(),
      createdBy: existing?.createdBy || Backend.user?.id || null,
    };

    if (!Array.isArray(Store.state.stories)) Store.state.stories = [];
    if (existing) {
      const idx = Store.state.stories.findIndex(s => s.id === this.editingId);
      Store.state.stories[idx] = record;
    } else {
      Store.state.stories.push(record);
    }
    Store.save();
    toast(this.editingId ? 'Story saved.' : 'Story added.');
    this.close();
    StoriesView.render();
  },

  error(msg) {
    $('#story-error').textContent = msg;
    $('#story-error').hidden = false;
  },

  async deleteCurrent() {
    if (!this.editingId) return;
    const id = this.editingId;
    this.close();
    StoriesView.deleteStory(id);
  },
};

// -------------------- DOCUMENTS DRAWER (v4.49 — Wave 5) --------------------
// Admin-only end-to-end. Each document is one row in state.documents,
// tagged to a member (memberId) or null for household-level docs (deed,
// marriage cert). File binaries live in the family-documents Storage
// bucket from Wave 1 (RLS admin-only on insert / select / delete).
const DocumentsView = {
  memberFilter: '',     // '' = all; 'household' = household-level only; otherwise a member id
  categoryFilter: '',   // '' = all; otherwise exact match
  searchQuery: '',

  init() {
    DocumentModal.init();
  },

  list() {
    return Array.isArray(Store.state.documents) ? Store.state.documents : [];
  },

  // Unique categories already used across saved documents (for the filter
  // dropdown + the autocomplete datalist on the modal). Sorted alpha,
  // dedupe case-insensitively.
  categories() {
    const seen = new Map();
    for (const d of this.list()) {
      const c = (d.category || '').trim();
      if (!c) continue;
      const key = c.toLowerCase();
      if (!seen.has(key)) seen.set(key, c);
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  },

  filtered() {
    let list = this.list();
    if (this.memberFilter === 'household') {
      list = list.filter(d => !d.memberId);
    } else if (this.memberFilter) {
      list = list.filter(d => d.memberId === this.memberFilter);
    }
    if (this.categoryFilter) {
      const key = this.categoryFilter.toLowerCase();
      list = list.filter(d => (d.category || '').toLowerCase() === key);
    }
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      list = list.filter(d => {
        const hay = [d.title, d.category, d.notes,
                     d.memberId ? displayName(Store.byId(d.memberId)) : 'household'].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    return list.slice().sort((a, z) => (z.createdAt || 0) - (a.createdAt || 0));
  },

  render() {
    const host = $('#vault-documents');
    if (!host) return;
    if (!Auth.canAccessVault()) {
      host.innerHTML = '<p class="muted" style="padding:24px; text-align:center;">Admin-only.</p>';
      return;
    }
    const all = this.list();
    const filtered = this.filtered();
    const members = Store.membersList();
    const cats = this.categories();
    host.innerHTML = `
      <div class="documents-toolbar">
        <button class="btn btn-primary btn-sm" id="btn-document-add">+ Add document</button>
        <select class="input" id="documents-member-filter">
          <option value="" ${this.memberFilter === '' ? 'selected' : ''}>All members + household</option>
          <option value="household" ${this.memberFilter === 'household' ? 'selected' : ''}>Household / shared only</option>
          ${sortMembers(members).map(m => `<option value="${escape(m.id)}" ${this.memberFilter === m.id ? 'selected' : ''}>${escape(displayName(m))}</option>`).join('')}
        </select>
        <select class="input" id="documents-category-filter">
          <option value="" ${this.categoryFilter === '' ? 'selected' : ''}>All categories</option>
          ${cats.map(c => `<option value="${escape(c)}" ${this.categoryFilter.toLowerCase() === c.toLowerCase() ? 'selected' : ''}>${escape(c)}</option>`).join('')}
        </select>
        <input class="input" id="documents-search" type="search" placeholder="Search documents…" value="${escape(this.searchQuery)}" />
      </div>
      ${all.length === 0
        ? `<div class="tree-empty" style="margin: 18px;">
            <div class="tree-empty-card">
              <h3>No documents yet</h3>
              <p>Drop in birth certificates, passport scans, school records, anything you'd want to find later. Each document can be tagged to a member or kept as household-level.</p>
              <button class="btn btn-primary" id="btn-document-add-first">+ Add your first document</button>
            </div>
          </div>`
        : (filtered.length
            ? `<div class="documents-list">${filtered.map(d => this.rowHTML(d)).join('')}</div>`
            : '<p class="muted" style="padding:24px; text-align:center;">No documents match the current filters.</p>')
      }
    `;
    on($('#btn-document-add'),         'click', () => DocumentModal.openAdd());
    on($('#btn-document-add-first'),   'click', () => DocumentModal.openAdd());
    on($('#documents-member-filter'),  'change', (e) => { this.memberFilter   = e.target.value; this.render(); });
    on($('#documents-category-filter'),'change', (e) => { this.categoryFilter = e.target.value; this.render(); });
    on($('#documents-search'),         'input',  (e) => { this.searchQuery    = e.target.value.trim(); this.render(); });

    host.querySelectorAll('[data-doc-open]').forEach(btn => {
      on(btn, 'click', () => this.openDocument(btn.dataset.docOpen));
    });
    host.querySelectorAll('[data-doc-edit]').forEach(btn => {
      on(btn, 'click', () => DocumentModal.openEdit(btn.dataset.docEdit));
    });
    host.querySelectorAll('[data-doc-delete]').forEach(btn => {
      on(btn, 'click', () => this.deleteDocument(btn.dataset.docDelete));
    });
  },

  rowHTML(d) {
    const m = d.memberId ? Store.byId(d.memberId) : null;
    const who = m ? displayName(m) : 'Household / shared';
    const sizeBytes = d.file?.sizeBytes || 0;
    const sizeStr = sizeBytes ? this.humanBytes(sizeBytes) : '';
    const ext = (d.file?.originalName || '').split('.').pop()?.toUpperCase() || '';
    const icon = this.iconForMime(d.file?.mimeType, ext);
    return `
      <article class="document-row" data-id="${escape(d.id)}">
        <div class="document-icon">${icon}</div>
        <div class="document-main">
          <div class="document-title">${escape(d.title || 'Untitled')}</div>
          <div class="document-meta muted small">
            ${d.category ? `<span class="document-cat">${escape(d.category)}</span>` : ''}
            <span>${escape(who)}</span>
            ${ext ? `<span>${escape(ext)}${sizeStr ? ` · ${escape(sizeStr)}` : ''}</span>` : ''}
            <span>Added ${escape(formatDate(isoDay(d.createdAt)))}</span>
          </div>
          ${d.notes ? `<div class="document-notes muted small" style="margin-top:6px;">${escape(d.notes)}</div>` : ''}
        </div>
        <div class="document-actions">
          <button class="btn btn-primary btn-sm" type="button" data-doc-open="${escape(d.id)}">Open</button>
          <button class="btn btn-ghost btn-sm"   type="button" data-doc-edit="${escape(d.id)}">Edit</button>
          <button class="btn btn-danger-ghost btn-sm" type="button" data-doc-delete="${escape(d.id)}">Delete</button>
        </div>
      </article>`;
  },

  iconForMime(mime, ext) {
    if (!mime && !ext) return '📄';
    const m = (mime || '').toLowerCase();
    const e = (ext  || '').toLowerCase();
    if (m.startsWith('image/'))                            return '🖼️';
    if (m === 'application/pdf' || e === 'pdf')            return '📕';
    if (e === 'doc' || e === 'docx')                       return '📝';
    if (e === 'xls' || e === 'xlsx' || m.includes('sheet')) return '📊';
    if (m.startsWith('text/') || e === 'txt')              return '📄';
    return '📄';
  },

  humanBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  },

  // Open a document. Images render in the shared lightbox so the admin
  // can preview without leaving the page; PDFs and everything else open
  // in a new tab via the signed URL (browsers handle them better that
  // way than trying to embed inline).
  async openDocument(id) {
    const d = this.list().find(x => x.id === id); if (!d || !d.file) return;
    const url = await Backend.getMediaUrl(d.file.bucket, d.file.path, 3600);
    if (!url) { toast('File unavailable. Try again in a moment.', 'warn'); return; }
    const mime = (d.file.mimeType || '').toLowerCase();
    if (mime.startsWith('image/')) {
      this.openImageLightbox(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  },

  openImageLightbox(src) {
    const el = $('#vault-lightbox');
    if (!el) return;
    el.querySelector('img').src = src;
    el.hidden = false;
    document.body.style.overflow = 'hidden';
  },

  async deleteDocument(id) {
    if (!Auth.isAdmin()) return;
    const d = this.list().find(x => x.id === id); if (!d) return;
    if (!confirm(`Delete "${d.title}"? The file is also removed from storage.`)) return;
    if (d.file?.bucket && d.file.path) await Backend.deleteMedia(d.file.bucket, d.file.path);
    Store.state.documents = this.list().filter(x => x.id !== id);
    Store.save();
    toast('Document deleted.');
    this.render();
  },
};

// -------------------- DOCUMENT MODAL (v4.49) --------------------
const DocumentModal = {
  editingId: null,
  pendingFile: null,            // File from picker, pre-upload
  uploadedRef: null,            // { bucket, path, mimeType, sizeBytes, originalName }
  uploading: 0,
  MAX_BYTES: 25 * 1024 * 1024,  // matches Wave 1 family-documents bucket cap

  init() {
    const el = $('#document-modal'); if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    on(el, 'click', (e) => { if (e.target.closest('[data-close]')) this.close(); });
    on($('#document-form'), 'submit', (e) => { e.preventDefault(); this.save(); });
    on($('#document-delete'), 'click', () => this.deleteCurrent());
    on($('#document-file-input'), 'change', (e) => this.onFilePick(e));
  },

  populateMemberSelect(currentId) {
    const sel = $('#document-member'); if (!sel) return;
    sel.innerHTML = `
      <option value="">— Household / shared —</option>
      ${sortMembers(Store.membersList()).map(m =>
        `<option value="${escape(m.id)}" ${m.id === currentId ? 'selected' : ''}>${escape(displayName(m))}</option>`
      ).join('')}
    `;
  },

  populateCategoryDatalist() {
    const datalist = $('#document-categories'); if (!datalist) return;
    datalist.innerHTML = DocumentsView.categories().map(c => `<option value="${escape(c)}"></option>`).join('');
  },

  openAdd() {
    if (!Auth.isAdmin()) return;
    this.editingId = null;
    this.pendingFile = null;
    this.uploadedRef = null;
    this.reset();
    this.populateMemberSelect('');
    this.populateCategoryDatalist();
    $('#document-modal-title').textContent = 'Add document';
    $('#document-submit').textContent = 'Save document';
    $('#document-delete').hidden = true;
    this.open();
    setTimeout(() => $('#document-form').title.focus(), 50);
  },

  openEdit(id) {
    if (!Auth.isAdmin()) return;
    const d = (Store.state.documents || []).find(x => x.id === id); if (!d) return;
    this.editingId = id;
    this.pendingFile = null;
    this.uploadedRef = d.file ? { ...d.file } : null;
    this.reset();
    this.populateMemberSelect(d.memberId || '');
    this.populateCategoryDatalist();
    $('#document-modal-title').textContent = 'Edit document';
    $('#document-submit').textContent = 'Save changes';
    $('#document-delete').hidden = false;
    const fm = $('#document-form');
    fm.title.value    = d.title || '';
    fm.category.value = d.category || '';
    fm.notes.value    = d.notes || '';
    $('#document-file-status').textContent = d.file?.originalName
      ? `Current file: ${d.file.originalName}. Pick a new one to replace it.`
      : 'No file attached.';
    this.open();
  },

  reset() {
    $('#document-form').reset();
    $('#document-error').hidden = true;
    $('#document-file-status').textContent = '';
  },
  open() {
    const el = $('#document-modal');
    el.setAttribute('aria-hidden', 'false');
    el.classList.add('is-open');
  },
  close() {
    const el = $('#document-modal');
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('is-open');
    this.editingId = null;
    this.pendingFile = null;
    this.uploadedRef = null;
    this.uploading = 0; // abandon any in-flight count so a reopen isn't wedged
  },

  onFilePick(e) {
    const file = e.target.files?.[0]; if (!file) { this.pendingFile = null; return; }
    if (file.size > this.MAX_BYTES) {
      toast(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB. Max is ${this.MAX_BYTES / 1024 / 1024} MB.`, 'warn');
      e.target.value = '';
      return;
    }
    this.pendingFile = file;
    $('#document-file-status').textContent = `Picked: ${file.name} (${DocumentsView.humanBytes(file.size)})`;
  },

  async save() {
    if (!Auth.isAdmin()) return;
    const fm = $('#document-form');
    const fd = new FormData(fm);
    const title = (fd.get('title') || '').toString().trim();
    if (!title) { this.error('Title is required.'); return; }

    const existing = this.editingId
      ? (Store.state.documents || []).find(d => d.id === this.editingId)
      : null;

    let file = existing?.file || null;
    // Replace file when the picker has a new selection.
    if (this.pendingFile) {
      this.uploading++;
      $('#document-file-status').textContent = 'Uploading…';
      try {
        const result = await Backend.uploadMedia(this.pendingFile, {
          bucket: 'family-documents', folder: 'docs', maxBytes: this.MAX_BYTES,
        });
        if (!result.ok) throw new Error(result.reason);
        // Clean up any prior file from Storage before replacing.
        if (existing?.file?.bucket) await Backend.deleteMedia(existing.file.bucket, existing.file.path);
        file = {
          bucket: result.bucket,
          path: result.path,
          mimeType: result.contentType || this.pendingFile.type || '',
          sizeBytes: result.sizeBytes || this.pendingFile.size,
          originalName: this.pendingFile.name,
        };
      } catch (err) {
        this.uploading = Math.max(0, this.uploading - 1);
        this.error(`Upload failed: ${err.message || err}`);
        return;
      }
      this.uploading = Math.max(0, this.uploading - 1);
    }
    if (!file) { this.error('Attach a file first.'); return; }

    const record = {
      ...(existing || {}),
      id: this.editingId || uid('doc'),
      title,
      category: (fd.get('category') || '').toString().trim(),
      memberId: (fd.get('memberId') || '').toString(),
      notes:    (fd.get('notes')    || '').toString(),
      file,
      createdAt: existing?.createdAt || Date.now(),
      createdBy: existing?.createdBy || Backend.user?.id || null,
    };

    if (!Array.isArray(Store.state.documents)) Store.state.documents = [];
    if (existing) {
      const idx = Store.state.documents.findIndex(d => d.id === this.editingId);
      Store.state.documents[idx] = record;
    } else {
      Store.state.documents.push(record);
    }
    Store.save();
    toast(this.editingId ? 'Document saved.' : 'Document added.');
    this.close();
    DocumentsView.render();
  },

  error(msg) {
    $('#document-error').textContent = msg;
    $('#document-error').hidden = false;
  },

  async deleteCurrent() {
    if (!this.editingId) return;
    const id = this.editingId;
    this.close();
    DocumentsView.deleteDocument(id);
  },
};

// -------------------- NEWSLETTER (v4.50 — Wave 6) --------------------
// Admin-only. Compiles a date-bounded HTML digest from the rest of the
// family-portal state (memories, my-kids entries, recipes, stories,
// time capsules, upcoming birthdays + anniversaries). Three output paths:
//   1. Print → uses the browser's print dialog, which on every modern
//      OS includes a "Save as PDF" option. Zero extra dependencies.
//   2. Copy as email → plain-text version on the clipboard, ready to
//      paste into Gmail / Apple Mail / Outlook.
//   3. Copy family emails → grabs every family member's email so admin
//      can paste them into the To: line in one go.
//
// CPU/memory: this is pure read-side work. No SQL, no realtime. Photos
// pre-resolve their signed URLs once on render so the printed PDF
// actually includes the images (signed URLs expire in 1 hour, so the
// admin should print within that window — which is realistic).
const NewsletterView = {
  fromIso: '',     // inclusive
  toIso:   '',     // inclusive
  greeting: 'The family · digest',
  signedUrlCache: new Map(),

  init() {
    on($('#btn-newsletter-refresh'),      'click', () => this.refresh());
    on($('#btn-newsletter-print'),        'click', () => this.printNewsletter());
    on($('#btn-newsletter-copy-text'),    'click', () => this.copyAsText());
    on($('#btn-newsletter-copy-emails'),  'click', () => this.copyFamilyEmails());
    // Live re-render on date / greeting edits (debounced via input event).
    on($('#newsletter-from'),     'change', () => this.refresh());
    on($('#newsletter-to'),       'change', () => this.refresh());
    on($('#newsletter-greeting'), 'input',  (e) => { this.greeting = e.target.value || 'The family · digest'; });
  },

  // Pick reasonable defaults (last 90 days through today) the first time
  // the view renders. After that, keep whatever the admin set.
  ensureDefaults() {
    if (!this.toIso) {
      const today = new Date();
      this.toIso = today.toISOString().slice(0, 10);
    }
    if (!this.fromIso) {
      const start = new Date();
      start.setDate(start.getDate() - 90);
      this.fromIso = start.toISOString().slice(0, 10);
    }
    if ($('#newsletter-from')) $('#newsletter-from').value = this.fromIso;
    if ($('#newsletter-to'))   $('#newsletter-to').value   = this.toIso;
    if ($('#newsletter-greeting') && !$('#newsletter-greeting').value) {
      $('#newsletter-greeting').value = this.greeting;
    }
  },

  refresh() {
    this.fromIso  = $('#newsletter-from').value  || this.fromIso;
    this.toIso    = $('#newsletter-to').value    || this.toIso;
    this.greeting = $('#newsletter-greeting').value || 'The family · digest';
    this.render();
  },

  render() {
    if (!Auth.isAdmin()) {
      const host = $('#newsletter-preview');
      if (host) host.innerHTML = '<p class="muted" style="padding:24px; text-align:center;">Admin-only.</p>';
      return;
    }
    this.ensureDefaults();
    const host = $('#newsletter-preview');
    if (!host) return;
    // v4.58: warm the memories cache (now table-backed) before compiling.
    MemoriesView.load().then(() => {
      const data = this.compile();
      host.innerHTML = this.renderHTML(data);
      // Resolve image signed URLs on the next tick so the preview shows
      // the actual photos. Each section that includes photos uses the
      // same data-newsletter-photo placeholder pattern.
      host.querySelectorAll('[data-newsletter-photo]').forEach(el => this.resolvePhotoSrc(el));
    });
  },

  // Compile: pull all sources, filter by date range, return a structured
  // object the renderer turns into HTML. Anything date-bearing in the
  // archive contributes here.
  compile() {
    const from = this.fromIso;
    const to   = this.toIso;
    const inRange = (iso) => !!iso && iso >= from && iso <= to;

    // --- Memory posts (date field) ---
    // v4.58: memories live in tables now; read MemoriesView's loaded cache
    // (warmed by render()/copyAsText() before compile()).
    const memories = (MemoriesView.list() || [])
      .filter(m => inRange(m.date))
      .sort((a, z) => (z.date || '').localeCompare(a.date || ''));

    // --- My Kids entries (date field per entry) ---
    // Flatten across kids + sections; tag each with the kid + section
    // so the renderer can group sensibly.
    const myKids = [];
    const myKidsMap = Store.state.myKids || {};
    for (const kidId of Object.keys(myKidsMap)) {
      const kid = Store.byId(kidId);
      if (!kid) continue;
      for (const section of ['milestones','school','art','letters']) {
        for (const e of (myKidsMap[kidId][section] || [])) {
          if (inRange(e.date)) myKids.push({ kid, section, entry: e });
        }
      }
    }
    myKids.sort((a, z) => (z.entry.date || '').localeCompare(a.entry.date || ''));

    // --- Recipes added in range (createdAt) ---
    const recipes = (Store.state.recipes || [])
      .filter(r => {
        const iso = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : '';
        return inRange(iso);
      })
      .sort((a, z) => (z.createdAt || 0) - (a.createdAt || 0));

    // --- Stories added in range (createdAt) ---
    const stories = (Store.state.stories || [])
      .filter(s => {
        const iso = s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : '';
        return inRange(iso);
      })
      .sort((a, z) => (z.createdAt || 0) - (a.createdAt || 0));

    // --- Time capsules that became unlocked OR were revealed in range. ---
    const today = new Date();
    const todayIso = today.toISOString().slice(0, 10);
    const capsules = (Store.state.timeCapsules || [])
      .filter(c => {
        // "unlocked during the window" — capsule's unlockDate falls in
        // range AND today is at or past unlock (meaning the recipient
        // can read it now).
        return inRange(c.unlockDate) && c.unlockDate <= todayIso;
      })
      .sort((a, z) => (z.unlockDate || '').localeCompare(a.unlockDate || ''));

    // --- Upcoming birthdays + anniversaries (next 30 days from "to"). ---
    // The "to" date anchors "now" so the digest stays consistent if the
    // admin compiles for a past quarter.
    const upcoming = this.upcomingFromAnchor(this.toIso, 30);

    return {
      from, to,
      greeting: this.greeting,
      memories,
      myKids,
      recipes,
      stories,
      capsules,
      upcoming,
    };
  },

  // Compute upcoming birthdays + anniversaries from an anchor date,
  // looking N days forward. Mirrors the dashboard's upcoming logic but
  // anchored on a specific day instead of "today".
  upcomingFromAnchor(anchorIso, daysAhead) {
    const anchor = new Date(anchorIso + 'T00:00:00');
    if (isNaN(anchor.getTime())) return [];
    const list = [];
    const add = (m, kind, monthDay, baseIso) => {
      // Compute next occurrence ≥ anchor and ≤ anchor+daysAhead.
      const [mo, da] = monthDay.split('-').map(n => parseInt(n, 10));
      if (!mo || !da) return;
      for (let yearOffset = 0; yearOffset <= 1; yearOffset++) {
        const candidate = new Date(anchor.getFullYear() + yearOffset, mo - 1, da);
        if (candidate < anchor) continue;
        const diff = (candidate - anchor) / 86400000;
        if (diff > daysAhead) return;
        list.push({
          member: m, kind, baseIso,
          dateIso: candidate.toISOString().slice(0, 10),
          age: kind === 'birthday' ? (candidate.getFullYear() - new Date(baseIso).getFullYear()) : null,
          years: kind === 'anniversary' ? (candidate.getFullYear() - new Date(baseIso).getFullYear()) : null,
        });
        return;
      }
    };
    for (const m of Store.membersList()) {
      if (m.birthday && !m.dateOfDeath) {
        add(m, 'birthday', m.birthday.slice(5), m.birthday);
      }
      if (m.anniversary && !m.dateOfDeath) {
        add(m, 'anniversary', m.anniversary.slice(5), m.anniversary);
      }
    }
    list.sort((a, b) => a.dateIso.localeCompare(b.dateIso));
    return list;
  },

  renderHTML(data) {
    const dateRange = `${formatDate(data.from)} – ${formatDate(data.to)}`;
    const sections = [];

    if (data.upcoming.length) {
      sections.push(`
        <section class="newsletter-section">
          <h3>Coming up in the next 30 days</h3>
          <ul class="newsletter-upcoming-list">
            ${data.upcoming.map(u => {
              const name = displayName(u.member);
              const stamp = formatDate(u.dateIso);
              if (u.kind === 'birthday') {
                const ageText = (u.age && u.age > 0) ? ` turns ${u.age}` : '';
                return `<li>🎂 <strong>${escape(name)}${escape(ageText)}</strong> · ${escape(stamp)}</li>`;
              }
              const spouse = u.member.spouseId ? Store.byId(u.member.spouseId) : null;
              const couple = spouse ? `${name} &amp; ${displayName(spouse)}` : name;
              const yearsText = (u.years && u.years > 0) ? ` · ${u.years} year${u.years === 1 ? '' : 's'}` : '';
              return `<li>❤️ <strong>${escape(couple)} anniversary</strong>${escape(yearsText)} · ${escape(stamp)}</li>`;
            }).join('')}
          </ul>
        </section>`);
    }

    if (data.myKids.length) {
      sections.push(`
        <section class="newsletter-section">
          <h3>From the kids</h3>
          ${data.myKids.map(({ kid, section, entry }) => {
            const sectionLabel = { milestones: 'Milestone', school: 'School', art: 'Artwork', letters: 'Letter' }[section] || section;
            const body = entry.body ? `<div class="newsletter-body rich">${RichText.sanitize(entry.body)}</div>` : '';
            const photos = (entry.photos || []).slice(0, 3).map(p =>
              `<div class="newsletter-photo" data-newsletter-photo data-bucket="${escape(p.bucket || '')}" data-path="${escape(p.path || '')}"></div>`
            ).join('');
            return `
              <article class="newsletter-card">
                <header class="newsletter-card-head">
                  <span class="newsletter-tag">${sectionLabel}</span>
                  <strong>${escape(displayName(kid))}</strong>
                  <span class="muted small">${escape(entry.date ? formatDate(entry.date) : '')}</span>
                </header>
                <div class="newsletter-card-title">${escape(entry.title || '')}</div>
                ${body}
                ${photos ? `<div class="newsletter-photos">${photos}</div>` : ''}
              </article>`;
          }).join('')}
        </section>`);
    }

    if (data.memories.length) {
      sections.push(`
        <section class="newsletter-section">
          <h3>On the memory wall</h3>
          ${data.memories.map(m => {
            const body = m.body
              ? (/<[a-z][^>]*>/i.test(m.body)
                  ? `<div class="newsletter-body rich">${RichText.sanitize(m.body)}</div>`
                  : `<div class="newsletter-body">${escape(m.body).replace(/\n/g, '<br>')}</div>`)
              : '';
            const photos = (m.photos || []).slice(0, 4).map(p =>
              `<div class="newsletter-photo" data-newsletter-photo data-bucket="${escape(p.bucket || '')}" data-path="${escape(p.path || '')}"></div>`
            ).join('');
            const tagsHTML = (m.tags || []).length
              ? `<div class="newsletter-card-tags">${(m.tags || []).map(t => {
                  const label = resolvePersonRefLabel(t);
                  return label ? `<span class="newsletter-tag">${escape(label)}</span>` : '';
                }).join('')}</div>`
              : '';
            return `
              <article class="newsletter-card">
                <header class="newsletter-card-head">
                  <span class="muted small">${escape(m.date ? formatDate(m.date) : '')}</span>
                </header>
                ${body}
                ${tagsHTML}
                ${photos ? `<div class="newsletter-photos">${photos}</div>` : ''}
              </article>`;
          }).join('')}
        </section>`);
    }

    if (data.recipes.length) {
      sections.push(`
        <section class="newsletter-section">
          <h3>New in the cookbook</h3>
          <ul class="newsletter-list-plain">
            ${data.recipes.map(r => {
              const from = r.fromText || RecipesView.formatFromRef(r.fromRef);
              const cat = r.category ? ` · ${escape(r.category)}` : '';
              const fromBit = from ? ` · from <em>${escape(from)}</em>` : '';
              return `<li><strong>${escape(r.name)}</strong>${cat}${fromBit}</li>`;
            }).join('')}
          </ul>
        </section>`);
    }

    if (data.stories.length) {
      sections.push(`
        <section class="newsletter-section">
          <h3>New stories</h3>
          <ul class="newsletter-list-plain">
            ${data.stories.map(s => {
              const kindEmoji = s.kind === 'video' ? '🎬' : '🎤';
              const tags = (s.tags || []).map(t => resolvePersonRefLabel(t)).filter(Boolean).join(', ');
              return `<li>${kindEmoji} <strong>${escape(s.title)}</strong>${tags ? ` · with ${escape(tags)}` : ''}</li>`;
            }).join('')}
          </ul>
        </section>`);
    }

    if (data.capsules.length) {
      sections.push(`
        <section class="newsletter-section">
          <h3>Capsules opened</h3>
          <ul class="newsletter-list-plain">
            ${data.capsules.map(c => {
              const to = resolvePersonRefLabel(c.recipientRef) || 'someone';
              const titleBit = c.title ? `: <em>${escape(c.title)}</em>` : '';
              return `<li>📨 <strong>${escape(to)}</strong>${titleBit} · ${escape(formatDate(c.unlockDate))}</li>`;
            }).join('')}
          </ul>
        </section>`);
    }

    if (!sections.length) {
      sections.push('<section class="newsletter-section"><p class="muted">Nothing landed in this date range yet.</p></section>');
    }

    return `
      <header class="newsletter-head">
        <h1 class="newsletter-title">${escape(data.greeting)}</h1>
        <p class="newsletter-range muted">${escape(dateRange)}</p>
      </header>
      ${sections.join('')}
      <footer class="newsletter-foot muted small">
        Compiled from the family archive · ${escape(formatDate(new Date().toISOString().slice(0, 10)))}
      </footer>`;
  },

  async resolvePhotoSrc(el) {
    const bucket = el.dataset.bucket;
    const path   = el.dataset.path;
    if (!bucket || !path) return;
    const key = `${bucket}|${path}`;
    const now = Date.now();
    const cached = this.signedUrlCache.get(key);
    if (cached && cached.expiresAt > now) {
      el.style.backgroundImage = `url('${cssUrl(cached.url)}')`;
      return;
    }
    const url = await Backend.getMediaUrl(bucket, path, 3600);
    if (!url) { el.classList.add('is-missing'); return; }
    this.signedUrlCache.set(key, { url, expiresAt: now + 50 * 60 * 1000 });
    el.style.backgroundImage = `url('${cssUrl(url)}')`;
  },

  // Trigger the browser's print dialog. Modern OS print dialogs include
  // "Save as PDF" as a destination option, so admins get a PDF without
  // an extra library. The view's `no-print` class hides controls in the
  // printed output (see styles.css print media query).
  printNewsletter() {
    // Refresh first so any unsaved date / greeting edits land in the
    // preview before the print dialog opens.
    this.refresh();
    // Defer slightly so the DOM update lands before window.print fires.
    setTimeout(() => window.print(), 60);
  },

  // Plain-text version for "Copy as email." Photos and rich markup are
  // omitted; only the words. Each section becomes a labeled block.
  async copyAsText() {
    await MemoriesView.load();   // v4.58: ensure table-backed memories are loaded
    const data = this.compile();
    const stripHtml = (html) => (html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<li[^>]*>/gi, '  • ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim();
    const lines = [];
    lines.push(data.greeting);
    lines.push(`${formatDate(data.from)} – ${formatDate(data.to)}`);
    lines.push('');
    if (data.upcoming.length) {
      lines.push('COMING UP — NEXT 30 DAYS');
      data.upcoming.forEach(u => {
        const name = displayName(u.member);
        if (u.kind === 'birthday') {
          const ageText = (u.age && u.age > 0) ? ` turns ${u.age}` : '';
          lines.push(`  • ${name}${ageText} — ${formatDate(u.dateIso)}`);
        } else {
          const spouse = u.member.spouseId ? Store.byId(u.member.spouseId) : null;
          const couple = spouse ? `${name} & ${displayName(spouse)}` : name;
          const years = (u.years && u.years > 0) ? ` (${u.years} years)` : '';
          lines.push(`  • ${couple} anniversary${years} — ${formatDate(u.dateIso)}`);
        }
      });
      lines.push('');
    }
    if (data.myKids.length) {
      lines.push('FROM THE KIDS');
      data.myKids.forEach(({ kid, section, entry }) => {
        const label = { milestones: 'Milestone', school: 'School', art: 'Artwork', letters: 'Letter' }[section] || section;
        lines.push(`  • [${label}] ${displayName(kid)} · ${formatDate(entry.date)} — ${entry.title || ''}`);
        const body = stripHtml(entry.body);
        if (body) lines.push(body.split('\n').map(l => '      ' + l).join('\n'));
      });
      lines.push('');
    }
    if (data.memories.length) {
      lines.push('ON THE MEMORY WALL');
      data.memories.forEach(m => {
        lines.push(`  • ${formatDate(m.date)}`);
        const body = stripHtml(m.body);
        if (body) lines.push(body.split('\n').map(l => '      ' + l).join('\n'));
      });
      lines.push('');
    }
    if (data.recipes.length) {
      lines.push('NEW IN THE COOKBOOK');
      data.recipes.forEach(r => {
        const from = r.fromText || RecipesView.formatFromRef(r.fromRef);
        const cat = r.category ? ` · ${r.category}` : '';
        const fromBit = from ? ` · from ${from}` : '';
        lines.push(`  • ${r.name}${cat}${fromBit}`);
      });
      lines.push('');
    }
    if (data.stories.length) {
      lines.push('NEW STORIES');
      data.stories.forEach(s => {
        const tags = (s.tags || []).map(t => resolvePersonRefLabel(t)).filter(Boolean).join(', ');
        lines.push(`  • ${s.kind === 'video' ? '[video]' : '[audio]'} ${s.title}${tags ? ` · with ${tags}` : ''}`);
      });
      lines.push('');
    }
    if (data.capsules.length) {
      lines.push('CAPSULES OPENED');
      data.capsules.forEach(c => {
        const to = resolvePersonRefLabel(c.recipientRef) || 'someone';
        lines.push(`  • To ${to}${c.title ? `: ${c.title}` : ''} · ${formatDate(c.unlockDate)}`);
      });
      lines.push('');
    }
    lines.push(`Compiled from the family archive · ${formatDate(new Date().toISOString().slice(0, 10))}`);
    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('Newsletter copied — paste into your email.');
    } catch {
      toast('Copy failed.', 'warn');
    }
  },

  // Pull every family member email + every friend household primary +
  // spouse emails — anyone reachable. Skip blanks. Comma-separated for
  // direct paste into an email To: field.
  async copyFamilyEmails() {
    const emails = new Set();
    for (const m of Store.membersList()) {
      const e = (m.email || '').trim();
      if (e) emails.add(e);
    }
    for (const f of Object.values(Store.state.friends || {})) {
      if (f.email) emails.add(f.email.trim());
      if (f.spouse?.email) emails.add(f.spouse.email.trim());
    }
    const list = [...emails].sort();
    if (!list.length) { toast('No emails on file yet.', 'warn'); return; }
    try {
      await navigator.clipboard.writeText(list.join(', '));
      toast(`Copied ${list.length} email${list.length === 1 ? '' : 's'}.`);
    } catch {
      toast('Copy failed.', 'warn');
    }
  },
};

document.addEventListener('DOMContentLoaded', init);
