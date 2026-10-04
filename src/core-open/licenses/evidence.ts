// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Local license evidence for `vg scan` JSON and SARIF.
 *
 * Dependency licenses that come from a registry response have no file in the
 * repo. Those stay on the dependency row. A parse failure for them is still a
 * `vibgrate/license-parse-failed` finding, but `location` remains the project
 * directory and `details.path` is omitted — there is no file to open.
 *
 * When a project directory declares a license, this module names the file:
 *
 *   1. `package.json` `license` / `licenses`, when that field is present
 *   2. otherwise the first existing name in {@link LICENSE_FILE_NAMES}
 *
 * Text that does not resolve as SPDX becomes a `vibgrate/license-parse-failed`
 * finding whose `location` and `details.path` are that repo-relative path.
 * The license body is not copied into the artifact. Paths are sorted; directory
 * enumeration order is not used.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DependencyLicense, Finding, ProjectScan } from '../types.js';
import { stripBom } from '../utils/fs.js';
import { buildDependencyLicense, licenseEvidencePath } from './dependency-license.js';
import { LICENSE_PARSE_FAILED, licenseParseDiagnostic } from './diagnostic.js';
import { normalizeLicense } from './normalize.js';

/** Evidence filenames, most specific first. The first file that exists wins. */
export const LICENSE_FILE_NAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.md',
  'COPYING.txt',
  'NOTICE',
  'NOTICE.md',
  'NOTICE.txt',
] as const;

/** Bytes read from a license file. Enough for an SPDX tag or a title. */
const PREFIX_BYTES = 4096;
/** Lines longer than this are prose, not a declaration. */
const TITLE_LINE_MAX = 200;
/** How many leading non-empty lines may identify a standard license text. */
const HEADER_LINE_LIMIT = 15;

/**
 * Titles the normalizer does not map on its own (GPL text says "GNU GENERAL
 * PUBLIC LICENSE", not "GPL"). Checked against a single short line.
 */
const STANDARD_HEADERS: readonly { re: RegExp; spdxId: string }[] = [
  { re: /\bgnu affero general public license\b/i, spdxId: 'AGPL-3.0-or-later' },
  { re: /\bgnu lesser general public license\b/i, spdxId: 'LGPL-3.0-or-later' },
  { re: /\bgnu library general public license\b/i, spdxId: 'LGPL-2.1-or-later' },
  { re: /\bgnu general public license\b/i, spdxId: 'GPL-3.0-or-later' },
  { re: /\bapache license\b/i, spdxId: 'Apache-2.0' },
  { re: /\bmit license\b/i, spdxId: 'MIT' },
  { re: /\bmozilla public license\b/i, spdxId: 'MPL-2.0' },
  { re: /\bbsd license\b/i, spdxId: 'BSD-3-Clause' },
  { re: /\bisc license\b/i, spdxId: 'ISC' },
  { re: /\bthe unlicense\b/i, spdxId: 'Unlicense' },
];

/**
 * Body phrases for the well-known texts that ship without a title line.
 * Matched only against the bounded prefix, never against the whole file.
 * The phrase is not copied into the artifact.
 */
const KNOWN_BODIES: readonly { re: RegExp; spdxId: string }[] = [
  { re: /\bpermission is hereby granted, free of charge\b/i, spdxId: 'MIT' },
  { re: /\bredistribution and use in source and binary forms\b/i, spdxId: 'BSD-3-Clause' },
  { re: /\bpermission to use, copy, modify, and\/or distribute this software\b/i, spdxId: 'ISC' },
  { re: /\bthis is free and unencumbered software released into the public domain\b/i, spdxId: 'Unlicense' },
  { re: /\blicensed under the apache license\b/i, spdxId: 'Apache-2.0' },
  { re: /\bmozilla public license, version 2\.0\b/i, spdxId: 'MPL-2.0' },
];

export type LicenseEvidenceSource = 'manifest' | 'license-file';

interface Classified {
  raw: string | null;
  spdxId: string | null;
  confidence: number;
  failed: boolean;
}

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function identified(spdxId: string, confidence: number): Classified {
  return { raw: spdxId, spdxId, confidence, failed: false };
}

/** A short declaration string. `failed` follows {@link licenseParseDiagnostic}. */
function classificationFromDeclaration(raw: string): Classified {
  const sliced = raw.trim().slice(0, TITLE_LINE_MAX);
  const built = buildDependencyLicense(sliced, 'license-file');
  const diag = licenseParseDiagnostic(sliced, 'evidence');
  return {
    raw: diag ? diag.raw : built.raw,
    spdxId: built.spdxId,
    confidence: built.confidence,
    failed: diag !== null,
  };
}

