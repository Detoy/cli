// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Local license evidence for scan findings.
 *
 * Dependency licenses that come from a registry response have no file in the
 * repo. Those stay on the dependency row (`license.raw`, `license.spdxId`)
 * and are not turned into findings — there is no path to point a human at.
 *
 * When the scan already has a project directory, this module reads the
 * declaration the pipeline can actually name:
 *
 *   - `package.json` `license` / `licenses`, when that manifest is present
 *   - a fixed set of license and NOTICE filenames in the same directory
 *
 * A declaration that does not resolve to a known SPDX id becomes a
 * `vibgrate/license-unparseable` finding whose `location` and `details.path`
 * are the repo-relative POSIX path of that file. The license body is never
 * copied into the artifact. Paths are sorted; directory enumeration order is
 * not used.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Finding } from '../types.js';
import { stripBom } from '../utils/fs.js';
import { normalizeLicense } from './normalize.js';

export const LICENSE_UNPARSEABLE_RULE_ID = 'vibgrate/license-unparseable';

/** Bytes read from a license file. Enough for an SPDX tag or a title. */
const PREFIX_BYTES = 4096;
/** Title lines longer than this are prose, not an SPDX declaration. */
const TITLE_LINE_MAX = 120;
/** How many leading non-empty lines may identify a standard license text. */
const HEADER_LINE_LIMIT = 15;

const EVIDENCE_FILES: ReadonlyArray<{ name: string; source: LicenseEvidenceSource }> = [
  { name: 'COPYING', source: 'license-file' },
  { name: 'COPYING.md', source: 'license-file' },
  { name: 'COPYING.txt', source: 'license-file' },
  { name: 'LICENCE', source: 'license-file' },
  { name: 'LICENCE.md', source: 'license-file' },
  { name: 'LICENCE.txt', source: 'license-file' },
  { name: 'LICENSE', source: 'license-file' },
  { name: 'LICENSE.md', source: 'license-file' },
  { name: 'LICENSE.txt', source: 'license-file' },
  { name: 'NOTICE', source: 'notice' },
  { name: 'NOTICE.md', source: 'notice' },
  { name: 'NOTICE.txt', source: 'notice' },
];

/**
 * Title patterns for the well-known license texts that ship without an
 * SPDX-License-Identifier line. More specific GNU titles come first.
 * Matched only against the bounded prefix, never against the whole file.
 */
const STANDARD_HEADERS: readonly RegExp[] = [
  /\bgnu affero general public license\b/i,
  /\bgnu lesser general public license\b/i,
  /\bgnu library general public license\b/i,
  /\bgnu general public license\b/i,
  /\bapache license\b/i,
  /\bmit license\b/i,
  /\bmozilla public license\b/i,
  /\bbsd license\b/i,
  /\bisc license\b/i,
  /\bthe unlicense\b/i,
];

export type LicenseEvidenceSource = 'manifest' | 'license-file' | 'notice';

export interface LicenseEvidence {
  /** Repo-relative POSIX path. Never absolute. */
  path: string;
  source: LicenseEvidenceSource;
}

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** True when normalization resolved a real SPDX id (including a fuzzy manifest match). */
export function isIdentifiedDeclaration(raw: string): boolean {
  const verdict = normalizeLicense(raw);
  return verdict.matchStatus !== 'unknown' && verdict.spdxId !== 'NOASSERTION';
}

/**
 * Exact, alias, or expression match. Fuzzy hits are rejected so a prose line
 * that merely mentions "MIT" is not treated as a parsed license file.
 */
function isStrictDeclaration(raw: string): boolean {
  const verdict = normalizeLicense(raw);
  if (verdict.matchStatus === 'unknown' || verdict.matchStatus === 'fuzzy') return false;
  return verdict.spdxId !== 'NOASSERTION';
}

/**
 * Reduce a manifest `license` / `licenses` value to one string.
 * `null` means the value was present but not a license string (object without
 * `type`/`spdx`, a number, …) — that is an unparseable declaration.
 * `''` means blank, which is absence rather than a failed parse.
 */
export function declaredLicenseText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const part = declaredLicenseText(item);
      if (part === null) return null;
      if (part) parts.push(part);
    }
    if (parts.length === 0) return '';
    return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.type === 'string') return obj.type.trim();
    if (typeof obj.spdx === 'string') return obj.spdx.trim();
    return null;
  }
  return null;
}

function manifestStatus(value: unknown): 'absent' | 'identified' | 'unparseable' {
  if (value === undefined || value === null) return 'absent';
  const text = declaredLicenseText(value);
  if (text === null) return 'unparseable';
  if (!text) return 'absent';
  return isIdentifiedDeclaration(text) ? 'identified' : 'unparseable';
}

function firstSpdxDeclaration(prefix: string): string | null {
  for (const line of prefix.split(/\r?\n/)) {
    const match = /SPDX-License-Identifier:\s*(.+)$/i.exec(line);
    if (!match?.[1]) continue;
    const value = match[1].replace(/\*\/\s*$/, '').replace(/-->\s*$/, '').trim();
    if (value) return value.slice(0, 200);
  }
  return null;
}

