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
  .header, .row { display: grid; grid-template-columns: 34px minmax(340px, 1fr) 258px 82px 74px; align-items: center; min-height: 30px; border-bottom: 1px solid var(--vscode-panel-border); }
  .header { position: sticky; top: 44px; z-index: 9; min-height: 28px; background: var(--vscode-editor-background); font-size: 11px; font-weight: 600; opacity: .8; }
  .header > div, .row > div { padding: 3px 8px; min-width: 0; }
  .graph { position: relative; height: 100%; min-height: 30px; }
  .graph::before { content: ''; position: absolute; left: 16px; top: 0; bottom: 0; width: 2px; background: var(--vscode-editorIndentGuide-background); }
  .dot { position: absolute; left: 12px; top: 50%; width: 10px; height: 10px; transform: translateY(-50%); border-radius: 50%; background: var(--vscode-focusBorder); border: 2px solid var(--vscode-editor-background); }
  .row.pushed .dot { background: var(--vscode-scmGraph-historyItemRemoteRefColor, var(--vscode-scmGraph-foreground2, var(--vscode-focusBorder))); }
  .row.first-row .graph::before { top: 50%; }
  .date-header { position: relative; min-height: 24px; display: flex; align-items: center; padding: 4px 12px 4px 42px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-sideBarSectionHeader-background, var(--vscode-editor-background)); color: var(--vscode-descriptionForeground, var(--vscode-foreground)); font-size: 11px; font-weight: 600; letter-spacing: .02em; }
  .date-header:not(.first-date-header)::before { content: ''; position: absolute; left: 16px; top: 0; bottom: 0; width: 2px; background: var(--vscode-editorIndentGuide-background); }
  .cell-input { width: 100%; height: 25px; padding: 2px 4px; border: 1px solid transparent; outline: none; background: transparent; color: inherit; font: inherit; }
  .cell-input:hover { border-color: var(--vscode-input-border, transparent); }
  .cell-input:focus { border-color: var(--vscode-focusBorder); background: var(--vscode-input-background); }
  .time { display: flex; align-items: center; gap: 4px; }
  .time-input { min-width: 0; }
  .restore-date { flex: 0 0 auto; padding: 3px 7px; font-size: 11px; }
  .actions { display: flex; align-items: center; justify-content: flex-start; }
  .revert-edit { padding: 3px 7px; font-size: 11px; }
  .hash { opacity: .62; font-family: var(--vscode-editor-font-family); }
  .row.dirty .message input, .row.dirty .time input, .row.dirty .hash { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .row.dirty .dot { background: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .row.date-mismatch .time .time-input { color: var(--vscode-editorWarning-foreground, #cca700); border-color: var(--vscode-editorWarning-foreground, #cca700); }
  .row.date-mismatch .restore-date { color: var(--vscode-editorWarning-foreground, #cca700); border-color: var(--vscode-editorWarning-foreground, #cca700); }
  .row.chronology-error .time .time-input, .row.time-invalid .time .time-input { color: var(--vscode-editorError-foreground, #f14c4c); border-color: var(--vscode-editorError-foreground, #f14c4c); }
  .row.merge { opacity: .55; }
  .row.merge input { cursor: not-allowed; }
  .empty { padding: 28px; opacity: .7; }
  .changed-count { min-width: 92px; text-align: right; }
  .modal-backdrop { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 28px; background: rgba(0, 0, 0, .46); }
  .modal-backdrop[hidden] { display: none; }
  .preview-dialog { width: min(760px, 100%); max-height: min(720px, calc(100vh - 56px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editor-background); box-shadow: 0 10px 36px rgba(0, 0, 0, .32); }
  .preview-header { padding: 14px 16px 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .preview-title { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
  .preview-summary { opacity: .78; }
  .pushed-warning { margin: 12px 16px 0; padding: 10px 12px; border: 1px solid var(--vscode-editorWarning-foreground, #cca700); border-radius: 4px; color: var(--vscode-editorWarning-foreground, #cca700); background: var(--vscode-inputValidation-warningBackground, transparent); }
  .preview-list { overflow: auto; padding: 8px 16px 12px; }
  .preview-item { padding: 10px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .preview-item:last-child { border-bottom: 0; }
  .preview-item-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .preview-hash { flex: 0 0 auto; opacity: .66; font-family: var(--vscode-editor-font-family); }
  .preview-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .preview-badges { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .preview-badge { padding: 1px 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
  .preview-badge.pushed { color: var(--vscode-editorWarning-foreground, #cca700); background: transparent; border: 1px solid currentColor; }
  .preview-detail { margin-top: 6px; opacity: .78; font-family: var(--vscode-editor-font-family); font-size: 12px; overflow-wrap: anywhere; }
  .preview-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--vscode-panel-border); }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="repo" id="repo">Git History Reword</span>
    <span class="branch" id="branch"></span>
    <span class="status" id="status"></span>
    <span class="spacer"></span>
    <span class="changed-count" id="changedCount">0 changed</span>
    <button class="secondary" id="revertAll" disabled>Revert All</button>
    <button class="secondary" id="refresh">Refresh</button>
    <button id="sync" disabled>Sync</button>
  </div>
  <div class="header">
    <div>Graph</div><div>Message</div><div>Time</div><div>Commit</div><div>Actions</div>
  </div>
  <div id="rows"></div>
  <div class="modal-backdrop" id="syncPreview" hidden>
    <div class="preview-dialog" role="dialog" aria-modal="true" aria-labelledby="syncPreviewTitle">
      <div class="preview-header">
        <div class="preview-title" id="syncPreviewTitle">Review Sync</div>
        <div class="preview-summary" id="syncPreviewSummary"></div>
      </div>
      <div class="pushed-warning" id="pushedWarning" hidden></div>
      <div class="preview-list" id="syncPreviewList"></div>
      <div class="preview-actions">
        <button class="secondary" id="cancelSync">Cancel</button>
        <button id="confirmSync">Sync changes</button>
      </div>
    </div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let model = null;
  const edits = new Map();
  let syncInProgress = false;
  let chronologyConflictCount = 0;
  let invalidTimeCount = 0;
  const rowsEl = document.getElementById('rows');
  const syncButton = document.getElementById('sync');
  const revertAllButton = document.getElementById('revertAll');
  const refreshButton = document.getElementById('refresh');
  const statusEl = document.getElementById('status');
  const countEl = document.getElementById('changedCount');
  const previewEl = document.getElementById('syncPreview');
  const previewSummaryEl = document.getElementById('syncPreviewSummary');
  const previewListEl = document.getElementById('syncPreviewList');
  const pushedWarningEl = document.getElementById('pushedWarning');
  const cancelSyncButton = document.getElementById('cancelSync');
  const confirmSyncButton = document.getElementById('confirmSync');

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  }

  function dateToLocalInput(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function parseLocalDateTime(value) {
    const match = /^(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})$/.exec(String(value || '').trim());
    if (!match) return null;
    const [, y, m, d, hh, mm, ss] = match.map(Number);
    const date = new Date(y, m - 1, d, hh, mm, ss, 0);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d ||
        date.getHours() !== hh || date.getMinutes() !== mm || date.getSeconds() !== ss) return null;
    return date;
  }

  const timestampSegments = [
    [0, 4],
    [5, 7],
    [8, 10],
    [11, 13],
    [14, 16],
    [17, 19]
  ];

  function selectTimestampSegment(input) {
    if (!input || typeof input.setSelectionRange !== 'function') return;
    if (input.selectionStart !== input.selectionEnd) return;
    const caret = input.selectionStart ?? 0;
    const segment = timestampSegments.find(([start, end]) => caret >= start && caret <= end);
    if (!segment) return;
    input.setSelectionRange(segment[0], segment[1]);
  }

  function localInputToIsoOffset(value) {
    const date = parseLocalDateTime(value);
    if (!date) return '';
    const pad = n => String(Math.abs(n)).padStart(2, '0');
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const oh = pad(Math.trunc(Math.abs(offsetMinutes) / 60));
    const om = pad(Math.abs(offsetMinutes) % 60);
    return value.trim().replace(' ', 'T') + sign + oh + ':' + om;
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

    let previousDate = '';
    rowsEl.innerHTML = model.commits.map((commit, position) => {
      const localTime = dateToLocalInput(commit.authorDate);
      const localDate = localTime.slice(0, 10);
      const dateHeader = localDate && localDate !== previousDate
        ? '<div class="date-header' + (position === 0 ? ' first-date-header' : '') + '">' + escapeHtml(localDate) + '</div>'
        : '';
      previousDate = localDate;

      const merge = commit.parentCount > 1;
      const dateMismatch = commit.authorDate !== commit.committerDate;
      const messageDisabled = merge || syncInProgress ? 'disabled' : '';
      const timeDisabled = merge || syncInProgress || dateMismatch ? 'disabled' : '';
      const firstClass = position === 0 ? ' first-row' : '';
      const mergeClass = merge ? ' merge' : '';
      const pushedClass = commit.pushed ? ' pushed' : '';
      const mismatchClass = dateMismatch ? ' date-mismatch' : '';
      const restore = dateMismatch
        ? '<button class="secondary restore-date" ' + (merge || syncInProgress ? 'disabled' : '') + ' title="Set Committer Date to Author Date">Restore</button>'
        : '';
      return dateHeader + '<div class="row' + firstClass + mergeClass + pushedClass + mismatchClass + '" data-index="' + commit.index + '">' +
        '<div class="graph"><span class="dot"></span></div>' +
        '<div class="message"><input class="cell-input message-input" ' + messageDisabled + ' value="' + escapeHtml(commit.subject) + '" title="Edit commit message"></div>' +
        '<div class="time"><input class="cell-input time-input" type="text" inputmode="numeric" spellcheck="false" placeholder="YYYY-MM-DD HH:mm:ss" ' + timeDisabled + ' value="' + escapeHtml(localTime) + '" title="24-hour local time. Changes both Author Date and Committer Date">' + restore + '</div>' +
        '<div class="hash" title="' + escapeHtml(commit.hash) + '">' + escapeHtml(commit.shortHash) + '</div>' +
        '<div class="actions"><button class="secondary revert-edit" ' + (merge || syncInProgress ? 'disabled' : '') + ' hidden title="Discard unsynced changes for this commit">Revert</button></div>' +
      '</div>';
    }).join('');

    rowsEl.querySelectorAll('.row').forEach(row => {
      const index = Number(row.dataset.index);
      const commit = model.commits[index];
      const messageInput = row.querySelector('.message-input');
      const timeInput = row.querySelector('.time-input');
      const restoreButton = row.querySelector('.restore-date');
      const revertButton = row.querySelector('.revert-edit');
      const onChange = () => updateEdit(index, commit, row, messageInput, timeInput);
      messageInput.addEventListener('input', onChange);
      timeInput.addEventListener('input', onChange);
      timeInput.addEventListener('focus', () => selectTimestampSegment(timeInput));
      timeInput.addEventListener('click', () => selectTimestampSegment(timeInput));
      revertButton?.addEventListener('click', () => revertEdit(index, commit, row, messageInput, timeInput, restoreButton, revertButton));
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
    updateChronology();
    updateToolbar();
  }

  function readRowTime(row) {
    if (!row) return NaN;
    const value = row.querySelector('.time-input')?.value || '';
    return parseLocalDateTime(value)?.getTime() ?? NaN;
  }

  function updateChronology() {
    const rows = Array.from(rowsEl.querySelectorAll('.row'));
    const rowByIndex = new Map(rows.map(row => [Number(row.dataset.index), row]));
    const conflictRows = new Set();
    let conflicts = 0;
    let invalidTimes = 0;

    for (const row of rows) {
      row.classList.remove('chronology-error');
      row.classList.remove('time-invalid');
      if (!Number.isFinite(readRowTime(row))) {
        row.classList.add('time-invalid');
        invalidTimes += 1;
      }
    }

    for (let childIndex = 0; childIndex < model.commits.length; childIndex += 1) {
      const childRow = rowByIndex.get(childIndex);
      const childTime = readRowTime(childRow);
      let parentTime;

      if (childIndex + 1 < model.commits.length) {
        parentTime = readRowTime(rowByIndex.get(childIndex + 1));
      } else {
        parentTime = new Date(model.commits[childIndex].parentAuthorDate || '').getTime();
      }

      if (!Number.isFinite(childTime) || !Number.isFinite(parentTime) || childTime >= parentTime) continue;
      conflicts += 1;
      conflictRows.add(childIndex);
      if (childIndex + 1 < model.commits.length) conflictRows.add(childIndex + 1);
    }

    for (const index of conflictRows) rowByIndex.get(index)?.classList.add('chronology-error');
    chronologyConflictCount = conflicts;
    invalidTimeCount = invalidTimes;
    if (!syncInProgress) {
      statusEl.textContent = invalidTimes > 0
        ? invalidTimes + ' invalid timestamp' + (invalidTimes === 1 ? '' : 's') + ' — use YYYY-MM-DD HH:mm:ss.'
        : conflicts > 0
          ? conflicts + ' chronological conflict' + (conflicts === 1 ? '' : 's') + ' — fix the red timestamps before Sync.'
          : '';
    }
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
    const revertButton = row.querySelector('.revert-edit');
    if (revertButton) revertButton.hidden = !edits.has(index);
    updateChronology();
    updateToolbar();
  }

  function resetRowEdit(index, commit, row, messageInput, timeInput, restoreButton, revertButton) {
    edits.delete(index);
    messageInput.value = commit.subject;
    timeInput.value = dateToLocalInput(commit.authorDate);
    row.classList.remove('dirty');
    row.classList.remove('chronology-error');
    row.classList.remove('time-invalid');

    const merge = commit.parentCount > 1;
    const dateMismatch = commit.authorDate !== commit.committerDate;
    if (dateMismatch) row.classList.add('date-mismatch');
    else row.classList.remove('date-mismatch');

    messageInput.disabled = syncInProgress || merge;
    timeInput.disabled = syncInProgress || merge || dateMismatch;
    if (restoreButton) {
      restoreButton.hidden = !dateMismatch;
      restoreButton.disabled = syncInProgress || merge;
    }
    if (revertButton) {
      revertButton.hidden = true;
      revertButton.disabled = syncInProgress || merge;
    }
  }

  function revertEdit(index, commit, row, messageInput, timeInput, restoreButton, revertButton) {
    if (syncInProgress || !edits.has(index)) return;
    resetRowEdit(index, commit, row, messageInput, timeInput, restoreButton, revertButton);
    updateChronology();
    updateToolbar();
  }

  function revertAllEdits() {
    if (syncInProgress || edits.size === 0) return;
    if (!confirm('Revert all unsynced changes?')) return;

    rowsEl.querySelectorAll('.row').forEach(row => {
      const index = Number(row.dataset.index);
      if (!edits.has(index)) return;
      const commit = model.commits[index];
      resetRowEdit(
        index,
        commit,
        row,
        row.querySelector('.message-input'),
        row.querySelector('.time-input'),
        row.querySelector('.restore-date'),
        row.querySelector('.revert-edit')
      );
    });
    updateChronology();
    updateToolbar();
  }

  function getPreviewData() {
    const entries = [...edits.values()]
      .sort((a, b) => a.index - b.index)
      .map(change => {
        const commit = model.commits[change.index];
        const subjectChanged = change.subject !== undefined && change.subject !== change.originalSubject.trim();
        const timeChanged = change.time !== undefined && change.time !== change.originalTime;
        return { change, commit, subjectChanged, timeChanged, pushed: commit?.pushed === true };
      });
    return { entries, pushedCount: entries.filter(entry => entry.pushed).length };
  }

  function renderSyncPreview() {
    const preview = getPreviewData();
    previewSummaryEl.textContent = preview.entries.length + ' changed commit' + (preview.entries.length === 1 ? '' : 's') + ' will be synced.';
    pushedWarningEl.hidden = preview.pushedCount === 0;
    pushedWarningEl.textContent = preview.pushedCount === 0
      ? ''
      : 'Pushed history will be rewritten: ' + preview.pushedCount + ' changed commit' + (preview.pushedCount === 1 ? ' is' : 's are') + ' already in the push ref. Updating the remote later may require a force push.';
    confirmSyncButton.textContent = preview.pushedCount > 0 ? 'Sync pushed history' : 'Sync changes';

    previewListEl.innerHTML = preview.entries.map(entry => {
      const badges = [];
      if (entry.subjectChanged) badges.push('<span class="preview-badge">Message</span>');
      if (entry.timeChanged) badges.push('<span class="preview-badge">Date</span>');
      if (entry.change.normalizeDates === true) badges.push('<span class="preview-badge">Normalize date</span>');
      if (entry.pushed) badges.push('<span class="preview-badge pushed">Pushed</span>');

      const details = [];
      if (entry.subjectChanged) {
        details.push('<div class="preview-detail">Message: ' + escapeHtml(entry.change.originalSubject.trim()) + ' → ' + escapeHtml(entry.change.subject) + '</div>');
      }
      if (entry.timeChanged) {
        details.push('<div class="preview-detail">Time: ' + escapeHtml(dateToLocalInput(entry.change.originalTime)) + ' → ' + escapeHtml(dateToLocalInput(entry.change.time)) + '</div>');
      } else if (entry.change.normalizeDates === true) {
        details.push('<div class="preview-detail">Committer Date → Author Date: ' + escapeHtml(dateToLocalInput(entry.change.originalTime)) + '</div>');
      }

      return '<div class="preview-item">' +
        '<div class="preview-item-head"><span class="preview-hash">' + escapeHtml(entry.commit?.shortHash || ('HEAD~' + entry.change.index)) + '</span>' +
        '<span class="preview-subject">' + escapeHtml(entry.commit?.subject || entry.change.originalSubject) + '</span></div>' +
        '<div class="preview-badges">' + badges.join('') + '</div>' + details.join('') +
      '</div>';
    }).join('');
  }

  function openSyncPreview() {
    if (!model || edits.size === 0 || chronologyConflictCount > 0 || invalidTimeCount > 0 || syncInProgress) return;
    renderSyncPreview();
    previewEl.hidden = false;
    confirmSyncButton.focus?.();
  }

  function closeSyncPreview() {
    previewEl.hidden = true;
  }

  function startSync() {
    if (!model || edits.size === 0 || chronologyConflictCount > 0 || invalidTimeCount > 0 || syncInProgress) return;
    closeSyncPreview();
    setSyncInProgress(true);
    statusEl.textContent = 'Syncing…';
    vscode.postMessage({ type: 'sync', baseHead: model.head, changes: [...edits.values()] });
  }

  function updateToolbar() {
    const count = edits.size;
    countEl.textContent = count + ' changed';
    revertAllButton.disabled = syncInProgress || count === 0;
    syncButton.disabled = syncInProgress || count === 0 || chronologyConflictCount > 0 || invalidTimeCount > 0;
  }

  function setSyncInProgress(value) {
    syncInProgress = value;
    rowsEl.querySelectorAll('.message-input, .time-input, .restore-date, .revert-edit').forEach(control => {
      const row = control.closest('.row');
      const mismatchLocked = control.classList.contains('time-input') && row.classList.contains('date-mismatch');
      control.disabled = value || row.classList.contains('merge') || mismatchLocked;
    });
    revertAllButton.disabled = value || edits.size === 0;
    syncButton.disabled = value || edits.size === 0 || chronologyConflictCount > 0 || invalidTimeCount > 0;
    refreshButton.disabled = value;
  }

  syncButton.addEventListener('click', openSyncPreview);
  revertAllButton.addEventListener('click', revertAllEdits);
  cancelSyncButton.addEventListener('click', closeSyncPreview);
  confirmSyncButton.addEventListener('click', startSync);
  previewEl.addEventListener('click', event => {
    if (event.target === previewEl) closeSyncPreview();
  });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !previewEl.hidden && !syncInProgress) closeSyncPreview();
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
      closeSyncPreview();
      model = message;
      edits.clear();
      refreshButton.disabled = syncInProgress;
      render();
    } else if (message.type === 'syncProgress') {
      statusEl.textContent = message.message || 'Syncing…';
    } else if (message.type === 'syncDone') {
      closeSyncPreview();
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
      closeSyncPreview();
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