function firstSpdxDeclaration(prefix: string): string | null {
  for (const line of prefix.split(/\r?\n/)) {
    const match = /SPDX-License-Identifier:\s*(.+)$/i.exec(line);
    if (!match?.[1]) continue;
    const value = match[1].replace(/\*\/\s*$/, '').replace(/-->\s*$/, '').trim();
    if (value) return value.slice(0, TITLE_LINE_MAX);
  }
  return null;
}

function nonEmptyLines(text: string): string[] {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) lines.push(trimmed);
  }
  return lines;
}

function headerSpdx(line: string): string | null {
  for (const header of STANDARD_HEADERS) {
    if (header.re.test(line)) return header.spdxId;
  }
  return null;
}

/**
 * Classify a license-file prefix. An SPDX tag is authoritative: a tag that
 * does not resolve does not fall through to a later title. Identified text
 * stores the SPDX id, not the file body.
 */
export function classifyLicensePrefix(text: string): Classified {
  const cleaned = stripBom(text).replace(/\u0000/g, '');
  if (!cleaned.trim()) return { raw: null, spdxId: null, confidence: 0, failed: false };

  const spdx = firstSpdxDeclaration(cleaned);
  if (spdx !== null) return classificationFromDeclaration(spdx);

  const lines = nonEmptyLines(cleaned);
  const head = lines.slice(0, HEADER_LINE_LIMIT);
  for (const line of head) {
    if (line.length > TITLE_LINE_MAX) continue;
    const header = headerSpdx(line);
    if (header) return identified(header, 0.6);
    const verdict = normalizeLicense(line);
    if (verdict.matchStatus !== 'unknown' && licenseParseDiagnostic(line, 'evidence') === null) {
      return identified(verdict.spdxId, verdict.confidence);
    }
  }

  const prefix = cleaned.slice(0, PREFIX_BYTES);
  for (const body of KNOWN_BODIES) {
    if (body.re.test(prefix)) return identified(body.spdxId, 0.6);
  }

  const first = lines[0];
  if (!first) return { raw: null, spdxId: null, confidence: 0, failed: false };
  return classificationFromDeclaration(first);
}

/**
 * Reduce a manifest `license` / `licenses` value to one string.
 * `null` means the value was present but not a license string.
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
    if (typeof obj.type === 'string' && obj.type.trim()) return obj.type.trim();
    if (typeof obj.spdx === 'string' && obj.spdx.trim()) return obj.spdx.trim();
    return null;
  }
  return null;
}

function manifestField(record: Record<string, unknown>): unknown {
  if (Object.prototype.hasOwnProperty.call(record, 'license')) {
    const license = record.license;
    if (typeof license === 'string') {
      if (license.trim()) return license;
    } else if (license != null) {
      return license;
    }
  }
  if (Object.prototype.hasOwnProperty.call(record, 'licenses') && record.licenses != null) {
    return record.licenses;
  }
  return undefined;
}

/** Repo-relative POSIX path of a file next to a project directory. */
export function licenseFilePath(projectPath: string, name: string): string {
  const base = projectPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!base || base === '.') return name;
  return `${base}/${name}`;
}

