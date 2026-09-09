'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const test = require('node:test');

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { _test: extensionTest } = require('../extension');
Module._load = originalLoad;

function mockGit(outputs, calls) {
  const originalExecFile = cp.execFile;
  cp.execFile = (command, args, options, callback) => {
    calls.push(args);
    const key = args[0] === 'rev-list' ? 'rev-list' : args[0] === 'show' ? 'show' : 'cat-file';
    const output = outputs[key];
    process.nextTick(() => callback(null, output, ''));
    return { stdin: { end() {} } };
  };
  return () => { cp.execFile = originalExecFile; };
}

test('linearity assertion batches parent inspection without metadata or messages', async t => {
  const hashes = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)];
  await t.test('linear history passes with one batched command', async () => {
    const calls = [];
    const restore = mockGit({
      'rev-list': `${hashes[0]}\n${hashes[1]} ${hashes[0]}\n${hashes[2]} ${hashes[1]}\n`
    }, calls);
    try {
      await extensionTest.assertLinearAffectedHistory('repo', [{ index: 2 }]);
    } finally {
      restore();
    }
    assert.deepEqual(calls, [[
      'rev-list', '--first-parent', '--parents', '--max-count=3', 'HEAD'
    ]]);
  });

  await t.test('merge within the affected range rejects', async () => {
    const calls = [];
    const restore = mockGit({
      'rev-list': `${hashes[0]}\n${hashes[1]} ${hashes[0]}\n${hashes[2]} ${hashes[1]} ${hashes[0]}\n`
    }, calls);
    try {
      await assert.rejects(
        extensionTest.assertLinearAffectedHistory('repo', [{ index: 2 }]),
        /Merge commit ccccccc is inside the affected history/
      );
    } finally {
      restore();
    }
    assert.deepEqual(calls, [[
      'rev-list', '--first-parent', '--parents', '--max-count=3', 'HEAD'
    ]]);
  });
});
