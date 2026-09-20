'use strict';

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
  .header, .row { display: grid; grid-template-columns: 34px minmax(340px, 1fr) 258px 82px; align-items: center; min-height: 30px; border-bottom: 1px solid var(--vscode-panel-border); }
  .header { position: sticky; top: 44px; z-index: 9; min-height: 28px; background: var(--vscode-editor-background); font-size: 11px; font-weight: 600; opacity: .8; }
  .header > div, .row > div { padding: 3px 8px; min-width: 0; }
  .graph { position: relative; height: 100%; min-height: 30px; }
  .graph::before { content: ''; position: absolute; left: 16px; top: 0; bottom: 0; width: 2px; background: var(--vscode-editorIndentGuide-background); }
  .dot { position: absolute; left: 12px; top: 50%; width: 10px; height: 10px; transform: translateY(-50%); border-radius: 50%; background: var(--vscode-focusBorder); border: 2px solid var(--vscode-editor-background); }
  .row.pushed .dot { background: var(--vscode-scmGraph-historyItemRemoteRefColor, var(--vscode-scmGraph-foreground2, var(--vscode-focusBorder))); }
  .row:first-of-type .graph::before { top: 50%; }
  .cell-input { width: 100%; height: 25px; padding: 2px 4px; border: 1px solid transparent; outline: none; background: transparent; color: inherit; font: inherit; }
  .cell-input:hover { border-color: var(--vscode-input-border, transparent); }
  .cell-input:focus { border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); }
  .time { display: flex; align-items: center; gap: 4px; }
  .time-input { min-width: 0; }
  .restore-date { flex: 0 0 auto; padding: 3px 7px; font-size: 11px; }
  .hash { opacity: .62; font-family: var(--vscode-editor-font-family); }
  .row.dirty .message input, .row.dirty .time input, .row.dirty .hash { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .row.dirty .dot { background: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .row.date-mismatch .time .time-input { color: var(--vscode-editorWarning-foreground, #cca700); border-color: var(--vscode-editorWarning-foreground, #cca700); }
  .row.date-mismatch .restore-date { color: var(--vscode-editorWarning-foreground, #cca700); border-color: var(--vscode-editorWarning-foreground, #cca700); }
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
      const merge = commit.parentCount > 1;
      const dateMismatch = commit.authorDate !== commit.committerDate;
      const messageDisabled = merge || syncInProgress ? 'disabled' : '';
      const timeDisabled = merge || syncInProgress || dateMismatch ? 'disabled' : '';
      const mergeClass = merge ? ' merge' : '';
      const pushedClass = commit.pushed ? ' pushed' : '';
      const mismatchClass = dateMismatch ? ' date-mismatch' : '';
      const restore = dateMismatch
        ? '<button class="secondary restore-date" ' + (merge || syncInProgress ? 'disabled' : '') + ' title="Set Committer Date to Author Date">Restore</button>'
        : '';
      return '<div class="row' + mergeClass + pushedClass + mismatchClass + '" data-index="' + commit.index + '">' +
        '<div class="graph"><span class="dot"></span></div>' +
        '<div class="message"><input class="cell-input message-input" ' + messageDisabled + ' value="' + escapeHtml(commit.subject) + '" title="Edit commit message"></div>' +
        '<div class="time"><input class="cell-input time-input" type="datetime-local" step="1" ' + timeDisabled + ' value="' + escapeHtml(dateToLocalInput(commit.authorDate)) + '" title="Changes both Author Date and Committer Date">' + restore + '</div>' +
        '<div class="hash" title="' + escapeHtml(commit.hash) + '">' + escapeHtml(commit.shortHash) + '</div>' +
      '</div>';
    }).join('');

    rowsEl.querySelectorAll('.row').forEach(row => {
      const index = Number(row.dataset.index);
      const commit = model.commits[index];
      const messageInput = row.querySelector('.message-input');
      const timeInput = row.querySelector('.time-input');
      const restoreButton = row.querySelector('.restore-date');
      const onChange = () => updateEdit(index, commit, row, messageInput, timeInput);
      messageInput.addEventListener('input', onChange);
      timeInput.addEventListener('input', onChange);
      restoreButton?.addEventListener('click', () => {
        const existing = edits.get(index) || {};
        edits.set(index, {
          ...existing,
          index,
          originalSubject: commit.subject,
          originalTime: commit.authorDate,
          time: commit.authorDate,
          normalizeDates: true
        });
        row.classList.remove('date-mismatch');
        row.classList.add('dirty');
        restoreButton.hidden = true;
        timeInput.disabled = syncInProgress || commit.parentCount > 1;
        updateEdit(index, commit, row, messageInput, timeInput);
      });
    });
    updateToolbar();
  }

  function updateEdit(index, commit, row, messageInput, timeInput) {
    const subject = messageInput.value.trim();
    const originalSubject = commit.subject.trim();
    const originalLocal = dateToLocalInput(commit.authorDate);
    const timeLocal = timeInput.value;
    const subjectChanged = subject !== originalSubject;
    const timeChanged = timeLocal !== originalLocal;
    const normalizeDates = edits.get(index)?.normalizeDates === true;

    if (!subjectChanged && !timeChanged && !normalizeDates) {
      edits.delete(index);
      row.classList.remove('dirty');
    } else {
      edits.set(index, {
        index,
        originalSubject: commit.subject,
        subject: subjectChanged ? subject : undefined,
        originalTime: commit.authorDate,
        time: timeChanged ? localInputToIsoOffset(timeLocal) : (normalizeDates ? commit.authorDate : undefined),
        normalizeDates
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
    rowsEl.querySelectorAll('.message-input, .time-input, .restore-date').forEach(control => {
      const row = control.closest('.row');
      const mismatchLocked = control.classList.contains('time-input') && row.classList.contains('date-mismatch');
      control.disabled = value || row.classList.contains('merge') || mismatchLocked;
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

module.exports = { getWebviewHtml };