function projectKey(projectPath: string): string | null {
  const base = projectPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!base || base === '.') return '.';
  if (base.startsWith('/') || /^[A-Za-z]:\//.test(base)) return null;
  const parts = base.split('/');
  if (parts.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  return base;
}

function absUnder(rootDir: string, relPosix: string): string {
  return path.join(rootDir, ...relPosix.split('/'));
}

/** True when `filePath` is `rootDir` or a file inside it. */
function insideRoot(rootDir: string, filePath: string): boolean {
  const rel = path.relative(rootDir, filePath);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

type ReadResult = { kind: 'missing' } | { kind: 'skip' } | { kind: 'unreadable' } | { kind: 'text'; text: string };

async function readEvidenceFile(rootDir: string, filePath: string, full: boolean): Promise<ReadResult> {
  let realPath = filePath;
  try {
    const st = await fs.lstat(filePath);
    if (st.isSymbolicLink()) {
      realPath = await fs.realpath(filePath);
      if (!insideRoot(rootDir, realPath)) return { kind: 'skip' };
      const target = await fs.stat(realPath);
      if (!target.isFile()) return { kind: 'skip' };
    } else if (!st.isFile()) {
      return { kind: 'missing' };
    }
  } catch {
    return { kind: 'missing' };
  }

  try {
    if (full) return { kind: 'text', text: await fs.readFile(realPath, 'utf8') };
    const handle = await fs.open(realPath, 'r');
    try {
      const buf = Buffer.alloc(PREFIX_BYTES);
      const { bytesRead } = await handle.read(buf, 0, PREFIX_BYTES, 0);
      return { kind: 'text', text: buf.subarray(0, bytesRead).toString('utf8') };
    } finally {
      await handle.close();
    }
  } catch {
    return { kind: 'unreadable' };
  }
}

function findingForDeclaration(
  raw: string,
  evidencePath: string,
  source: LicenseEvidenceSource,
  packageName: string | undefined,
): Finding | null {
  const diag = licenseParseDiagnostic(raw, evidencePath, packageName);
  if (!diag) return null;
  return {
    ruleId: diag.code,
    level: 'warning',
    message: diag.message,
    location: diag.location,
    details: { raw: diag.raw, path: evidencePath, source },
  };
}

function unreadableFinding(evidencePath: string): Finding {
  return {
    ruleId: LICENSE_PARSE_FAILED,
    level: 'warning',
    message: `Could not read license text at ${evidencePath}.`,
    location: evidencePath,
    details: { path: evidencePath, source: 'license-file' },
  };
}

function licenseFromClassified(
  classified: Classified,
  source: LicenseEvidenceSource,
  evidencePath: string,
): DependencyLicense {
  const evidence = licenseEvidencePath(evidencePath) ?? evidencePath;
  if (!classified.raw) {
    return { raw: null, spdxId: classified.spdxId, source, confidence: classified.confidence, path: evidence };
  }
  const built = buildDependencyLicense(classified.raw, source, evidence);
  return { ...built, source, path: evidence };
}

interface DirScan {
  license?: DependencyLicense;
  findings: Finding[];
}

async function scanProjectDir(rootDir: string, dirKey: string, packageName: string): Promise<DirScan> {
  const findings: Finding[] = [];
  let manifestLicense: DependencyLicense | undefined;

  const manifestRel = licenseFilePath(dirKey, 'package.json');
  const manifestRead = await readEvidenceFile(rootDir, absUnder(rootDir, manifestRel), true);
  if (manifestRead.kind === 'text') {
    try {
      const parsed: unknown = JSON.parse(stripBom(manifestRead.text));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const field = manifestField(parsed as Record<string, unknown>);
        if (field !== undefined) {
          const text = declaredLicenseText(field);
          const raw = text === null ? 'unrecognized' : text;
          if (raw) {
            const license = buildDependencyLicense(raw, 'manifest', manifestRel);
            const finding = findingForDeclaration(raw, manifestRel, 'manifest', packageName);
            if (finding) {
              const shown = finding.details?.raw;
              if (typeof shown === 'string') license.raw = shown;
              findings.push(finding);
            }
            manifestLicense = license;
          }
        }
      }
    } catch {
      // Unreadable JSON — a sibling license file can still be evidence.
    }
  }

  let firstFile: DependencyLicense | undefined;
  for (const name of LICENSE_FILE_NAMES) {
    const rel = licenseFilePath(dirKey, name);
    const read = await readEvidenceFile(rootDir, absUnder(rootDir, rel), false);
    if (read.kind === 'missing' || read.kind === 'skip') continue;
    if (read.kind === 'unreadable') {
      const license: DependencyLicense = {
        raw: null,
        spdxId: null,
        source: 'license-file',
        confidence: 0,
        path: rel,
      };
      if (!firstFile) firstFile = license;
      findings.push(unreadableFinding(rel));
      continue;
    }
    const classified = classifyLicensePrefix(read.text);
    const license = licenseFromClassified(classified, 'license-file', rel);
    if (classified.failed && classified.raw) {
      const finding = findingForDeclaration(classified.raw, rel, 'license-file', packageName);
      if (finding) {
        const shown = finding.details?.raw;
        if (typeof shown === 'string') license.raw = shown;
        findings.push(finding);
      }
    }
    if (!firstFile) firstFile = license;
  }

  return { license: manifestLicense ?? firstFile, findings };
}

/**
 * Record each project's declared license and return findings for declarations
 * that did not resolve as SPDX. One scan per project directory. Findings are
 * sorted by path.
 */
export async function attachLicenseEvidence(rootDir: string, projects: ProjectScan[]): Promise<Finding[]> {
  const dirs = new Map<string, string>();
  const ordered = [...projects].sort((a, b) => cmp(a.path, b.path) || cmp(a.name, b.name) || cmp(a.type, b.type));
  for (const project of ordered) {
    const key = projectKey(project.path);
    if (!key || dirs.has(key)) continue;
    dirs.set(key, project.name);
  }

  const keys = [...dirs.keys()].sort(cmp);
  const scanned = new Map<string, DirScan>();
  for (const key of keys) {
    scanned.set(key, await scanProjectDir(rootDir, key, dirs.get(key) ?? key));
  }

  for (const project of projects) {
    const key = projectKey(project.path);
    const license = key ? scanned.get(key)?.license : undefined;
    if (license) project.license = { ...license };
  }

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    for (const finding of scanned.get(key)?.findings ?? []) {
      const id = `${finding.ruleId}\0${finding.location}\0${finding.message}`;
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push(finding);
    }
  }
  findings.sort((a, b) => cmp(a.location, b.location) || cmp(a.ruleId, b.ruleId) || cmp(a.message, b.message));
  return findings;
}
