'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { _test: extensionTest } = require('../extension');
Module._load = originalLoad;

class Element {
  constructor(id = '', className = '') {
    this.id = id;
    this.className = className;
    this.children = [];
    this.listeners = {};
    this.disabled = false;
    this.value = '';
    this.dataset = {};
    this._html = '';
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  dispatch(type, event = {}) {
    this.listeners[type]?.(event);
  }

  querySelector(selector) {
    return this.children.find(child => child.className.split(' ').includes(selector.slice(1))) || null;
  }

  querySelectorAll(selector) {
    if (selector === '.row') return this.children;
    const classes = selector.split(', ').map(value => value.slice(1));
    return this.children.flatMap(row => row.children.filter(child =>
      classes.some(name => child.className.split(' ').includes(name))));
  }

  closest(selector) {
    return selector === '.row' ? this.parent : null;
  }

  classList = {
    contains: name => this.className.split(' ').includes(name),
    add: name => { if (!this.className.split(' ').includes(name)) this.className += ` ${name}`; },
    remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); }
  };

  set textContent(value) { this.text = value; }
  get textContent() { return this.text || ''; }

  get innerHTML() { return this._html; }

  set innerHTML(value) {
    this._html = value;
    this.children = [];
    if (!value.includes('data-index')) return;
    const indexes = [...value.matchAll(/data-index="(\d+)"/g)];
    const inputTags = [...value.matchAll(/<input class="cell-input (message-input|time-input)"[^>]*value="([^"]*)"/g)];
    let inputIndex = 0;
    for (const match of indexes) {
      const row = new Element('', 'row');
      row.dataset.index = match[1];
      row.parent = this;
      for (const className of ['message-input', 'time-input']) {
        const input = new Element('', `cell-input ${className}`);
        input.value = inputTags[inputIndex]?.[2] || '';
        inputIndex += 1;
        input.parent = row;
        row.children.push(input);
      }
      this.children.push(row);
    }
  }
}

function createDom() {
  const elements = new Map(['repo', 'branch', 'status', 'changedCount', 'sync', 'refresh', 'rows', 'syncPreview', 'syncPreviewSummary', 'syncPreviewList', 'pushedWarning', 'cancelSync', 'confirmSync']
    .map(id => [id, new Element(id)]));
  elements.get('rows').querySelectorAll = Element.prototype.querySelectorAll;
  return {
    getElementById: id => elements.get(id),
    elements
  };
}

function createWebview(options = {}) {
  const html = extensionTest.getWebviewHtml({ cspSource: 'vscode-resource:' });
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  const document = createDom();
  const messages = [];
  const window = { listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } };
  const context = vm.createContext({
    document,
    window,
    confirm: () => true,
    acquireVsCodeApi: () => ({ postMessage: message => messages.push(message) })
  });
  vm.runInContext(script, context);
  const send = message => window.listeners.message({ data: message });
  send({
    type: 'history',
    repoName: 'repo',
    branch: 'main',
    head: 'head',
    commits: [{ index: 0, shortHash: 'abc1234', subject: 'old', authorDate: '2020-01-01T00:00:00Z', committerDate: '2020-01-01T00:00:00Z', parentCount: 0, pushed: options.pushed === true }]
  });
  return { document, messages, send, context, html };
}

test('sync disables editable inputs and restores them after sync failure or completion', () => {
  const webview = createWebview();
  const rows = webview.document.elements.get('rows');
  const row = rows.children[0];
  const messageInput = row.children[0];
  messageInput.value = 'new';
  messageInput.dispatch('input');
  assert.equal(webview.document.elements.get('sync').disabled, false);

  webview.document.elements.get('sync').dispatch('click');
  assert.equal(webview.document.elements.get('syncPreview').hidden, false);
  assert.equal(messageInput.disabled, false);

  webview.document.elements.get('confirmSync').dispatch('click');
  assert.equal(webview.document.elements.get('syncPreview').hidden, true);
  assert.equal(messageInput.disabled, true);
  assert.equal(webview.document.elements.get('refresh').disabled, true);

  webview.send({ type: 'syncError', message: 'failed' });
  assert.equal(messageInput.disabled, false);
  assert.equal(webview.document.elements.get('refresh').disabled, false);

  webview.document.elements.get('sync').dispatch('click');
  webview.document.elements.get('confirmSync').dispatch('click');
  assert.equal(messageInput.disabled, true);
  webview.send({ type: 'syncDone', message: 'done' });
  assert.equal(messageInput.disabled, false);
  assert.equal(webview.document.elements.get('refresh').disabled, false);
});


test('sync preview lists changes and warns before rewriting pushed history', () => {
  const webview = createWebview({ pushed: true });
  const row = webview.document.elements.get('rows').children[0];
  const messageInput = row.children[0];
  messageInput.value = 'new subject';
  messageInput.dispatch('input');

  webview.document.elements.get('sync').dispatch('click');

  const preview = webview.document.elements.get('syncPreview');
  const warning = webview.document.elements.get('pushedWarning');
  const list = webview.document.elements.get('syncPreviewList');
  assert.equal(preview.hidden, false);
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /Pushed history will be rewritten/);
  assert.match(list.innerHTML, /preview-badge pushed/);
  assert.match(list.innerHTML, /Message/);
  assert.match(list.innerHTML, /old.*new subject/);
  assert.equal(webview.document.elements.get('confirmSync').textContent, 'Sync pushed history');
  assert.equal(webview.messages.filter(message => message.type === 'sync').length, 0);

  webview.document.elements.get('cancelSync').dispatch('click');
  assert.equal(preview.hidden, true);
  assert.equal(webview.messages.filter(message => message.type === 'sync').length, 0);
});


test('timestamp editor uses an explicit 24-hour local format', () => {
  const webview = createWebview();
  const timeInput = webview.document.elements.get('rows').children[0].children[1];
  assert.match(timeInput.value, /^2020-01-01 (?:[01]\d|2[0-3]):00:00$/);
  assert.doesNotMatch(timeInput.value, /AM|PM/i);
  assert.match(webview.html, /placeholder=\"YYYY-MM-DD HH:mm:ss\"/);
  assert.doesNotMatch(webview.html, /type=\"datetime-local\"/);

  const local = new Date(2026, 8, 18, 17, 15, 32);
  assert.equal(webview.context.dateToLocalInput(local.toISOString()), '2026-09-18 17:15:32');
  assert.match(webview.context.localInputToIsoOffset('2026-09-18 17:15:32'), /^2026-09-18T17:15:32[+-]\d{2}:\d{2}$/);
});

test('invalid 24-hour timestamps block Sync until corrected', () => {
  const webview = createWebview();
  const row = webview.document.elements.get('rows').children[0];
  const messageInput = row.children[0];
  const timeInput = row.children[1];

  messageInput.value = 'new';
  messageInput.dispatch('input');
  assert.equal(webview.document.elements.get('sync').disabled, false);

  timeInput.value = '2020-01-01 13:99:00';
  timeInput.dispatch('input');
  assert.equal(webview.document.elements.get('sync').disabled, true);
  assert.match(webview.document.elements.get('status').textContent, /invalid timestamp/);

  timeInput.value = '2020-01-01 23:59:00';
  timeInput.dispatch('input');
  assert.equal(webview.document.elements.get('sync').disabled, false);
});
