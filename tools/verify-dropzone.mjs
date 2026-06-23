// Verify v4.62 drag-and-drop upload zone in the album detail.
// Run: node tools/verify-dropzone.mjs  (server on :3000)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

const res = await page.evaluate(async () => {
  Backend.user = { id: 'me' };
  Backend.getMediaUrl = async (b, p) => `https://picsum.photos/seed/${encodeURIComponent(p)}/400/400`;
  AuthorNames.nameFor = () => 'You';
  AlbumsApi.getAlbum = async (id) => ({
    album: { id, title: 'Summer 2025 Trip', description: null, event_date: null, created_by: 'me' },
    photos: [{ id: 'p1', bucket: 'family-photos', path: 'ph1', sort_order: 0 }],
    comments: [],
  });
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-memories');
  document.getElementById('memories-subpanel').hidden = true;
  document.getElementById('albums-subpanel').hidden = false;
  await AlbumsView.openAlbum('a1');
  await new Promise(r => setTimeout(r, 300));

  const dz = document.getElementById('album-dropzone');
  const out = { present: !!dz, hasInput: !!dz?.querySelector('input[type=file]'), text: dz?.querySelector('.album-dropzone-text')?.textContent?.trim() };

  // dragover → highlight, dragleave → clear
  dz.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  out.dragoverHighlights = dz.classList.contains('is-dragover');
  dz.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  out.dragleaveClears = !dz.classList.contains('is-dragover');

  // drop → uploadFiles receives the dropped files (spy)
  let spy = null;
  AlbumsView.uploadFiles = async (fl) => { spy = [...(fl || [])].map(f => f.name); };
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'beach.png', { type: 'image/png' }));
  dt.items.add(new File(['y'], 'cake.jpg', { type: 'image/jpeg' }));
  dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await new Promise(r => setTimeout(r, 100));
  out.dropDelivered = JSON.stringify(spy);

  // leave it in dragover state for the screenshot
  dz.classList.add('is-dragover');
  return out;
});
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT, 'verify-dropzone.png') });
await browser.close();
console.log(JSON.stringify(res, null, 2));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
