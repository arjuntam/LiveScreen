'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { createShutdown } = require('../src/desktop/shutdown.cjs');

test('exit closes windows before waiting on the server and performs cleanup only once', async () => {
  const steps = []; let finish;
  const shutdown = createShutdown({
    onBegin: () => steps.push('begin'), stopActivity: () => steps.push('stop'), closeWindows: () => steps.push('windows'),
    closeServer: () => { steps.push('server'); return new Promise(resolve => { finish = resolve; }); },
    quit: () => steps.push('quit'), forceExit: () => assert.fail('unexpected force exit'), timeoutMs: 60000
  });
  const waiting = shutdown(); await shutdown();
  assert.deepEqual(steps, ['begin', 'stop', 'windows', 'server']); finish(); await waiting;
  assert.deepEqual(steps, ['begin', 'stop', 'windows', 'server', 'quit']);
});
test('cleanup and logging errors cannot prevent application exit', async () => {
  let windows = false, exited = false;
  const shutdown = createShutdown({
    onBegin: () => {}, stopActivity: () => { throw new Error('failed blocker'); }, closeWindows: () => { windows = true; },
    closeServer: async () => { throw new Error('failed close'); }, quit: () => { exited = true; },
    forceExit: () => assert.fail('unexpected force exit'), log: () => { throw new Error('disk full'); }, timeoutMs: 60000
  });
  await shutdown(); assert.equal(windows, true); assert.equal(exited, true);
});
test('hung network shutdown is forcibly bounded after windows are destroyed', async () => {
  let windows = false, forced = 0;
  const shutdown = createShutdown({
    onBegin: () => {}, stopActivity: () => {}, closeWindows: () => { windows = true; },
    closeServer: () => new Promise(() => {}), quit: () => assert.fail('server is still stuck'),
    forceExit: code => { assert.equal(code, 0); forced++; }, timeoutMs: 15
  });
  void shutdown(); await delay(40); assert.equal(windows, true); assert.equal(forced, 1);
});
test('a quit veto cannot leave an invisible application indefinitely', async () => {
  let forced = 0;
  const shutdown = createShutdown({
    onBegin: () => {}, stopActivity: () => {}, closeWindows: () => {}, closeServer: async () => {}, quit: () => {},
    forceExit: () => { forced++; }, timeoutMs: 15
  });
  await shutdown(); await delay(40); assert.equal(forced, 1);
});
