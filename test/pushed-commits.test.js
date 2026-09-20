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

async function commitFile(repo, subject, content) {
  await fs.promises.writeFile(path.join(repo, 'file.txt'), content, 'utf8');
  await runGit(repo, ['add', 'file.txt']);
  await runGit(repo, ['commit', '-m', subject]);
}

async function createRepo(t, prefix) {
  const repo = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.promises.rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await runGit(repo, ['init']);
  await runGit(repo, ['config', 'user.name', 'Push Test']);
  await runGit(repo, ['config', 'user.email', 'push@example.test']);
  return repo;
}

test('loadHistory marks commits reachable from the push ref as pushed', async t => {
  const remote = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-push-remote-'));
  t.after(() => fs.promises.rm(remote, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await runGit(remote, ['init', '--bare']);

  const repo = await createRepo(t, 'git-history-reword-push-local-');
  await commitFile(repo, 'pushed commit', 'one');
  await runGit(repo, ['remote', 'add', 'origin', remote]);
  await runGit(repo, ['push', '-u', 'origin', 'HEAD']);
  await commitFile(repo, 'local commit', 'two');

  const model = await extensionTest.loadHistory(repo);
  assert.equal(model.commits.length, 2);
  assert.equal(model.commits[0].subject, 'local commit');
  assert.equal(model.commits[0].pushed, false);
  assert.equal(model.commits[1].subject, 'pushed commit');
  assert.equal(model.commits[1].pushed, true);
});

test('loadHistory treats commits as unpushed when no push ref exists', async t => {
  const repo = await createRepo(t, 'git-history-reword-no-push-');
  await commitFile(repo, 'local only', 'one');

  const model = await extensionTest.loadHistory(repo);
  assert.equal(model.commits.length, 1);
  assert.equal(model.commits[0].pushed, false);
});

test('webview uses the SCM remote-ref theme color for pushed commit dots', () => {
  const html = extensionTest.getWebviewHtml({ cspSource: 'vscode-resource:' });
  assert.match(html, /\.row\.pushed \.dot \{ background: var\(--vscode-scmGraph-historyItemRemoteRefColor/);
  assert.match(html, /const pushedClass = commit\.pushed \? ' pushed' : '';/);
});
