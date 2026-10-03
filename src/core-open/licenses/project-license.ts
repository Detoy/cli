/**
 * Project license evidence for scan JSON and SARIF.
 *
 * The scan already opens each project's manifest. When that manifest declares
 * a license, or a LICENSE / NOTICE / COPYING file sits beside it, the evidence
 * path is recorded on the project and emitted as a finding. Text that does not
 * parse as SPDX becomes a warning at that path instead of being dropped. The
 * file body is not copied into the artifact.
 *
 * Registry-only dependency licenses have no local file; they stay on the
 * dependency row and are not promoted to a finding.
 */
import * as path from 'node:path';
import type { DependencyLicense, Finding, ProjectScan } from '../types.js';
import { buildDependencyLicense, licenseEvidencePath } from './dependency-license.js';
import { normalizeLicense } from './normalize.js';

/** Evidence filenames, most specific first. First file that exists wins. */
export const LICENSE_EVIDENCE_FILES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.txt',
  'NOTICE',
  'NOTICE.md',
  'NOTICE.txt',
] as const;

export interface LicenseIo {
  exists(absPath: string): Promise<boolean>;
  readText(absPath: string): Promise<string>;
  readJson(absPath: string): Promise<unknown>;
}

/** A manifest `license` value reduced to a declared string, if it has one. */
export function licenseRawFromManifest(value: unknown): { present: boolean; raw: string | null } {
  if (value == null) return { present: false, raw: null };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? { present: true, raw: trimmed } : { present: false, raw: null };
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const part = licenseRawFromManifest(item);
      if (part.raw) parts.push(part.raw);
      else if (part.present) return { present: true, raw: null };
    }
    if (parts.length === 0) return { present: value.length > 0, raw: null };
    return { present: true, raw: parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})` };
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.type === 'string' && obj.type.trim()) return { present: true, raw: obj.type.trim() };
    if (typeof obj.spdx === 'string' && obj.spdx.trim()) return { present: true, raw: obj.spdx.trim() };
    return { present: true, raw: null };
  }
  return { present: true, raw: null };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Classify a short excerpt of a license file. Returns an SPDX id when the
 * SPDX tag or the first non-empty line resolves; otherwise raw stays null so
 * the file body is not stored.
 */
export function classifyLicenseExcerpt(text: string): { raw: string | null; spdxId: string | null; confidence: number } {
  const excerpt = stripBom(text).slice(0, 1024);
  const tagged = /SPDX-License-Identifier:\s*([A-Za-z0-9.\-+]+)/.exec(excerpt);
  const candidate = tagged?.[1] ?? firstNonEmptyLine(excerpt);
  if (!candidate) return { raw: null, spdxId: null, confidence: 0 };
  const verdict = normalizeLicense(candidate);
  if (verdict.matchStatus === 'unknown') return { raw: null, spdxId: null, confidence: 0 };
  return {
    raw: candidate.slice(0, 200),
    spdxId: verdict.spdxId,
    confidence: verdict.confidence,
  };
}

function firstNonEmptyLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed.slice(0, 120);
  }
  return null;
}

function repoPath(projectPath: string, name: string): string {
  const base = projectPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!base || base === '.') return name;
  return `${base}/${name}`;
}

function absUnder(rootDir: string, relPosix: string): string {
  return path.join(rootDir, ...relPosix.split('/'));
}

/**
 * Detect one project's declared license. Manifest `license` wins over a
 * sibling license file. Returns undefined when nothing was declared.
 */
export async function detectProjectLicense(
  rootDir: string,
  projectPath: string,
  io: LicenseIo,
): Promise<DependencyLicense | undefined> {
  const manifestRel = repoPath(projectPath, 'package.json');
  const manifestAbs = absUnder(rootDir, manifestRel);
  if (await io.exists(manifestAbs)) {
    try {
      const json = await io.readJson(manifestAbs);
      const field = json && typeof json === 'object' ? (json as Record<string, unknown>).license : undefined;
      const parsed = licenseRawFromManifest(field);
      if (parsed.present) {
        if (parsed.raw) return buildDependencyLicense(parsed.raw, 'manifest', manifestRel);
        return { raw: null, spdxId: null, source: 'manifest', confidence: 0, path: manifestRel };
      }
    } catch {
      // Unreadable manifest — a sibling license file can still be evidence.
    }
  }

  for (const name of LICENSE_EVIDENCE_FILES) {
    const rel = repoPath(projectPath, name);
    const abs = absUnder(rootDir, rel);
    if (!(await io.exists(abs))) continue;
    let text = '';
    try {
      text = await io.readText(abs);
    } catch {
      return { raw: null, spdxId: null, source: 'license-file', confidence: 0, path: rel };
    }
    const classified = classifyLicenseExcerpt(text);
    return {
      raw: classified.raw,
      spdxId: classified.spdxId,
      source: 'license-file',
      confidence: classified.confidence,
      path: rel,
    };
  }
  return undefined;
}

/** Attach {@link ProjectScan.license} for every project that has evidence. */
export async function attachProjectLicenses(
  projects: readonly ProjectScan[],
  rootDir: string,
  io: LicenseIo,
): Promise<void> {
  await Promise.all(projects.map(async (project) => {
    const license = await detectProjectLicense(rootDir, project.path, io);
    if (license) project.license = license;
  }));
}

/**
 * A finding for a license that has a source path. Parseable licenses are
 * notes; unparseable ones are warnings that name the file. No path → no
 * finding (registry signals stay on the dependency row).
 */
export function findingForLicense(license: DependencyLicense): Finding | null {
  const evidence = licenseEvidencePath(license.path);
  if (!evidence || license.source === 'none') return null;
  if (license.spdxId) {
    return {
      ruleId: 'vibgrate/license',
      level: 'note',
      message: `Declared license ${license.spdxId} at ${evidence}.`,
      location: evidence,
      details: {
        source: license.source,
        path: evidence,
        spdxId: license.spdxId,
      },
    };
  }
  return {
    ruleId: 'vibgrate/unparseable-license',
    level: 'warning',
    message: `Unparseable license text at ${evidence}.`,
    location: evidence,
    details: {
      source: license.source,
      path: evidence,
      ...(license.raw ? { raw: license.raw } : {}),
    },
  };
}

/**
 * License findings for a scan, sorted by path then rule so output does not
 * follow project discovery order. One finding per path and rule.
 */
export function licenseFindingsForProjects(projects: readonly ProjectScan[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const ordered = [...projects].sort(
    (a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name) || a.type.localeCompare(b.type),
  );
  for (const project of ordered) {
    const candidates: DependencyLicense[] = [];
    if (project.license?.path) candidates.push(project.license);
    const deps = [...project.dependencies].sort(
      (a, b) => a.package.localeCompare(b.package) || a.section.localeCompare(b.section),
    );
    for (const dep of deps) {
      if (dep.license?.path) candidates.push(dep.license);
    }
    for (const license of candidates) {
      const finding = findingForLicense(license);
      if (!finding) continue;
      const key = `${finding.ruleId}\0${finding.location}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finding);
    }
  }
  out.sort((a, b) => a.location.localeCompare(b.location) || a.ruleId.localeCompare(b.ruleId));
  return out;
}
