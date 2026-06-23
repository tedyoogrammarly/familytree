// One-time, NON-DESTRUCTIVE migration: copy the existing memories out of the
// archive blob (archive.state.memories) into the dedicated memories/* tables.
// The blob array is left untouched — retire it later (deploy runbook D6) only
// after verifying the feed.
//
// Uses the SERVICE-ROLE key (bypasses RLS) so original authorship of posts,
// reactions, and comments by *different* family members is preserved — an
// admin login could not insert rows attributed to other users under the new
// "author = auth.uid()" policies. The service-role key must NEVER ship to the
// browser; it is read from an env var here and used locally only.
//
//   DRY run (no writes — read, transform, report counts):
//     DRY=1 SUPABASE_SERVICE_ROLE_KEY=… node tools/seed-memories.mjs
//   Real run:
//     SUPABASE_SERVICE_ROLE_KEY=… [ADMIN_UUID=…] node tools/seed-memories.mjs
//
// ADMIN_UUID (optional) is the fallback author for any legacy post missing a
// createdBy (older posts pre-dating that field).
import { readFile } from 'node:fs/promises';
import { blobMemoryToRows } from './migrate-memories.mjs';

const DRY = process.env.DRY === '1';
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_UUID = process.env.ADMIN_UUID || null;
if (!SERVICE) { console.error('Set SUPABASE_SERVICE_ROLE_KEY (Supabase → Settings → API → service_role).'); process.exit(1); }

// URL from the committed public config.
const cfg = await readFile(new URL('../config.js', import.meta.url), 'utf8');
const URL_ = cfg.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
const hdr = { apikey: SERVICE, Authorization: 'Bearer ' + SERVICE, 'Content-Type': 'application/json' };

async function rest(path, opts = {}) {
  const res = await fetch(URL_ + path, { ...opts, headers: { ...hdr, ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

// 1) Read the blob memories.
const rows = await rest('/rest/v1/archive?id=eq.1&select=state');
const state = rows[0]?.state;
if (!state) { console.error('No archive row.'); process.exit(1); }
const blobMemories = Array.isArray(state.memories) ? state.memories : [];
console.log(`Found ${blobMemories.length} memories in the blob.`);

// 2) Transform + report.
let plannedM = 0, plannedR = 0, plannedC = 0;
const work = blobMemories.map(bm => {
  const t = blobMemoryToRows(bm, ADMIN_UUID);
  plannedM++; plannedR += t.reactions.length; plannedC += t.comments.length;
  if (!t.memory.author) console.warn(`  ⚠️  memory ${bm.id} has no author and no ADMIN_UUID fallback — insert will fail (author NOT NULL).`);
  return t;
});
console.log(`Planned inserts: ${plannedM} memories, ${plannedR} reactions, ${plannedC} comments.`);

if (DRY) {
  console.log('DRY run — no writes. Sample:', JSON.stringify(work[0], null, 2));
  process.exit(0);
}

// 3) Insert. memory first (capture id), then its reactions + comments.
let m = 0, r = 0, c = 0;
for (const t of work) {
  const { legacy_id, ...memoryRow } = t.memory;       // legacy_id is not a column
  try {
    const inserted = await rest('/rest/v1/memories?select=id', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(memoryRow),
    });
    const id = inserted[0].id; m++;
    if (t.reactions.length) {
      await rest('/rest/v1/memory_reactions', { method: 'POST', body: JSON.stringify(t.reactions.map(x => ({ ...x, memory_id: id }))) });
      r += t.reactions.length;
    }
    if (t.comments.length) {
      await rest('/rest/v1/memory_comments', { method: 'POST', body: JSON.stringify(t.comments.map(x => ({ ...x, memory_id: id }))) });
      c += t.comments.length;
    }
  } catch (e) { console.warn(`  insert failed for legacy ${legacy_id}:`, e.message); }
}
console.log(`Inserted ${m} memories, ${r} reactions, ${c} comments. Blob left untouched.`);
console.log('Verify the feed, then run deploy runbook D6 to retire the blob memories array.');
