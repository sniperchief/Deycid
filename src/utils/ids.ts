import { randomUUID } from 'node:crypto';

let caseCounter = 1041;

/**
 * Human-friendly sequential case number, unique within a server process.
 * Cases live in memory for the life of the process, so a counter is enough;
 * the uuid-backed `newId` is used wherever collisions would actually matter.
 */
export function nextCaseId(): string {
  caseCounter += 1;
  return `case-${caseCounter}`;
}

/** Short display form: `case-1042` -> `#1042`. */
export function caseNumber(caseId: string): string {
  const tail = caseId.split('-').pop();
  return tail ? `#${tail}` : caseId;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Test seam so id-sensitive assertions stay stable. */
export function __resetCaseCounterForTests(value = 1041): void {
  caseCounter = value;
}
