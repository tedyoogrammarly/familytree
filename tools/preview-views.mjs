// Multi-view preview harness — renders any app view with a rich mock
// archive (no Supabase auth) and screenshots it. Companion to
// tools/preview-dashboard.mjs; same pattern as tools/verify-subtabs.mjs.
//
// Run: node tools/preview-views.mjs [view ...]        (server on :3000)
//      default: all views. Screenshots → temporary screenshots/view-<name>.png
// Env: SS_W / SS_H viewport, SS_FULL=1 full-page, SS_TAG=suffix
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const ALL = ['calendar', 'tree', 'myfamily', 'memories', 'mykids', 'recipes', 'events', 'gifts', 'admin', 'vault', 'history', 'timecapsule', 'stories'];
const views = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const W = Number(process.env.SS_W || 1440);
const H = Number(process.env.SS_H || 1000);
const FULL = process.env.SS_FULL === '1';
const TAG = process.env.SS_TAG ? '-' + process.env.SS_TAG : '';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

await page.evaluate(() => {
  const Y = new Date().getFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const daysOut = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
  const annual = (n, year) => { const d = daysOut(n); return `${year}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const pic = (seed, w = 400, h = 400) => `https://picsum.photos/seed/${seed}/${w}/${h}`;

  Auth.current = { firstName: 'Ted', lastName: 'Yoo', role: 'admin', memberId: 'ted' };
  Auth.isAdmin = () => true;

  // ---- Three-generation family ----
  const M = {};
  const add = (m) => { M[m.id] = Object.assign({ parentIds: [], exSpouseIds: [] }, m); };
  add({ id: 'gpa',  firstName: 'Sang',   lastName: 'Chang', gender: 'male',   birthday: `${Y - 93}-03-14`, spouseId: 'gma', anniversary: `${Y - 64}-05-02` });
  add({ id: 'gma',  firstName: 'Kum',    lastName: 'Yoo',   gender: 'female', birthday: annual(11, Y - 61), spouseId: 'gpa' });
  add({ id: 'ted',  firstName: 'Ted',    lastName: 'Yoo',   gender: 'male',   birthday: `${Y - 38}-09-21`, spouseId: 'sarah', anniversary: annual(24, Y - 12), parentIds: ['gpa', 'gma'] });
  add({ id: 'sarah', firstName: 'Sarah', lastName: 'Yoo',   gender: 'female', birthday: `${Y - 36}-01-17`, spouseId: 'ted' });
  add({ id: 'esther', firstName: 'Esther', lastName: 'Kim', gender: 'female', birthday: `${Y - 41}-11-02`, spouseId: 'max', parentIds: ['gpa', 'gma'] });
  add({ id: 'max',  firstName: 'Maximilian', lastName: 'Kim', gender: 'male', birthday: `${Y - 42}-06-30`, spouseId: 'esther' });
  add({ id: 'sophia', firstName: 'Sophia', lastName: 'Yoo', gender: 'female', birthday: annual(36, Y - 12), parentIds: ['ted', 'sarah'] });
  add({ id: 'dylan',  firstName: 'Dylan',  lastName: 'Yoo', gender: 'male',   birthday: annual(39, Y - 6),  parentIds: ['ted', 'sarah'] });
  add({ id: 'rambo',  firstName: 'Rambo',  lastName: 'Kim', gender: 'male',   birthday: annual(34, Y - 10), parentIds: ['esther', 'max'] });

  Store.state.members = M;
  Store.state.currentUserId = 'ted';
  Store.state.manualLayout = false;
  try { autoLayout(); } catch (e) {}
  try { Canvas.scale = 0.9; Canvas.tx = 160; Canvas.ty = 80; Canvas.apply(); } catch (e) {}

  Store.state.events = [
    { id: 'e0', name: 'Pizza & movie night', date: iso(daysOut(0)), location: 'Home', icon: '🍕', attendeeIds: ['ted', 'sarah', 'sophia', 'dylan'] },
    { id: 'e1', name: 'Summer BBQ at the lake', date: iso(daysOut(16)), location: 'Lake Mead', icon: '🎉', attendeeIds: ['ted', 'sarah', 'gpa', 'gma'] },
    { id: 'e2', name: "Sophia's recital", date: iso(daysOut(-12)), location: 'Smith Center', icon: '🎻', attendeeIds: ['ted', 'sarah', 'sophia'] },
  ];
  Store.state.gifts = [
    { id: 'g1', direction: 'given', item: 'Lego Millennium Falcon', toMemberId: 'dylan', fromMemberIds: ['ted', 'sarah'], date: iso(daysOut(39)), amount: 84.99, purchased: true, sent: false, occasion: 'Birthday' },
    { id: 'g2', direction: 'given', item: 'Birthday flowers', toMemberId: 'gma', fromMemberIds: ['ted'], date: iso(daysOut(11)), amount: 65, purchased: false, sent: false, occasion: 'Birthday' },
    { id: 'g3', direction: 'received', item: 'Gift card', toMemberId: 'ted', fromText: 'The Kims', date: iso(daysOut(-2)), amount: 100, occasion: 'Housewarming' },
    { id: 'g4', direction: 'received', item: 'Hand-knit blanket', toMemberId: 'sophia', fromMemberIds: ['gma'], date: iso(daysOut(-30)), amount: 0, occasion: 'Just because' },
  ];
  Store.state.reminders = [
    { id: 'r1', title: 'Water the garden', icon: '🪴', startDate: iso(daysOut(1)), recurrence: 'weekly', color: 'teal' },
  ];
  Store.state.grocery = [
    { id: 'gr1', text: 'Hydrocortisone', done: false, ts: Date.now() - 1000 },
    { id: 'gr2', text: 'Strawberries', done: false, ts: Date.now() - 2000 },
    { id: 'gr3', text: 'Diapers size 4', done: true, ts: Date.now() - 4000 },
  ];
  Store.state.recipes = [
    { id: 'rc1', name: 'Grandma Kum\'s Kimchi Jjigae', category: 'Soups', fromRef: 'm:gma', fromText: '', serves: '4', time: '45 min',
      ingredients: '1 lb pork shoulder\n2 cups aged kimchi\n1 block tofu\n4 cups anchovy stock', steps: 'Sear the pork.\nAdd kimchi and stock.\nSimmer 30 minutes.\nAdd tofu at the end.', photo: { bucket: 'family-photos', path: 'jjigae' }, favorite: true },
    { id: 'rc2', name: 'Saturday Pancakes', category: 'Breakfast', fromRef: 'm:ted', fromText: '', serves: '6', time: '20 min',
      ingredients: '2 cups flour\n2 eggs\n1.5 cups milk\n2 tbsp sugar', steps: 'Whisk dry.\nWhisk wet.\nCombine, rest 5 min, griddle.', photo: { bucket: 'family-photos', path: 'pancakes' }, favorite: false },
    { id: 'rc3', name: 'LA Galbi', category: 'Mains', fromRef: 'm:gpa', fromText: '', serves: '8', time: '2 hr + marinade',
      ingredients: '3 lb flanken short ribs\n1 cup soy\n1 Asian pear, grated\n1/2 cup brown sugar', steps: 'Blend marinade.\nMarinate overnight.\nGrill hot and fast.', photo: null, favorite: true },
  ];
  Store.state.myKidsRoster = ['sophia', 'dylan'];
  Store.state.myKids = {
    sophia: { milestones: [{ id: 'k1', date: `${Y - 1}-06-01`, title: 'First violin solo', body: 'Nailed it.', photos: [] }], school: [], art: [], letters: [] },
    dylan: { milestones: [{ id: 'k2', date: `${Y}-02-10`, title: 'Lost first tooth', body: '', photos: [] }], school: [], art: [], letters: [] },
  };
  Store.state.vault = Object.assign(Store.state.vault || {}, {
    banks: [{ id: 'b1', bankName: 'Chase', nickname: 'Household checking', accountNumber: '••••4821', routingNumber: '•••••••31', accountType: 'Checking', holderIds: ['ted', 'sarah'], balanceHistory: [], notes: '' }],
    utilities: [{ id: 'u1', emoji: '⚡', name: 'NV Energy', website: 'nvenergy.com', phone: '702-402-5555', accountNumber: '••••9917', notes: '' }],
    insurances: [], hoas: [], codeSets: [], neighbors: [],
  });
  Store.state.timeCapsules = [
    { id: 'tc1', toRef: 'm:sophia', title: 'For your 18th birthday', body: 'Sealed letter…', unlockDate: `${Y + 6}-07-01`, createdAt: Date.now(), createdBy: 'ted' },
  ];
  Store.state.stories = [];
  Store.save = () => {};

  // ---- Supabase-backed surfaces → stubbed ----
  Backend.user = { id: 'me', email: 'ted@example.com' };
  Backend.getMediaUrl = async (b, p) => `https://picsum.photos/seed/${encodeURIComponent(p)}/600/600`;
  Backend.saveArchive = async () => {};
  try { AuthorNames.nameFor = (id) => 'Ted'; } catch (e) {}
  try { MemoriesApi.list = async () => ([
    { id: 'mm1', date: iso(daysOut(-3)), body: "Dylan's first bike ride without training wheels — straight down the cul-de-sac.", tags: ['m:dylan'], photos: [{ bucket: 'family-photos', path: 'bike' }], createdAt: Date.now(), createdBy: 'me', reactions: [{ emoji: '❤️', userId: 'u1', createdAt: 1 }], comments: [] },
    { id: 'mm2', date: iso(daysOut(-9)), body: 'Sunday dinner at Grandma\'s. Kimchi jjigae, as always.', tags: ['m:gma'], photos: [{ bucket: 'family-photos', path: 'dinner' }, { bucket: 'family-photos', path: 'table' }], createdAt: Date.now() - 86400000, createdBy: 'me', reactions: [], comments: [] },
  ]); } catch (e) {}
  try {
    AlbumsApi.listAlbums = async () => ([
      { id: 'a1', title: 'Summer 2025 Trip', description: 'Coast drive.', event_date: `${Y - 1}-07-04`, created_by: 'me' },
      { id: 'a2', title: "Grandma's 80th", description: null, event_date: `${Y - 1}-05-18`, created_by: 'me' },
    ]);
    AlbumsView._resolveCovers = async () => {};
    AlbumsView.coverByAlbum = new Map([['a1', { bucket: 'family-photos', path: 'c1' }], ['a2', { bucket: 'family-photos', path: 'c2' }]]);
  } catch (e) {}
  try { NewsletterView.render = () => {}; } catch (e) {}

  try { toast = () => {}; } catch (e) {}
  try { enterApp(); } catch (e) { console.log('enterApp failed: ' + e.message); }
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.body.classList.add('is-admin');
  document.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = false; });
  const chipName = document.getElementById('user-chip-name');
  if (chipName) chipName.textContent = 'Ted Yoo';
  const chipRole = document.getElementById('user-chip-role');
  if (chipRole) chipRole.textContent = 'Admin';
  try { Canvas.scale = 0.9; Canvas.tx = 200; Canvas.ty = 90; Canvas.apply(); } catch (e) {}
});

for (const v of views) {
  const res = await page.evaluate(async (name) => {
    try { Views.show(name); await new Promise(r => setTimeout(r, 600)); return 'ok'; }
    catch (e) { return 'ERR: ' + e.message; }
  }, v);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `view-${v}${TAG}.png`), fullPage: FULL });
  console.log(`view-${v}${TAG}.png`, res);
}

await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.slice(0, 12).join('\n') : 'No console/page errors.');
