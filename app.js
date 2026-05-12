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
  lastWriteAt: 0,
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
  // single tick coalesce into one network round-trip.
  queueSaveArchive(state) {
    if (!this.client) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSaveArchive(state), 500);
  },

  async flushSaveArchive(state) {
    if (!this.client) return;
    this.saveTimer = null;
    this.saveInFlight = (async () => {
      const now = Date.now();
      const { error } = await this.client
        .from('archive')
        .upsert({ id: 1, state, updated_at: new Date().toISOString(), updated_by: this.user?.id || null });
      if (error) {
        console.warn('saveArchive:', error.message);
      } else {
        this.lastWriteAt = now;
      }
    })();
    return this.saveInFlight;
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
              <div class="mp-chip-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${m.photo}')"` : ''}></div>
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
          <div class="mp-option-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${m.photo}')"` : ''}></div>
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
      // v4.20: groups-add-to-events opt-out. Default true so existing
      // members keep their current behavior — they still get added when
      // an admin picks "+ Add by group…" on an event.
      if (m.includeInGroupEvents === undefined) m.includeInGroupEvents = true;
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
    const password = randomPassword();
    const passwordHash = await hashPassword(password);

    const birthday = input.birthday || '';
    const inferredAge = ageGroupForBirthday(birthday);
    const m = {
      id,
      firstName: input.firstName.trim(),
      middleName: (input.middleName || '').trim(),
      lastName: input.lastName.trim(),
      displayName: (input.displayName || '').trim(),
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
      passwordHash,
      mustChangePassword: true,
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
  const w = 22, h = 20;
  // Heart path centered roughly on (0,0)
  const path = 'M 0 6 C 0 -1, -10 -1, -10 6 C -10 12, 0 16, 0 18 C 0 16, 10 12, 10 6 C 10 -1, 0 -1, 0 6 Z';
  const halo = `<rect x="${x - w/2}" y="${y - h/2}" width="${w}" height="${h}" rx="4" fill="var(--paper-soft)" opacity=".95"/>`;
  if (!divorced) {
    return `<g class="spouse-heart" transform="translate(${x} ${y - 2}) scale(.8)">
      ${halo}
      <path d="${path}" class="heart-fill"/>
    </g>`;
  }
  // broken: heart fill + a jagged white line down the middle
  return `<g class="spouse-heart broken" transform="translate(${x} ${y - 2}) scale(.8)">
    ${halo}
    <path d="${path}" class="heart-fill"/>
    <path d="M -1.4 -0.5 L 1 4 L -1 8 L 1.4 13 L -0.5 17" class="heart-crack"/>
  </g>`;
}

