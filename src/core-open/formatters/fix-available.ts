/**
 * Human "fix available" hints for `vg scan` / `vg report` text.
 *
 * The hint is derived only from fix or remediation metadata already on the
 * finding. When that metadata is absent, callers omit the hint — they must
 * not invent a "no fix" claim.
 */

/** A finding message plus the optional hint to print under it. */
export interface FindingPresentation {
  message: string;
  /** `fix available: …`, or null when the payload has no known fix. */
  fixHint: string | null;
}

const VERSION_LIST_KEYS = ['fixedVersions', 'fixed_versions', 'patchedVersions', 'patched_versions'] as const;
const VERSION_KEYS = ['fixedVersion', 'fixed_version', 'patchedVersion', 'patched_version'] as const;
const TEXT_KEYS = ['remediation', 'fix'] as const;

/** Dash that starts a clause in a finding message (em, en, or a spaced hyphen). */
const CLAUSE_DASH = String.raw`(?:—|–|\s+-\s+)`;

/** Baked-in "no fix" claim. Stripped from human text; never a real signal. */
const NO_FIX_CLAUSE = new RegExp(String.raw`\s*${CLAUSE_DASH}\s*no fix(?: available)?\b`, 'gi');

/**
 * Prose "fixed in <versions>" clause. Dropped from human text only when a
 * structured version hint replaces it, so the version is not printed twice.
 * Stops at the next clause (for example attribution) and keeps hyphens that
 * belong to a version (`1.2.3-beta.1`).
 */
const FIXED_IN_CLAUSE = new RegExp(
  String.raw`\s*${CLAUSE_DASH}\s*fixed in\s+.*?(?=\s*${CLAUSE_DASH}|$)`,
  'gi',
);

const UNKNOWN_TEXT = /^(?:no fix(?: available)?|none|unknown|n\/a|null|undefined|-)$/i;

function pushVersion(out: string[], value: unknown): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (!trimmed || UNKNOWN_TEXT.test(trimmed) || out.includes(trimmed)) return;
  out.push(trimmed);
}

function collectVersions(details: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of VERSION_LIST_KEYS) {
    const value = details[key];
    if (Array.isArray(value)) {
      for (const item of value) pushVersion(out, item);
    } else {
      pushVersion(out, value);
    }
  }
  for (const key of VERSION_KEYS) pushVersion(out, details[key]);
  return out;
}

function remediationText(details: Record<string, unknown>): string | null {
  for (const key of TEXT_KEYS) {
    const value = details[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || UNKNOWN_TEXT.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

/**
 * `fix available: …` when `details` already names a fixed version or a
 * remediation. Null when the fix is unknown — including an empty list, a
 * false flag, or a placeholder such as "none".
 *
 * Version order is the payload's order (first list key, then single-version
 * keys), with duplicates removed. Identical details therefore render the
 * same hint.
 */
export function fixAvailableHint(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  const versions = collectVersions(details);
  if (versions.length > 0) return `fix available: ${versions.join(', ')}`;
  const text = remediationText(details);
  if (text) return `fix available: ${text}`;
  return null;
}

/** Human message plus hint. Does not mutate the finding. */
export function presentFinding(finding: { message: string; details?: Record<string, unknown> }): FindingPresentation {
  const versions = finding.details ? collectVersions(finding.details) : [];
  const fixHint = fixAvailableHint(finding.details);
  let message = finding.message.replace(NO_FIX_CLAUSE, '');
  // A version hint replaces the prose "fixed in …" clause. A remediation
  // string does not, because that clause may be the only copy of the version.
  if (versions.length > 0) message = message.replace(FIXED_IN_CLAUSE, '');
  message = message.replace(/[ \t]{2,}/g, ' ').trim();
  return { message, fixHint };
}
