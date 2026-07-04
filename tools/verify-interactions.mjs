// Verify the v4.69 interactive features: tree relationship spotlight +
// collapse, Memories person filter + month headers, Vault reveal/copy.
// Run: node tools/verify-interactions.mjs   (server on :3000)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/status of 400/.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

await page.evaluate(() => {
  const Y = new Date().getFullYear();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const daysOut = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
  const M = {};
  const add = (m) => { M[m.id] = Object.assign({ parentIds: [], exSpouseIds: [] }, m); };
  add({ id: 'gpa', firstName: 'Sang', lastName: 'Chang', gender: 'male', birthday: `${Y-93}-03-14`, spouseId: 'gma' });
  add({ id: 'gma', firstName: 'Kum', lastName: 'Yoo', gender: 'female', birthday: `${Y-61}-07-14`, spouseId: 'gpa' });
  add({ id: 'ted', firstName: 'Ted', lastName: 'Yoo', gender: 'male', birthday: `${Y-38}-09-21`, spouseId: 'sarah', parentIds: ['gpa','gma'] });
  add({ id: 'sarah', firstName: 'Sarah', lastName: 'Yoo', gender: 'female', birthday: `${Y-36}-01-17`, spouseId: 'ted' });
  add({ id: 'esther', firstName: 'Esther', lastName: 'Kim', gender: 'female', birthday: `${Y-41}-11-02`, spouseId: 'max', parentIds: ['gpa','gma'] });
  add({ id: 'max', firstName: 'Maximilian', lastName: 'Kim', gender: 'male', birthday: `${Y-42}-06-30`, spouseId: 'esther' });
  add({ id: 'sophia', firstName: 'Sophia', lastName: 'Yoo', gender: 'female', birthday: `${Y-12}-08-08`, parentIds: ['ted','sarah'] });
  add({ id: 'dylan', firstName: 'Dylan', lastName: 'Yoo', gender: 'male', birthday: `${Y-6}-08-11`, parentIds: ['ted','sarah'] });
  add({ id: 'rambo', firstName: 'Rambo', lastName: 'Kim', gender: 'male', birthday: `${Y-10}-08-06`, parentIds: ['esther','max'] });
  Auth.current = { firstName: 'Ted', lastName: 'Yoo', role: 'admin', memberId: 'ted' };
  Auth.isAdmin = () => true;
  Store.state.members = M;
  Store.state.currentUserId = 'ted';
  Store.state.manualLayout = false;
  Store.state.vault.banks = [{ id: 'b1', bankName: 'Chase', nickname: 'Household checking', accountNumber: '883104821', routingNumber: '122100231', accountType: 'Checking', holderIds: ['ted'], balanceHistory: [], notes: '' }];
  Store.save = () => {};
  Backend.user = { id: 'me', email: 'ted@example.com' };
  Backend.getMediaUrl = async (b, p) => `https://picsum.photos/seed/${encodeURIComponent(p)}/600/600`;
  Backend.saveArchive = async () => {};
  try { Store.healMissingKeys(); } catch (e) {}
  try { MemoriesApi.list = async () => ([
    { id: 'mm1', date: iso(daysOut(-3)), body: 'Bike ride.', tags: ['m:dylan'], photos: [], createdAt: 3, createdBy: 'me', reactions: [], comments: [] },
    { id: 'mm2', date: iso(daysOut(-9)), body: 'Dinner at Grandma\'s.', tags: ['m:gma'], photos: [], createdAt: 2, createdBy: 'me', reactions: [], comments: [] },
    { id: 'mm3', date: iso(daysOut(-45)), body: 'Science fair.', tags: ['m:sophia'], photos: [], createdAt: 1, createdBy: 'me', reactions: [], comments: [] },
  ]); } catch (e) {}
  try { AuthorNames.nameFor = () => 'Ted'; } catch (e) {}
  try { NewsletterView.render = () => {}; } catch (e) {}
  try { toast = () => {}; } catch (e) {}
  autoLayout();
  enterApp();
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = false; });
  Canvas.scale = 0.8; Canvas.tx = 220; Canvas.ty = 90; Canvas.apply();
});

const results = {};

