// Verify v4.64 Ship A: Recipes tab gating + post author byline + reactor names.
// Run: node tools/verify-memories-display.mjs  (server on :3000)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

const res = await page.evaluate(async () => {
  Backend.user = { id: 'me' };
  AuthorNames.nameFor = (id) => ({ me: 'Ted', u1: 'Mom', u2: 'Dad' }[id] || 'Family member');
  MemoriesApi.list = async () => ([{
    id: 'm1', date: '2026-05-09', body: "Harvey's 1st birthday", tags: [],
    photos: [], createdAt: Date.now(), createdBy: 'me',
    reactions: [
      { emoji: '❤️', userId: 'u1', createdAt: 1 },
      { emoji: '❤️', userId: 'u2', createdAt: 2 },
      { emoji: '🎉', userId: 'me', createdAt: 3 },
    ],
    comments: [],
  }]);
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-memories');
  await MemoriesView.refresh();

  const out = {};
  out.author = document.querySelector('.memory-author')?.textContent;
  out.whoLine = document.querySelector('.memory-reaction-who')?.textContent?.replace(/\s+/g, ' ').trim();

  // Recipes tab gating: plain user (no is-admin/is-family) → hidden; family → visible.
  const recipesTab = document.querySelector('.nav-tab[data-view="recipes"]');
  document.body.classList.remove('is-admin', 'is-family');
  out.recipesHiddenForUser = getComputedStyle(recipesTab).display === 'none';
  document.body.classList.add('is-family');
  out.recipesVisibleForFamily = getComputedStyle(recipesTab).display !== 'none';
  document.body.classList.remove('is-family');
  document.body.classList.add('is-admin');
  out.recipesVisibleForAdmin = getComputedStyle(recipesTab).display !== 'none';
  document.body.classList.remove('is-admin');
  return out;
});
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'verify-memories-display.png') });
await browser.close();
console.log(JSON.stringify(res, null, 2));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
