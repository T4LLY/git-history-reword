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

function commitMessage(rawCommit) {
  const separator = rawCommit.indexOf(Buffer.from('\n\n'));
  assert.notEqual(separator, -1);
  return rawCommit.slice(separator + 2);
}

test('subject reword preserves comment-like body lines', async t => {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-c1-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true }));

  await runGit(repo, ['init']);
  const tree = (await runGit(repo, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: Buffer.alloc(0) }))
    .toString('ascii')
    .trim();
  const originalTail = Buffer.from('\n\n# ticket 123\n? question\n; note\n\\ slash\n\x01 control\nbody\n', 'utf8');
  const originalMessage = Buffer.concat([Buffer.from('old subject', 'utf8'), originalTail]);
  const rawCommit = Buffer.from(
    `tree ${tree}\n` +
    'author C1 Test <c1@example.test> 946684800 +0000\n' +
    'committer C1 Test <c1@example.test> 946684800 +0000\n\n'
  );
  const originalHash = (await runGit(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: Buffer.concat([rawCommit, originalMessage])
  })).toString('ascii').trim();
  const branchRef = (await runGit(repo, ['symbolic-ref', '--quiet', 'HEAD'])).toString('ascii').trim();
  await runGit(repo, ['update-ref', branchRef, originalHash]);

  const nextMessage = Buffer.concat([Buffer.from('new subject', 'utf8'), originalTail]);
  await extensionTest.runHistoryReword(repo, 'HEAD', nextMessage);

  const rewritten = await runGit(repo, ['cat-file', 'commit', 'HEAD']);
  assert.deepEqual(commitMessage(rewritten), nextMessage);
});
