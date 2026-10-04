/**
 * Human-readable "fix available" hints for scan and report text.
 *
 * Reads fix / remediation fields already present on a finding. Does not look
 * anything up. When those fields are missing or empty the hint is null —
 * callers omit the line rather than claiming there is no fix.
 */

/** Exact clause older scan messages appended when `fixedVersions` was empty. */
const NO_FIX_CLAIM = ' — no fix available';

/** Drop a stored "no fix" claim from a finding message before human display. */
export function findingDisplayMessage(message: string): string {
  return message.replace(NO_FIX_CLAIM, '');
}

/**
 * Concise hint when the finding payload already names a fixed version or a
 * remediation. `null` when that metadata is absent — never "no fix".
 *
 * Version order follows the payload (already deterministic for a given scan).
 * Blanks and duplicates are dropped; the first occurrence of each version wins.
 */
export function fixAvailableHint(details: Record<string, unknown> | undefined | null): string | null {
  if (!details || typeof details !== 'object') return null;

  const versions = readVersions(details);
  if (versions.length > 0) return `fix available: ${versions.join(', ')}`;

  const remediation = readRemediation(details.remediation);
  if (remediation) return `fix available: ${remediation}`;

  return null;
}

/** Message plus optional hint line for the default human text path. */
export function presentFinding(finding: {
  message: string;
  details?: Record<string, unknown> | null;
}): { message: string; hint: string | null } {
  return {
    message: findingDisplayMessage(finding.message),
    hint: fixAvailableHint(finding.details),
  };
}

function readVersions(details: Record<string, unknown>): string[] {
  const raw = details.fixedVersions ?? details.fixedVersion;
  const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const version = item.trim();
    if (!version || seen.has(version)) continue;
    seen.add(version);
    out.push(version);
  }
  return out;
}

function readRemediation(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().replace(/\s+/g, ' ');
  return text.length > 0 ? text : null;
}
