'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const execFile = util.promisify(cp.execFile);
const MAX_COMMITS = 200;
const panels = new Map();

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('gitHistoryReword.open', openHistoryEditor),
    vscode.commands.registerCommand('gitHistoryReword.reword', openHistoryEditor)
  );
}

async function openHistoryEditor() {
  try {
    const repo = await pickRepository();
    if (!repo) return;

    const cwd = repo.rootUri.fsPath;
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
    panel.onDidDispose(() => panels.delete(cwd));
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
  }
}

async function sendHistory(panel, cwd) {
  const model = await loadHistory(cwd);
  await panel.webview.postMessage({ type: 'history', ...model });
}

async function loadHistory(cwd) {
  const [head, branch] = await Promise.all([
    git(cwd, ['rev-parse', 'HEAD']).then(v => v.trim()),
    git(cwd, ['branch', '--show-current']).then(v => v.trim())
  ]);

  const format = '%H%x1f%h%x1f%aI%x1f%cI%x1f%s%x1f%P%x1e';
  const stdout = await git(cwd, [
    'log',
    '--first-parent',
    `-n${MAX_COMMITS}`,
    `--pretty=format:${format}`
  ], 8 * 1024 * 1024);

  const commits = stdout
    .split('\x1e')
    .map(record => record.replace(/^\r?\n|\r?\n$/g, ''))
    .filter(Boolean)
    .map((record, index) => {
      const [hash, shortHash, authorDate, committerDate, subject, parents = ''] = record.split('\x1f');
      return {
        index,
        hash,
        shortHash,
        authorDate,
        committerDate,
        subject,
        parentCount: parents.trim() ? parents.trim().split(/\s+/).length : 0
      };
    });

  return {
    head,
    branch: branch || '(detached HEAD)',
    repoName: path.basename(cwd),
    commits
  };
}

