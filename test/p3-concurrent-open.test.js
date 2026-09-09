'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const test = require('node:test');

const repo = { rootUri: { fsPath: 'repo' } };
let createCount;

const panel = {
  webview: {
    html: '',
    postMessage: async () => {},
    onDidReceiveMessage: () => {}
  },
  reveal: () => {},
  onDidDispose: callback => { panel.dispose = callback; }
};

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      ViewColumn: { Active: 1 },
      commands: { registerCommand: () => ({}) },
      extensions: {
        getExtension: () => ({
          isActive: true,
          exports: { getAPI: () => ({ repositories: [repo] }) }
        })
      },
      window: {
        createWebviewPanel: () => { createCount += 1; return panel; },
        showErrorMessage: () => {}
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { _test: extensionTest } = require('../extension');
Module._load = originalLoad;

test('concurrent opens create one panel after async checks', async () => {
  createCount = 0;
  const originalExecFile = cp.execFile;
  cp.execFile = (command, args, options, callback) => {
    const delay = args[0] === '--version' ? 20 : 0;
    const output = args[0] === '--version'
      ? 'git version 2.54.0\n'
      : args[0] === 'rev-parse' ? 'head\n'
        : args[0] === 'branch' ? 'main\n' : '';
    setTimeout(() => callback(null, output, ''), delay);
    return { stdin: { end() {} } };
  };

  try {
    await Promise.all([
      extensionTest.openHistoryEditor(),
      extensionTest.openHistoryEditor()
    ]);
  } finally {
    cp.execFile = originalExecFile;
  }

  assert.equal(createCount, 1);
});
