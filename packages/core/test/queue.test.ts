import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Queue } from '../src/queue.js';
import type { QueueItem } from '../src/types/index.js';

function item(id: string, title = id): QueueItem {
  return { id, status: 'ready', ref: { title }, addedAt: 0 };
}

test('inserts at the end by default and bumps version', () => {
  const queue = new Queue();
  assert.equal(queue.version, 0);
  queue.insert(item('a'));
  queue.insert(item('b'));
  assert.deepEqual(queue.list().map((i) => i.id), ['a', 'b']);
  assert.equal(queue.version, 2);
});

test('positions are anchored to ids, not indexes', () => {
  const queue = new Queue();
  queue.insert(item('a'));
  queue.insert(item('b'));
  queue.insert(item('c'));

  queue.insert(item('x'), { after: 'a' });
  assert.deepEqual(queue.list().map((i) => i.id), ['a', 'x', 'b', 'c']);

  queue.insert(item('y'), { before: 'c' });
  assert.deepEqual(queue.list().map((i) => i.id), ['a', 'x', 'b', 'y', 'c']);
});

test('`next` inserts after the cursor', () => {
  const queue = new Queue();
  queue.insert(item('a'));
  queue.insert(item('b'));
  queue.cursorId = 'a';
  queue.insert(item('urgent'), { next: true });
  assert.deepEqual(queue.list().map((i) => i.id), ['a', 'urgent', 'b']);
});

test('moving resolves the anchor after removal, so a move to the end lands at the end', () => {
  const queue = new Queue();
  queue.insert(item('a'));
  queue.insert(item('b'));
  queue.insert(item('c'));
  queue.move('a', { after: 'c' });
  assert.deepEqual(queue.list().map((i) => i.id), ['b', 'c', 'a']);
});

test('moving to a stale anchor throws instead of silently landing somewhere', () => {
  const queue = new Queue();
  queue.insert(item('a'));
  assert.throws(() => queue.move('a', { after: 'gone' }), /not found/);
});

test('nextPlayable skips entries that already played or failed', () => {
  const queue = new Queue();
  queue.insert({ ...item('a'), status: 'ended' });
  queue.insert({ ...item('b'), status: 'failed' });
  queue.insert(item('c'));
  assert.equal(queue.nextPlayable(null)?.id, 'c');
});

test('clear keeps the active entry by default', () => {
  const queue = new Queue();
  queue.insert(item('a'));
  queue.insert(item('b'));
  queue.cursorId = 'a';
  queue.clear();
  assert.deepEqual(queue.list().map((i) => i.id), ['a']);
  queue.clear({ keepActive: false });
  assert.equal(queue.length, 0);
});

test('list returns copies, so callers cannot mutate queue state by accident', () => {
  const queue = new Queue();
  queue.insert(item('a'));
  const copy = queue.list();
  copy[0]!.ref.title = 'tampered';
  assert.equal(queue.require('a').ref.title, 'a');
});

test('duplicatesOf matches on identity, not on id', () => {
  const queue = new Queue();
  const a = queue.insert({
    id: 'a',
    status: 'ready',
    ref: { title: 'Nights', artist: 'Frank Ocean' },
    addedAt: 0,
  });
  queue.insert({
    id: 'b',
    status: 'ready',
    ref: { title: 'nights (Remastered 2016)', artist: 'Frank Ocean feat. Someone' },
    addedAt: 0,
  });
  assert.deepEqual(queue.duplicatesOf(a).map((i) => i.id), ['b']);
});
