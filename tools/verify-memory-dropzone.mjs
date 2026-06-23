// Verify v4.63 drag-and-drop in the New post (Memories) modal + that the
// album dropzone still works after the shared-class refactor.
// Run: node tools/verify-memory-dropzone.mjs  (server on :3000)
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT = join(fileURLToPath(new URL('../', import.meta.url)), 'temporary screenshots');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

const res = await page.evaluate(async () => {
  Backend.user = { id: 'me' };
  document.getElementById('login-view').hidden = true;
  document.getElementById('app-view').hidden = false;
  MemoryModal.open();   // handlers were bound at app init

  const dz = document.getElementById('memory-dropzone');
  const out = {
    present: !!dz,
    sharedClass: dz?.classList.contains('photo-dropzone'),
    hasInput: !!dz?.querySelector('input[type=file]'),
    text: dz?.querySelector('.photo-dropzone-text')?.textContent?.trim(),
  };
  dz.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  out.dragoverHighlights = dz.classList.contains('is-dragover');
  dz.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
  out.dragleaveClears = !dz.classList.contains('is-dragover');

  let spy = null;
  MemoryModal.uploadFiles = async (fl) => { spy = [...(fl || [])].map(f => f.name); };
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'a.png', { type: 'image/png' }));
  dt.items.add(new File(['y'], 'b.jpg', { type: 'image/jpeg' }));
  dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  await new Promise(r => setTimeout(r, 80));
  out.dropDelivered = JSON.stringify(spy);
  dz.classList.add('is-dragover');   // for the screenshot
  return out;
});
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'verify-memory-dropzone.png') });
await browser.close();
console.log(JSON.stringify(res, null, 2));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'No console/page errors.');
