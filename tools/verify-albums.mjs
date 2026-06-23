// One-off local visual check for the Albums tab. Injects mock data so the
// gallery + detail render with the real CSS (no Supabase login needed).
// Run: node tools/verify-albums.mjs   (server must be on :3000)
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

// Inject mocks + force the albums view to render the gallery.
await page.evaluate(() => {
  Backend.user = { id: 'me', email: 'me@example.com' };
  Backend.getMediaUrl = async (bucket, path) => `https://picsum.photos/seed/${encodeURIComponent(path)}/800/600`;
  AuthorNames.nameFor = (id) => ({ u1: 'Mom', u2: 'Dad', me: 'You' }[id] || 'Family member');
  const albums = [
    { id: 'a1', title: 'Summer 2025 Trip', description: 'Two weeks on the coast.', event_date: '2025-07-04', created_by: 'u1' },
    { id: 'a2', title: "Grandma's 80th", description: null, event_date: '2025-05-18', created_by: 'u2' },
    { id: 'a3', title: 'Christmas Morning', description: null, event_date: '2025-12-25', created_by: 'me' },
    { id: 'a4', title: 'Everyday Moments', description: null, event_date: null, created_by: 'u1' },
  ];
  AlbumsApi.listAlbums = async () => albums;
  AlbumsView.coverByAlbum = new Map(albums.map(a => [a.id, { bucket: 'family-photos', path: 'cover-' + a.id }]));
  AlbumsView._resolveCovers = async () => {}; // covers pre-seeded above
  document.getElementById('login-view').hidden = true;     // reveal the app shell
  document.getElementById('app-view').hidden = false;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-albums');
  return AlbumsView.render();
});
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, 'verify-albums-gallery.png') });

// Open an album detail with mock photos + comments.
await page.evaluate(() => {
  AlbumsApi.getAlbum = async (id) => ({
    album: { id, title: 'Summer 2025 Trip', description: 'Two weeks on the coast.', event_date: '2025-07-04', created_by: 'me' },
    photos: ['p1','p2','p3','p4','p5'].map((p, i) => ({ id: p, bucket: 'family-photos', path: 'photo-' + i, sort_order: i })),
    comments: [
      { id: 'c1', photo_id: null, author: 'u2', body: 'Such a great trip!', created_at: new Date(Date.now() - 3600e3).toISOString() },
      { id: 'c2', photo_id: null, author: 'u1', body: 'The sunsets 😍', created_at: new Date(Date.now() - 600e3).toISOString() },
    ],
  });
  return AlbumsView.openAlbum('a1');
});
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, 'verify-albums-detail.png'), fullPage: true });

// Graceful degradation: empty state when there are no albums.
await page.evaluate(() => { AlbumsApi.listAlbums = async () => []; return AlbumsView.render(); });
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'verify-albums-empty.png') });

await browser.close();
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
console.log('saved verify-albums-gallery.png, verify-albums-detail.png, verify-albums-empty.png');
