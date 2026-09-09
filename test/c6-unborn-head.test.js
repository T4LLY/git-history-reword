'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { _test: extensionTest } = require('../extension');
Module._load = originalLoad;

function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    cp.execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

test('loadHistory returns the empty history model for an unborn HEAD', async t => {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-c6-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await runGit(repo, ['init']);

  const model = await extensionTest.loadHistory(repo);
  assert.equal(model.head, '');
  assert.equal(model.commits.length, 0);
  assert.equal(model.repoName, path.basename(repo));
});

test('loadHistory still reports unrelated Git errors', async t => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-c6-not-repo-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  await assert.rejects(
    extensionTest.loadHistory(directory),
    error => {
      assert.match(error.stderr, /not a git repository/i);
      return true;
    }
  );
});
