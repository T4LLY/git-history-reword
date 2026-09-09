'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const test = require('node:test');

let configuredPath;
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {
        getConfiguration: () => ({ get: () => configuredPath })
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { _test: extensionTest } = require('../extension');
Module._load = originalLoad;

function mockExecFile(commands) {
  const originalExecFile = cp.execFile;
  cp.execFile = (command, args, options, callback) => {
    commands.push(command);
    process.nextTick(() => callback(null, 'ok', ''));
    return { stdin: { end() {} } };
  };
  return () => { cp.execFile = originalExecFile; };
}

test('git uses configured git.path and falls back to PATH', async () => {
  const commands = [];
  const restore = mockExecFile(commands);
  try {
    configuredPath = 'C:\\Portable Git\\bin\\git.exe';
    await extensionTest.git('repo', ['--version']);
    configuredPath = undefined;
    await extensionTest.git('repo', ['--version']);
  } finally {
    configuredPath = undefined;
    restore();
  }
  assert.deepEqual(commands, ['C:\\Portable Git\\bin\\git.exe', 'git']);
});
