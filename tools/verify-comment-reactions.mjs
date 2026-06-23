// Verify v4.65 comment reactions: render chips + react button, toggle wiring.
// Run: node tools/verify-comment-reactions.mjs  (server on :3000)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 800 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

const res = await page.evaluate(async () => {
  Backend.user = { id: 'me' };
  AuthorNames.nameFor = (id) => ({ me: 'Ted', u1: 'Mom', u2: 'Dad' }[id] || 'Family member');
  MemoriesApi.list = async () => ([{
    id: 'm1', date: '2026-05-09', body: 'Beach day!', tags: [], photos: [],
    createdAt: Date.now(), createdBy: 'me', reactions: [],
    comments: [{
      id: 'c1', body: 'So cute!', authorId: 'u1', authorName: 'Mom', createdAt: Date.now() - 5000,
      reactions: [{ emoji: '❤️', userId: 'u2' }, { emoji: '❤️', userId: 'me' }],
    }],
  }]);
  // stub the write so the toggle round-trips without a backend
  let added = null, removed = null;
  MemoriesApi.addCommentReaction = async (cid, e) => { added = [cid, e]; return { ok: true }; };
  MemoriesApi.removeCommentReaction = async (cid, e) => { removed = [cid, e]; return { ok: true }; };
  window.__spy = () => ({ added, removed });

  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-memories');
  await MemoriesView.refresh();

  const out = {};
  out.chipCount = document.querySelectorAll('.memory-creaction-chip').length;
  out.reactBtn = !!document.querySelector('.memory-creaction-more');
  const heartChip = document.querySelector('.memory-creaction-chip[data-creact="❤️"]');
  out.heartCount = heartChip?.querySelector('.memory-creaction-count')?.textContent;
  out.heartTitle = heartChip?.title;            // who reacted
  out.heartIsMine = heartChip?.classList.contains('is-mine');

  // click my ❤️ → should remove (I already reacted), optimistic → chip count 1
  heartChip.click();
  await new Promise(r => setTimeout(r, 60));
  out.afterToggle = window.__spy();
  out.heartCountAfter = document.querySelector('.memory-creaction-chip[data-creact="❤️"]')?.querySelector('.memory-creaction-count')?.textContent;
  return out;
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'verify-comment-reactions.png') });
await browser.close();
console.log(JSON.stringify(res, null, 2));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
