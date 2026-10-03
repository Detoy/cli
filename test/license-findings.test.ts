import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCoreScan, formatSarif } from '../src/core-open/index.js';
import { buildDependencyLicense } from '../src/core-open/licenses/dependency-license.js';
import {
  detectProjectLicense,
  findingForLicense,
  licenseFindingsForProjects,
  type LicenseIo,
} from '../src/core-open/licenses/project-license.js';
import type { ProjectScan } from '../src/core-open/types.js';

const GARBAGE = 'NOT-A-REAL-LICENSE-BLOB-7f3a';

function ioFor(root: string): LicenseIo {
  return {
    exists: async (abs) => {
      try {
        await fs.promises.access(abs);
        return true;
      } catch {
        return false;
      }
    },
    readText: (abs) => fs.promises.readFile(abs, 'utf8'),
    readJson: async (abs) => JSON.parse(await fs.promises.readFile(abs, 'utf8')) as unknown,
  };
}

function write(root: string, rel: string, contents: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
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

  it('keeps an unparseable registry license on the row and does not invent a path', () => {
    const license = buildDependencyLicense(GARBAGE, 'registry');
    expect(license).toEqual({ raw: GARBAGE, spdxId: null, source: 'registry', confidence: 0 });
    expect(license.path).toBeUndefined();
    expect(findingForLicense(license)).toBeNull();
  });

  it('points an unparseable manifest license at the manifest instead of dropping it', async () => {
    const root = temp();
    write(root, 'pkg/package.json', JSON.stringify({ name: 'pkg', license: GARBAGE }));
    const first = await detectProjectLicense(root, 'pkg', ioFor(root));
    const second = await detectProjectLicense(root, 'pkg', ioFor(root));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({
      raw: GARBAGE,
      spdxId: null,
      source: 'manifest',
      path: 'pkg/package.json',
    });
    if (!first) throw new Error('expected a manifest license');
    const finding = findingForLicense(first);
    expect(finding).toMatchObject({
      ruleId: 'vibgrate/unparseable-license',
      level: 'warning',
      location: 'pkg/package.json',
      message: 'Unparseable license text at pkg/package.json.',
      details: { source: 'manifest', path: 'pkg/package.json', raw: GARBAGE },
    });
  });

  it('prefers the manifest path, and otherwise names the license file without copying its body', async () => {
    const root = temp();
    write(root, 'pkg/package.json', JSON.stringify({ name: 'pkg', license: 'MIT' }));
    write(root, 'pkg/LICENSE', `${GARBAGE}\n`);
    write(root, 'pkg/NOTICE', 'custom terms\n');
    const declared = await detectProjectLicense(root, 'pkg', ioFor(root));
    expect(declared).toMatchObject({ spdxId: 'MIT', source: 'manifest', path: 'pkg/package.json' });
    expect(JSON.stringify(declared)).not.toContain(GARBAGE);

    write(root, 'pkg/package.json', JSON.stringify({ name: 'pkg' }));
    const fromFile = await detectProjectLicense(root, 'pkg', ioFor(root));
    expect(fromFile).toMatchObject({
      raw: null,
      spdxId: null,
      source: 'license-file',
      path: 'pkg/LICENSE',
    });
    expect(JSON.stringify(fromFile)).not.toContain(GARBAGE);

    write(root, 'other/package.json', JSON.stringify({ name: 'other' }));
    write(root, 'other/NOTICE', 'SPDX-License-Identifier: Apache-2.0\n');
    const notice = await detectProjectLicense(root, 'other', ioFor(root));
    expect(notice).toMatchObject({ spdxId: 'Apache-2.0', source: 'license-file', path: 'other/NOTICE' });
  });

  it('sorts license findings by path and emits one per evidence file', () => {
    const projects = [
      project('b', { raw: null, spdxId: null, source: 'license-file', confidence: 0, path: 'b/LICENSE' }),
      project('a', { raw: 'MIT', spdxId: 'MIT', source: 'manifest', confidence: 1, path: 'a/package.json' }),
    ];
    const first = licenseFindingsForProjects(projects);
    const second = licenseFindingsForProjects([...projects].reverse());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map((f) => f.location)).toEqual(['a/package.json', 'b/LICENSE']);
    expect(first.map((f) => f.ruleId)).toEqual(['vibgrate/license', 'vibgrate/unparseable-license']);
  });

  it('includes the license file path in scan JSON and SARIF', async () => {
    const root = temp();
    write(root, 'pkg/package.json', JSON.stringify({ name: 'license-fixture', version: '1.0.0' }));
    write(root, 'pkg/LICENSE', `${GARBAGE}\nCopyright example only.\n`);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('VIBGRATE_DSN', '');

    const artifact = await runCoreScan(root, {
      format: 'json',
      concurrency: 2,
      offline: true,
      noLocalArtifacts: true,
      vibgrateVersion: 'test',
    });

    const project = artifact.projects.find((p) => p.path === 'pkg' || p.path === 'pkg/');
    expect(project?.license).toMatchObject({
      raw: null,
      spdxId: null,
      source: 'license-file',
      path: 'pkg/LICENSE',
    });
    const finding = artifact.findings.find((f) => f.ruleId === 'vibgrate/unparseable-license');
    expect(finding).toMatchObject({
      level: 'warning',
      location: 'pkg/LICENSE',
      message: 'Unparseable license text at pkg/LICENSE.',
    });

    const json = JSON.stringify(artifact);
    expect(json).toContain('"path":"pkg/LICENSE"');
    expect(json).not.toContain(GARBAGE);

    const sarif = formatSarif(artifact) as {
      runs: Array<{ results: Array<{ ruleId: string; locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }> }> }>;
    };
    const result = sarif.runs[0]?.results.find((r) => r.ruleId === 'vibgrate/unparseable-license');
    expect(result?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('pkg/LICENSE');
  });
});

function project(projectPath: string, license: ProjectScan['license']): ProjectScan {
  return {
    type: 'node',
    path: projectPath,
    name: projectPath,
    frameworks: [],
    dependencies: [],
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
    license,
  };
}
