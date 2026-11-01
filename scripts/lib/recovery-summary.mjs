import { createHash } from 'node:crypto';

function sortedEntries(record) {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

export function compareCounts(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const differences = names
    .filter((name) => before[name] !== after[name])
    .map((name) => ({
      name,
      before: before[name] ?? null,
      after: after[name] ?? null,
    }));
  return {
    status: differences.length === 0 ? 'PASS' : 'FAIL',
    differences,
  };
}

export function assertNoDuplicateEventIds(eventIds) {
  const duplicates = [
    ...new Set(eventIds.filter((value, index) => eventIds.indexOf(value) !== index)),
  ];
  return {
    status: duplicates.length === 0 ? 'PASS' : 'FAIL',
    unique: new Set(eventIds).size,
    duplicates,
  };
}

export function assertNoDuplicateVectors(vectors) {
  const keys = vectors.map((vector) => vector.vectorId);
  return assertNoDuplicateEventIds(keys);
}

export function assertNoActiveOrphans(manifest) {
  const orphans = manifest.filter((entry) => entry.active === true && entry.referenced !== true);
  return {
    status: orphans.length === 0 ? 'PASS' : 'FAIL',
    orphanCount: orphans.length,
    objectKeyHashes: orphans.map((entry) =>
      createHash('sha256')
        .update(String(entry.objectKeyHash ?? ''))
        .digest('hex'),
    ),
  };
}

export function normalizeRecovery(input) {
  const counts = compareCounts(input.beforeCounts, input.afterCounts);
  const events = assertNoDuplicateEventIds(input.eventIds);
  const vectors = assertNoDuplicateVectors(input.vectors);
  const orphans = assertNoActiveOrphans(input.objects);
  const health = {
    status: input.health?.healthz === 200 && input.health?.readyz === 200 ? 'PASS' : 'FAIL',
    healthz: input.health?.healthz ?? null,
    readyz: input.health?.readyz ?? null,
  };
  const failures = [counts, events, vectors, orphans, health].filter(
    (item) => item.status === 'FAIL',
  );
  const blockers = input.blockers ?? [];
  return {
    schemaVersion: 1,
    changeId: input.changeId,
    candidateSha: input.candidateSha,
    isolatedSource: input.isolatedSource,
    isolatedRestore: input.isolatedRestore,
    commands: input.commands,
    beforeCounts: Object.fromEntries(sortedEntries(input.beforeCounts)),
    afterCounts: Object.fromEntries(sortedEntries(input.afterCounts)),
    counts,
    events,
    vectors,
    objects: orphans,
    health,
    status: failures.length > 0 ? 'FAIL' : blockers.length > 0 ? 'SCOPED_BLOCKED' : 'PASS',
    blockers,
  };
}
