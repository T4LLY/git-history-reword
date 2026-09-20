'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { getWebviewHtml } = require('./webview');
const { assertChronologicalHistory } = require('./chronology');
const { rewriteDates: rewriteCommitDates, getCommitMetadata: readCommitMetadata } = require('./history-rewrite');

const execFile = util.promisify(cp.execFile);
const MAX_COMMITS = 200;
const panels = new Map();
const openingPanels = new Map();

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitHistoryReword.open', openHistoryEditor)
  );
}

async function openHistoryEditor() {
  let cwd;
  let opening;
  try {
    const repo = await pickRepository();
    if (!repo) return;

    cwd = repo.rootUri.fsPath;
    const previous = openingPanels.get(cwd);
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    opening = { promise, release };
    openingPanels.set(cwd, opening);

    await previous?.promise;
    await assertGitHistorySupported(cwd);

    const existing = panels.get(cwd);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      await sendHistory(existing, cwd);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'gitHistoryReword.history',
      `Git History Reword — ${path.basename(cwd)}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panels.set(cwd, panel);
    panel.onDidDispose(() => {
      if (panels.get(cwd) === panel) panels.delete(cwd);
      if (openingPanels.get(cwd) === opening) {
        openingPanels.delete(cwd);
      }
      opening.release();
    });
    panel.webview.html = getWebviewHtml(panel.webview);

    panel.webview.onDidReceiveMessage(async message => {
      try {
        if (message.type === 'ready' || message.type === 'refresh') {
          await sendHistory(panel, cwd);
          return;
        }

        if (message.type === 'sync') {
          await syncChanges(panel, cwd, message.baseHead, message.changes || []);
        }
      } catch (error) {
        const text = formatError(error);
        await panel.webview.postMessage({ type: 'syncError', message: text });
        vscode.window.showErrorMessage(`Git History Reword: ${text}`);
      }
    });

    await sendHistory(panel, cwd);
  } catch (error) {
    vscode.window.showErrorMessage(`Git History Reword: ${formatError(error)}`);
  } finally {
    if (cwd && openingPanels.get(cwd) === opening) {
      openingPanels.delete(cwd);
    }
    opening?.release();
  }
}

async function sendHistory(panel, cwd) {
  const model = await loadHistory(cwd);
  await panel.webview.postMessage({ type: 'history', ...model });
}

async function loadHistory(cwd) {
  const [head, branch] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']).then(v => v.trim()).catch(error => {
      if (isUnbornHeadError(error)) return null;
      throw error;
    }),
    git(cwd, ['branch', '--show-current']).then(v => v.trim())
  ]);

  if (head === null) {
    return {
      head: '',
      branch: branch || '(detached HEAD)',
      repoName: path.basename(cwd),
      commits: []
    };
  }

  const format = '%H%x1f%h%x1f%aI%x1f%cI%x1f%s%x1f%P%x1e';
  const [stdout, pushCommit] = await Promise.all([
    git(cwd, [
      'log',
      '--first-parent',
      `-n${MAX_COMMITS + 1}`,
      `--pretty=format:${format}`,
      head
    ], 8 * 1024 * 1024),
    resolvePushCommit(cwd)
  ]);

  const unpushedHashes = pushCommit
    ? await getUnpushedHashes(cwd, head, pushCommit)
    : new Set();

  const history = stdout
    .split('\x1e')
    .map(record => record.replace(/^\r?\n|\r?\n$/g, ''))
    .filter(Boolean)
    .map(record => {
      const [hash, shortHash, authorDate, committerDate, subject, parents = ''] = record.split('\x1f');
      return {
        hash,
        shortHash,
        authorDate,
        committerDate,
        subject,
        parentCount: parents.trim() ? parents.trim().split(/\s+/).length : 0
      };
    });

  const commits = history.slice(0, MAX_COMMITS).map((commit, index) => ({
    ...commit,
    index,
    parentAuthorDate: history[index + 1]?.authorDate || null,
    pushed: pushCommit !== null && !unpushedHashes.has(commit.hash)
  }));

  return {
    head,
    branch: branch || '(detached HEAD)',
    repoName: path.basename(cwd),
    commits
  };
}

async function resolvePushCommit(cwd) {
  try {
    const stdout = await git(cwd, ['rev-parse', '--verify', '--quiet', '@{push}^{commit}']);
    return stdout.trim() || null;
  } catch (error) {
    const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    if (error?.code === 1 && stderr === '') return null;
    throw error;
  }
}

async function getUnpushedHashes(cwd, head, pushCommit) {
  const stdout = await git(cwd, [
    'rev-list',
    '--first-parent',
    `--max-count=${MAX_COMMITS}`,
    head,
    '--not',
    pushCommit
  ]);
  return new Set(stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean));
}

function isUnbornHeadError(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  return /ambiguous argument ['"]HEAD['"]:\s+unknown revision or path not in the working tree/i.test(stderr);
}

function getEffectiveChanges(changes) {
  return changes.filter(change => {
    const subjectChanged = change.subject !== undefined && change.subject !== change.originalSubject.trim();
    const timeChanged = change.time !== undefined && change.time !== change.originalTime;
    return subjectChanged || timeChanged || change.normalizeDates === true;
  });
}

function getDateChanges(changes) {
  return changes.filter(change =>
    change.normalizeDates === true || (change.time && change.time !== change.originalTime));
}

async function syncChanges(panel, cwd, baseHead, changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    await panel.webview.postMessage({ type: 'syncDone', message: 'No changes.' });
    return;
  }

  const normalized = changes
    .map(change => ({
      index: Number(change.index),
      subject: typeof change.subject === 'string' ? change.subject.trim() : undefined,
      originalSubject: typeof change.originalSubject === 'string' ? change.originalSubject : '',
      time: typeof change.time === 'string' && change.time.length > 0 ? change.time : undefined,
      originalTime: typeof change.originalTime === 'string' ? change.originalTime : undefined,
      normalizeDates: change.normalizeDates === true
    }))
    .filter(change => Number.isInteger(change.index) && change.index >= 0)
    .sort((a, b) => b.index - a.index);
  const effectiveChanges = getEffectiveChanges(normalized);

  const outOfRange = normalized.find(change => change.index >= MAX_COMMITS);
  if (outOfRange) {
    throw new Error(`Commit index ${outOfRange.index} is outside the displayed history range (0-${MAX_COMMITS - 1}).`);
  }

  if (effectiveChanges.length === 0) {
    await panel.webview.postMessage({ type: 'syncDone', message: 'No valid changes.' });
    return;
  }

  const currentHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (currentHead !== baseHead) {
    throw new Error('Git history changed after this list was loaded. Refresh before Sync.');
  }

  for (const change of effectiveChanges) {
    if (change.subject !== undefined && change.subject.length === 0) {
      throw new Error(`Commit HEAD~${change.index}: commit message cannot be empty.`);
    }
    if (change.normalizeDates && !change.time) {
      throw new Error(`Commit HEAD~${change.index}: date normalization requires the Author Date.`);
    }
  }

  await assertChronologicalHistory(git, cwd, effectiveChanges, currentHead, MAX_COMMITS);
  const originalHistory = await assertLinearAffectedHistory(cwd, effectiveChanges, currentHead);
  const verifiedHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (verifiedHead !== currentHead) {
    throw new Error('Git history changed during Sync. Refresh before Sync.');
  }
  const backup = await createBackupRef(cwd, currentHead);
  const headRef = (await git(cwd, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim() || 'HEAD';

  try {
    await panel.webview.postMessage({ type: 'syncProgress', message: 'Rewriting commit messages…' });
    let expectedHead = currentHead;

    // Resolve targets from the verified original HEAD so rewrites cannot shift live ordinals.
    for (const change of effectiveChanges) {
      if (change.subject === undefined || change.subject === change.originalSubject.trim()) continue;

      const observedHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
      if (observedHead !== expectedHead) {
        throw new Error('Git history changed during Sync. Refresh before Sync.');
      }

      const target = originalHistory[change.index];
      const rev = change.index === 0 ? 'HEAD' : `HEAD~${change.index}`;
      const fullMessage = await getCommitMessage(cwd, target.hash);
      const { tail } = splitMessage(fullMessage);
      const nextMessage = joinMessage(change.subject, tail);
      await runHistoryReword(cwd, rev, nextMessage);
      expectedHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
    }

    const dateChanges = getDateChanges(effectiveChanges);
    if (dateChanges.length > 0) {
      const observedHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
      if (observedHead !== expectedHead) {
        throw new Error('Git history changed during Sync. Refresh before Sync.');
      }
      await panel.webview.postMessage({ type: 'syncProgress', message: 'Rewriting commit timestamps…' });
      await rewriteDates(cwd, dateChanges);
    }
  } catch (error) {
    let rollbackError;
    try {
      await git(cwd, ['update-ref', '-m', 'Git History Reword: rollback failed sync', headRef, currentHead]);
    } catch (error) {
      rollbackError = error;
    }
    if (rollbackError) {
      throw new Error(`${formatError(error)} (Sync rollback failed. Restore the pre-sync state from backup ${backup}. Rollback error: ${formatError(rollbackError)})`);
    }
    throw new Error(`${formatError(error)} (Sync rolled back to ${currentHead.slice(0, 8)}.)`);
  }

  await vscode.commands.executeCommand('git.refresh').then(() => {}, () => {});
  const nextModel = await loadHistory(cwd);
  await panel.webview.postMessage({
    type: 'syncDone',
    message: `Synced ${effectiveChanges.length} commit${effectiveChanges.length === 1 ? '' : 's'}. Backup: ${backup}`,
    ...nextModel
  });
}

async function assertLinearAffectedHistory(cwd, changes, head = 'HEAD') {
  const maxIndex = Math.max(...changes.map(change => change.index));
  const stdout = await git(cwd, [
    'rev-list',
    '--first-parent',
    '--parents',
    `--max-count=${maxIndex + 1}`,
    head
  ]);
  const records = stdout
    .split(/\r?\n/)
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [hash, ...parents] = record.split(/\s+/);
      return { hash, parents };
    });
  if (records.length <= maxIndex) {
    throw new Error('The selected commit is no longer available. Refresh the list.');
  }
  const merged = records.find(commit => commit.parents.length > 1);
  if (merged) {
    throw new Error(`Merge commit ${merged.hash.slice(0, 7)} is inside the affected history. git history reword does not support merge histories yet.`);
  }
  return records;
}

async function rewriteDates(cwd, dateChanges) {
  return rewriteCommitDates(git, cwd, dateChanges);
}

async function getCommitMetadata(cwd, count) {
  return readCommitMetadata(git, cwd, count);
}

async function createBackupRef(cwd, head) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    '-',
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
    '-',
    String(now.getMilliseconds()).padStart(3, '0')
  ].join('');
  const ref = `refs/git-history-reword/backup-${stamp}`;
  await git(cwd, ['update-ref', ref, head]);
  return ref;
}

async function pickRepository() {
  const gitExtension = vscode.extensions.getExtension('vscode.git');
  if (!gitExtension) throw new Error('VS Code built-in Git extension is not available.');

  const exports = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
  const api = exports.getAPI(1);
  const repositories = api.repositories;

  if (repositories.length === 0) throw new Error('No Git repository is open.');
  if (repositories.length === 1) return repositories[0];

  const selected = await vscode.window.showQuickPick(
    repositories.map(repo => ({
      label: path.basename(repo.rootUri.fsPath),
      description: repo.rootUri.fsPath,
      repo
    })),
    { title: 'Select Git repository', placeHolder: 'Repository to edit' }
  );

  return selected?.repo;
}

async function assertGitHistorySupported(cwd) {
  const stdout = await git(cwd, ['--version']);
  const match = stdout.match(/git version\s+(\d+)\.(\d+)/i);
  if (!match) return;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 2 || (major === 2 && minor < 54)) {
    throw new Error(`git history reword requires Git 2.54 or newer. Installed: ${stdout.trim()}`);
  }
}

async function getCommitMessage(cwd, rev) {
  const raw = await git(cwd, ['cat-file', 'commit', rev], 8 * 1024 * 1024, { encoding: 'buffer' });
  const separator = raw.indexOf(Buffer.from('\n\n'));
  if (separator === -1) throw new Error(`Commit ${rev} has no message separator.`);
  return raw.slice(separator + 2);
}

function splitMessage(message) {
  const newline = Buffer.isBuffer(message) ? message.indexOf(0x0a) : message.indexOf('\n');
  if (newline === -1) return { subject: message, tail: null };
  return { subject: message.slice(0, newline), tail: message.slice(newline + 1) };
}

function joinMessage(subject, tail) {
  if (Buffer.isBuffer(tail)) {
    const subjectBuffer = Buffer.isBuffer(subject) ? subject : Buffer.from(subject, 'utf8');
    return Buffer.concat([subjectBuffer, Buffer.from('\n'), tail]);
  }
  return tail === null ? subject : `${subject}\n${tail}`;
}

async function runHistoryReword(cwd, rev, message) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-history-reword-'));
  try {
    const messagePath = path.join(tempDir, 'message.txt');
    await fs.promises.writeFile(messagePath, message);
    const editor = await createEditor(tempDir, messagePath);
    const env = { ...process.env, GIT_EDITOR: editor };
    // history reword ignores commit.cleanup; this escaped control value disables
    // printable comment-prefix cleanup without shifting it onto another text character.
    await git(cwd, ['-c', 'core.commentChar=\\001', 'history', 'reword', rev, '--update-refs=head'], 8 * 1024 * 1024, { env });
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

async function createEditor(tempDir, messagePath) {
  if (process.platform === 'win32') {
    const editorPath = path.join(tempDir, 'editor.cmd');
    const source = messagePath.replace(/"/g, '""');
    await fs.promises.writeFile(editorPath, `@echo off\r\ncopy /Y "${source}" "%~1" >nul\r\n`, 'utf8');
    return `"${editorPath.replace(/\\/g, '/')}"`;
  }

  const editorPath = path.join(tempDir, 'editor.sh');
  const escapedSource = messagePath.replace(/'/g, `'"'"'`);
  await fs.promises.writeFile(editorPath, `#!/bin/sh\ncp '${escapedSource}' "$1"\n`, { encoding: 'utf8', mode: 0o700 });
  return `sh "${editorPath.replace(/"/g, '\\"')}"`;
}

function getGitExecutable() {
  const configuration = vscode.workspace?.getConfiguration?.('git');
  const configuredPath = configuration?.get?.('path');
  return typeof configuredPath === 'string' && configuredPath.trim() ? configuredPath.trim() : 'git';
}

function git(cwd, args, maxBuffer = 4 * 1024 * 1024, options = {}) {
  return new Promise((resolve, reject) => {
    const encoding = options.encoding === 'buffer' ? null : options.encoding;
    const execOptions = {
      cwd,
      windowsHide: true,
      maxBuffer,
      env: options.env || process.env
    };
    if (encoding !== undefined) execOptions.encoding = encoding;

    const child = cp.execFile(
      getGitExecutable(),
      args,
      execOptions,
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
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
  });
}

function formatError(error) {
  const stderr = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
  const stdout = typeof error?.stdout === 'string' ? error.stdout.trim() : '';
  const text = stderr || stdout || error?.message || String(error);
  if (/not a git command|unknown subcommand.*history/i.test(text)) {
    return 'git history is unavailable. Install Git 2.54 or newer.';
  }
  return text;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _test: { splitMessage, joinMessage, loadHistory, syncChanges, getEffectiveChanges, getDateChanges, rewriteDates, runHistoryReword, assertLinearAffectedHistory, getCommitMetadata, git, getWebviewHtml, openHistoryEditor }
};
