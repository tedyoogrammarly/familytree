// Dashboard preview harness — renders the admin Dashboard with mock data
// (no Supabase auth needed) and screenshots it. Follows the same pattern as
// tools/verify-subtabs.mjs.
//
// Run: node tools/preview-dashboard.mjs [label]   (server on :3000)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const label = process.argv[2] || 'dash-preview';
const FULL = process.env.SS_FULL === '1';

const browser = await chromium.launch();
const W = Number(process.env.SS_W || 1440);
const H = Number(process.env.SS_H || 1000);
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

await page.evaluate(async () => {
  const Y = new Date().getFullYear();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const daysOut = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
  // Annual date that lands N days from today (for birthdays/anniversaries).
  const annual = (n, birthYear) => {
    const d = daysOut(n);
    return `${birthYear}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  Auth.current = { firstName: 'Ted', lastName: 'Yoo', role: 'admin' };
  Auth.isAdmin = () => true;

  const members = {};
  const add = (m) => { members[m.id] = m; };
  add({ id: 'm1', firstName: 'Kum',        lastName: 'Yoo',     gender: 'female', birthday: annual(11, Y - 61) });
  add({ id: 'm2', firstName: 'Sang',       lastName: 'Chang',   gender: 'male',   birthday: annual(28, Y - 93) });
  add({ id: 'm3', firstName: 'Rambo',      lastName: 'Kang',    gender: 'male',   birthday: annual(34, Y - 10) });
  add({ id: 'm4', firstName: 'Sophia',     lastName: 'Mai',     gender: 'female', birthday: annual(36, Y - 12) });
  add({ id: 'm5', firstName: 'Dylan',      lastName: 'Grisnik', gender: 'male',   birthday: annual(39, Y - 6)  });
  add({ id: 'm6', firstName: 'Maximilian', lastName: 'Yoo',     gender: 'male',   spouseId: 'm7', anniversary: annual(24, Y - 12) });
  add({ id: 'm7', firstName: 'Esther',     lastName: 'Yoo',     gender: 'female', spouseId: 'm6' });

  Store.state.members = members;
  Store.state.events = [
    { id: 'e0', name: 'Pizza & movie night', date: iso(daysOut(0)), location: 'Home', icon: '🍕' },
    { id: 'e1', name: 'Summer BBQ at the lake', date: iso(daysOut(16)), location: 'Lake Mead', icon: '🎉' },
  ];
  Store.state.reminders = [];
  Store.state.gifts = [
    { id: 'g1', direction: 'given', item: 'Lego Millennium Falcon', toMemberId: 'm5', fromMemberIds: [], date: iso(daysOut(39)), amount: 84.99, purchased: true, sent: false },
    { id: 'g2', direction: 'given', item: 'Birthday flowers', toMemberId: 'm1', fromMemberIds: [], date: iso(daysOut(11)), amount: 65, purchased: false, sent: false },
    { id: 'g3', direction: 'received', item: 'Gift card', toMemberId: 'm6', date: iso(daysOut(-2)), amount: 100 },
  ];
  Store.state.grocery = [
    { id: 'gr1', text: 'Hydrocortisone', done: false, ts: Date.now() - 1000 },
    { id: 'gr2', text: 'Strawberries', done: false, ts: Date.now() - 2000 },
    { id: 'gr3', text: 'Rice (20 lb)', done: false, ts: Date.now() - 3000 },
    { id: 'gr4', text: 'Diapers size 4', done: true, ts: Date.now() - 4000 },
  ];
  Store.save = () => {};

  // Weather: pre-warm the cache so no network call happens.
  DashboardView.weatherCache = { days: [0, 1, 2, 3, 4].map((i) => ({
    iso: iso(daysOut(i)), high: [104, 106, 103, 101, 105][i], low: [82, 84, 80, 79, 83][i], code: [0, 1, 0, 2, 0][i],
  })) };
  DashboardView.weatherFetchedAt = Date.now();

  // Family summary digest hits Supabase — skip it in the harness.
  NewsletterView.render = () => {
    const host = document.getElementById('newsletter-preview');
    if (host) host.innerHTML = '<p class="muted small" style="margin:0;">(Family summary renders here — skipped in preview harness.)</p>';
  };

  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.body.classList.add('is-admin');
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-dashboard');
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.toggle('is-active', t.dataset.view === 'dashboard'));
  document.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = false; });
  const chipName = document.getElementById('user-chip-name');
  if (chipName) chipName.textContent = 'Ted Yoo';
  const chipRole = document.getElementById('user-chip-role');
  if (chipRole) chipRole.textContent = 'Admin';

  Views.current = 'dashboard';
  DashboardView.render();
});

await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, `dash-${label}.png`), fullPage: FULL });
await browser.close();
console.log('saved', join(OUT, `dash-${label}.png`));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
