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
              <span>${escape(m.firstName)} ${escape(m.lastName)}</span>
              <button type="button" class="mp-chip-x" data-remove="${id}" aria-label="Remove">
                <svg viewBox="0 0 16 16" width="10" height="10"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
            </span>`;
          }).join('')
        : '<span class="mp-empty">No members selected</span>';
      const q = (search.value || '').toLowerCase();
      const sel = new Set(selectedIds);
      const matches = sortMembers(Store.membersList())
        .filter(m => !q || (`${m.firstName} ${m.lastName} ${m.nickname || ''}`).toLowerCase().includes(q));
      list.innerHTML = matches.map(m => `
        <button type="button" class="mp-option ${sel.has(m.id) ? 'is-selected' : ''}" data-toggle="${m.id}">
          <div class="mp-option-avatar is-${m.gender}" ${m.photo ? `style="background-image:url('${m.photo}')"` : ''}></div>
          <span>${escape(m.firstName)} ${escape(m.lastName)}</span>
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
      theme: { baseHue: 205 },
      events: [],
      gifts: [],
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
      nickname: (input.nickname || '').trim(),
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
      x: 0, y: 0,
      createdAt: Date.now(),
    };
    Store.state.members[id] = m;

    // wire relationship
    if (input.relType && input.relTargetId) {
      this.connect(m, input.relType, input.relTargetId, input.relSecondId);
      // If creating a spouse and the user marked it divorced, set the flag on both.
      if (input.relType === 'spouse' && input.relDivorced) {
        m.divorced = true;
        const t = Store.byId(input.relTargetId);
        if (t) t.divorced = true;
      }
    }
    // Children inherit ethnicities from their parents.
    inheritEthnicities();
    // Re-run the full auto-layout so the new member slots into a clean tree.
    autoLayout();
    Store.save();
    return { member: m, password };
  },
  connect(member, relType, targetId, secondId) {
    const target = Store.byId(targetId);
    if (!target) return;
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
      // Detach any prior spouse on either side and clear the lingering
      // `divorced` flag so a fresh marriage starts with a solid heart.
      const detach = (personId) => {
        const p = Store.byId(personId);
        if (!p) return;
        const oldId = p.spouseId;
        if (oldId && oldId !== member.id && oldId !== target.id) {
          const old = Store.byId(oldId);
          if (old) { old.spouseId = null; old.divorced = false; }
        }
        p.spouseId = null;
        p.divorced = false;
      };
      detach(target.id);
      detach(member.id);
      member.spouseId = target.id;
      target.spouseId = member.id;
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
    (member.parentIds || []).forEach(pid => {
      const p = Store.byId(pid); if (p) out.push({ label: 'Parent', member: p });
    });
    (member.childrenIds || []).forEach(cid => {
      const c = Store.byId(cid); if (c) out.push({ label: 'Child', member: c });
    });
    // siblings
    const sibIds = new Set();
    (member.parentIds || []).forEach(pid => {
      (Store.byId(pid)?.childrenIds || []).forEach(cid => {
        if (cid !== member.id) sibIds.add(cid);
      });
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
function autoLayout(orientation = Store.state.orientation || 'vertical') {
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
    placed.add(m.id);
    if (spouse) placed.add(spouse.id);

    // When the couple is collapsed, treat them as a leaf for layout purposes
    // so the tree compresses around the hidden subtree.
    const isCollapsed = m.collapsed || (spouse && spouse.collapsed);
    const childIds = isCollapsed ? [] : unique([
      ...(m.childrenIds || []),
      ...(spouse?.childrenIds || []),
    ]).filter(cid => !placed.has(cid) && Store.byId(cid));

    const coupleSize = spouse ? (2 * SIBLING_SIZE + SIBLING_GAP) : SIBLING_SIZE;

    if (!childIds.length) {
      placeAt(m, start, depth);
      if (spouse) placeAt(spouse, start + SIBLING_SIZE + SIBLING_GAP, depth);
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
    placeAt(m, coupleStart, depth);
    if (spouse) placeAt(spouse, coupleStart + SIBLING_SIZE + SIBLING_GAP, depth);
    return span;
  };

  // Roots = members whose parents aren't in the data set
  const roots = all.filter(m => !(m.parentIds || []).some(pid => Store.byId(pid)));
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

    // spouse connectors + heart marker
    const drawnSpouse = new Set();
    visibleMembers.forEach(m => {
      if (!m.spouseId || drawnSpouse.has(m.id)) return;
      if (!visibleIds.has(m.spouseId)) return;
      const s = Store.byId(m.spouseId); if (!s) return;
      drawnSpouse.add(m.id); drawnSpouse.add(s.id);
      const divorced = !!(m.divorced || s.divorced);

      let mx, my;
      if (orientation === 'vertical') {
        const left = m.x < s.x ? m : s, right = m.x < s.x ? s : m;
        const y = Math.max(left.y, right.y) + NODE_H * 0.5;
        lines.push(`<path class="edge spouse" d="M ${left.x + NODE_W} ${y} H ${right.x}"/>`);
        mx = (left.x + NODE_W + right.x) / 2;
        my = y;
      } else {
        const top = m.y < s.y ? m : s, bot = m.y < s.y ? s : m;
        const x = Math.max(top.x, bot.x) + NODE_W * 0.5;
        lines.push(`<path class="edge spouse" d="M ${x} ${top.y + NODE_H} V ${bot.y}"/>`);
        mx = x;
        my = (top.y + NODE_H + bot.y) / 2;
      }
      lines.push(heartMarker(mx, my, divorced));

      // "X yrs" chip near the heart for current couples with an anniversary on file.
      const aniso = m.anniversary || s.anniversary || '';
      if (!divorced && aniso) {
        const yrs = yearsTogether(aniso);
        if (yrs != null) {
          // Position the label just to the right of the heart for vertical
          // spouse rows, or just below it for horizontal stacks.
          const isVertical = orientation === 'vertical';
          const lx = isVertical ? mx + 16 : mx;
          const ly = isVertical ? my + 4  : my + 22;
          const anchor = isVertical ? 'start' : 'middle';
          lines.push(
            `<text class="spouse-years" x="${lx}" y="${ly}" text-anchor="${anchor}">${yrs} yr${yrs === 1 ? '' : 's'}</text>`
          );
        }
      }
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
      node.addEventListener('click', (e) => {
        if (e.target.closest('.node-add')) return;
        if (e.target.closest('.node-toggle')) return;
        if (!Auth.isAdmin()) return;
        Drawer.open(id);
      });
    });
  },
};

function nodeHTML(m) {
  const photoBg = m.photo ? `style="background-image:url('${m.photo}'); background-size: cover;"` : '';
  const inner = m.photo ? '' : Silhouettes.for(m);
  const isSelf = Auth.isSelf(m.id) ? ' is-self' : '';
  const relation = Tree.computeRelation(m.id);
  // Age is sensitive — only admins see it on tree cards.
  const ageStr = Auth.isAdmin() ? ageLabel(m.birthday) : '';
  const gen = ((_gensCache || computeGenerations())[m.id] ?? 0);

  const sp = m.spouseId ? Store.byId(m.spouseId) : null;
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
    <div class="node${isSelf}${collapsedClass}" data-id="${m.id}" data-gen="${gen}" style="${styleVars}">
      <div class="node-gen-bar" aria-hidden="true"></div>
      ${selfStar}
      <div class="node-photo is-${m.gender}" ${photoBg}>${inner}</div>
      <div class="node-body">
        ${relation ? `<div class="node-relation">${relation}</div>` : ''}
        <div class="node-name">${escape(m.firstName)} ${escape(m.lastName)}</div>
        ${m.nickname ? `<div class="node-nick">"${escape(m.nickname)}"</div>` : ''}
        ${m.group ? `<div class="node-group">${escape(m.group)}</div>` : ''}
        ${ageStr ? `<div class="node-meta">
          <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          ${ageStr}
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
      const yrs = yearsTogether($('#edit-anniversary').value);
      $('#edit-anniv-years').textContent = yrs != null
        ? `${yrs} year${yrs === 1 ? '' : 's'} together`
        : '';
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
    $('#drawer-name').textContent = fullName(m);
    $('#drawer-nick').textContent = m.nickname ? `"${m.nickname}"` : '';
    $('#kv-birthday').textContent = m.birthday ? formatDate(m.birthday) : '—';
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
    $('#kv-username').textContent = m.username;

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
    f.nickname.value = m.nickname || '';
    f.birthday.value = m.birthday || '';
    f.phone.value = formatPhoneUS(m.phone || '');
    f.email.value = m.email || '';
    f.address.value = m.address || '';
    f.zip.value   = m.zip   || '';
    f.city.value  = m.city  || '';
    f.state.value = m.state || '';
    $('#edit-zip-status').hidden = true;
    f.gender.value = m.gender;
    f.ageGroup.value = m.ageGroup;
    if (f.role) f.role.value = m.role;
    refreshGroupSelect($('#edit-group'), m.group);
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
    m.nickname   = (fd.get('nickname') || '').toString().trim();
    m.birthday   = (fd.get('birthday') || '').toString();
    // Normalize phone to a consistent "(XXX) XXX-XXXX" format on save.
    m.phone      = formatPhoneUS((fd.get('phone') || '').toString());
    m.email      = (fd.get('email') || '').toString().trim();
    m.address    = (fd.get('address') || '').toString().trim();
    m.city       = (fd.get('city')  || '').toString().trim();
    m.state      = (fd.get('state') || '').toString().trim().toUpperCase().slice(0, 3);
    m.zip        = (fd.get('zip')   || '').toString().trim().slice(0, 10);
    m.group      = (fd.get('group') || '').toString();
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
    };
    reader.readAsDataURL(file);
  },
  clearPhoto() {
    const f = $('#drawer-edit');
    f.dataset.tempPhoto = 'cleared';
    const m = Store.byId(this.currentId);
    const preview = $('#photo-preview');
    preview.style.backgroundImage = '';
    preview.innerHTML = Silhouettes.for({ gender: f.gender.value, ageGroup: f.ageGroup.value });
  },
  async resetPassword() {
    if (!Auth.isAdmin()) return;
    const m = Store.byId(this.currentId); if (!m) return;
    await sendAdminResetEmail(m);
  },
  deleteMember() {
    if (!Auth.isAdmin()) return;
    const m = Store.byId(this.currentId); if (!m) return;
    if (!confirm(`Remove ${m.firstName} ${m.lastName} from the family tree? Their account will be deleted.`)) return;
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
    // Read the joint state: if EITHER is marked divorced, the couple reads as divorced.
    const currentlyDivorced = !!(m.divorced || s?.divorced);
    const next = !currentlyDivorced;
    m.divorced = next;
    if (s) s.divorced = next;
    Store.save();
    toast(next ? 'Marked as divorced.' : 'Marked as married.');
    Canvas.renderAll();
    this.renderView();
  },
};

function relRow(r) {
  const m = r.member;
  const bg = m.photo ? `style="background-image:url('${m.photo}')"` : '';
  return `
    <div class="rel-row" data-id="${m.id}" data-rel="${r.label.toLowerCase()}">
      <div class="rel-avatar is-${m.gender}" ${bg}></div>
      <div class="rel-info">
        <span class="rel-label">${r.label}</span>
        <span class="rel-name">${escape(m.firstName)} ${escape(m.lastName)}</span>
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
  show(name) {
    if ((name === 'admin' || name === 'gifts' || name === 'calendar') && !Auth.isAdmin()) name = 'tree';
    if (name === 'events' && !Auth.isAdmin() && !userEventsList().length) name = 'tree';
    this.current = name;
    $$('.nav-tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === name));
    $('#view-tree').hidden       = name !== 'tree';
    $('#view-myfamily').hidden   = name !== 'myfamily';
    $('#view-admin').hidden      = name !== 'admin';
    $('#view-events').hidden     = name !== 'events';
    $('#view-calendar').hidden   = name !== 'calendar';
    $('#view-gifts').hidden      = name !== 'gifts';
    if (name === 'admin')     AdminView.render();
    if (name === 'events')    EventsView.render();
    if (name === 'calendar')  CalendarView.render();
    if (name === 'gifts')     GiftsView.render();
    if (name === 'myfamily')  MyFamilyView.render();
    if (name === 'tree')      Canvas.renderAll();
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
      `<option value="${m.id}" ${m.id === currentId ? 'selected' : ''}>${escape(m.firstName)} ${escape(m.lastName)}</option>`
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
    const parents = (focus.parentIds || []).map(id => Store.byId(id)).filter(Boolean);
    const spouse  = focus.spouseId && !focus.divorced ? Store.byId(focus.spouseId) : null;
    // Children: union of focus's children and (if married) spouse's children, deduped.
    const childIds = unique([...(focus.childrenIds || []), ...((spouse && spouse.childrenIds) || [])]);
    const children = childIds.map(id => Store.byId(id)).filter(Boolean);

    // Layout: 3 rows. Each row is centered horizontally around x = 0.
    // Card geometry matches the main Family Tree.
    const CW = NODE_W, CH = NODE_H;
    const GAP_X = 60;
    const ROW_GAP = 100;

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

    placeRow(parents, Y_PARENTS);
    placeRow(spouse ? [focus, spouse] : [focus], Y_FOCUS);
    placeRow(children, Y_CHILDREN);

    // World bounds — compute min/max so we can center the canvas.
    const all = [focus, ...parents, ...(spouse ? [spouse] : []), ...children];
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

    // -------- nodes --------
    const renderableMembers = [focus, ...parents, ...(spouse ? [spouse] : []), ...children];
    nodes.innerHTML = renderableMembers.map(m => {
      const p = rowFor[m.id]; if (!p) return '';
      const html = nodeHTML(m);
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
    const hearts = [];

    // Parents → focus: drop from parent-couple midpoint (or single parent) down
    // to a trunk above focus, then up into focus.
    if (parents.length) {
      const focusTop = ANCHOR_TOP(focus.id);
      const parentBottoms = parents.map(p => ANCHOR_BOTTOM(p.id));
      const couple = parents.length === 2 &&
        parents[0].spouseId === parents[1].id &&
        !parents[0].divorced && !parents[1].divorced;
      const trunkY = focusTop.y - 36;
      const midX = couple
        ? (parentBottoms[0].x + parentBottoms[1].x) / 2
        : parentBottoms[0].x;

      // Vertical down from each parent's bottom
      parentBottoms.forEach((pb, idx) => {
        // Stop the line at the spouse-line height (where the heart will sit), so
        // it visually connects through the heart rather than overshooting it.
        const stopY = couple ? pb.y + 28 : trunkY;
        lines.push(`M ${pb.x} ${pb.y} V ${stopY}`);
      });

      // For a couple: horizontal spouse line and a single drop to trunk
      if (couple) {
        const yLine = parentBottoms[0].y + 28;
        const x0 = Math.min(parentBottoms[0].x, parentBottoms[1].x);
        const x1 = Math.max(parentBottoms[0].x, parentBottoms[1].x);
        lines.push(`M ${x0} ${yLine} H ${x1}`);
        // drop from midpoint to trunk
        lines.push(`M ${midX} ${yLine} V ${trunkY}`);
        // heart between parents
        hearts.push(heartMarker(midX, yLine, !!parents[0].divorced || !!parents[1].divorced));
      }

      // horizontal trunk above focus (so it lines up even if midX != focus.x)
      lines.push(`M ${Math.min(midX, focusTop.x)} ${trunkY} H ${Math.max(midX, focusTop.x)}`);
      // drop into focus top
      lines.push(`M ${focusTop.x} ${trunkY} V ${focusTop.y}`);
    }

    // Focus + Spouse: spouse line + heart
    if (spouse) {
      const a = rowFor[focus.id];
      const b = rowFor[spouse.id];
      const yLine = a.y + CH / 2 + shiftY;
      const leftX  = Math.min(a.x, b.x) + CW + shiftX;
      const rightX = Math.max(a.x, b.x) + shiftX;
      lines.push(`M ${leftX} ${yLine} H ${rightX}`);
      const heartX = (leftX + rightX) / 2;
      hearts.push(heartMarker(heartX, yLine, false));
    }

    // Focus(+Spouse) → Children: drop from couple midpoint (or focus bottom)
    // to a trunk above the kids, then up into each child.
    if (children.length) {
      const focusBottom = ANCHOR_BOTTOM(focus.id);
      let startX, startY;
      if (spouse) {
        const a = rowFor[focus.id];
        const b = rowFor[spouse.id];
        const yLine = a.y + CH / 2 + shiftY;
        startX = (Math.min(a.x, b.x) + CW + Math.max(a.x, b.x)) / 2 + shiftX;
        startY = yLine;
        // Drop from heart-line down past the bottom of the focus row
        const dropTo = a.y + CH + shiftY + 4;
        lines.push(`M ${startX} ${startY} V ${dropTo}`);
        startY = dropTo;
      } else {
        startX = focusBottom.x;
        startY = focusBottom.y;
      }
      const childTops = children.map(c => ANCHOR_TOP(c.id));
      const trunkY = childTops[0].y - 36;
      lines.push(`M ${startX} ${startY} V ${trunkY}`);
      const minCX = Math.min(startX, ...childTops.map(p => p.x));
      const maxCX = Math.max(startX, ...childTops.map(p => p.x));
      lines.push(`M ${minCX} ${trunkY} H ${maxCX}`);
      childTops.forEach(ct => lines.push(`M ${ct.x} ${trunkY} V ${ct.y}`));
    }

    edges.setAttribute('width', stageW);
    edges.setAttribute('height', worldH + padTop * 2);
    edges.innerHTML = `
      <g class="myfamily-edge-lines">
        ${lines.map(d => `<path d="${d}" />`).join('')}
      </g>
      <g class="myfamily-hearts">
        ${hearts.join('')}
      </g>
    `;

    // Card click → drawer (per design decision: clickable for users on My Family)
    nodes.querySelectorAll('.node').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.node-add')) return;
        if (e.target.closest('.node-toggle')) return;
        Drawer.open(el.dataset.id);
      });
    });
  },
};

// -------------------- ADMIN VIEW --------------------
const AdminView = {
  filterGroup: '',                // active group chip; '' means "all"
  viewMode: 'table',              // 'table' | 'cards' — toggle in Members panel
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
    return sortMembers(list);
  },
  render() {
    const list = this.visibleMembers();
    $('#admin-filter-note').textContent = this.filterGroup
      ? `Showing ${list.length} member${list.length === 1 ? '' : 's'} in “${this.filterGroup}”`
      : `Showing all members (${list.length})`;

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
    const rows = list.map(m => {
      const bg = m.photo ? `style="background-image:url('${m.photo}')"` : '';
      return `
        <tr data-id="${m.id}">
          <td>
            <div class="row-name">
              <div class="row-avatar is-${m.gender}" ${bg}></div>
              <div>
                <div style="font-weight:600">${escape(m.firstName)} ${escape(m.lastName)}</div>
                ${m.nickname ? `<div class="muted small">"${escape(m.nickname)}"</div>` : ''}
              </div>
            </div>
          </td>
          <td>
            <span class="username-cell">
              <code data-username-display>${escape(m.username)}</code>
              <button class="username-edit" data-action="edit-username" title="Edit username">
                <svg viewBox="0 0 16 16" width="11" height="11" fill="none"><path d="M11 2l3 3-9 9H2v-3l9-9z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
              </button>
            </span>
          </td>
          <td><span class="role-pill ${m.role}">${m.role}</span></td>
          <td>${m.group ? escape(m.group) : '—'}</td>
          <td>${m.birthday ? formatDate(m.birthday) : '—'}</td>
          <td style="text-align:right; white-space:nowrap;">
            <button class="btn btn-ghost btn-sm" data-action="edit">Edit</button>
            <button class="btn btn-ghost btn-sm" data-action="reset">Reset PW</button>
            <button class="btn btn-danger-ghost btn-sm" data-action="delete">Delete</button>
          </td>
        </tr>`;
    }).join('');
    $('#admin-rows').innerHTML = rows || `<tr><td colspan="6" class="muted" style="padding:24px; text-align:center;">No members ${this.filterGroup ? `in “${escape(this.filterGroup)}”` : 'yet'}.</td></tr>`;

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
        else if (action === 'edit-username') { this.editUsername(tr, m); }
      });
    });
    $('#admin-rows').querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (e.target.closest('.username-cell input')) return;
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
            <div class="node-name">${escape(m.firstName)} ${escape(m.lastName)}</div>
            ${m.nickname ? `<div class="node-nick">"${escape(m.nickname)}"</div>` : ''}
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
                <span>${escape(m.firstName)} ${escape(m.lastName)}</span>
              </div>
              <button class="btn btn-ghost btn-sm" data-remove="${m.id}">Remove</button>
            </div>`).join('') : '<p class="muted small">No members in this group yet.</p>'}
        </div>
        <div class="group-add-row">
          <select class="input" id="group-add-member">
            <option value="">+ Add member to this group…</option>
            ${notInGroup.map(m => `<option value="${m.id}">${escape(m.firstName)} ${escape(m.lastName)}${m.group ? ' (' + escape(m.group) + ')' : ''}</option>`).join('')}
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
    if (!confirm(`Delete ${m.firstName} ${m.lastName}?`)) return;
    Tree.remove(m.id);
    this.render();
    Canvas.renderAll();
  },
  editUsername(tr, m) {
    const cell = tr.querySelector('.username-cell');
    if (!cell || cell.querySelector('input')) return;
    const code = cell.querySelector('code');
    const editBtn = cell.querySelector('.username-edit');
    code.hidden = true;
    if (editBtn) editBtn.hidden = true;
    const input = document.createElement('input');
    input.className = 'input';
    input.value = m.username;
    input.style.maxWidth = '180px';
    cell.appendChild(input);
    input.focus();
    input.select();
    const finish = (commit) => {
      const next = input.value.trim().toLowerCase();
      if (!commit) { this.render(); return; }
      if (!next) { toast('Username cannot be empty.', 'warn'); return; }
      if (!/^[a-z0-9._-]+$/.test(next)) { toast('Only lowercase letters, digits, dot, underscore, dash.', 'warn'); return; }
      if (next === m.username) { this.render(); return; }
      const taken = Store.membersList().some(x => x.id !== m.id && x.username === next);
      if (taken || next === 'admin') { toast('That username is taken.', 'warn'); return; }
      m.username = next;
      Store.save();
      toast('Username updated.');
      this.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
  },
  exportCSV() {
    const list = this.visibleMembers();
    if (!list.length) { toast('Nothing to export.', 'warn'); return; }
    const data = [
      ['First name', 'Last name', 'Nickname', 'Username', 'Role', 'Group', 'Email', 'Phone', 'Address', 'Birthday', 'Ethnicities'],
      ...list.map(m => [
        m.firstName, m.lastName, m.nickname || '', m.username, m.role,
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
          const giftNet = eventGiftNet(ev.id);
          const expTot  = eventExpenseTotals(ev);
          const cardNet = giftNet.net - expTot.paid;
          const hasNum  = giftNet.received !== 0 || giftNet.given !== 0 || expTot.paid !== 0;
          const netChip = hasNum
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
            <div style="font-weight:600">${escape(m.firstName)} ${escape(m.lastName)}${isYou ? ' <span class="row-you-tag">you</span>' : ''}</div>
            ${m.nickname ? `<div class="muted small">"${escape(m.nickname)}"</div>` : ''}
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
          .map(m => `<option value="${m.id}">${escape(m.firstName)} ${escape(m.lastName)}</option>`).join('')}
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
              const sum = attendeesRaw.reduce((s, x) => s + giftTotalForAttendee(x), 0);
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

    detail.innerHTML = `
      ${cover ? `<div class="event-cover" style="background-image:url('${cover}')"></div>` : ''}
      <header class="panel-head">
        <div>
          <h3>${ev.icon ? `<span class="event-title-icon">${escape(ev.icon)}</span>` : ''}${escape(ev.name)}</h3>
          <p class="muted small">${ev.date ? formatDate(ev.date) : 'Date TBD'}${locationHtml}</p>
        </div>
        ${headerActions}
      </header>
      ${ev.description ? `<p class="panel-prose">${escape(ev.description)}</p>` : ''}
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
        Store.membersList()
          .filter(m => m.group === grp && !present.has(m.id))
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
    } else {
      $('#event-modal-title').textContent = 'New event';
      $('#event-icon').value = '🎉';
      if (opts.defaultDate) f.date.value = opts.defaultDate;
    }
    $('#event-modal').setAttribute('aria-hidden', 'false');
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
    const data = {
      name,
      date: (fd.get('date') || '').toString(),
      location: (fd.get('location') || '').toString().trim(),
      description: (fd.get('description') || '').toString().trim(),
      icon: ((fd.get('icon') || '').toString().trim() || ''),
      coverPhoto: coverIsUpload ? coverValue : null,
      coverUrl:   coverIsUpload ? '' : coverValue,
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
        chips.push(`<button type="button" class="cal-chip cal-chip-birthday" data-member-id="${m.id}" title="${escape(m.firstName)} ${escape(m.lastName)}${ageHint}">
          <span class="cal-chip-icon">🎂</span><span class="cal-chip-text">${escape(m.firstName)} ${escape(m.lastName)}</span>
        </button>`);
      });
      const dayAnnivs = anniversariesByMD.get(md) || [];
      dayAnnivs.forEach(({ focus, partner, isoDate }) => {
        const aYear = parseInt((isoDate || '').slice(0, 4), 10);
        const nth   = Number.isFinite(aYear) ? (c.dt.getFullYear() - aYear) : null;
        const ordHint = nth != null && nth > 0 ? ` — ${nth}${nthSuffix(nth)} anniversary` : '';
        const label = `${focus.firstName} & ${partner.firstName}`;
        chips.push(`<button type="button" class="cal-chip cal-chip-anniv" data-member-id="${focus.id}" title="${escape(focus.firstName)} ${escape(focus.lastName)} & ${escape(partner.firstName)} ${escape(partner.lastName)}${ordHint}">
          <span class="cal-chip-icon">💍</span><span class="cal-chip-text">${escape(label)}</span>
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
        .map(m => `${m.firstName} ${m.lastName}`);
      const fromName = fromNames.length
        ? fromNames.join(', ')
        : (g.fromText || '—');
      const toName = g.toMemberId && memMap[g.toMemberId]
        ? `${memMap[g.toMemberId].firstName} ${memMap[g.toMemberId].lastName}`
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
      const names = fromIds.map(id => memMap[id]).filter(Boolean).map(m => `${m.firstName} ${m.lastName}`);
      return names.length ? names.join(', ') : (g.fromText || '');
    };
    const toOf = g => g.toMemberId && memMap[g.toMemberId]
      ? `${memMap[g.toMemberId].firstName} ${memMap[g.toMemberId].lastName}` : (g.toText || '');
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
        .map(m => `<option value="${m.id}">${escape(m.firstName)} ${escape(m.lastName)}</option>`)
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
  close() { this.el.setAttribute('aria-hidden', 'true'); },
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
      sel.innerHTML = `<option value="${tm.id}">${escape(tm.firstName)} ${escape(tm.lastName)}</option>`;
      sel.value = tm.id;
      sel.disabled = true;
      targetWrap.querySelector('span').textContent = 'Anchor person';
    } else {
      sel.disabled = false;
      targetWrap.querySelector('span').textContent = 'Connect to';
      const opts = sortMembers(Store.membersList()).map(m => `<option value="${m.id}">${escape(m.firstName)} ${escape(m.lastName)}</option>`).join('');
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
      if (s) opts.push(`<option value="${s.id}" selected>${s.firstName} ${s.lastName} (spouse)</option>`);
    }
    sortMembers(Store.membersList().filter(m => m.id !== target.id && m.id !== target.spouseId)).forEach(m => {
      opts.push(`<option value="${m.id}">${m.firstName} ${m.lastName}</option>`);
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
      nickname: fd.get('nickname'),
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
    $('#link-subject').textContent = `Connect ${m.firstName} ${m.lastName} to someone already in the tree.`;
    const sel = $('#link-target');
    const opts = sortMembers(Store.membersList().filter(x => x.id !== memberId))
      .map(x => `<option value="${x.id}">${escape(x.firstName)} ${escape(x.lastName)}</option>`)
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
    Tree.connect(member, relType, target.id);
    if (relType === 'spouse' && fd.get('divorced')) {
      member.divorced = true;
      target.divorced = true;
    }
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

// Admin path: trigger Supabase to email the member a password reset link.
// We can't set another user's password from the anon client (that needs the
// service_role secret), but resetPasswordForEmail works with the anon key —
// the user clicks the link in their inbox and lands back on the site, where
// ChangePasswordModal's recovery mode picks up the token.
async function sendAdminResetEmail(m) {
  if (!Auth.isAdmin()) return;
  if (!m) return;
  if (!m.email) {
    toast('Add an email to this member first — the reset link is sent there.', 'warn');
    return;
  }
  if (!confirm(`Send a password reset email to ${m.email}?\n\nThey'll get a link to set a new password.`)) return;
  const r = await Backend.sendPasswordReset(m.email);
  if (r.ok) toast(`Reset link sent to ${m.email}.`);
  else      toast('Could not send reset: ' + r.reason, 'warn');
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
  document.body.classList.toggle('is-admin', Auth.isAdmin());
  if (Canvas?.renderAll) Canvas.renderAll();
  if (Views?.current === 'admin')    AdminView.render();
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
  on($('#btn-auto-layout'),'click', () => { autoLayout(); Canvas.renderAll(); Canvas.fit(); toast('Tree arranged.'); });
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
        if ((`${m.firstName} ${m.lastName} ${m.nickname || ''}`).toLowerCase().includes(q)) {
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
function ageParts(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  let years  = now.getFullYear() - d.getFullYear();
  let months = now.getMonth()    - d.getMonth();
  let days   = now.getDate()     - d.getDate();
  if (days < 0) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (years < 0) return null;
  return { years, months };
}
function ageLabel(iso) {
  const a = ageParts(iso); if (!a) return '';
  if (a.years >= 4) return `${a.years} years old`;
  if (a.years === 0) return `${a.months} ${a.months === 1 ? 'month' : 'months'} old`;
  const yr = `${a.years} ${a.years === 1 ? 'year' : 'years'}`;
  const mo = a.months ? ` ${a.months} ${a.months === 1 ? 'month' : 'months'}` : '';
  return `${yr}${mo} old`;
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
  LinkFamilyModal.init();
  CropModal.init();
  EventsView.init();
  CalendarView.init();
  GiftsView.init();
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

  // If we have a live Supabase session from a previous visit, skip the login
  // screen and head straight in — unless this load is a recovery link.
  if (backendOk) {
    const session = await Backend.session();
    if (session && !Backend.recoveryPending) {
      Backend.user = session.user;
      await onSignedIn();
    }
  }
}

document.addEventListener('DOMContentLoaded', init);