// ---- 1. Tree: spotlight on hover ----
await page.evaluate(async () => { Views.show('tree'); await new Promise(r => setTimeout(r, 700)); });
await page.hover('.node[data-id="ted"]');
await page.waitForTimeout(400);
results.spotlight = await page.evaluate(() => ({
  canvasFlag: document.getElementById('tree-canvas').classList.contains('spotlight-on'),
  hotEdges: document.querySelectorAll('#tree-edges .is-hot').length,
  dimEdges: document.querySelectorAll('#tree-edges .is-dim').length,
  kinCards: [...document.querySelectorAll('.node.is-kin')].map(n => n.dataset.id).sort().join(','),
  backstage: [...document.querySelectorAll('.node.is-backstage')].map(n => n.dataset.id).sort().join(','),
  parentsMarriageHot: !!document.querySelector('#tree-edges .edge.spouse.is-hot[data-m="gpa gma"], #tree-edges .edge.spouse.is-hot[data-m="gma gpa"]'),
}));
await page.screenshot({ path: join(OUT, 'ix-tree-spotlight.png') });
// leave → spotlight clears
await page.mouse.move(1200, 800);
await page.waitForTimeout(350);
results.spotlightClears = await page.evaluate(() =>
  !document.getElementById('tree-canvas').classList.contains('spotlight-on'));

// ---- 2. Tree: collapse Ted's branch ----
results.collapse = await page.evaluate(async () => {
  const before = document.querySelectorAll('.node').length;
  document.querySelector('.node[data-id="ted"] .node-toggle').click();
  await new Promise(r => setTimeout(r, 500));
  const after = document.querySelectorAll('.node').length;
  const badge = document.querySelector('.node[data-id="ted"] .node-toggle-count')?.textContent || '';
  document.querySelector('.node[data-id="ted"] .node-toggle').click();  // re-expand
  await new Promise(r => setTimeout(r, 400));
  const restored = document.querySelectorAll('.node').length;
  return { before, after, badge, restored };
});
await page.screenshot({ path: join(OUT, 'ix-tree-expanded.png') });

// ---- 3. Memories: person filter + month headers ----
await page.evaluate(async () => { Views.show('memories'); await new Promise(r => setTimeout(r, 700)); });
results.memories = await page.evaluate(async () => {
  const chips = [...document.querySelectorAll('.mem-person-chip')].map(c => c.textContent.trim());
  const monthsAll = document.querySelectorAll('.mem-month-head').length;
  const dylanChip = [...document.querySelectorAll('.mem-person-chip')].find(c => c.textContent.includes('Dylan'));
  dylanChip.click();
  await new Promise(r => setTimeout(r, 300));
  const postsFiltered = document.querySelectorAll('.memory-post').length;
  const title = document.getElementById('memories-list-title').textContent;
  return { chips, monthsAll, postsFiltered, title };
});
await page.screenshot({ path: join(OUT, 'ix-memories-filtered.png') });
await page.evaluate(async () => {
  document.querySelector('.mem-person-chip[data-person=""]').click();
  await new Promise(r => setTimeout(r, 250));
});

// ---- 4. Vault: reveal + copy ----
await page.evaluate(async () => {
  Views.show('vault');
  await new Promise(r => setTimeout(r, 600));
  document.querySelector('[data-vault-section="finance"]')?.click();
  await new Promise(r => setTimeout(r, 500));
});
results.vault = await page.evaluate(async () => {
  const widget = document.querySelector('.secret-num');
  if (!widget) return { found: false };
  const masked = widget.querySelector('[data-secret-value]').textContent;
  widget.querySelector('[data-secret-reveal]').click();
  await new Promise(r => setTimeout(r, 120));
  const revealed = widget.querySelector('[data-secret-value]').textContent;
  widget.querySelector('[data-secret-reveal]').click();
  await new Promise(r => setTimeout(r, 120));
  const remasked = widget.querySelector('[data-secret-value]').textContent;
  widget.querySelector('[data-secret-copy]').click();
  await new Promise(r => setTimeout(r, 200));
  let clip = '';
  try { clip = await navigator.clipboard.readText(); } catch (e) { clip = 'ERR ' + e.message; }
  return { found: true, masked, revealed, remasked, clip };
});
await page.evaluate(async () => {
  const w = document.querySelector('.secret-num');
  if (w) { w.querySelector('[data-secret-reveal]').click(); await new Promise(r => setTimeout(r, 100)); }
});
await page.screenshot({ path: join(OUT, 'ix-vault-revealed.png') });

await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
