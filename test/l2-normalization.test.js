'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { _test: extensionTest } = require('../extension');
Module._load = originalLoad;

test('L2 comparison ignores subject-only whitespace and counts actual changes once', () => {
  const changes = extensionTest.getEffectiveChanges([
    { index: 2, subject: '', originalSubject: '   ' },
    { index: 1, subject: 'updated', originalSubject: 'original' },
    { index: 0, subject: undefined, originalSubject: 'same', time: '2026-09-09T12:00:00+00:00', originalTime: '2026-09-09T11:00:00+00:00' }
  ]);

  assert.deepEqual(changes.map(change => change.index), [1, 0]);
});


test('date normalization is effective even when the selected time equals Author Date', () => {
  const change = {
    index: 0,
    subject: undefined,
    originalSubject: 'same',
    time: '2026-09-09T11:00:00+00:00',
    originalTime: '2026-09-09T11:00:00+00:00',
    normalizeDates: true
  };

  assert.deepEqual(extensionTest.getEffectiveChanges([change]).map(item => item.index), [0]);
  assert.deepEqual(extensionTest.getDateChanges([change]).map(item => item.index), [0]);
});
