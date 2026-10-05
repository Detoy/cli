import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSarif, runCoreScan } from '../src/core-open/index.js';
import { LICENSE_PARSE_FAILED } from '../src/core-open/licenses/diagnostic.js';
import { attachLicenseEvidence } from '../src/core-open/licenses/evidence.js';
import { generateFindings } from '../src/core-open/scoring/drift-score.js';
import type { DependencyRow, ProjectScan } from '../src/core-open/types.js';

const SECRET = 'BODY-SECRET-9f3c2a';
const GARBAGE = 'Custom-Internal-Terms-7f3a';

function project(projectPath: string, extra: Partial<ProjectScan> = {}): ProjectScan {
  return {
    type: 'node',
    path: projectPath,
    name: projectPath === '.' ? 'root' : projectPath,
    frameworks: [],
    dependencies: [],
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    ...extra,
  };
}

function dep(partial: Partial<DependencyRow> & Pick<DependencyRow, 'package'>): DependencyRow {
  return {
    section: 'dependencies',
    currentSpec: '1.0.0',
    resolvedVersion: '1.0.0',
    latestStable: '1.0.0',
    majorsBehind: 0,
    drift: 'current',
    ...partial,
  };
}

describe('license finding source path', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function temp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-license-'));
    dirs.push(dir);
    return dir;
  }

  function write(root: string, rel: string, contents: string): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }

  it('keeps an unparseable registry license on the project path and does not invent a file', () => {
    const findings = generateFindings([
      project('apps/web', {
        dependencies: [dep({ package: 'bad', license: { raw: GARBAGE, spdxId: null, source: 'registry', confidence: 0 } })],
      }),
    ]);
    const finding = findings.find((item) => item.ruleId === LICENSE_PARSE_FAILED);
    expect(finding?.location).toBe('apps/web');
    expect(finding?.details).toEqual({ raw: GARBAGE });
    expect(finding?.details?.path).toBeUndefined();
  });

  it('points a dependency license that named its file at that path', () => {
    const findings = generateFindings([
      project('apps/web', {
        dependencies: [
          dep({
            package: 'bad',
            license: { raw: GARBAGE, spdxId: null, source: 'manifest', confidence: 0, path: 'apps/web/package.json' },
          }),
        ],
      }),
    ]);
    const finding = findings.find((item) => item.ruleId === LICENSE_PARSE_FAILED);
    expect(finding).toMatchObject({
      location: 'apps/web/package.json',
      details: { path: 'apps/web/package.json', raw: GARBAGE, source: 'manifest' },
    });
  });

  it('points an unparseable manifest license at the manifest instead of dropping it', async () => {
    const root = temp();
    write(root, 'pkg/package.json', JSON.stringify({ name: 'pkg', license: GARBAGE }));
    const projects = [project('pkg')];
    const first = await attachLicenseEvidence(root, projects);
    const again = [project('pkg')];
    const second = await attachLicenseEvidence(root, again);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(projects[0]?.license).toMatchObject({
      source: 'manifest',
      path: 'pkg/package.json',
      spdxId: null,
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      ruleId: LICENSE_PARSE_FAILED,
      level: 'warning',
      location: 'pkg/package.json',
      details: { path: 'pkg/package.json', source: 'manifest' },
    });
    expect(first[0]?.message).toContain('pkg/package.json');
    expect(JSON.stringify(first)).toContain(GARBAGE);
  });

  it('does not copy a manifest license url into the finding', async () => {
    const root = temp();
    write(root, 'package.json', JSON.stringify({ name: 'root', license: { url: `https://example.invalid/${SECRET}` } }));
    const projects = [project('.')];
    const findings = await attachLicenseEvidence(root, projects);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location).toBe('package.json');
    expect(findings[0]?.details?.path).toBe('package.json');
    expect(JSON.stringify({ license: projects[0]?.license, findings })).not.toContain(SECRET);
    expect(JSON.stringify(findings)).not.toContain('example.invalid');
  });

  it('does not copy a license file body, and names the file when the text does not resolve', async () => {
    const root = temp();
    write(root, 'pkg/package.json', JSON.stringify({ name: 'pkg' }));
    write(root, 'pkg/LICENSE', `${GARBAGE}\n${SECRET}\nCopyright example only.\n`);
    const projects = [project('pkg')];
    const findings = await attachLicenseEvidence(root, projects);
    expect(projects[0]?.license).toMatchObject({
      source: 'license-file',
      path: 'pkg/LICENSE',
      spdxId: null,
    });
    expect(findings.map((finding) => finding.location)).toEqual(['pkg/LICENSE']);
    expect(findings[0]?.details).toMatchObject({ path: 'pkg/LICENSE', source: 'license-file' });
    const json = JSON.stringify({ license: projects[0]?.license, findings });
    expect(json).not.toContain(SECRET);
    expect(json).toContain(GARBAGE);
  });

  it('prefers the manifest path, and still reports an unparseable license file', async () => {
    const root = temp();
    write(root, 'pkg/package.json', JSON.stringify({ name: 'pkg', license: 'MIT' }));
    write(root, 'pkg/LICENSE', `${GARBAGE}\n${SECRET}\n`);
    write(root, 'pkg/NOTICE', 'Licensed under the Apache License, Version 2.0 (the "License").\n');
    const projects = [project('pkg')];
    const findings = await attachLicenseEvidence(root, projects);
    expect(projects[0]?.license).toMatchObject({ spdxId: 'MIT', source: 'manifest', path: 'pkg/package.json' });
    expect(findings.map((finding) => finding.location)).toEqual(['pkg/LICENSE']);
    expect(JSON.stringify({ license: projects[0]?.license, findings })).not.toContain(SECRET);
  });

  it('uses the first existing license file when the manifest has no license field', async () => {
    const root = temp();
    write(root, 'pkg/package.json', JSON.stringify({ name: 'pkg' }));
    write(root, 'pkg/NOTICE', 'Licensed under the Apache License, Version 2.0 (the "License").\n');
    write(root, 'pkg/COPYING', 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n');
    write(root, 'pkg/LICENSE', 'Apache License\nVersion 2.0, January 2004\n');
    const projects = [project('pkg')];
    const findings = await attachLicenseEvidence(root, projects);
    expect(findings).toEqual([]);
    expect(projects[0]?.license).toMatchObject({ spdxId: 'Apache-2.0', source: 'license-file', path: 'pkg/LICENSE' });

    fs.rmSync(path.join(root, 'pkg/LICENSE'));
    const withoutLicense = [project('pkg')];
    await attachLicenseEvidence(root, withoutLicense);
    expect(withoutLicense[0]?.license?.path).toBe('pkg/COPYING');
    expect(withoutLicense[0]?.license?.spdxId).toBe('GPL-3.0-or-later');
  });

  it('keeps a failed SPDX tag from falling through to a later title', async () => {
    const root = temp();
    write(root, 'pkg/package.json', JSON.stringify({ name: 'pkg' }));
    write(root, 'pkg/LICENSE', ['SPDX-License-Identifier: NotAReal-License-9.9', 'MIT License', SECRET].join('\n'));
    const projects = [project('pkg')];
    const findings = await attachLicenseEvidence(root, projects);
    expect(findings.map((finding) => finding.location)).toEqual(['pkg/LICENSE']);
    expect(JSON.stringify(findings)).toContain('NotAReal-License-9.9');
    expect(JSON.stringify(findings)).not.toContain(SECRET);
    expect(projects[0]?.license?.spdxId).toBeNull();
  });

  it('does not flag a standard MIT body or an explicit NOASSERTION', async () => {
    const root = temp();
    write(root, 'ok/package.json', JSON.stringify({ name: 'ok' }));
    write(root, 'ok/LICENSE', 'Permission is hereby granted, free of charge, to any person obtaining a copy\n');
    write(root, 'na/package.json', JSON.stringify({ name: 'na', license: 'NOASSERTION' }));
    const projects = [project('na'), project('ok')];
    const findings = await attachLicenseEvidence(root, projects);
    expect(findings).toEqual([]);
    expect(projects.find((item) => item.path === 'ok')?.license).toMatchObject({ spdxId: 'MIT', path: 'ok/LICENSE' });
    expect(projects.find((item) => item.path === 'na')?.license).toMatchObject({
      path: 'na/package.json',
      raw: 'NOASSERTION',
    });
  });

  it('sorts findings by path and does not follow a license symlink outside the repo', async () => {
    const root = temp();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-license-outside-'));
    dirs.push(outsideDir);
    const outside = path.join(outsideDir, 'secret-license.txt');
    fs.writeFileSync(outside, `${SECRET}\n`);
    write(root, 'b/package.json', JSON.stringify({ name: 'b', license: GARBAGE }));
    write(root, 'a/package.json', JSON.stringify({ name: 'a', license: 'MIT' }));
    fs.symlinkSync(outside, path.join(root, 'a/LICENSE'));

    const forward = [project('b'), project('a')];
    const reverse = [project('a'), project('b')];
    const first = await attachLicenseEvidence(root, forward);
    const second = await attachLicenseEvidence(root, reverse);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((finding) => finding.location)).toEqual(['b/package.json']);
    expect(JSON.stringify(first)).not.toContain(SECRET);
    expect(JSON.stringify(forward[0]?.license)).not.toContain(SECRET);
    expect(JSON.stringify(reverse.find((item) => item.path === 'a')?.license)).not.toContain(SECRET);
  });

  it('does not flag this repository root (Apache-2.0 manifest, LICENSE, and NOTICE)', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const projects = [project('.')];
    const findings = await attachLicenseEvidence(repoRoot, projects);
    expect(findings).toEqual([]);
    expect(projects[0]?.license).toMatchObject({
      spdxId: 'Apache-2.0',
      source: 'manifest',
      path: 'package.json',
    });
  });

  it('includes the license file path in scan JSON and SARIF', async () => {
    const root = temp();
    write(root, 'pkg/package.json', JSON.stringify({ name: 'license-fixture', version: '1.0.0' }));
    write(root, 'pkg/LICENSE', `${GARBAGE}\n${SECRET}\nCopyright example only.\n`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('VIBGRATE_DSN', '');

    const artifact = await runCoreScan(root, {
      format: 'json',
      concurrency: 2,
      offline: true,
      quiet: true,
      noLocalArtifacts: true,
      vibgrateVersion: 'test',
    });

    const scanned = artifact.projects.find((item) => item.path === 'pkg');
    expect(scanned?.license).toMatchObject({
      source: 'license-file',
      path: 'pkg/LICENSE',
      spdxId: null,
    });
    const finding = artifact.findings.find((item) => item.ruleId === LICENSE_PARSE_FAILED);
    expect(finding).toMatchObject({
      level: 'warning',
      location: 'pkg/LICENSE',
      details: { path: 'pkg/LICENSE', source: 'license-file' },
    });

    const json = JSON.stringify(artifact);
    expect(json).toContain('"path":"pkg/LICENSE"');
    expect(json).not.toContain(SECRET);

    const sarif = formatSarif(artifact) as {
      runs: Array<{
        results: Array<{
          ruleId: string;
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
          properties?: { path?: string };
        }>;
      }>;
    };
    const result = sarif.runs[0]?.results.find((item) => item.ruleId === LICENSE_PARSE_FAILED);
    expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('pkg/LICENSE');
    expect(result?.properties?.path).toBe('pkg/LICENSE');
    expect(JSON.stringify(sarif)).not.toContain(SECRET);
  });
});
