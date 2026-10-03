import { createHash } from 'node:crypto';
import type { BaselineComparison, BaselineSuppressedFinding } from './types.js';

/**
 * Fields that identify a drift finding across a baseline and a later scan.
 * The message is part of the id, so a changed finding is not recorded as
 * suppressed.
 */
export interface DriftFindingIdentity {
  ruleId: string;
  level: string;
  location: string;
  message: string;
}

/**
 * Content id for a drift finding. 32 lowercase hex characters (128 bits of
 * SHA-256). Parts are length-prefixed so concatenation cannot collide, and
 * the digest does not depend on object key order, clock, or map iteration.
 */
export function driftFindingId(finding: DriftFindingIdentity): string {
  const payload = [finding.ruleId, finding.level, finding.location, finding.message]
    .map(encodePart)
    .join('\n');
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function encodePart(value: string): string {
  return `${Buffer.byteLength(value, 'utf8')}:${value}`;
}

function isIdentity(value: unknown): value is DriftFindingIdentity {
  if (!value || typeof value !== 'object') return false;
  const finding = value as Record<string, unknown>;
  return typeof finding.ruleId === 'string'
    && typeof finding.level === 'string'
    && typeof finding.location === 'string'
    && typeof finding.message === 'string';
}

/**
 * Findings in `current` that already appear in `baseline`. Does not remove
 * or reorder `current`. `suppressed` is sorted by ruleId, then location,
 * then id. Duplicate ids collapse to one record.
 */
export function compareBaselineFindings(
  current: readonly unknown[],
  baseline: readonly unknown[] | undefined,
): BaselineComparison {
  const baselineIds = new Set<string>();
  if (baseline) {
    for (const finding of baseline) {
      if (isIdentity(finding)) baselineIds.add(driftFindingId(finding));
    }
  }

  const suppressed: BaselineSuppressedFinding[] = [];
  const seen = new Set<string>();
  for (const finding of current) {
    if (!isIdentity(finding)) continue;
    const id = driftFindingId(finding);
    if (!baselineIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    suppressed.push({ ruleId: finding.ruleId, location: finding.location, id });
  }

  suppressed.sort(compareSuppressed);
  return {
    compared: true,
    suppressedCount: suppressed.length,
    suppressed,
  };
}

function compareSuppressed(a: BaselineSuppressedFinding, b: BaselineSuppressedFinding): number {
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  if (a.location !== b.location) return a.location < b.location ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** Count line shared by text and Markdown reports. */
export function baselineSuppressionSummary(count: number): string {
  return `Baseline suppressions: ${count}`;
}

/** Ids recorded on a comparison, or an empty set when no baseline was compared. */
export function baselinedIdSet(comparison: BaselineComparison | undefined): Set<string> {
  const ids = new Set<string>();
  if (!comparison) return ids;
  for (const entry of comparison.suppressed) ids.add(entry.id);
  return ids;
}
