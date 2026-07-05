// Stress-test My Family connector routing with the messy real-world shape:
// divorced bio parents, a step-parent, and half-siblings (multiple kid
// groups → multiple trunk lanes). Mirrors the Suejin case.
// Run: node tools/verify-myfamily-lanes.mjs   (server on :3000)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' && !/status of 400/.test(m.text())) errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

await page.evaluate(() => {
  const Y = new Date().getFullYear();
  const M = {};
  const add = (m) => { M[m.id] = Object.assign({ parentIds: [], exSpouseIds: [] }, m); };
  // Suejin-style shape: mom (divorced from dad), dad (remarried… twice-ish),
  // stepmom, half-siblings from different parent pairs, cousins via groups.
  add({ id: 'mom',   firstName: 'Jongmi', lastName: 'Choi',  gender: 'female', exSpouseIds: ['dad'] });
  add({ id: 'dad',   firstName: 'Tony',   lastName: 'Chang', gender: 'male',   birthday: `${Y-71}-02-02`, spouseId: 'step', exSpouseIds: ['mom'], group: 'Chang Family' });
  add({ id: 'step',  firstName: 'Sunyi',  lastName: 'Chang', gender: 'female', birthday: `${Y-64}-03-03`, spouseId: 'dad' });
  add({ id: 'mimi',  firstName: 'Mimi',   lastName: 'Morse', gender: 'female', exSpouseIds: ['dad'] });
  add({ id: 'sue',   firstName: 'Suejin', lastName: 'Bowyer', gender: 'female', birthday: `${Y-47}-04-04`, spouseId: 'ben', parentIds: ['mom','dad'] });
  add({ id: 'ben',   firstName: 'Benjamin', lastName: 'Bowyer', gender: 'male', birthday: `${Y-45}-05-05`, spouseId: 'sue' });
  add({ id: 'jinny', firstName: 'Jinny',  lastName: 'Tomozy', gender: 'female', birthday: `${Y-49}-06-06`, parentIds: ['mom','dad'] });
  add({ id: 'heather', firstName: 'Heather', lastName: 'Morse Grisnik', gender: 'female', birthday: `${Y-42}-07-07`, parentIds: ['dad','mimi'] });
  add({ id: 'jewelia', firstName: 'Jewelia', lastName: 'Chang', gender: 'female', parentIds: ['mimi'] });
  add({ id: 'mav',   firstName: 'Maverick', lastName: 'Bowyer', gender: 'male', birthday: `${Y-13}-08-08`, parentIds: ['sue','ben'] });
  add({ id: 'zelda', firstName: 'Zelda',  lastName: 'Bowyer', gender: 'female', birthday: `${Y-11}-09-09`, parentIds: ['sue','ben'] });
  Auth.current = { firstName: 'Ted', lastName: 'Yoo', role: 'admin', memberId: 'sue' };
  Auth.isAdmin = () => true;
  Store.state.members = M;
  Store.state.currentUserId = 'sue';
  Store.save = () => {};
  Backend.user = { id: 'me', email: 'ted@example.com' };
  Backend.saveArchive = async () => {};
  try { Store.healMissingKeys(); } catch (e) {}
  try { NewsletterView.render = () => {}; } catch (e) {}
  try { toast = () => {}; } catch (e) {}
  autoLayout();
  enterApp();
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.querySelectorAll('[data-admin-only]').forEach(el => { el.hidden = false; });
});

await page.evaluate(async () => {
  Views.show('myfamily');
  await new Promise(r => setTimeout(r, 500));
  const picker = document.getElementById('myfamily-picker');
  if (picker) { picker.value = 'sue'; picker.dispatchEvent(new Event('change', { bubbles: true })); }
  await new Promise(r => setTimeout(r, 600));
});

// Geometry audit: no horizontal connector may pass through a card's box.
const audit = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('#myfamily-nodes .node')].map(n => {
    const t = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(n.style.transform) || [];
    return { id: n.dataset.id, x: +t[1], y: +t[2], w: n.offsetWidth, h: n.offsetHeight };
  });
  const paths = [...document.querySelectorAll('#myfamily-edges .myfamily-edge-lines path')].map(p => p.getAttribute('d'));
  const overlaps = [];
  paths.forEach(d => {
    // Only audit pure horizontal segments: "M x y H x2"
    const m = /^M ([-\d.]+) ([-\d.]+) H ([-\d.]+)$/.exec(d);
    if (!m) return;
    const [x1, y, x2] = [+m[1], +m[2], +m[3]];
    const lo = Math.min(x1, x2), hi = Math.max(x1, x2);
    nodes.forEach(n => {
      // Strictly inside the card box (2px tolerance), overlapping horizontally.
      if (y > n.y + 2 && y < n.y + n.h - 2 && hi > n.x + 2 && lo < n.x + n.w - 2) {
        // Horizontal heart-lines BETWEEN two cards legitimately sit at card
        // mid-height; only flag if the segment enters this card's x-range
        // beyond its edge (i.e. actually crosses the card, not just abuts).
        const enters = lo < n.x + n.w - 6 && hi > n.x + 6;
        if (enters) overlaps.push({ d, card: n.id });
      }
    });
  });
  return { cards: nodes.length, hSegments: paths.filter(d => /H/.test(d)).length, overlaps };
});
await page.screenshot({ path: join(OUT, 'ix-myfamily-lanes.png'), fullPage: true });
await browser.close();
console.log(JSON.stringify(audit, null, 1));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
