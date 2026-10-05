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
 */
import type { DependencyLicense } from '../types.js';
import { normalizeLicense } from './normalize.js';

/** Long enough for a deep monorepo path; longer evidence is not a stable location. */
const SOURCE_PATH_MAX = 1024;

/**
 * Repo-relative path of a license declaration.
 *
 * Forward slashes, no leading `./`, no absolute path, no parent traversal,
 * no URI. Returns null when the value is absent or not a path inside the
 * repo. A path that passes these checks is returned unchanged in substance
 * — callers must not drop it.
 */
export function normalizeLicenseSourcePath(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  let p = value.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/+$/, '');
  if (!p || p.length > SOURCE_PATH_MAX) return null;
  if (p.startsWith('/')) return null;
  if (/^[a-zA-Z]:\//.test(p)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null;
  if (/[\u0000-\u001f]/.test(p)) return null;
  const segments = p.split('/');
  if (segments.some((seg) => seg.length === 0 || seg === '.' || seg === '..')) return null;
  return segments.join('/');
}

export function buildDependencyLicense(
  raw: string | null | undefined,
  source: DependencyLicense['source'],
  sourcePath?: string | null,
): DependencyLicense {
  const path = normalizeLicenseSourcePath(sourcePath);
  const located = path ? { sourcePath: path } : {};
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return { raw: null, spdxId: null, source: 'none', confidence: 0, ...located };
  }
  const verdict = normalizeLicense(trimmed);
  return {
    raw: trimmed.slice(0, 200),
    spdxId: verdict.matchStatus === 'unknown' ? null : verdict.spdxId,
    source,
    confidence: verdict.confidence,
    ...located,
  };
}
