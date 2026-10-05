// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Helper for ecosystem scanners: turn a declared license string into the
 * compact DependencyLicense carrier stored on each DependencyRow.
 *
 * The scanner records the raw declared string plus a best-effort canonical
 * SPDX id; full classification (category / obligations / risk) and the growing
 * library lookup happen during API enrichment.
 *
 * A registry signal has no local file, so `path` stays omitted. Pass
 * `evidencePath` when the declaration was read from a manifest or license
 * file — scan JSON and SARIF then point the finding at that file instead of
 * dropping the path.
 */
import type { DependencyLicense } from '../types.js';
import { normalizeLicense } from './normalize.js';

/**
 * Repo-relative evidence path, or undefined when the caller has none.
 * Rejects absolute paths and `..` so a finding never points outside the repo.
 * Deterministic: only string rewriting, no filesystem access.
 */
export function licenseEvidencePath(input: string | null | undefined): string | undefined {
  if (typeof input !== 'string') return undefined;
  const norm = input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!norm || norm === '.') return undefined;
  if (norm.startsWith('/') || /^[A-Za-z]:\//.test(norm)) return undefined;
  const parts = norm.split('/');
  if (parts.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined;
  return norm;
}

export function buildDependencyLicense(
  raw: string | null | undefined,
  source: DependencyLicense['source'],
  evidencePath?: string | null,
): DependencyLicense {
  const path = licenseEvidencePath(evidencePath);
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { raw: null, spdxId: null, source: 'none', confidence: 0, ...(path ? { path } : {}) };
  }
  const verdict = normalizeLicense(trimmed);
  return {
    raw: trimmed.slice(0, 200),
    spdxId: verdict.matchStatus === 'unknown' ? null : verdict.spdxId,
    source,
    confidence: verdict.confidence,
    ...(path ? { path } : {}),
  };
}
