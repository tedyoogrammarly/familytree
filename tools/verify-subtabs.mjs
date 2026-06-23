// Verify the consolidated Memories page: one nav tab, Posts | Albums sub-tabs.
// Run: node tools/verify-subtabs.mjs   (server on :3000)
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

const setup = await page.evaluate(async () => {
  Backend.user = { id: 'me', email: 'me@example.com' };
  Backend.getMediaUrl = async (b, p) => `https://picsum.photos/seed/${encodeURIComponent(p)}/600/600`;
  AuthorNames.nameFor = (id) => ({ u1: 'Aunt Jo', me: 'You' }[id] || 'Family member');
  MemoriesApi.list = async () => ([
    { id: 'm1', date: '2026-05-09', body: "Harvey's 1st birthday", tags: [], photos: [{ bucket: 'family-photos', path: 'cake' }],
      createdAt: Date.now(), createdBy: 'me', reactions: [{ emoji: '❤️', userId: 'u1', createdAt: 1 }], comments: [] },
  ]);
  AlbumsApi.listAlbums = async () => ([
    { id: 'a1', title: 'Summer 2025 Trip', description: 'Coast.', event_date: '2025-07-04', created_by: 'u1' },
    { id: 'a2', title: "Grandma's 80th", description: null, event_date: '2025-05-18', created_by: 'me' },
  ]);
  AlbumsView._resolveCovers = async () => {};
  AlbumsView.coverByAlbum = new Map([['a1', { bucket: 'family-photos', path: 'c1' }], ['a2', { bucket: 'family-photos', path: 'c2' }]]);
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-memories');
  // emulate clicking the top nav "Memories" → default sub-tab
  await MemoriesView.showSubtab(MemoriesView.subtab);
  return {
    navHasAlbumsTab: !!document.querySelector('.nav-tab[data-view="albums"]'),
    subtabCount: document.querySelectorAll('[data-mem-subtab]').length,
    postsActive: document.querySelector('[data-mem-subtab="posts"]').classList.contains('is-active'),
    postsPanelVisible: !document.getElementById('memories-subpanel').hidden,
    albumsPanelVisible: !document.getElementById('albums-subpanel').hidden,
    newPostVisible: !document.getElementById('btn-memory-add').hidden,
    newAlbumVisible: !document.getElementById('btn-album-add').hidden,
  };
});
await page.waitForTimeout(700);
await page.screenshot({ path: join(OUT, 'verify-subtab-posts.png') });

// Switch to Albums sub-tab (simulate clicking the sub-tab button).
const afterAlbums = await page.evaluate(async () => {
  document.querySelector('[data-mem-subtab="albums"]').click();
  await new Promise(r => setTimeout(r, 300));
  return {
    albumsActive: document.querySelector('[data-mem-subtab="albums"]').classList.contains('is-active'),
    postsPanelVisible: !document.getElementById('memories-subpanel').hidden,
    albumsPanelVisible: !document.getElementById('albums-subpanel').hidden,
    newPostVisible: !document.getElementById('btn-memory-add').hidden,
    newAlbumVisible: !document.getElementById('btn-album-add').hidden,
    subtitle: document.getElementById('memories-subtitle').textContent.slice(0, 24),
  };
});
await page.waitForTimeout(700);
await page.screenshot({ path: join(OUT, 'verify-subtab-albums.png') });

await browser.close();
console.log('posts view:', JSON.stringify(setup));
console.log('albums view:', JSON.stringify(afterAlbums));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
