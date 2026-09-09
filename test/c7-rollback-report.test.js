'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const test = require('node:test');

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return { commands: { executeCommand: async () => {} } };
  return originalLoad.call(this, request, parent, isMain);
};
const { _test: extensionTest } = require('../extension');
Module._load = originalLoad;

const currentHead = 'a'.repeat(40);
const panel = { webview: { postMessage: async () => {} } };

function mockGit(rollbackFails, calls) {
  const originalExecFile = cp.execFile;
  cp.execFile = (command, args, options, callback) => {
    calls.push(args);
    let output = '';
    let error;
    if (args[0] === 'rev-parse') {
      output = currentHead;
    } else if (args[0] === 'rev-list') {
      output = `${currentHead}\n`;
    } else if (args[0] === 'symbolic-ref') {
      output = 'refs/heads/main';
    } else if (args[0] === 'cat-file') {
      output = Buffer.from('tree 0000000000000000000000000000000000000000\n\nold subject\n\nbody\n');
    } else if (args.includes('history')) {
      error = new Error('history reword failed');
      error.stderr = 'original failure';
    } else if (args[0] === 'update-ref' && args[1] === '-m' && rollbackFails) {
      error = new Error('rollback update-ref failed');
      error.stderr = 'rollback failure';
    }
    process.nextTick(() => callback(error, output, error ? error.stderr : ''));
    return { stdin: { end() {} } };
  };
  return () => { cp.execFile = originalExecFile; };
}

function sync() {
  return extensionTest.syncChanges(panel, 'repo', currentHead, [{
    index: 0,
    subject: 'new subject',
    originalSubject: 'old subject'
  }]);
}

test('sync reports rollback success and failure distinctly', async t => {
  await t.test('reports rollback after a successful rollback', async () => {
    const calls = [];
    const restore = mockGit(false, calls);
    try {
      await assert.rejects(sync(), /original failure \(Sync rolled back to aaaaaaaa\.\)/);
    } finally {
      restore();
    }
    assert.equal(calls.filter(args => args[0] === 'update-ref' && args[1] === '-m').length, 1);
  });

  await t.test('reports backup when rollback fails', async () => {
    const calls = [];
    const restore = mockGit(true, calls);
    let failure;
    try {
      await assert.rejects(sync(), error => {
        failure = error;
        assert.match(error.message, /original failure \(Sync rollback failed\. Restore the pre-sync state from backup /);
        assert.match(error.message, /Rollback error: rollback failure/);
        return true;
      });
    } finally {
      restore();
    }
    const backupRef = calls.find(args => args[0] === 'update-ref' && args.length === 3)[1];
    assert.ok(failure.message.includes(`backup ${backupRef}`));
  });
});
