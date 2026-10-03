// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { BaselineComparison, BaselineSuppressedFinding, Finding } from './types.js';

/**
 * Rules that emit at most one finding per location. Their id ignores the
 * message, so a version-number edit does not look like a new finding.
 */
const LOCATION_ONLY_RULES = new Set([
  'vibgrate/runtime-eol',
  'vibgrate/runtime-lag',
  'vibgrate/dependency-rot',
]);

const MAJOR_LAG_RULES = new Set([
  'vibgrate/framework-major-lag',
  'vibgrate/dependency-major-lag',
]);

/** "React is 2 major versions behind …" / "lodash is 3 major versions behind …" */
const MAJOR_LAG_NAME = /^(.+?) is \d+ major versions behind/;

/**
 * Content-derived id for a drift finding.
 *
 * First 16 hex characters of SHA-256 over `[ruleId, location, subject]`.
 * The subject keeps two findings at the same path distinct without copying
 * the message (which changes as versions move, and which must not be repeated
 * into the suppression record):
 *
 * - vulnerability findings: `advisoryId`, `ecosystem`, and `package` from `details`
 * - framework / dependency major-lag: the name that precedes "is N major versions behind"
 * - runtime EOL, runtime lag, dependency rot: nothing (rule + location is enough)
 * - any other rule: the message, so distinct findings do not collapse
 */
export function findingId(finding: Finding): string {
  const payload = JSON.stringify([finding.ruleId, finding.location, findingSubject(finding)]);
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Current findings whose id also appears in the baseline.
 * Sorted by ruleId, then location, then id. The input arrays are not modified,
 * and the result never includes the finding message.
 */
export function suppressedBaselineFindings(
  current: readonly Finding[],
  baseline: readonly Finding[],
): BaselineSuppressedFinding[] {
  const baselineIds = new Set<string>();
  for (const finding of baseline) {
    const normalized = asFinding(finding);
    if (normalized) baselineIds.add(findingId(normalized));
  }

  const suppressed: BaselineSuppressedFinding[] = [];
  const seen = new Set<string>();
  for (const finding of current) {
    const normalized = asFinding(finding);
    if (!normalized) continue;
    const id = findingId(normalized);
    if (!baselineIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    suppressed.push({ ruleId: normalized.ruleId, location: normalized.location, id });
  }

  suppressed.sort(compareSuppressed);
  return suppressed;
}

/**
 * Reference to the baseline file that is safe to store in a scan artifact.
 * Repo-relative, with `/` separators. A file outside the repo contributes
 * only its basename, so a home-directory path never enters the document.
 */
export function baselineFileReference(rootDir: string, baselinePath: string): string {
  const absRoot = path.resolve(rootDir);
  const absBaseline = path.resolve(baselinePath);
  const rel = path.relative(absRoot, absBaseline);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return path.basename(absBaseline);
  }
  return rel.split(path.sep).join('/');
}

/** "1 finding suppressed" / "2 findings suppressed". */
export function baselineSuppressionPhrase(count: number): string {
  const n = Number.isFinite(count) ? count : 0;
  return `${n} ${n === 1 ? 'finding' : 'findings'} suppressed`;
}

/**
 * Read a `baseline` block from a scan artifact. Returns undefined for the
 * legacy string path and for anything that is not a comparison record, so
 * older artifacts still format.
 */
export function readBaselineComparison(value: unknown): BaselineComparison | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.compared !== true || !Array.isArray(raw.suppressed)) return undefined;

  const suppressed: BaselineSuppressedFinding[] = [];
  for (const item of raw.suppressed) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.ruleId !== 'string' || typeof row.location !== 'string' || typeof row.id !== 'string') continue;
    suppressed.push({ ruleId: row.ruleId, location: row.location, id: row.id });
  }

  const suppressedCount = typeof raw.suppressedCount === 'number' && Number.isFinite(raw.suppressedCount)
    ? raw.suppressedCount
    : suppressed.length;

  return {
    compared: true,
    file: typeof raw.file === 'string' ? raw.file : '',
    suppressedCount,
    suppressed,
  };
}

/** Phrase for text/markdown, or undefined when this artifact did not compare a baseline. */
export function baselineSuppressionPhraseFrom(baseline: unknown): string | undefined {
  const comparison = readBaselineComparison(baseline);
  if (!comparison) return undefined;
  return baselineSuppressionPhrase(comparison.suppressedCount);
}

function findingSubject(finding: Finding): string {
  const fromDetails = subjectFromDetails(finding);
  if (fromDetails) return fromDetails;

  if (MAJOR_LAG_RULES.has(finding.ruleId)) {
    const name = nameBeforeMajorLag(finding.message);
    return name ? `name=${name}` : `message=${finding.message}`;
  }

  if (LOCATION_ONLY_RULES.has(finding.ruleId)) return '';
  return finding.message ? `message=${finding.message}` : '';
}

function subjectFromDetails(finding: Finding): string {
  const details = finding.details;
  if (!details || typeof details.advisoryId !== 'string' || !details.advisoryId) return '';
  const ecosystem = typeof details.ecosystem === 'string' ? details.ecosystem : '';
  const pkg = typeof details.package === 'string' ? details.package : '';
  return `advisoryId=${details.advisoryId}\necosystem=${ecosystem}\npackage=${pkg}`;
}

function nameBeforeMajorLag(message: string): string {
  const match = MAJOR_LAG_NAME.exec(message);
  return match?.[1]?.trim() ?? '';
}

function asFinding(value: unknown): Finding | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Partial<Finding>;
  if (typeof raw.ruleId !== 'string' || typeof raw.location !== 'string') return undefined;
  const level = raw.level === 'error' || raw.level === 'note' || raw.level === 'warning' ? raw.level : 'warning';
  const finding: Finding = {
    ruleId: raw.ruleId,
    level,
    message: typeof raw.message === 'string' ? raw.message : '',
    location: raw.location,
  };
  if (raw.details && typeof raw.details === 'object') finding.details = raw.details;
  return finding;
}

function compareSuppressed(a: BaselineSuppressedFinding, b: BaselineSuppressedFinding): number {
  return cmp(a.ruleId, b.ruleId) || cmp(a.location, b.location) || cmp(a.id, b.id);
}

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
