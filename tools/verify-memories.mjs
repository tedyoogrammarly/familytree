// One-off local check for the open Memories feed (table-backed). Injects mock
// data so the feed renders without a Supabase login. Verifies: feed renders
// from MemoriesApi, "+ New post" is visible to all, the viewer's OWN post shows
// Edit/Delete while someone else's does not, reactions/comments are open.
// Run: node tools/verify-memories.mjs   (server on :3000)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

const flags = await page.evaluate(async () => {
  Backend.user = { id: 'me', email: 'me@example.com' };
  Backend.getMediaUrl = async (b, p) => `https://picsum.photos/seed/${encodeURIComponent(p)}/600/600`;
  AuthorNames.nameFor = (id) => ({ u1: 'Aunt Jo', me: 'You' }[id] || 'Family member');
  // Mock the table-backed list: one post by me, one by someone else.
  MemoriesApi.list = async () => ([
    { id: 'm-mine', date: '2025-08-01', body: 'Beach day with the cousins!', tags: [], photos: [{ bucket: 'family-photos', path: 'beach' }],
      createdAt: Date.now(), createdBy: 'me',
      reactions: [{ emoji: '❤️', userId: 'u1', createdAt: 1 }],
      comments: [{ id: 'c1', body: 'Wish we were there!', authorId: 'u1', authorName: 'Aunt Jo', createdAt: Date.now() - 5000 }] },
    { id: 'm-theirs', date: '2025-07-15', body: "Grandpa's garden is thriving.", tags: [], photos: [],
      createdAt: Date.now(), createdBy: 'u1', reactions: [], comments: [] },
  ]);
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-memories');
  // also clear the global [data-admin-only] hide by simulating a signed-in non-admin:
  document.body.classList.remove('is-admin', 'is-family');
  await MemoriesView.refresh();
  // Collect assertion signals from the rendered DOM.
  const posts = [...document.querySelectorAll('.memory-post')];
  const mine = posts.find(p => p.dataset.id === 'm-mine');
  const theirs = posts.find(p => p.dataset.id === 'm-theirs');
  return {
    newPostBtnVisible: !!document.getElementById('btn-memory-add') && getComputedStyle(document.getElementById('btn-memory-add')).display !== 'none',
    postCount: posts.length,
    mineHasEdit: !!mine?.querySelector('[data-mem-edit]'),
    theirsHasEdit: !!theirs?.querySelector('[data-mem-edit]'),
    mineHasComposer: !!mine?.querySelector('.memory-comment-add'),
    theirsHasReactPicks: !!theirs?.querySelector('.memory-react-pick'),
  };
});
await page.waitForTimeout(800);
await page.screenshot({ path: join(OUT, 'verify-memories-feed.png'), fullPage: true });
await browser.close();
console.log('flags:', JSON.stringify(flags, null, 2));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
