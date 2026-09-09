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

test('huge change index is rejected before any Git process starts', async () => {
  const head = 'a'.repeat(40);
  const calls = [];
  const originalExecFile = cp.execFile;
  cp.execFile = (command, args, options, callback) => {
    calls.push(args);
    throw new Error('unexpected Git process');
  };
  try {
    await assert.rejects(
      extensionTest.syncChanges({}, 'repo', head, [{ index: 1000000, subject: 'edited', originalSubject: 'old' }]),
      /outside the displayed history range \(0-199\)/
    );
  } finally {
    cp.execFile = originalExecFile;
  }
  assert.equal(calls.length, 0);
});

test('highest displayed index stays bounded at MAX_COMMITS', async () => {
  const head = 'a'.repeat(40);
  const calls = [];
  const originalExecFile = cp.execFile;
  cp.execFile = (command, args, options, callback) => {
    calls.push(args);
    const output = args[0] === 'rev-parse' ? head : `${head}\n`;
    process.nextTick(() => callback(null, output, ''));
    return { stdin: { end() {} } };
  };
  try {
    await assert.rejects(
      extensionTest.syncChanges({}, 'repo', head, [{ index: 199, subject: 'edited', originalSubject: 'old' }]),
      /selected commit is no longer available/
    );
  } finally {
    cp.execFile = originalExecFile;
  }
  assert.ok(calls.some(args => args.includes('--max-count=200')));
});
