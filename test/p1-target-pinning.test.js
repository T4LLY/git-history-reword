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
  if (request === 'vscode') return { commands: { executeCommand: async () => {} } };
  return originalLoad.call(this, request, parent, isMain);
};
const { _test: extensionTest } = require('../extension');
Module._load = originalLoad;

const head = 'a'.repeat(40);
const middle = 'b'.repeat(40);
const oldest = 'c'.repeat(40);
const panel = { webview: { postMessage: async () => {} } };

function runGit(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = cp.execFile('git', args, { cwd, encoding: null }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function mockGit(config, calls) {
  const originalExecFile = cp.execFile;
  let revParses = 0;
  cp.execFile = (command, args, execOptions, callback) => {
    calls.push(args);
    let output = '';
    let error;
    if (args[0] === 'rev-parse') {
      revParses += 1;
      if (revParses <= 3) {
        output = config.driftAtInitial && revParses === 2 ? 'd'.repeat(40) : head;
      } else {
        output = config.driftAfterFirst && revParses === 5 ? 'd'.repeat(40) : 'e'.repeat(40);
      }
    } else if (args[0] === 'rev-list') {
      output = `${head}\n${middle} ${head}\n${oldest} ${middle}\n`;
    } else if (args[0] === 'symbolic-ref') {
      output = 'refs/heads/main';
    } else if (args[0] === 'branch') {
      output = 'main';
    } else if (args[0] === 'cat-file') {
      output = Buffer.from('tree 0000000000000000000000000000000000000000\n\nold subject\n\nbody\n');
    } else if (args[0] === 'log') {
      output = '';
    }
    process.nextTick(() => callback(error, output, error ? error.stderr : ''));
    return { stdin: { end() {} } };
  };
  return () => { cp.execFile = originalExecFile; };
}

test('sync pins original targets and detects a changed HEAD', async t => {
  await t.test('linear history uses original target hashes', async () => {
    const calls = [];
    const restore = mockGit({}, calls);
    try {
      await extensionTest.syncChanges(panel, 'repo', head, [
        { index: 2, subject: 'oldest edited', originalSubject: 'old subject' },
        { index: 0, subject: 'newest edited', originalSubject: 'old subject' }
      ]);
    } finally {
      restore();
    }
    assert.deepEqual(
      calls.filter(args => args[0] === 'cat-file').map(args => args[2]),
      [oldest, head]
    );
    const historyCalls = calls.filter(args => args.includes('history'));
    assert.equal(historyCalls.length, 2);
    assert.ok(historyCalls[0].includes('HEAD~2'));
    assert.ok(historyCalls[1].includes('HEAD'));
  });

  await t.test('intervening HEAD change aborts before the next rewrite', async () => {
    const calls = [];
    const restore = mockGit({ driftAfterFirst: true }, calls);
    try {
      await assert.rejects(
        extensionTest.syncChanges(panel, 'repo', head, [
          { index: 2, subject: 'oldest edited', originalSubject: 'old subject' },
          { index: 0, subject: 'newest edited', originalSubject: 'old subject' }
        ]),
        /Git history changed during Sync/
      );
    } finally {
      restore();
    }
    assert.equal(calls.filter(args => args.includes('history')).length, 1);
    assert.equal(calls.some(args => args[0] === 'update-ref' && args[1] === '-m'), true);
  });
});

test('linear subject rewrites remain functional with pinned targets', async t => {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-p1-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await runGit(repo, ['init']);

  const tree = (await runGit(repo, ['hash-object', '-t', 'tree', '-w', '--stdin'], Buffer.alloc(0))).toString('ascii').trim();
  const hashes = [];
  let parent = '';
  for (const subject of ['oldest subject', 'middle subject', 'newest subject']) {
    const rawCommit = Buffer.from(
      `tree ${tree}\n` +
      (parent ? `parent ${parent}\n` : '') +
      'author P1 Test <p1@example.test> 946684800 +0000\n' +
      'committer P1 Test <p1@example.test> 946684800 +0000\n\n' +
      `${subject}\n`
    );
    parent = (await runGit(repo, ['hash-object', '-t', 'commit', '-w', '--stdin'], rawCommit)).toString('ascii').trim();
    hashes.push(parent);
  }
  const branchRef = (await runGit(repo, ['symbolic-ref', '--quiet', 'HEAD'])).toString('ascii').trim();
  await runGit(repo, ['update-ref', branchRef, hashes[2]]);

  await extensionTest.syncChanges(panel, repo, hashes[2], [
    { index: 2, subject: 'oldest rewritten', originalSubject: 'oldest subject' },
    { index: 0, subject: 'newest rewritten', originalSubject: 'newest subject' }
  ]);

  const subjects = (await runGit(repo, ['log', '--format=%s', '--first-parent'])).toString('utf8').trim().split(/\r?\n/);
  assert.deepEqual(subjects, ['newest rewritten', 'middle subject', 'oldest rewritten']);
});
