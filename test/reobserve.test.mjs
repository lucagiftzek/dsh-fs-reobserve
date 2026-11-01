// Unit tests for dsh-fs-reobserve on a mock plugin context (no DSH needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { apply, name, inject } from '../lib/index.js';

function mockCtx(statImpl) {
  const handlers = new Map();
  const emitted = [];
  const logs = [];
  const ctx = {
    logger: { info: (...a) => logs.push(a), debug() {}, warn() {} },
    on(ev, fn) { handlers.set(ev, fn); },
    emit(ev, ...args) { emitted.push([ev, ...args]); },
    fs: { stat: statImpl }
  };
  return { ctx, handlers, emitted, logs };
}

const session = {};
const actor = { agent: { session } };
const target = (p) => ({ targetKey: 'k:' + p, displayPath: p });

test('default export is an object with name, apply and inject', () => {
  assert.equal(typeof plugin, 'object');
  assert.equal(plugin.apply, apply);
  assert.equal(name, 'fs-reobserve');
  assert.deepEqual(inject, ['fs']);
});

test('own bash rewrite refreshes the observation and attaches a notice', async () => {
  const { ctx, handlers, emitted } = mockCtx(async () => ({ type: 'file', version: 'v2' }));
  apply(ctx, {});
  handlers.get('fs/observed')(target('/w/a.txt'), { kind: 'present', version: 'v1' }, actor);
  const out = await handlers.get('tools/post-execute')({ name: 'bash', agent: { session } }, {}, async () => ({ ok: true }));
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0][2], { kind: 'present', version: 'v2' });
  assert.equal(out.ok, true);
  assert.equal(out.additionalContexts.length, 1);
  assert.match(out.additionalContexts[0].content[0].text, /rewrote 1: \/w\/a\.txt/);
  assert.equal(out.additionalContexts[0].source.kind, 'plugin:fs-reobserve');
});

test('delete and create transitions are covered', async () => {
  const state = { '/w/gone': undefined, '/w/new': { type: 'file', version: 'n1' } };
  const { ctx, handlers, emitted } = mockCtx(async (t) => state[t.displayPath]);
  apply(ctx, { notify: false });
  handlers.get('fs/observed')(target('/w/gone'), { kind: 'present', version: 'g1' }, actor);
  handlers.get('fs/observed')(target('/w/new'), { kind: 'absent' }, actor);
  const out = await handlers.get('tools/post-execute')({ name: 'shell', agent: { session } }, {}, async () => ({ ok: 1 }));
  assert.deepEqual(emitted.map((e) => e[2].kind).sort(), ['absent', 'present']);
  assert.equal(out.additionalContexts, undefined, 'notify=false attaches nothing');
});

test('other tools and unchanged files are ignored', async () => {
  const { ctx, handlers, emitted } = mockCtx(async () => ({ type: 'file', version: 'v1' }));
  apply(ctx, {});
  handlers.get('fs/observed')(target('/w/a'), { kind: 'present', version: 'v1' }, actor);
  await handlers.get('tools/post-execute')({ name: 'read', agent: { session } }, {}, async () => ({}));
  await handlers.get('tools/post-execute')({ name: 'bash', agent: { session } }, {}, async () => ({}));
  assert.equal(emitted.length, 0);
});

test('a different session never gets refreshed by this one', async () => {
  const { ctx, handlers, emitted } = mockCtx(async () => ({ type: 'file', version: 'v9' }));
  apply(ctx, {});
  handlers.get('fs/observed')(target('/w/a'), { kind: 'present', version: 'v1' }, actor);
  await handlers.get('tools/post-execute')({ name: 'bash', agent: { session: {} } }, {}, async () => ({}));
  assert.equal(emitted.length, 0);
});
