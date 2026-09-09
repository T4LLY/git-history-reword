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

  set innerHTML(value) {
    this._html = value;
    this.children = [];
    if (!value.includes('data-index')) return;
    const indexes = [...value.matchAll(/data-index="(\d+)"/g)];
    for (const match of indexes) {
      const row = new Element('', 'row');
      row.dataset.index = match[1];
      row.parent = this;
      for (const className of ['message-input', 'time-input']) {
        const input = new Element('', `cell-input ${className}`);
        input.parent = row;
        row.children.push(input);
      }
      this.children.push(row);
    }
  }
}

function createDom() {
  const elements = new Map(['repo', 'branch', 'status', 'changedCount', 'sync', 'refresh', 'rows']
    .map(id => [id, new Element(id)]));
  elements.get('rows').querySelectorAll = Element.prototype.querySelectorAll;
  return {
    getElementById: id => elements.get(id),
    elements
  };
}

function createWebview() {
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
    commits: [{ index: 0, subject: 'old', authorDate: '2020-01-01T00:00:00Z', parentCount: 0 }]
  });
  return { document, messages, send };
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
  assert.equal(messageInput.disabled, true);
  assert.equal(webview.document.elements.get('refresh').disabled, true);

  webview.send({ type: 'syncError', message: 'failed' });
  assert.equal(messageInput.disabled, false);
  assert.equal(webview.document.elements.get('refresh').disabled, false);

  webview.document.elements.get('sync').dispatch('click');
  assert.equal(messageInput.disabled, true);
  webview.send({ type: 'syncDone', message: 'done' });
  assert.equal(messageInput.disabled, false);
  assert.equal(webview.document.elements.get('refresh').disabled, false);
});
