// Playwright screenshot helper for The Family Archive.
//
// Usage:
//   node screenshot.mjs <url> [label]
//
// Saves auto-incremented PNGs to ./temporary screenshots/screenshot-N[-label].png
//
// Optional env vars:
//   SS_EMAIL, SS_PASSWORD  → log in via the login form before screenshotting
//   SS_VIEW                → after login, click the nav tab [data-view="SS_VIEW"]
//   SS_FULL=1              → full-page screenshot (default: viewport only)
//   SS_W, SS_H             → viewport size (default 1440x900)
//   SS_WAIT                → extra ms to wait before shooting (default 600)
import { chromium } from 'playwright';
import { readdir, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const OUT = join(ROOT, 'temporary screenshots');

const url = process.argv[2] || 'http://localhost:3000';
const label = process.argv[3] || '';
const W = Number(process.env.SS_W || 1440);
const H = Number(process.env.SS_H || 900);
const FULL = process.env.SS_FULL === '1';
const WAIT = Number(process.env.SS_WAIT || 600);

async function nextName() {
  await mkdir(OUT, { recursive: true });
  const files = await readdir(OUT);
  let max = 0;
  for (const f of files) {
    const m = f.match(/^screenshot-(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const n = max + 1;
  return join(OUT, `screenshot-${n}${label ? '-' + label : ''}.png`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console error]', m.text()); });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
// Surface CSP violations explicitly (they also log as console errors, but this is unambiguous).
await page.addInitScript(() => {
  document.addEventListener('securitypolicyviolation', (e) => {
    console.error('CSP-VIOLATION ' + e.violatedDirective + ' blocked ' + e.blockedURI);
  });
});

await page.goto(url, { waitUntil: 'networkidle' });

if (process.env.SS_EMAIL && process.env.SS_PASSWORD) {
  try {
    await page.fill('#login-form input[name="email"]', process.env.SS_EMAIL);
    await page.fill('#login-form input[name="password"]', process.env.SS_PASSWORD);
    await page.click('#btn-login-submit');
    await page.waitForSelector('#app-view:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(1200);
  } catch (e) {
    console.log('  [login failed]', e.message);
  }
}

if (process.env.SS_VIEW) {
  try {
    await page.click(`.nav-tab[data-view="${process.env.SS_VIEW}"]`);
    await page.waitForTimeout(900);
  } catch (e) {
    console.log('  [view switch failed]', e.message);
  }
}

await page.waitForTimeout(WAIT);
const out = await nextName();
await page.screenshot({ path: out, fullPage: FULL });
await browser.close();
console.log('saved', out);