async function syncChanges(panel, cwd, baseHead, changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    await panel.webview.postMessage({ type: 'syncDone', message: 'No changes.' });
    return;
  }

  const currentHead = (await git(cwd, ['rev-parse', 'HEAD'])).trim();
  if (currentHead !== baseHead) {
    throw new Error('Git history changed after this list was loaded. Refresh before Sync.');
  }

  const normalized = changes
    .map(change => ({
      index: Number(change.index),
      subject: typeof change.subject === 'string' ? change.subject.trim() : undefined,
      originalSubject: typeof change.originalSubject === 'string' ? change.originalSubject : '',
      time: typeof change.time === 'string' && change.time.length > 0 ? change.time : undefined,
      originalTime: typeof change.originalTime === 'string' ? change.originalTime : undefined
    }))
    .filter(change => Number.isInteger(change.index) && change.index >= 0)
    .sort((a, b) => b.index - a.index);

  for (const change of normalized) {
    if (change.subject !== undefined && change.subject.length === 0) {
      throw new Error(`Commit HEAD~${change.index}: commit message cannot be empty.`);
    }
  }

  if (normalized.length === 0) {
    await panel.webview.postMessage({ type: 'syncDone', message: 'No valid changes.' });
    return;
  }

  await assertLinearAffectedHistory(cwd, normalized);
  const backup = await createBackupRef(cwd, currentHead);
  const headRef = (await git(cwd, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim() || 'HEAD';

  try {
    await panel.webview.postMessage({ type: 'syncProgress', message: 'Rewriting commit messages…' });

    // Use a stable HEAD-relative ordinal. git history reword rewrites descendant hashes,
    // but the logical position in a linear history remains the same.
    for (const change of normalized) {
      if (change.subject === undefined || change.subject === change.originalSubject.trim()) continue;

      const rev = change.index === 0 ? 'HEAD' : `HEAD~${change.index}`;
      const fullMessage = await getCommitMessage(cwd, rev);
      const { tail } = splitMessage(fullMessage);
      const nextMessage = joinMessage(change.subject, tail);
      await runHistoryReword(cwd, rev, nextMessage);
    }

    const dateChanges = normalized.filter(change => change.time && change.time !== change.originalTime);
    if (dateChanges.length > 0) {
      await panel.webview.postMessage({ type: 'syncProgress', message: 'Rewriting commit timestamps…' });
      await rewriteDates(cwd, dateChanges);
    }
  } catch (error) {
    await git(cwd, ['update-ref', '-m', 'Git History Reword: rollback failed sync', headRef, currentHead]).catch(() => {});
    throw new Error(`${formatError(error)} (Sync rolled back to ${currentHead.slice(0, 8)}.)`);
  }

  await vscode.commands.executeCommand('git.refresh').then(() => {}, () => {});
  const nextModel = await loadHistory(cwd);
  await panel.webview.postMessage({
    type: 'syncDone',
    message: `Synced ${normalized.length} commit${normalized.length === 1 ? '' : 's'}. Backup: ${backup}`,
    ...nextModel
  });
}

async function assertLinearAffectedHistory(cwd, changes) {
  const maxIndex = Math.max(...changes.map(change => change.index));
  const records = await getCommitMetadata(cwd, maxIndex + 1);
  if (records.length <= maxIndex) {
    throw new Error('The selected commit is no longer available. Refresh the list.');
  }
  const merged = records.find(commit => commit.parents.length > 1);
  if (merged) {
    throw new Error(`Merge commit ${merged.shortHash} is inside the affected history. git history reword does not support merge histories yet.`);
  }
}

async function rewriteDates(cwd, dateChanges) {
  const branchRef = (await git(cwd, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (!branchRef) {
    throw new Error('Timestamp editing requires HEAD to be attached to a local branch.');
  }

  const maxIndex = Math.max(...dateChanges.map(change => change.index));
  const edits = new Map(dateChanges.map(change => [change.index, change.time]));
  const newestFirst = await getCommitMetadata(cwd, maxIndex + 1);

  if (newestFirst.length <= maxIndex) {
    throw new Error('The selected commit is no longer available while rewriting timestamps.');
  }

  const oldHead = newestFirst[0].hash;
  const slice = newestFirst.slice(0, maxIndex + 1);
  if (slice.some(commit => commit.parents.length > 1)) {
    throw new Error('Timestamp editing currently supports linear history only.');
  }

  for (const commit of slice) {
    const headers = await getUnpreservedCommitHeaders(cwd, commit.hash);
    if (headers.length > 0) {
      throw new Error(`Timestamp rewrite cannot preserve ${headers[0]} header on commit ${commit.hash}.`);
    }
  }

  const oldestFirst = [...slice].reverse();
  let rewrittenParent = null;

  for (let offset = 0; offset < oldestFirst.length; offset += 1) {
    const commit = oldestFirst[offset];
    const originalIndex = maxIndex - offset;
    const requestedTime = edits.get(originalIndex);
    const authorDate = requestedTime || commit.authorDate;
    const committerDate = requestedTime || commit.committerDate;

    let parent;
    if (rewrittenParent) {
      parent = rewrittenParent;
    } else {
      parent = commit.parents[0] || null;
    }

    const args = ['commit-tree', commit.tree];
    if (parent) args.push('-p', parent);

    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: commit.authorName,
      GIT_AUTHOR_EMAIL: commit.authorEmail,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_NAME: commit.committerName,
      GIT_COMMITTER_EMAIL: commit.committerEmail,
      GIT_COMMITTER_DATE: committerDate
    };

    const newHash = (await git(cwd, args, 4 * 1024 * 1024, { env, input: commit.message })).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(newHash)) {
      throw new Error(`git commit-tree returned an invalid commit id: ${newHash}`);
    }
    rewrittenParent = newHash;
  }

  await git(cwd, ['update-ref', '-m', 'Git History Reword: sync timestamps', branchRef, rewrittenParent, oldHead]);
}

async function getCommitMetadata(cwd, count) {
  const hashes = (await git(cwd, ['rev-list', '--first-parent', `--max-count=${count}`, 'HEAD']))
    .split(/\r?\n/)
    .map(v => v.trim())
    .filter(Boolean);

  const commits = [];
  for (const hash of hashes) {
    const format = '%H%x1f%h%x1f%T%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI';
    const header = await git(cwd, ['show', '-s', `--format=${format}`, hash], 1024 * 1024);
    const [fullHash, shortHash, tree, parentsText, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = header.trimEnd().split('\x1f');
    const message = await getCommitMessage(cwd, hash);
    commits.push({
      hash: fullHash,
      shortHash,
      tree,
      parents: parentsText.trim() ? parentsText.trim().split(/\s+/) : [],
      authorName,
      authorEmail,
      authorDate,
      committerName,
      committerEmail,
      committerDate,
      message
    });
  }
  return commits;
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

async function getUnpreservedCommitHeaders(cwd, rev) {
  const raw = await git(cwd, ['cat-file', 'commit', rev], 8 * 1024 * 1024, { encoding: 'buffer' });
  const separator = raw.indexOf(Buffer.from('\n\n'));
  if (separator === -1) throw new Error(`Commit ${rev} has no message separator.`);

  return raw.slice(0, separator)
    .toString('ascii')
    .split(/\r?\n/)
    .map(line => line.match(/^([A-Za-z][A-Za-z0-9-]*)\s/))
    .map(match => match && match[1])
    .filter(name => name === 'encoding' || name === 'mergetag' || /^gpgsig(?:-.+)?$/.test(name));
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
      'git',
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

function getWebviewHtml(webview) {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Git History Reword</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); font-size: 13px; }
  .toolbar { position: sticky; top: 0; z-index: 10; height: 44px; display: flex; align-items: center; gap: 10px; padding: 0 12px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .repo { font-weight: 600; }
  .branch { padding: 2px 8px; border-radius: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .spacer { flex: 1; }
  .status { opacity: .8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  button { border: 1px solid transparent; border-radius: 2px; padding: 5px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-foreground); background: transparent; border-color: var(--vscode-button-secondaryBackground); }
  button:disabled { opacity: .45; cursor: default; }
  .header, .row { display: grid; grid-template-columns: 34px minmax(340px, 1fr) 194px 82px; align-items: center; min-height: 30px; border-bottom: 1px solid var(--vscode-panel-border); }
  .header { position: sticky; top: 44px; z-index: 9; min-height: 28px; background: var(--vscode-editor-background); font-size: 11px; font-weight: 600; opacity: .8; }
  .header > div, .row > div { padding: 3px 8px; min-width: 0; }
  .graph { position: relative; height: 100%; min-height: 30px; }
  .graph::before { content: ''; position: absolute; left: 16px; top: 0; bottom: 0; width: 2px; background: var(--vscode-editorIndentGuide-background); }
  .dot { position: absolute; left: 12px; top: 50%; width: 10px; height: 10px; transform: translateY(-50%); border-radius: 50%; background: var(--vscode-focusBorder); border: 2px solid var(--vscode-editor-background); }
  .row:first-of-type .graph::before { top: 50%; }
  .cell-input { width: 100%; height: 25px; padding: 2px 4px; border: 1px solid transparent; outline: none; background: transparent; color: inherit; font: inherit; }
  .cell-input:hover { border-color: var(--vscode-input-border, transparent); }
  .cell-input:focus { border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); }
  .hash { opacity: .62; font-family: var(--vscode-editor-font-family); }
  .row.dirty .message input, .row.dirty .time input, .row.dirty .hash { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .row.dirty .dot { background: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .row.merge { opacity: .55; }
  .row.merge input { cursor: not-allowed; }
  .empty { padding: 28px; opacity: .7; }
  .changed-count { min-width: 92px; text-align: right; }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="repo" id="repo">Git History Reword</span>
    <span class="branch" id="branch"></span>
    <span class="status" id="status"></span>
    <span class="spacer"></span>
    <span class="changed-count" id="changedCount">0 changed</span>
    <button class="secondary" id="refresh">Refresh</button>
    <button id="sync" disabled>Sync</button>
  </div>
  <div class="header">
    <div>Graph</div><div>Message</div><div>Time</div><div>Commit</div>
  </div>
  <div id="rows"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let model = null;
  const edits = new Map();
  let syncInProgress = false;
  const rowsEl = document.getElementById('rows');
  const syncButton = document.getElementById('sync');
  const refreshButton = document.getElementById('refresh');
  const statusEl = document.getElementById('status');
  const countEl = document.getElementById('changedCount');

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  function dateToLocalInput(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function localInputToIsoOffset(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const pad = n => String(Math.abs(n)).padStart(2, '0');
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const oh = pad(Math.trunc(Math.abs(offsetMinutes) / 60));
    const om = pad(Math.abs(offsetMinutes) % 60);
    return value + sign + oh + ':' + om;
  }

  function render() {
    if (!model) return;
    document.getElementById('repo').textContent = model.repoName;
    document.getElementById('branch').textContent = model.branch;
    statusEl.textContent = '';

    if (!model.commits.length) {
      rowsEl.innerHTML = '<div class="empty">No commits found.</div>';
      return;
    }

    rowsEl.innerHTML = model.commits.map(commit => {
      const disabled = commit.parentCount > 1 || syncInProgress ? 'disabled' : '';
      const mergeClass = commit.parentCount > 1 ? ' merge' : '';
      return '<div class="row' + mergeClass + '" data-index="' + commit.index + '">' +
        '<div class="graph"><span class="dot"></span></div>' +
        '<div class="message"><input class="cell-input message-input" ' + disabled + ' value="' + escapeHtml(commit.subject) + '" title="Edit commit message"></div>' +
        '<div class="time"><input class="cell-input time-input" type="datetime-local" step="1" ' + disabled + ' value="' + escapeHtml(dateToLocalInput(commit.authorDate)) + '" title="Changes both Author Date and Committer Date"></div>' +
        '<div class="hash" title="' + escapeHtml(commit.hash) + '">' + escapeHtml(commit.shortHash) + '</div>' +
      '</div>';
    }).join('');

    rowsEl.querySelectorAll('.row').forEach(row => {
      const index = Number(row.dataset.index);
      const commit = model.commits[index];
      const messageInput = row.querySelector('.message-input');
      const timeInput = row.querySelector('.time-input');
      const onChange = () => updateEdit(index, commit, row, messageInput, timeInput);
      messageInput.addEventListener('input', onChange);
      timeInput.addEventListener('input', onChange);
    });
    updateToolbar();
  }

  function updateEdit(index, commit, row, messageInput, timeInput) {
    const subject = messageInput.value.trim();
    const originalLocal = dateToLocalInput(commit.authorDate);
    const timeLocal = timeInput.value;
    const subjectChanged = subject !== commit.subject;
    const timeChanged = timeLocal !== originalLocal;

    if (!subjectChanged && !timeChanged) {
      edits.delete(index);
      row.classList.remove('dirty');
    } else {
      edits.set(index, {
        index,
        originalSubject: commit.subject,
        subject: subjectChanged ? subject : undefined,
        originalTime: commit.authorDate,
        time: timeChanged ? localInputToIsoOffset(timeLocal) : undefined
      });
      row.classList.add('dirty');
    }
    updateToolbar();
  }

  function updateToolbar() {
    const count = edits.size;
    countEl.textContent = count + ' changed';
    syncButton.disabled = syncInProgress || count === 0;
  }

  function setSyncInProgress(value) {
    syncInProgress = value;
    rowsEl.querySelectorAll('.message-input, .time-input').forEach(input => {
      input.disabled = value || input.closest('.row').classList.contains('merge');
    });
    syncButton.disabled = value || edits.size === 0;
    refreshButton.disabled = value;
  }

  syncButton.addEventListener('click', () => {
    if (!model || edits.size === 0) return;
    setSyncInProgress(true);
    statusEl.textContent = 'Syncing…';
    vscode.postMessage({ type: 'sync', baseHead: model.head, changes: [...edits.values()] });
  });

  refreshButton.addEventListener('click', () => {
    if (edits.size > 0 && !confirm('Discard staged edits and refresh?')) return;
    edits.clear();
    statusEl.textContent = 'Refreshing…';
    vscode.postMessage({ type: 'refresh' });
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'history') {
      model = message;
      edits.clear();
      refreshButton.disabled = syncInProgress;
      render();
    } else if (message.type === 'syncProgress') {
      statusEl.textContent = message.message || 'Syncing…';
    } else if (message.type === 'syncDone') {
      setSyncInProgress(false);
      if (message.commits) {
        model = message;
        edits.clear();
        render();
      }
      statusEl.textContent = message.message || 'Synced.';
      refreshButton.disabled = false;
      updateToolbar();
    } else if (message.type === 'syncError') {
      setSyncInProgress(false);
      statusEl.textContent = message.message || 'Sync failed.';
      refreshButton.disabled = false;
      updateToolbar();
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) value += chars.charAt(Math.floor(Math.random() * chars.length));
  return value;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  _test: { splitMessage, joinMessage, rewriteDates, runHistoryReword, getCommitMetadata, git, getWebviewHtml }
};
