// Verify v4.61 gallery: uniform square-cover grid + "Create album" tile, no hero.
// Run: node tools/verify-gallery-grid.mjs  (server on :3000)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

const res = await page.evaluate(async () => {
  Backend.user = { id: 'me' };
  Backend.getMediaUrl = async (b, p) => `https://picsum.photos/seed/${encodeURIComponent(p)}/600/600`;
  AuthorNames.nameFor = (id) => ({ u1: 'Mom', me: 'You' }[id] || 'Family');
  const albums = [
    { id: 'a1', title: 'Harvey’s 1st Birthday', created_by: 'me' },
    { id: 'a2', title: 'Summer 2025 Trip', created_by: 'u1' },
    { id: 'a3', title: "Grandma's 80th", created_by: 'u1' },
    { id: 'a4', title: 'Everyday Moments', created_by: 'me' },
  ];
  AlbumsApi.listAlbums = async () => albums;
  AlbumsView._resolveCovers = async function () {
    const counts = { a1: 24, a2: 41, a3: 18, a4: 7 };
    for (const a of albums) {
      this.coverByAlbum.set(a.id, { bucket: 'family-photos', path: 'cov-' + a.id });
      this.countByAlbum.set(a.id, counts[a.id]);
    }
  };
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-memories');
  MemoriesView.subtab = 'albums';
  document.getElementById('memories-subpanel').hidden = true;
  document.getElementById('albums-subpanel').hidden = false;
  await AlbumsView.render();
  const card = document.querySelector('.album-card-cover');
  const r = card.getBoundingClientRect();
  return {
    hasHero: !!document.querySelector('.album-hero'),
    createTile: !!document.querySelector('[data-album-create]'),
    albumCards: document.querySelectorAll('.album-card[data-album-open]').length,
    coverIsSquare: Math.abs(r.width - r.height) <= 2,
    firstMeta: document.querySelector('.album-card[data-album-open] .album-card-meta')?.textContent,
  };
});
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, 'verify-gallery-grid.png') });
await browser.close();
console.log(JSON.stringify(res, null, 2));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
