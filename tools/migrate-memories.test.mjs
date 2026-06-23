import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobMemoryToRows } from './migrate-memories.mjs';

test('maps core fields + photos/tags to a memory row', () => {
  const { memory } = blobMemoryToRows({
    id: 'mem_1', date: '2025-06-01', body: 'Hi', tags: ['m:abc'],
    photos: [{ bucket: 'family-photos', path: 'memories/x.jpg' }],
    createdAt: 1730000000000, createdBy: 'user-uuid-1',
  }, 'admin-uuid');
  assert.equal(memory.date, '2025-06-01');
  assert.equal(memory.author, 'user-uuid-1');           // prefer original createdBy
  assert.equal(memory.body, 'Hi');
  assert.deepEqual(memory.tags, ['m:abc']);
  assert.equal(memory.photos[0].path, 'memories/x.jpg');
  assert.equal(new Date(memory.created_at).getTime(), 1730000000000);
});

test('falls back to fallbackAuthor when createdBy missing', () => {
  const { memory } = blobMemoryToRows({ id: 'm', date: '2025-01-01' }, 'admin-uuid');
  assert.equal(memory.author, 'admin-uuid');
});

test('dedupes reactions by (user,emoji) and maps comments', () => {
  const { reactions, comments } = blobMemoryToRows({
    id: 'm', date: '2025-01-01',
    reactions: [
      { emoji: '❤️', userId: 'u1', createdAt: 1 },
      { emoji: '❤️', userId: 'u1', createdAt: 2 },   // dup → collapsed
      { emoji: '🎉', userId: 'u2', createdAt: 3 },
    ],
    comments: [{ id: 'c1', body: 'nice', authorId: 'u2', createdAt: 5 }],
  }, 'admin-uuid');
  assert.equal(reactions.length, 2);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, 'nice');
  assert.equal(comments[0].author, 'u2');
});

test('skips reactions/comments with no user/author (cannot satisfy NOT NULL author)', () => {
  const { reactions, comments } = blobMemoryToRows({
    id: 'm', date: '2025-01-01',
    reactions: [{ emoji: '👍', userId: null }],
    comments: [{ id: 'c', body: 'x', authorId: null }],
  }, null);
  assert.equal(reactions.length, 0);
  assert.equal(comments.length, 0);
});

test('carries legacy_id so the seeder can attach children, and normalizes missing arrays', () => {
  const { memory, reactions, comments } = blobMemoryToRows({ id: 'mem_42', date: '2025-02-02' }, 'admin');
  assert.equal(memory.legacy_id, 'mem_42');
  assert.deepEqual(memory.tags, []);
  assert.deepEqual(memory.photos, []);
  assert.deepEqual(reactions, []);
  assert.deepEqual(comments, []);
});
