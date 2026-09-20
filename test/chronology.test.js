'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { findChronologyConflicts } = require('../chronology');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return { commands: { executeCommand: async () => {} } };
  return originalLoad.call(this, request, parent, isMain);
};
const { _test: extensionTest } = require('../extension');
Module._load = originalLoad;

function runGit(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.execFile('git', args, {
      cwd,
      encoding: 'utf8',
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

async function createChronologyRepo(t) {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-chronology-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true }));
  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.name', 'Chronology Test']);
  await runGit(repo, ['config', 'user.email', 'chronology@example.test']);

  await fs.promises.writeFile(path.join(repo, 'file.txt'), 'parent\n');
  await runGit(repo, ['add', 'file.txt']);
  await runGit(repo, ['commit', '-m', 'parent'], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-09-18T21:29:27+09:00',
      GIT_COMMITTER_DATE: '2026-09-18T21:29:27+09:00'
    }
  });

  await fs.promises.writeFile(path.join(repo, 'file.txt'), 'child\n');
  await runGit(repo, ['add', 'file.txt']);
  await runGit(repo, ['commit', '-m', 'child'], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-09-18T17:15:32+09:00',
      GIT_COMMITTER_DATE: '2026-09-18T17:15:32+09:00'
    }
  });
  return repo;
}

test('chronology detects a child Author Date earlier than its parent and allows equality', () => {
  const commits = [
    { hash: 'a'.repeat(40), authorDate: '2026-09-18T17:15:32+09:00' },
    { hash: 'b'.repeat(40), authorDate: '2026-09-18T21:29:27+09:00' }
  ];
  const conflicts = findChronologyConflicts(commits);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].childIndex, 0);
  assert.equal(conflicts[0].parentIndex, 1);

  commits[0].authorDate = commits[1].authorDate;
  assert.equal(findChronologyConflicts(commits).length, 0);
});

test('staged date edits are used when validating chronology', () => {
  const commits = [
    { hash: 'a'.repeat(40), authorDate: '2026-09-18T17:15:32+09:00' },
    { hash: 'b'.repeat(40), authorDate: '2026-09-18T21:29:27+09:00' }
  ];
  const conflicts = findChronologyConflicts(commits, [{
    index: 0,
    time: '2026-09-18T22:00:00+09:00'
  }]);
  assert.equal(conflicts.length, 0);
});

test('chronology checks the displayed boundary against commit 200', () => {
  const commits = Array.from({ length: 201 }, (_, index) => ({
    hash: index.toString(16).padStart(40, '0'),
    authorDate: '2026-09-18T12:00:00+09:00'
  }));
  commits[199].authorDate = '2026-09-18T10:00:00+09:00';
  commits[200].authorDate = '2026-09-18T11:00:00+09:00';

  const conflicts = findChronologyConflicts(commits, [], 200);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].childIndex, 199);
  assert.equal(conflicts[0].parentIndex, 200);
});

test('loadHistory exposes each displayed commit parent Author Date', async t => {
  const repo = await createChronologyRepo(t);
  const model = await extensionTest.loadHistory(repo);
  assert.equal(model.commits.length, 2);
  assert.equal(model.commits[0].parentAuthorDate, model.commits[1].authorDate);
  assert.equal(model.commits[1].parentAuthorDate, null);
});

test('sync fails closed before rewriting when chronology is contradictory', async t => {
  const repo = await createChronologyRepo(t);
  const model = await extensionTest.loadHistory(repo);
  const panel = { webview: { postMessage: async () => {} } };

  await assert.rejects(
    extensionTest.syncChanges(panel, repo, model.head, [{
      index: 0,
      originalSubject: 'child',
      subject: 'changed child',
      originalTime: model.commits[0].authorDate
    }]),
    /earlier than its parent/
  );

  assert.equal((await runGit(repo, ['rev-parse', 'HEAD'])).trim(), model.head);
  assert.equal((await runGit(repo, ['show', '-s', '--format=%s', 'HEAD'])).trim(), 'child');
});

test('webview marks chronology conflicts red and blocks Sync until resolved', () => {
  const html = extensionTest.getWebviewHtml({ cspSource: 'vscode-resource:' });
  assert.match(html, /\.row\.chronology-error \.time \.time-input/);
  assert.match(html, /editorError-foreground/);
  assert.match(html, /parentAuthorDate/);
  assert.match(html, /chronologyConflictCount > 0/);
  assert.match(html, /fix the red timestamps before Sync/);
});