/** `identified` when the prefix names a known license; otherwise `unparseable`. */
export function classifyLicensePrefix(prefix: string): 'identified' | 'unparseable' {
  const text = stripBom(prefix).replace(/\u0000/g, '');
  const spdx = firstSpdxDeclaration(text);
  if (spdx !== null) {
    return isIdentifiedDeclaration(spdx) ? 'identified' : 'unparseable';
  }

  let seen = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    seen += 1;
    if (STANDARD_HEADERS.some((pattern) => pattern.test(trimmed))) return 'identified';
    if (trimmed.length <= TITLE_LINE_MAX && isStrictDeclaration(trimmed)) return 'identified';
    if (seen >= HEADER_LINE_LIMIT) break;
  }
  return 'unparseable';
}

/** Repo-relative POSIX path, or null when `filePath` escapes `rootDir`. */
export function repoRelativePosix(rootDir: string, filePath: string): string | null {
  const rel = path.relative(rootDir, filePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const posix = rel.split(/[/\\]/).join('/');
  if (!posix || posix.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return posix;
}

type ReadResult =
  | { kind: 'text'; text: string }
  | { kind: 'unreadable' }
  | { kind: 'skip' };

async function readEvidenceFile(rootDir: string, filePath: string): Promise<ReadResult> {
  let realPath = filePath;
  try {
    const st = await fs.lstat(filePath);
    if (st.isSymbolicLink()) {
      realPath = await fs.realpath(filePath);
      if (repoRelativePosix(rootDir, realPath) === null) return { kind: 'skip' };
      const target = await fs.stat(realPath);
      if (!target.isFile()) return { kind: 'skip' };
    } else if (!st.isFile()) {
      return { kind: 'skip' };
    }
  } catch {
    return { kind: 'skip' };
  }

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(realPath, 'r');
    const buf = Buffer.alloc(PREFIX_BYTES);
    const { bytesRead } = await handle.read(buf, 0, PREFIX_BYTES, 0);
    return { kind: 'text', text: buf.subarray(0, bytesRead).toString('utf8') };
  } catch {
    return { kind: 'unreadable' };
  } finally {
    await handle?.close();
  }
}

async function manifestLicenseValue(manifestPath: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed: unknown = JSON.parse(stripBom(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, 'license') && record.license != null) {
      return record.license;
    }
    if (Object.prototype.hasOwnProperty.call(record, 'licenses') && record.licenses != null) {
      return record.licenses;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function evidenceForDirectory(rootDir: string, projectDir: string): Promise<LicenseEvidence[]> {
  const found: LicenseEvidence[] = [];

  const manifestPath = path.join(projectDir, 'package.json');
  const manifestRel = repoRelativePosix(rootDir, manifestPath);
  if (manifestRel) {
    let exists = false;
    try {
      exists = (await fs.lstat(manifestPath)).isFile();
    } catch {
      exists = false;
    }
    if (exists && manifestStatus(await manifestLicenseValue(manifestPath)) === 'unparseable') {
      found.push({ path: manifestRel, source: 'manifest' });
    }
  }

  for (const file of EVIDENCE_FILES) {
    const abs = path.join(projectDir, file.name);
    const rel = repoRelativePosix(rootDir, abs);
    if (!rel) continue;
    const read = await readEvidenceFile(rootDir, abs);
    if (read.kind === 'skip') continue;
    if (read.kind === 'unreadable' || classifyLicensePrefix(read.text) === 'unparseable') {
      found.push({ path: rel, source: file.source });
    }
  }

  return found;
}

function uniqueProjectDirs(rootDir: string, projects: ReadonlyArray<{ path: string }>): string[] {
  const byKey = new Map<string, string>();
  for (const project of projects) {
    const raw = project.path && project.path !== '.' ? project.path : '.';
    const abs = path.resolve(rootDir, raw);
    const rel = path.relative(rootDir, abs);
    if (!rel) {
      if (!byKey.has('.')) byKey.set('.', abs);
      continue;
    }
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const key = rel.split(/[/\\]/).filter(Boolean).join('/');
    if (!key || key.split('/').some((segment) => segment === '..')) continue;
    if (!byKey.has(key)) byKey.set(key, abs);
  }
  return [...byKey.entries()].sort((a, b) => cmp(a[0], b[0])).map(([, abs]) => abs);
}

function toFinding(evidence: LicenseEvidence): Finding {
  return {
    ruleId: LICENSE_UNPARSEABLE_RULE_ID,
    level: 'warning',
    message: `Unparseable license text at ${evidence.path}.`,
    location: evidence.path,
    details: {
      path: evidence.path,
      source: evidence.source,
    },
  };
}

/**
 * Findings for local license declarations that failed SPDX identification.
 * One finding per evidence path. Sorted by path, then source. Duplicate
 * project directories (a Dockerfile beside a package) are scanned once.
 */
export async function collectLicenseFindings(
  rootDir: string,
  projects: ReadonlyArray<{ path: string }>,
): Promise<Finding[]> {
  const dirs = uniqueProjectDirs(rootDir, projects);
  const evidence: LicenseEvidence[] = [];
  for (const dir of dirs) {
    evidence.push(...await evidenceForDirectory(rootDir, dir));
  }
  evidence.sort((a, b) => cmp(a.path, b.path) || cmp(a.source, b.source));

  const findings: Finding[] = [];
  let previous = '';
  for (const item of evidence) {
    const key = `${item.path}\0${item.source}`;
    if (key === previous) continue;
    previous = key;
    findings.push(toFinding(item));
  }
  return findings;
}
