import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Emitter } from '../src/emitter.js';

interface Events {
  ping: { n: number };
  pong: { n: number };
}

test('listeners receive what was emitted, and only for their event', () => {
  const emitter = new Emitter<Events>();
  const pings: number[] = [];
  const pongs: number[] = [];
  emitter.on('ping', ({ n }) => pings.push(n));
  emitter.on('pong', ({ n }) => pongs.push(n));

  emitter.emit('ping', { n: 1 });
  emitter.emit('pong', { n: 2 });

  assert.deepEqual(pings, [1]);
  assert.deepEqual(pongs, [2]);
});

test('emitting to nobody is not an error', () => {
  assert.doesNotThrow(() => new Emitter<Events>().emit('ping', { n: 1 }));
});

test('unsubscribing stops delivery', () => {
  const emitter = new Emitter<Events>();
  const seen: number[] = [];
  const off = emitter.on('ping', ({ n }) => seen.push(n));

  emitter.emit('ping', { n: 1 });
  off();
  emitter.emit('ping', { n: 2 });

  assert.deepEqual(seen, [1]);
});

test('once fires exactly once, however many times it is emitted', () => {
  const emitter = new Emitter<Events>();
  const seen: number[] = [];
  emitter.once('ping', ({ n }) => seen.push(n));

  emitter.emit('ping', { n: 1 });
  emitter.emit('ping', { n: 2 });

  assert.deepEqual(seen, [1]);
});

test('a once listener can be cancelled before it fires', () => {
  const emitter = new Emitter<Events>();
  const seen: number[] = [];
  const off = emitter.once('ping', ({ n }) => seen.push(n));
  off();
  emitter.emit('ping', { n: 1 });
  assert.deepEqual(seen, []);
});

test('a listener that unsubscribes mid-emit does not skip its neighbour', () => {
  // The reason emit iterates a copy. Without it, removing from the set while
  // walking it silently drops whoever happened to be next.
  const emitter = new Emitter<Events>();
  const seen: string[] = [];
  const offA = emitter.on('ping', () => {
    seen.push('a');
    offA();
  });
  emitter.on('ping', () => seen.push('b'));

  emitter.emit('ping', { n: 1 });
  assert.deepEqual(seen, ['a', 'b']);
});

test('a listener that throws does not take down playback', () => {
  const emitter = new Emitter<Events>();
  const seen: string[] = [];
  emitter.on('ping', () => {
    throw new Error('a broken subscriber');
  });
  emitter.on('ping', () => seen.push('still ran'));

  assert.doesNotThrow(() => emitter.emit('ping', { n: 1 }));
  assert.deepEqual(seen, ['still ran'], 'one bad listener must not silence the rest');
});

test('removeAll drops every listener on every event', () => {
  const emitter = new Emitter<Events>();
  const seen: string[] = [];
  emitter.on('ping', () => seen.push('ping'));
  emitter.on('pong', () => seen.push('pong'));

  emitter.removeAll();
  emitter.emit('ping', { n: 1 });
  emitter.emit('pong', { n: 2 });

  assert.deepEqual(seen, []);
});

test('the same listener added twice is held once', () => {
  const emitter = new Emitter<Events>();
  let calls = 0;
  const listener = () => { calls++; };
  emitter.on('ping', listener);
  emitter.on('ping', listener);

  emitter.emit('ping', { n: 1 });
  assert.equal(calls, 1);
});