function setOrientation(value) {
  Store.state.orientation = value;
  Store.save();
  // re-layout to match the new orientation
  autoLayout(value);
  Canvas.renderAll();
  Canvas.fit();
  // swap toolbar icon
  const v = document.getElementById('orient-icon-vertical');
  const h = document.getElementById('orient-icon-horizontal');
  const btn = document.getElementById('btn-orientation');
  if (value === 'horizontal') { v.hidden = true; h.hidden = false; btn.title = 'Switch to vertical view'; }
  else { v.hidden = false; h.hidden = true; btn.title = 'Switch to horizontal view'; }
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
    this.el.addEventListener('pointerdown', (e) => {
      // ignore if on a node or interactive child
      if (e.target.closest('.node')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      this.el.classList.add('is-grabbing');
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.tx += e.clientX - sx;
      this.ty += e.clientY - sy;
      sx = e.clientX; sy = e.clientY;
      this.apply();
    });
    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      this.el.classList.remove('is-grabbing');
      try { this.el.releasePointerCapture(e.pointerId); } catch {}
      Store.save();
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
        if (!Auth.isAdmin()) return;
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
  const photoBg = m.photo ? `style="background-image:url('${m.photo}'); background-size: cover;"` : '';
  const inner = m.photo ? '' : Silhouettes.for(m);
  const isSelf = Auth.isSelf(m.id) ? ' is-self' : '';
  const relation = Tree.computeRelation(m.id);
  // Age is sensitive — only admins see it on tree cards.
  const ageStr = Auth.isAdmin() ? ageLabel(m.birthday, m.dateOfDeath) : '';
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
      ${inMemoriam ? '<div class="node-memoriam" title="In loving memory">In loving memory</div>' : ''}
      <div class="node-photo is-${m.gender}" ${photoBg}>${inner}</div>
      <div class="node-body">
        ${relation ? `<div class="node-relation">${relation}</div>` : ''}
        <div class="node-name">${escape(displayName(m))}</div>
        ${m.group ? `<div class="node-group">${escape(m.group)}</div>` : ''}
        ${ageStr ? `<div class="node-meta">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          ${ageStr}
        </div>` : ''}
        ${togetherStr ? `<div class="node-anniv" title="Anniversary: ${escape(anniIso)}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-4.35-7-10.5C5 7.46 7.46 5 10.5 5c1.74 0 3.41.81 4.5 2.09C16.09 5.81 17.76 5 19.5 5 22.54 5 25 7.46 25 10.5 25 16.65 18 21 18 21H12z" fill="currentColor" transform="translate(-2 0)"/></svg>
          ${escape(togetherStr)}
        </div>` : ''}
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
      photo.style.backgroundImage = `url('${m.photo}')`;
      photo.innerHTML = '';
    } else {
      photo.style.backgroundImage = '';
      photo.innerHTML = Silhouettes.for(m);
    }
    $('#drawer-relation').textContent = Tree.computeRelation(m.id) || 'Family';
    $('#drawer-name').textContent = displayName(m);
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
      if (m.plan529) {
        plan529Row.hidden = false;
        const a = $('#kv-529');
        a.href = m.plan529;
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

    renderDrawerGifts(m);

    // permissions
    const canEdit = Auth.isAdmin() || Auth.isSelf(m.id);
    $('#drawer-edit-btn').toggleAttribute('hidden', !canEdit);

    // divorce-status toggle visibility + label (uses joint state)
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
    if (m.photo) { preview.style.backgroundImage = `url('${m.photo}')`; preview.innerHTML = ''; }
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
      preview.style.backgroundImage = `url('${cropped}')`;
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
    preview.style.backgroundImage = `url('${cropped}')`;
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
  const bg = m.photo ? `style="background-image:url('${m.photo}')"` : '';
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
    if ((name === 'admin' || name === 'gifts' || name === 'calendar' || name === 'dashboard' || name === 'history') && !Auth.isAdmin()) name = 'tree';
    if (name === 'events' && !Auth.isAdmin() && !userEventsList().length) name = 'tree';
    this.current = name;
    // Synchronous visibility flip — cheap and gives the click immediate
    // visual feedback (active nav-tab + new view shown).
    $$('.nav-tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === name));
    $('#view-dashboard').hidden  = name !== 'dashboard';
    $('#view-tree').hidden       = name !== 'tree';
    $('#view-myfamily').hidden   = name !== 'myfamily';
    $('#view-admin').hidden      = name !== 'admin';
    $('#view-history').hidden    = name !== 'history';
    $('#view-events').hidden     = name !== 'events';
    $('#view-calendar').hidden   = name !== 'calendar';
    $('#view-gifts').hidden      = name !== 'gifts';
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
      if (name === 'admin')     AdminView.render();
      if (name === 'history')   HistoryView.render();
      if (name === 'events')    EventsView.render();
      if (name === 'calendar')  CalendarView.render();
      if (name === 'gifts')     GiftsView.render();
      if (name === 'myfamily')  MyFamilyView.render();
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
        const id = el.dataset.id;
        if (!Auth.isAdmin() && !allowedIds.has(id)) return;
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
      const bg = m.photo ? `style="background-image:url('${m.photo}')"` : '';
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
          <td style="text-align:right; white-space:nowrap;">
            <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
            <button class="btn btn-ghost btn-sm" data-action="reset">Reset PW</button>
            <button class="btn btn-danger-ghost btn-sm" data-action="delete">Delete</button>
          </td>
        </tr>`;
    }).join('');
    $('#admin-rows').innerHTML = rows || `<tr><td colspan="7" class="muted" style="padding:24px; text-align:center;">No members ${this.filterGroup ? `in “${escape(this.filterGroup)}”` : 'yet'}.</td></tr>`;

    $('#admin-rows').querySelectorAll('button[data-action]').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tr = btn.closest('tr');
        const id = tr.dataset.id;
        const m = Store.byId(id);
        const action = btn.dataset.action;
        if (action === 'edit')          { Drawer.open(id); setTimeout(() => Drawer.startEdit(), 50); }
        else if (action === 'reset')    { await this.resetPassword(m); }
        else if (action === 'delete')   { this.deleteMember(m); }
        else if (action === 'copy-email') {
          try { await navigator.clipboard.writeText(btn.dataset.email); toast('Email copied.'); }
          catch { toast('Copy failed.', 'warn'); }
        }
      });
    });
    $('#admin-rows').querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
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
      const photoBg = m.photo ? `style="background-image:url('${m.photo}'); background-size: cover;"` : '';
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
                <div class="row-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${m.photo}')"` : ''}></div>
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
  exportCSV() {
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
        $('#event-cover-preview').style.backgroundImage = `url('${dataUrl}')`;
        $('#event-cover-url').value = '';
      };
      reader.readAsDataURL(file);
    });
    on($('#event-cover-url'), 'input', (e) => {
      const url = e.target.value.trim();
      $('#event-form').dataset.cover = url;
      $('#event-cover-preview').style.backgroundImage = url ? `url('${url}')` : '';
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
          <div class="row-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${m.photo}')"` : ''}></div>
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
        <tr data-idx="${idx}" class="status-${status}${isYou ? ' is-you-row' : ''}">
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

    const bulkAddBlock = isAdmin ? `
      <select class="input" id="event-add-member">
        <option value="">+ Add family member…</option>
        ${sortMembers(Store.membersList().filter(m => !attendeesRaw.some(a => a.memberId === m.id)))
          .map(m => `<option value="${m.id}">${escape(displayName(m))}</option>`).join('')}
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
      ${cover ? `<div class="event-cover" style="background-image:url('${cover}')"></div>` : ''}
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
        const mid = e.target.value; if (!mid) return;
        const m = Store.byId(mid); if (!m) return;
        attendeesRaw.push(pushAttendee(m));
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
        const i = +el.dataset.idx;
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
      const i = +btn.dataset.remove;
      if (!isAdmin && attendeesRaw[i]?.addedBy !== u?.id) return; // user can only remove own guest
      attendeesRaw.splice(i, 1);
      ev.attendees = attendeesRaw;
      Store.save();
      this.renderDetail();
    }));

    if (isAdmin) {
      // Per-attendee "Add gift" — opens the gift modal pre-filled with this event
      detail.querySelectorAll('[data-gift]').forEach(btn => on(btn, 'click', () => {
        const i = +btn.dataset.gift;
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
      $('#event-cover-preview').style.backgroundImage = cover ? `url('${cover}')` : '';
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

    // Build lookups
    const eventsByDate = new Map();
    (Store.state.events || []).forEach(ev => {
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
      // Calendar-only reminders (recurring)
      const dayReminders = (Store.state.reminders || []).filter(r => reminderOccursOn(r, iso));
      dayReminders.forEach(r => {
        chips.push(`<button type="button" class="cal-chip cal-chip-reminder" data-reminder-id="${r.id}" title="${escape(r.title)} — click to edit">
          <span class="cal-chip-icon">${escape(r.icon || '🔔')}</span><span class="cal-chip-text">${escape(r.title)}</span>
        </button>`);
      });

      return `
        <div class="cal-cell${c.inMonth ? '' : ' is-other-month'}${isToday ? ' is-today' : ''}" data-date="${iso}">
          <div class="cal-cell-head">
            <span class="cal-day-num">${c.dt.getDate()}</span>
            <button type="button" class="cal-add" data-add-event="${iso}" title="Create event on this day" aria-label="Create event on this day">
              <svg viewBox="0 0 16 16" width="11" height="11" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="cal-chips">${chips.join('')}</div>
        </div>`;
    }).join('');

    const grid = $('#cal-grid');
    grid.innerHTML = html;

    // Wire interactions
    grid.querySelectorAll('.cal-chip-event').forEach(b => on(b, 'click', (e) => {
      e.stopPropagation();
      EventsView.selectedId = b.dataset.eventId;
      Views.show('events');
    }));
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
    if (this.direction === 'both') return all.slice();
    return all.filter(g => g.direction === this.direction);
  },
  render() {
    const dir = this.direction;
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
    const memberOptions = ['<option value="">— none —</option>',
      ...sortMembers(Store.membersList())
        .map(m => `<option value="${m.id}">${escape(displayName(m))}</option>`)
    ].join('');
    $('#gift-to-member').innerHTML = memberOptions;

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
      f.toMemberId.value = g.toMemberId || '';
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
      toMemberId:   (fd.get('toMemberId')   || '').toString(),
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
      if (t.photo) { av.style.backgroundImage = `url('${t.photo}')`; av.innerHTML = ''; }
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
      $('#user-chip-role').textContent = u.role;
      $('#user-chip-avatar').style.background = '';
      if (u.photo) {
        $('#user-chip-avatar').style.backgroundImage = `url('${u.photo}')`;
      } else {
        $('#user-chip-avatar').style.backgroundImage = '';
        $('#user-chip-avatar').style.backgroundColor = u.gender === 'male' ? '#e3edf8' : '#fbe3ec';
      }
    }
    document.body.classList.toggle('is-admin', Auth.isAdmin());
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
  Auth.applyAccount();
  if (typeof TreeFilters !== 'undefined' && TreeFilters.refreshGroupOptions) {
    TreeFilters.refreshGroupOptions();
  }
  if (typeof PageEmojis !== 'undefined' && PageEmojis.applyAll) PageEmojis.applyAll();
  document.body.classList.toggle('is-admin', Auth.isAdmin());
  if (Canvas?.renderAll) Canvas.renderAll();
  if (Views?.current === 'admin')    AdminView.render();
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

  Auth.applyAccount();
  if (typeof TreeFilters !== 'undefined' && TreeFilters.refreshGroupOptions) {
    TreeFilters.refreshGroupOptions();
  }
  Backend.onRemoteChange = applyRemoteState;
  Backend.subscribeArchive();
  enterApp();
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
  on($('#btn-orientation'), 'click', () => {
    const next = (Store.state.orientation === 'horizontal') ? 'vertical' : 'horizontal';
    setOrientation(next);
    toast(next === 'horizontal' ? 'Horizontal view.' : 'Vertical view.');
  });

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
  on($('#btn-add-member'), 'click', () => MemberModal.open());
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
  t.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-show'), 2400);
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
  // sync orientation toolbar icon with stored value
  const orient = Store.state.orientation || 'vertical';
  const v = document.getElementById('orient-icon-vertical');
  const h = document.getElementById('orient-icon-horizontal');
  const btn = document.getElementById('btn-orientation');
  if (orient === 'horizontal') { v.hidden = true; h.hidden = false; btn.title = 'Switch to vertical view'; }
  else { v.hidden = false; h.hidden = true; btn.title = 'Switch to horizontal view'; }
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
  RemindersModal.init();
  DashboardView.init();
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
    const tz = 'America/Los_Angeles';
    const now = new Date();
    $('#dash-time').textContent = now.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    $('#dash-date').textContent = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }) + ' · Las Vegas, NV';
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

const HistoryView = {
  render() {
    const list = $('#history-list'); if (!list) return;
    const entries = CHANGELOG;
    const current = $('#history-current-version');
    if (current) current.textContent = entries.length ? `v${entries[0].version}` : '—';
    if (!entries.length) {
      list.innerHTML = '<p class="muted small">No history entries yet.</p>';
      return;
    }
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
  },
};

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

document.addEventListener('DOMContentLoaded', init);
