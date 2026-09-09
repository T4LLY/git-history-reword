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
    const child = cp.execFile(
      'git',
      args,
      {
        cwd,
        encoding: null,
        maxBuffer: 8 * 1024 * 1024,
        env: options.env || process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve(stdout);
      }
    );
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

function commitMessage(rawCommit) {
  const separator = rawCommit.indexOf(Buffer.from('\n\n'));
  assert.notEqual(separator, -1);
  return rawCommit.slice(separator + 2);
}

test('rewriteDates preserves invalid UTF-8 commit message bytes', async t => {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-c2-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true }));

  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.name', 'C2 Test']);
  await runGit(repo, ['config', 'user.email', 'c2@example.test']);

  const tree = (await runGit(repo, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: Buffer.alloc(0) }))
    .toString('ascii')
    .trim();
  const originalMessage = Buffer.from([
    0x63, 0x61, 0x66, 0xe9, 0x0a,
    0x0a,
    0x61, 0x63, 0x63, 0x65, 0x6e, 0x74, 0x73, 0x3a, 0x20, 0xe9, 0xe8, 0x0a
  ]);
  const commitHeader = Buffer.from(
    `tree ${tree}\n` +
    'author C2 Test <c2@example.test> 946684800 +0000\n' +
    'committer C2 Test <c2@example.test> 946684800 +0000\n\n'
  );
  const originalHash = (await runGit(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: Buffer.concat([commitHeader, originalMessage])
  })).toString('ascii').trim();
  const branchRef = (await runGit(repo, ['symbolic-ref', '--quiet', 'HEAD'])).toString('ascii').trim();
  await runGit(repo, ['update-ref', branchRef, originalHash]);

  const before = await runGit(repo, ['cat-file', 'commit', originalHash]);
  assert.deepEqual(commitMessage(before), originalMessage);
  const metadata = await extensionTest.getCommitMetadata(repo, 1);
  assert.ok(Buffer.isBuffer(metadata[0].message));
  assert.deepEqual(metadata[0].message, originalMessage);

  // Tell commit-tree which legacy encoding the repository uses so Git itself
  // does not transcode the raw message while rebuilding the commit.
  await runGit(repo, ['config', 'i18n.commitEncoding', 'ISO-8859-1']);
  await extensionTest.rewriteDates(repo, [{
    index: 0,
    time: '2001-02-03T04:05:06+00:00',
    originalTime: '2000-01-01T00:00:00+00:00'
  }]);

  const rewritten = await runGit(repo, ['cat-file', 'commit', 'HEAD']);
  assert.deepEqual(commitMessage(rewritten), originalMessage);
});

test('subject reword preserves the raw tail of a non-UTF-8 commit message', async t => {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-c2-reword-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true }));

  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.name', 'C2 Test']);
  await runGit(repo, ['config', 'user.email', 'c2@example.test']);
  await runGit(repo, ['config', 'i18n.commitEncoding', 'ISO-8859-1']);

  const tree = (await runGit(repo, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: Buffer.alloc(0) }))
    .toString('ascii')
    .trim();
  const originalTail = Buffer.from([
    0x0a, 0x0a, 0x62, 0x6f, 0x64, 0x79, 0x3a, 0x20, 0xe9, 0xe8, 0x0a
  ]);
  const originalMessage = Buffer.concat([Buffer.from('old subject', 'utf8'), originalTail]);
  const commitHeader = Buffer.from(
    `tree ${tree}\n` +
    'author C2 Test <c2@example.test> 946684800 +0000\n' +
    'committer C2 Test <c2@example.test> 946684800 +0000\n\n'
  );
  const originalHash = (await runGit(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    input: Buffer.concat([commitHeader, originalMessage])
  })).toString('ascii').trim();
  const branchRef = (await runGit(repo, ['symbolic-ref', '--quiet', 'HEAD'])).toString('ascii').trim();
  await runGit(repo, ['update-ref', branchRef, originalHash]);

  const { tail } = extensionTest.splitMessage(originalMessage);
  const nextMessage = extensionTest.joinMessage('new subject', tail);
  assert.deepEqual(nextMessage, Buffer.concat([Buffer.from('new subject', 'utf8'), originalTail]));
  await extensionTest.runHistoryReword(repo, 'HEAD', nextMessage);

  const rewritten = await runGit(repo, ['cat-file', 'commit', 'HEAD']);
  assert.deepEqual(commitMessage(rewritten), nextMessage);
});
