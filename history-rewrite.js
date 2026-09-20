'use strict';

const PER_COMMIT_READ_LIMIT = 8 * 1024 * 1024;
const BATCH_OVERHEAD_PER_COMMIT = 256;

async function rewriteDates(git, cwd, dateChanges) {
  const branchRef = (await git(cwd, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (!branchRef) {
    throw new Error('Timestamp editing requires HEAD to be attached to a local branch.');
  }

  const maxIndex = Math.max(...dateChanges.map(change => change.index));
  const edits = new Map(dateChanges.map(change => [change.index, change.time]));
  const newestFirst = await getCommitMetadata(git, cwd, maxIndex + 1);

  if (newestFirst.length <= maxIndex) {
    throw new Error('The selected commit is no longer available while rewriting timestamps.');
  }

  const oldHead = newestFirst[0].hash;
  const slice = newestFirst.slice(0, maxIndex + 1);
  if (slice.some(commit => commit.parents.length > 1)) {
    throw new Error('Timestamp editing currently supports linear history only.');
  }

  for (const commit of slice) {
    if (commit.unpreservedHeaders.length > 0) {
      throw new Error(`Timestamp rewrite cannot preserve ${commit.unpreservedHeaders[0]} header on commit ${commit.hash}.`);
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

    const parent = rewrittenParent || commit.parents[0] || null;
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

async function getCommitMetadata(git, cwd, count) {
  const hashes = (await git(cwd, ['rev-list', '--first-parent', `--max-count=${count}`, 'HEAD']))
    .split(/\r?\n/)
    .map(value => value.trim())
    .filter(Boolean);

  if (hashes.length === 0) return [];

  const input = Buffer.from(`${hashes.join('\n')}\n`, 'ascii');
  const maxBuffer = Math.max(
    PER_COMMIT_READ_LIMIT,
    hashes.length * (PER_COMMIT_READ_LIMIT + BATCH_OVERHEAD_PER_COMMIT)
  );
  const batch = await git(cwd, ['cat-file', '--batch'], maxBuffer, { encoding: 'buffer', input });
  const objects = parseBatchObjects(batch, hashes);
  return objects.map(({ hash, body }) => parseCommit(hash, body));
}

function parseBatchObjects(batch, expectedHashes) {
  if (!Buffer.isBuffer(batch)) {
    throw new TypeError('git cat-file --batch output must be a Buffer.');
  }

  const objects = [];
  let offset = 0;

  for (const expectedHash of expectedHashes) {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd === -1) {
      throw new Error(`git cat-file --batch ended before commit ${expectedHash}.`);
    }

    const header = batch.subarray(offset, headerEnd).toString('ascii');
    const match = header.match(/^([0-9a-f]{40,64})\s+(\S+)\s+(\d+)$/i);
    if (!match) {
      throw new Error(`git cat-file --batch returned an invalid header for commit ${expectedHash}: ${header}`);
    }

    const [, hash, type, sizeText] = match;
    if (hash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error(`git cat-file --batch returned ${hash} while reading ${expectedHash}.`);
    }
    if (type !== 'commit') {
      throw new Error(`Object ${hash} is ${type}, expected commit.`);
    }

    const size = Number(sizeText);
    const bodyStart = headerEnd + 1;
    const bodyEnd = bodyStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || bodyEnd >= batch.length) {
      throw new Error(`git cat-file --batch returned an invalid size for commit ${hash}.`);
    }
    if (batch[bodyEnd] !== 0x0a) {
      throw new Error(`git cat-file --batch did not terminate commit ${hash} correctly.`);
    }

    objects.push({ hash, body: batch.subarray(bodyStart, bodyEnd) });
    offset = bodyEnd + 1;
  }

  if (offset !== batch.length) {
    throw new Error('git cat-file --batch returned unexpected trailing data.');
  }

  return objects;
}

function parseCommit(hash, raw) {
  const separator = raw.indexOf(Buffer.from('\n\n'));
  if (separator === -1) throw new Error(`Commit ${hash} has no message separator.`);

  const headerLines = raw.subarray(0, separator).toString('utf8').split('\n');
  let tree = null;
  const parents = [];
  let author = null;
  let committer = null;
  const unpreservedHeaders = [];

  for (const line of headerLines) {
    if (line.startsWith(' ')) continue;
    const space = line.indexOf(' ');
    if (space <= 0) throw new Error(`Commit ${hash} has an invalid header.`);

    const name = line.slice(0, space);
    const value = line.slice(space + 1);
    if (name === 'tree') tree = value;
    else if (name === 'parent') parents.push(value);
    else if (name === 'author') author = parseIdentity(value, 'author', hash);
    else if (name === 'committer') committer = parseIdentity(value, 'committer', hash);

    if (name === 'encoding' || name === 'mergetag' || /^gpgsig(?:-.+)?$/.test(name)) {
      unpreservedHeaders.push(name);
    }
  }

  if (!tree || !author || !committer) {
    throw new Error(`Commit ${hash} is missing required metadata.`);
  }

  return {
    hash,
    shortHash: hash.slice(0, 7),
    tree,
    parents,
    authorName: author.name,
    authorEmail: author.email,
    authorDate: author.date,
    committerName: committer.name,
    committerEmail: committer.email,
    committerDate: committer.date,
    message: raw.subarray(separator + 2),
    unpreservedHeaders
  };
}

function parseIdentity(value, label, hash) {
  const match = value.match(/^(.*) <(.*)> (-?\d+) ([+-]\d{4})$/);
  if (!match) throw new Error(`Commit ${hash} has an invalid ${label} header.`);
  return {
    name: match[1],
    email: match[2],
    date: `${match[3]} ${match[4]}`
  };
}

module.exports = {
  rewriteDates,
  getCommitMetadata,
  _test: { parseBatchObjects, parseCommit, parseIdentity }
};
