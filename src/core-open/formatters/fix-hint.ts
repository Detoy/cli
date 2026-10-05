// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Human hint for a published fix already present on a scan result.
 *
 * A non-empty list of fixed versions is the only signal treated as "a fix is
 * available". An empty list, a missing field, or blank entries are absence:
 * callers print nothing. This never returns a "no fix" claim — absence is not
 * evidence that no fix exists, and we do not look one up.
 */

const FALSE_NO_FIX = / — no fix available/g;

/** Concise hint, or `''` when fix metadata is absent. Order follows the input. */
export function fixAvailableHint(fixedVersions: unknown): string {
  if (!Array.isArray(fixedVersions)) return '';
  const versions: string[] = [];
  for (const raw of fixedVersions) {
    if (typeof raw !== 'string') continue;
    const version = raw.trim();
    if (!version || /[\r\n]/.test(version) || versions.includes(version)) continue;
    versions.push(version);
  }
  if (versions.length === 0) return '';
  return `fix available (${versions.join(', ')})`;
}

/**
 * Finding text for the default human report.
 *
 * Drops a stored "no fix available" claim (that phrase was inferred from a
 * missing list). Adds a hint line only when `details.fixedVersions` is
 * present and the message does not already state it.
 */
export function humanFindingText(finding: {
  message: string;
  details?: Record<string, unknown> | null;
}): { message: string; hint: string | null } {
  const message = finding.message.replace(FALSE_NO_FIX, '');
  const fixedVersions = finding.details?.fixedVersions;
  const hint = fixAvailableHint(fixedVersions);
  if (!hint || message.includes('fix available')) return { message, hint: null };
  return { message, hint };
}
