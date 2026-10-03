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
 * A registry signal has no local evidence file, so `path` stays omitted and an
 * unparseable registry string is kept on the dependency row (`raw` retained,
 * `spdxId` null) rather than promoted to a finding. When the caller already
 * has a manifest or license-file path, pass it — an unknown SPDX id is still
 * returned (not dropped) so the scan can point at that file.
 */
import type { DependencyLicense } from '../types.js';
import { normalizeLicense } from './normalize.js';

/** Repo-relative evidence path, or undefined when the caller has none. */
export function licenseEvidencePath(input: string | null | undefined): string | undefined {
  if (!input) return undefined;
  const norm = input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return norm || undefined;
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
