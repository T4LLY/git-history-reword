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

function runGit(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.execFile('git', args, {
      cwd,
      encoding: null,
      maxBuffer: 8 * 1024 * 1024,
      env: options.env || process.env
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

function rawCommit(tree) {
  return Buffer.from(
    `tree ${tree}\n` +
    'author C3 Test <c3@example.test> 946684800 +0000\n' +
    'committer C3 Test <c3@example.test> 946684800 +0000\n' +
    'encoding ISO-8859-1\n\n' +
    'legacy message\n'
  );
}

test('rewriteDates rejects an encoding header before changing the branch', async t => {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-c3-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true }));

  await runGit(repo, ['init']);
  const tree = (await runGit(repo, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: Buffer.alloc(0) }))
    .toString('ascii')
    .trim();
  const originalHash = (await runGit(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: rawCommit(tree)
  })).toString('ascii').trim();
  const branchRef = (await runGit(repo, ['symbolic-ref', '--quiet', 'HEAD'])).toString('ascii').trim();
  await runGit(repo, ['update-ref', branchRef, originalHash]);

  await assert.rejects(
    extensionTest.rewriteDates(repo, [{
      index: 0,
      time: '2001-02-03T04:05:06+00:00',
      originalTime: '2000-01-01T00:00:00+00:00'
    }]),
    error => {
      assert.match(error.message, new RegExp(`encoding header on commit ${originalHash}`));
      return true;
    }
  );

  const head = (await runGit(repo, ['rev-parse', 'HEAD'])).toString('ascii').trim();
  assert.equal(head, originalHash);
});
