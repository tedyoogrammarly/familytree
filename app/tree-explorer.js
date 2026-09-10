// Navigation stays separate from archive data and profile permissions.
// This script loads before app.js; its methods run after the app initializes.
const TreeExplorer = {
  selectedId: null,
  history: [],
  matches: [],
  activeResult: -1,
  initialized: false,

  init() {
    if (this.initialized) return;
    this.initialized = true;
    const search = document.getElementById('tree-search');
    const results = document.getElementById('tree-search-results');
    search?.addEventListener('input', () => this.search(search.value));
    search?.addEventListener('focus', () => { if (search.value.trim()) this.search(search.value); });
    search?.addEventListener('keydown', e => {
      if (e.key === 'Escape') { this.closeSearch(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
      if (results?.hidden) {
        if (e.key === 'Enter' || !search.value.trim()) return;
        this.search(search.value);
      }
      if (!this.matches.length) return;
      e.preventDefault();
      if (e.key === 'Enter') {
        this.select(this.matches[Math.max(0, this.activeResult)].id);
        Canvas.el.focus({ preventScroll: true });
        return;
      }
      this.activeResult = (this.activeResult + (e.key === 'ArrowDown' ? 1 : -1) + this.matches.length) % this.matches.length;
      results?.querySelectorAll('[data-member-id]').forEach((button, index) => {
        const active = index === this.activeResult;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', String(active));
        if (active) {
          search.setAttribute('aria-activedescendant', button.id);
          button.scrollIntoView({ block: 'nearest' });
        }
      });
    });
    results?.addEventListener('click', e => {
      const button = e.target.closest('[data-member-id]');
      if (button) this.select(button.dataset.memberId);
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.tree-search-wrap')) this.closeSearch();
    });
    document.getElementById('tree-selection')?.addEventListener('click', e => {
      const relative = e.target.closest('[data-member-id]');
      if (relative) { this.select(relative.dataset.memberId); return; }
      const action = e.target.closest('[data-tree-action]')?.dataset.treeAction;
      if (action === 'clear') { this.clear(); Canvas.el.focus({ preventScroll: true }); }
      if (action === 'back') this.back();
      if (action === 'profile' && Auth.canOpenTreeDrawer() && this.selectedId) Drawer.open(this.selectedId);
    });
    document.getElementById('btn-tree-back')?.addEventListener('click', () => this.back());
    document.getElementById('btn-find-me')?.addEventListener('click', () => {
      const id = Auth.current?.id || Auth.current?.memberId || Store.state.currentUserId;
      if (Store.byId(id)) this.select(id);
    });
  },

  search(query) {
    const results = document.getElementById('tree-search-results');
    const search = document.getElementById('tree-search');
    if (!results || !search) return;
    const q = query.trim().toLocaleLowerCase();
    this.activeResult = -1;
    search.removeAttribute('aria-activedescendant');
    if (!q) { this.closeSearch(); return; }
    this.matches = Store.membersList().filter(m =>
      [m.firstName, m.middleName, m.lastName, m.displayName, m.internationalName].filter(Boolean).join(' ').toLocaleLowerCase().includes(q)
    ).sort((a, b) => displayName(a).localeCompare(displayName(b))).slice(0, 30);
    results.innerHTML = this.matches.length
      ? this.matches.map((m, i) => `<button type="button" role="option" aria-selected="false" tabindex="-1" id="tree-result-${i}" class="tree-search-result" data-member-id="${escape(m.id)}"><strong>${escape(displayName(m))}</strong><span>${escape(m.group || 'Family member')} <span aria-hidden="true">↗</span></span></button>`).join('')
      : '<p class="tree-search-empty" role="status">No family members found. Try a first or last name.</p>';
    results.hidden = false;
    search.setAttribute('aria-expanded', 'true');
  },

  closeSearch() {
    this.matches = [];
    this.activeResult = -1;
    const results = document.getElementById('tree-search-results');
    if (results) results.hidden = true;
    const search = document.getElementById('tree-search');
    search?.setAttribute('aria-expanded', 'false');
    search?.removeAttribute('aria-activedescendant');
  },

  reveal(id) {
    if (computeVisibleIds().has(id)) return;
    // Open only the path to this person, including both sides of a couple.
    const seen = new Set();
    const pending = [id];
    while (pending.length) {
      const next = pending.pop();
      if (seen.has(next)) continue;
      seen.add(next);
      const member = Store.byId(next);
      if (!member) continue;
      member.collapsed = false;
      const spouse = Store.byId(member.spouseId);
      if (spouse) spouse.collapsed = false;
      pending.push(...(member.parentIds || []), ...(member.exSpouseIds || []));
      if (spouse) pending.push(spouse.id);
    }
    TreeFilters.group = '';
    TreeFilters.myFamily = false;
    TreeFilters.syncToolbar();
    autoLayout();
  },

  select(id, { remember = true, center = true } = {}) {
    if (!Store.byId(id)) return;
    if (remember && this.selectedId && this.selectedId !== id) {
      this.history.push({ id: this.selectedId, scale: Canvas.scale, tx: Canvas.tx, ty: Canvas.ty });
      if (this.history.length > 40) this.history.shift();
    }
    this.reveal(id);
    this.selectedId = id;
    Canvas._pinnedId = id;
    this.closeSearch();
    const input = document.getElementById('tree-search');
    if (input) input.value = '';
    Canvas.renderAll();
    if (center) Canvas.focusMember(id);
    Canvas.el.focus({ preventScroll: true });
    if (window.matchMedia('(max-width: 760px)').matches) Canvas.el.scrollIntoView({ block: 'nearest' });
  },

  back() {
    let previous;
    while (this.history.length && !previous) {
      const candidate = this.history.pop();
      if (Store.byId(candidate.id)) previous = candidate;
    }
    if (!previous) { this.render(); return; }
    this.select(previous.id, { remember: false, center: false });
    Canvas.scale = previous.scale;
    Canvas.tx = previous.tx;
    Canvas.ty = previous.ty;
    Canvas.apply();
  },

  clear() {
    this.selectedId = null;
    this.history = [];
    Canvas._pinnedId = null;
    Canvas.spotlight(null);
    this.render();
  },

  render() {
    const all = Store.membersList();
    const count = document.getElementById('tree-member-count');
    const visible = computeVisibleIds();
    if (count) count.textContent = visible.size === all.length
      ? `${all.length} family member${all.length === 1 ? '' : 's'}`
      : `${visible.size} of ${all.length} members shown`;
    const findMe = document.getElementById('btn-find-me');
    if (findMe) {
      findMe.disabled = !Store.byId(Auth.current?.id || Auth.current?.memberId || Store.state.currentUserId);
      findMe.title = findMe.disabled ? 'Link your account to a family member to find yourself' : 'Go to your place in the tree';
    }
    const back = document.getElementById('btn-tree-back');
    if (back) back.disabled = !this.history.length;
    const member = Store.byId(this.selectedId);
    if (this.selectedId && (!member || !visible.has(this.selectedId))) {
      this.selectedId = null;
      Canvas._pinnedId = null;
      Canvas.spotlight(null);
    }
    Canvas.nodes?.querySelectorAll('.node').forEach(node => {
      const selected = node.dataset.id === this.selectedId;
      node.classList.toggle('is-selected', selected);
      if (selected) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    });
    const panel = document.getElementById('tree-selection');
    if (!panel) return;
    panel.hidden = !this.selectedId;
    Canvas.el?.classList.toggle('has-selection', !!this.selectedId);
    if (!this.selectedId) { panel.innerHTML = ''; return; }
    const relatives = ids => [...new Set(ids)].map(id => Store.byId(id)).filter(Boolean);
    const parents = relatives(member.parentIds || []);
    const partners = relatives([member.spouseId].filter(Boolean));
    const former = relatives(member.exSpouseIds || []);
    const children = all.filter(m => (m.parentIds || []).includes(member.id));
    const siblings = all.filter(m => m.id !== member.id && (
      (member.siblingLinkIds || []).includes(m.id) || (m.parentIds || []).some(id => (member.parentIds || []).includes(id))
    ));
    const groups = [['Parents', parents], ['Spouse', partners], ['Children', children], ['Siblings', siblings], ['Past marriage', former]];
    const groupHTML = groups.filter(([, people]) => people.length).map(([label, people]) =>
      `<div class="tree-relative-group"><span class="tree-selection-label">${label} <span>${people.length}</span></span><div class="tree-relative-links">${people.map(m => `<button type="button" class="tree-relative" data-member-id="${escape(m.id)}">${escape(displayName(m))}<span aria-hidden="true">↗</span></button>`).join('')}</div></div>`
    ).join('');
    panel.innerHTML = `<div class="tree-selection-heading"><div><span class="tree-selection-label">Tracing family connections</span><h3 class="tree-selection-name">${escape(displayName(member))}</h3></div><button type="button" class="icon-btn" data-tree-action="clear" aria-label="Clear selection" title="Clear selection (Escape)">×</button></div><div class="tree-relative-groups">${groupHTML || '<p class="tree-relative-empty">No relationships added yet.</p>'}</div><div class="tree-selection-actions">${this.history.length ? '<button type="button" class="btn btn-ghost btn-sm" data-tree-action="back">← Previous person</button>' : ''}${Auth.canOpenTreeDrawer() ? '<button type="button" class="btn btn-secondary btn-sm" data-tree-action="profile">View profile ↗</button>' : ''}</div>`;
  },
};
