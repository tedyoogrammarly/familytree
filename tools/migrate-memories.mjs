// Pure transform: one blob memory object -> { memory, reactions, comments }
// rows ready to insert into the memories/* tables. No I/O here, so it is
// unit-testable and reusable by the one-time seed script (seed-memories.mjs).
//
// Blob shape (from app.js MemoryModal.save):
//   { id, date, body, photos:[{bucket,path}], tags:[…], createdAt, createdBy,
//     reactions:[{emoji,userId,createdAt}], comments:[{id,body,authorId,authorName,createdAt}] }
export function blobMemoryToRows(m, fallbackAuthor) {
  const author = m.createdBy || fallbackAuthor || null;
  const memory = {
    legacy_id: m.id,                                  // not a column — strip before insert; used to attach children
    author,
    date: m.date,
    body: m.body || null,
    tags: Array.isArray(m.tags) ? m.tags : [],
    photos: Array.isArray(m.photos) ? m.photos.map(p => ({ bucket: p.bucket, path: p.path })) : [],
    created_at: new Date(m.createdAt || Date.now()).toISOString(),
  };
  const seen = new Set();
  const reactions = [];
  for (const r of (m.reactions || [])) {
    if (!r || !r.emoji || !r.userId) continue;        // user_id is NOT NULL in the table
    const key = `${r.userId}|${r.emoji}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reactions.push({ user_id: r.userId, emoji: r.emoji, created_at: new Date(r.createdAt || Date.now()).toISOString() });
  }
  const comments = (m.comments || [])
    .filter(c => c && c.body && c.authorId)            // author is NOT NULL in the table
    .map(c => ({ author: c.authorId, body: c.body, created_at: new Date(c.createdAt || Date.now()).toISOString() }));
  return { memory, reactions, comments };
}
