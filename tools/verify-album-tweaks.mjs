// Verify v4.60 album tweaks: smaller hero, "set as cover" + cover badge,
// and the upload progress bar. Run: node tools/verify-album-tweaks.mjs (server :3000)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

await page.evaluate(async () => {
  Backend.user = { id: 'me' };
  Backend.getMediaUrl = async (b, p) => `https://picsum.photos/seed/${encodeURIComponent(p)}/800/600`;
  AuthorNames.nameFor = () => 'You';
  AlbumsApi.listAlbums = async () => ([{ id: 'a1', title: 'Summer 2025 Trip', description: 'Coast.', event_date: '2025-07-04', created_by: 'me', cover_photo_id: 'p3' }]);
  AlbumsView._resolveCovers = async () => {};
  AlbumsView.coverByAlbum = new Map([['a1', { bucket: 'family-photos', path: 'p3' }]]);
  AlbumsApi.getAlbum = async (id) => ({
    album: { id, title: 'Summer 2025 Trip', description: 'Coast.', event_date: '2025-07-04', created_by: 'me', cover_photo_id: 'p3' },
    photos: ['p1','p2','p3','p4','p5'].map((p, i) => ({ id: p, bucket: 'family-photos', path: 'ph' + i, sort_order: i })),
    comments: [],
  });
  AlbumsApi.updateAlbum = async () => ({ ok: true });
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-memories');
  await MemoriesView.showSubtab('albums');
});
await page.waitForTimeout(700);
const heroH = await page.evaluate(() => Math.round(document.querySelector('.album-hero').getBoundingClientRect().height));
await page.screenshot({ path: join(OUT, 'verify-tweak-gallery.png') });

// open the album detail
const detail = await page.evaluate(async () => {
  await AlbumsView.openAlbum('a1');
  await new Promise(r => setTimeout(r, 400));
  return {
    coverBadges: document.querySelectorAll('.album-photo-coverbadge').length,
    setCoverBtns: document.querySelectorAll('[data-set-cover]').length,
    coverOnP3: document.querySelector('[data-photo-id="p3"]').classList.contains('is-cover'),
  };
});
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'verify-tweak-detail.png'), fullPage: true });

// click "set as cover" on p1 → badge should move to p1
const afterSet = await page.evaluate(async () => {
  document.querySelector('[data-set-cover="p1"]').click();
  await new Promise(r => setTimeout(r, 400));
  return {
    coverOnP1: document.querySelector('[data-photo-id="p1"]').classList.contains('is-cover'),
    coverOnP3: document.querySelector('[data-photo-id="p3"]').classList.contains('is-cover'),
  };
});

// show the upload progress bar mid-upload
await page.evaluate(() => AlbumsView._setUploadProgress(2, 5));
await page.waitForTimeout(300);
const prog = await page.evaluate(() => {
  const p = document.getElementById('album-upload-progress');
  return { visible: !p.hidden, width: p.querySelector('.aup-fill').style.width, label: p.querySelector('.aup-label').textContent };
});
await page.screenshot({ path: join(OUT, 'verify-tweak-progress.png') });

await browser.close();
console.log('hero height px:', heroH, '(expect <= ~300)');
console.log('detail:', JSON.stringify(detail));
console.log('after set-cover p1:', JSON.stringify(afterSet));
console.log('progress bar:', JSON.stringify(prog));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
