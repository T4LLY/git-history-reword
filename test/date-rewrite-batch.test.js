'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getCommitMetadata, _test } = require('../history-rewrite');

function rawCommit({ tree, parent, subject, author = 'Batch Test <batch@example.test> 946684800 +0000' }) {
  return Buffer.from(
    `tree ${tree}\n` +
    (parent ? `parent ${parent}\n` : '') +
    `author ${author}\n` +
    'committer Batch Test <batch@example.test> 946684801 +0000\n\n' +
    `${subject}\n`
  );
}

function batchEntry(hash, body) {
  return Buffer.concat([
    Buffer.from(`${hash} commit ${body.length}\n`, 'ascii'),
    body,
    Buffer.from('\n')
  ]);
}

test('getCommitMetadata reads all commit objects with one cat-file --batch process', async () => {
  const hash1 = '1'.repeat(40);
  const hash2 = '2'.repeat(40);
  const tree1 = 'a'.repeat(40);
  const tree2 = 'b'.repeat(40);
  const body1 = rawCommit({ tree: tree1, parent: hash2, subject: 'newest' });
  const body2 = rawCommit({ tree: tree2, subject: 'oldest' });
  const calls = [];

  const fakeGit = async (_cwd, args, _maxBuffer, options = {}) => {
    calls.push({ args, options });
    if (args[0] === 'rev-list') return `${hash1}\n${hash2}\n`;
    if (args[0] === 'cat-file' && args[1] === '--batch') {
      assert.deepEqual(options.input, Buffer.from(`${hash1}\n${hash2}\n`, 'ascii'));
      assert.equal(options.encoding, 'buffer');
      return Buffer.concat([batchEntry(hash1, body1), batchEntry(hash2, body2)]);
    }
    throw new Error(`Unexpected git call: ${args.join(' ')}`);
  };

  const commits = await getCommitMetadata(fakeGit, '/repo', 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [
    ['rev-list', '--first-parent'],
    ['cat-file', '--batch']
  ]);
  assert.equal(commits[0].tree, tree1);
  assert.deepEqual(commits[0].parents, [hash2]);
  assert.equal(commits[0].authorDate, '946684800 +0000');
  assert.deepEqual(commits[0].message, Buffer.from('newest\n'));
  assert.equal(commits[1].tree, tree2);
});

test('batch commit parsing preserves raw message bytes and reports unsupported headers', () => {
  const hash = '3'.repeat(40);
  const raw = Buffer.concat([
    Buffer.from(
      `tree ${'c'.repeat(40)}\n` +
      'author Batch Test <batch@example.test> 946684800 +0000\n' +
      'committer Batch Test <batch@example.test> 946684801 +0000\n' +
      'encoding ISO-8859-1\n\n'
    ),
    Buffer.from([0x73, 0x75, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x0a, 0xe9, 0x0a])
  ]);

  const commit = _test.parseCommit(hash, raw);
  assert.deepEqual(commit.message, Buffer.from([0x73, 0x75, 0x62, 0x6a, 0x65, 0x63, 0x74, 0x0a, 0xe9, 0x0a]));
  assert.deepEqual(commit.unpreservedHeaders, ['encoding']);
});
