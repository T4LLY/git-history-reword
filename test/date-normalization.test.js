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

test('rewriteDates can normalize Committer Date to Author Date without changing the selected time', async t => {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-normalize-date-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true }));

  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.name', 'Date Test']);
  await runGit(repo, ['config', 'user.email', 'date@example.test']);
  await fs.promises.writeFile(path.join(repo, 'file.txt'), 'content\n');
  await runGit(repo, ['add', 'file.txt']);

  const authorDate = '2026-09-01T10:00:00+09:00';
  const committerDate = '2026-09-02T11:00:00+09:00';
  await runGit(repo, ['commit', '-m', 'mismatched dates'], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_DATE: committerDate
    }
  });

  const before = await extensionTest.loadHistory(repo);
  assert.equal(before.commits[0].authorDate, authorDate);
  assert.equal(before.commits[0].committerDate, committerDate);

  await extensionTest.rewriteDates(repo, [{
    index: 0,
    time: authorDate,
    originalTime: authorDate,
    normalizeDates: true
  }]);

  const after = await extensionTest.loadHistory(repo);
  assert.equal(after.commits[0].authorDate, authorDate);
  assert.equal(after.commits[0].committerDate, authorDate);
});


test('sync accepts a normalization-only edit and rewrites both dates to Author Date', async t => {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-sync-normalize-date-'));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true }));

  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.name', 'Date Test']);
  await runGit(repo, ['config', 'user.email', 'date@example.test']);
  await fs.promises.writeFile(path.join(repo, 'file.txt'), 'content\n');
  await runGit(repo, ['add', 'file.txt']);

  const authorDate = '2026-09-01T10:00:00+09:00';
  const committerDate = '2026-09-02T11:00:00+09:00';
  await runGit(repo, ['commit', '-m', 'mismatched dates'], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_DATE: committerDate
    }
  });

  const before = await extensionTest.loadHistory(repo);
  const messages = [];
  const panel = { webview: { postMessage: async message => messages.push(message) } };
  await extensionTest.syncChanges(panel, repo, before.head, [{
    index: 0,
    originalSubject: before.commits[0].subject,
    originalTime: authorDate,
    time: authorDate,
    normalizeDates: true
  }]);

  const after = await extensionTest.loadHistory(repo);
  assert.equal(after.commits[0].authorDate, authorDate);
  assert.equal(after.commits[0].committerDate, authorDate);
  assert.match(messages.at(-1).message, /Synced 1 commit/);
});

test('webview exposes warning styling and Restore action for mismatched dates', () => {
  const html = extensionTest.getWebviewHtml({ cspSource: 'vscode-resource:' });
  assert.match(html, /date-mismatch/);
  assert.match(html, /editorWarning-foreground/);
  assert.match(html, /Set Committer Date to Author Date/);
  assert.match(html, />Restore<\/button>/);
  assert.match(html, /normalizeDates: true/);
});
