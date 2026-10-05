// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { createHash } from 'node:crypto';
import type { BaselineComparison, BaselineSuppression, Finding } from './types.js';

/**
 * Stable id for a drift finding suppressed because the baseline already
 * recorded the same rule at the same location. The message is not part of the
 * id: wording can change without looking like a new finding.
 */
export function baselineSuppressionId(ruleId: string, location: string): string {
  const input = `vg-baseline-suppression/v1\n${ruleId.length}\n${ruleId}\n${location.length}\n${location}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

function isSuppressionRef(value: unknown): value is Pick<Finding, 'ruleId' | 'location'> {
  if (!value || typeof value !== 'object') return false;
  const rec = value as { ruleId?: unknown; location?: unknown };
  return typeof rec.ruleId === 'string' && rec.ruleId.length > 0
    && typeof rec.location === 'string' && rec.location.length > 0;
}

function compareSuppression(a: BaselineSuppression, b: BaselineSuppression): number {
  if (a.ruleId < b.ruleId) return -1;
  if (a.ruleId > b.ruleId) return 1;
  if (a.location < b.location) return -1;
  if (a.location > b.location) return 1;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Findings in `current` whose rule and location already appear in
 * `baselineFindings`. One record per id. Sorted by ruleId, location, then id.
 * Baseline-only findings are not listed — nothing in the current scan was
 * suppressed for them.
 */
export function compareBaselineFindings(
  current: readonly Finding[],
  baselineFindings: readonly unknown[],
): BaselineComparison {
  const known = new Set<string>();
  for (const finding of baselineFindings) {
    if (!isSuppressionRef(finding)) continue;
    known.add(baselineSuppressionId(finding.ruleId, finding.location));
  }

  const byId = new Map<string, BaselineSuppression>();
  for (const finding of current) {
    if (!isSuppressionRef(finding)) continue;
    const id = baselineSuppressionId(finding.ruleId, finding.location);
    if (!known.has(id) || byId.has(id)) continue;
    byId.set(id, { ruleId: finding.ruleId, location: finding.location, id });
  }

  const suppressed = [...byId.values()].sort(compareSuppression);
  return {
    compared: true,
    suppressedCount: suppressed.length,
    suppressed,
  };
}

/** Human-readable count. Uses the list length so the sentence matches the record. */
export function baselineSuppressionLabel(comparison: BaselineComparison | undefined): string | null {
  if (!comparison?.compared) return null;
  const count = comparison.suppressed.length;
  return count === 1
    ? '1 finding suppressed by baseline'
    : `${count} findings suppressed by baseline`;
}
