'use strict';

function findChronologyConflicts(commits, changes = [], maxCommits = 200) {
  const changedTimes = new Map(
    changes
      .filter(change => Number.isInteger(change.index) && typeof change.time === 'string' && change.time.length > 0)
      .map(change => [change.index, change.time])
  );
  const conflicts = [];
  const edgeCount = Math.min(maxCommits, Math.max(0, commits.length - 1));

  for (let childIndex = 0; childIndex < edgeCount; childIndex += 1) {
    const parentIndex = childIndex + 1;
    const child = commits[childIndex];
    const parent = commits[parentIndex];
    const childTime = changedTimes.get(childIndex) || child.authorDate;
    const parentTime = changedTimes.get(parentIndex) || parent.authorDate;
    const childMs = Date.parse(childTime);
    const parentMs = Date.parse(parentTime);

    if (!Number.isFinite(childMs)) {
      throw new Error(`Commit HEAD~${childIndex}: invalid Author Date ${childTime}.`);
    }
    if (!Number.isFinite(parentMs)) {
      throw new Error(`Commit HEAD~${parentIndex}: invalid Author Date ${parentTime}.`);
    }
    if (childMs < parentMs) {
      conflicts.push({
        childIndex,
        parentIndex,
        childHash: child.hash,
        parentHash: parent.hash,
        childTime,
        parentTime
      });
    }
  }

  return conflicts;
}

async function assertChronologicalHistory(git, cwd, changes, head = 'HEAD', maxCommits = 200) {
  const format = '%H%x1f%aI%x1e';
  const stdout = await git(cwd, [
    'log',
    '--first-parent',
    `-n${maxCommits + 1}`,
    `--pretty=format:${format}`,
    head
  ], 8 * 1024 * 1024);
  const commits = stdout
    .split('\x1e')
    .map(record => record.replace(/^\r?\n|\r?\n$/g, ''))
    .filter(Boolean)
    .map(record => {
      const [hash, authorDate] = record.split('\x1f');
      return { hash, authorDate };
    });

  const [conflict] = findChronologyConflicts(commits, changes, maxCommits);
  if (!conflict) return;

  throw new Error(
    `Commit HEAD~${conflict.childIndex} (${conflict.childHash.slice(0, 7)}) has Author Date ${conflict.childTime}, ` +
    `which is earlier than its parent HEAD~${conflict.parentIndex} (${conflict.parentHash.slice(0, 7)}) at ${conflict.parentTime}.`
  );
}

module.exports = { findChronologyConflicts, assertChronologicalHistory };
