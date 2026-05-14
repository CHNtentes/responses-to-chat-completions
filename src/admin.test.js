import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createLogBus } from './admin.js';

describe('LogBus', () => {
  it('does not write to console directly', () => {
    const bus = createLogBus();
    const writes = [];
    const fakeConsole = { log: (...args) => writes.push(args.join(' ')) };
    bus.setConsole(fakeConsole);
    bus.publish('info', { event: 'test' });
    // LogBus no longer writes to console directly — the caller handles that
    assert.strictEqual(writes.length, 0);
    bus.destroy();
  });

  it('sends log entries to SSE listeners', () => {
    const bus = createLogBus();
    const writes = [];
    const fakeSse = { write: (chunk) => writes.push(chunk.toString()), on: () => {} };
    bus.addListener(fakeSse);
    bus.publish('warn', { event: 'hello' });
    const dataLines = writes.filter(w => w.startsWith('data:'));
    assert.strictEqual(dataLines.length, 1);
    assert.ok(dataLines[0].includes('hello'));
    bus.destroy();
  });

  it('replays history to new listeners', () => {
    const bus = createLogBus();
    bus.publish('info', { event: 'old' });
    const writes = [];
    const fakeSse = { write: (chunk) => writes.push(chunk.toString()), on: () => {} };
    bus.addListener(fakeSse);
    const dataLines = writes.filter(w => w.startsWith('data:'));
    assert.ok(dataLines.some(w => w.includes('old')));
    bus.destroy();
  });

  it('stops sending after listener is removed', () => {
    const bus = createLogBus();
    const writes = [];
    const fakeSse = { write: (chunk) => writes.push(chunk.toString()), on: () => {} };
    bus.addListener(fakeSse);
    bus.removeListener(fakeSse);
    writes.length = 0;
    bus.publish('info', { event: 'after' });
    const dataLines = writes.filter(w => w.startsWith('data:'));
    assert.strictEqual(dataLines.length, 0);
    bus.destroy();
  });

  it('limits history to max entries', () => {
    const bus = createLogBus();
    for (let i = 0; i < 250; i++) {
      bus.publish('info', { event: 'e' + i });
    }
    const writes = [];
    const fakeSse = { write: (chunk) => writes.push(chunk.toString()), on: () => {} };
    bus.addListener(fakeSse);
    const dataLines = writes.filter(w => w.startsWith('data:'));
    assert.strictEqual(dataLines.length, 200);
    bus.destroy();
  });
});
