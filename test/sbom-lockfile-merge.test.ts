/**
 * Multi-project lockfile merge for `vg sbom export`: identity is
 * ecosystem + name + version, contributing projects are recorded, and a
 * collision warns only when fields are dropped.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectLockfileGraph, collectMergeWarnings, collectPurlWarnings, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { DependencyRow, ProjectScan, ScanArtifact } from '../src/reporting/types.js';

function dep(name: string, version: string, overrides: Partial<DependencyRow> = {}): DependencyRow {
  return {
    package: name,
    section: 'dependencies',
    currentSpec: version,
    resolvedVersion: version,
    latestStable: version,
    majorsBehind: 0,
    drift: 'current',
    ...overrides,
  };
}

function project(name: string, relPath: string, type: ProjectScan['type'], deps: DependencyRow[]): ProjectScan {
  return {
    type,
    path: relPath,
    name,
    frameworks: [],
    dependencies: deps,
    dependencyAgeBuckets: { current: deps.length, oneBehind: 0, twoPlusBehind: 0, unknown: 0 },
  };
}

function artifact(projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath: 'workspace',
    drift: {
      score: 10,
      riskLevel: 'low',
      components: { runtimeScore: 10, frameworkScore: 10, dependencyScore: 10, eolScore: 10 },
    },
    findings: [],
    projects,
  };
}

function packageLock(name: string, packages: Record<string, string>): string {
  const body: Record<string, { name?: string; version?: string }> = { '': { name } };
  for (const pkg of Object.keys(packages).sort()) body[`node_modules/${pkg}`] = { version: packages[pkg] };
  return JSON.stringify({ name, lockfileVersion: 3, requires: true, packages: body });
}

function prop(properties: Array<{ name: string; value: string }>, name: string): string | undefined {
  return properties.find((p) => p.name === name)?.value;
}

describe('sbom export: multi-project lockfile merge', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-merge-'));
    fs.mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
    fs.mkdirSync(path.join(root, 'apps', 'web'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'apps', 'api', 'package-lock.json'),
      packageLock('api', { 'shared-lib': '1.2.3', 'split-pkg': '2.0.0' }),
    );
    fs.writeFileSync(
      path.join(root, 'apps', 'web', 'package-lock.json'),
      packageLock('web', { 'shared-lib': '1.2.3', 'split-pkg': '1.0.0' }),
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function scanned(): ScanArtifact {
    return artifact([
      project('web', 'apps/web', 'node', [
        dep('shared-lib', '1.2.3'),
        dep('split-pkg', '1.0.0'),
        dep('chalk', '5.0.0'),
      ]),
      project('api', 'apps/api', 'node', [
        dep('shared-lib', '1.2.3'),
        dep('chalk', '5.0.0', { currentSpec: '^5.0.0', drift: 'major-behind', majorsBehind: 1 }),
      ]),
    ]);
  }

  const chalkWarning =
    'Kept npm package "chalk@5.0.0" from project "web". Dropped currentSpec ^5.0.0, drift major-behind, majorsBehind 1 from project "api".';

  it('records contributing projects, keeps both versions, and repeats byte-for-byte', () => {
    const scan = scanned();
    const firstGraph = collectLockfileGraph(scan, root);
    const first = toCycloneDx(scan, firstGraph);
    const second = toCycloneDx(scan, collectLockfileGraph(scan, root));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(toSpdx(scan, collectLockfileGraph(scan, root)))).toBe(JSON.stringify(toSpdx(scan, firstGraph)));

    const cdx = first as {
      components: Array<{
        name: string;
        version: string;
        purl: string;
        'bom-ref': string;
        properties: Array<{ name: string; value: string }>;
      }>;
    };
    const rows = cdx.components.map((c) => ({
      name: c.name,
      version: c.version,
      purl: c.purl,
      bom: c['bom-ref'],
      project: prop(c.properties, 'vibgrate:project'),
      projects: prop(c.properties, 'vibgrate:projects'),
      scope: prop(c.properties, 'vibgrate:scope'),
      merge: prop(c.properties, 'vibgrate:mergeWarning'),
    }));
    expect(rows).toEqual([
      {
        name: 'shared-lib',
        version: '1.2.3',
        purl: 'pkg:npm/shared-lib@1.2.3',
        bom: 'pkg:npm/shared-lib@1.2.3',
        project: 'web',
        projects: 'api,web',
        scope: 'direct',
        merge: undefined,
      },
      {
        name: 'split-pkg',
        version: '1.0.0',
        purl: 'pkg:npm/split-pkg@1.0.0',
        bom: 'pkg:npm/split-pkg@1.0.0',
        project: 'web',
        projects: 'web',
        scope: 'direct',
        merge: undefined,
      },
      {
        name: 'chalk',
        version: '5.0.0',
        purl: 'pkg:npm/chalk@5.0.0',
        bom: 'pkg:npm/chalk@5.0.0',
        project: 'web',
        projects: 'api,web',
        scope: 'direct',
        merge: chalkWarning,
      },
      {
        name: 'split-pkg',
        version: '2.0.0',
        purl: 'pkg:npm/split-pkg@2.0.0',
        bom: 'pkg:npm/split-pkg@2.0.0',
        project: 'api',
        projects: 'api',
        scope: 'transitive',
        merge: undefined,
      },
    ]);

    expect(collectMergeWarnings(scan, firstGraph)).toEqual([chalkWarning]);
    expect(collectPurlWarnings(scan, firstGraph)).toEqual([]);

    const spdx = toSpdx(scan, firstGraph) as {
      packages: Array<{ name: string; versionInfo: string; annotations: Array<{ comment: string }> }>;
    };
    const chalk = spdx.packages.find((p) => p.name === 'chalk')!;
    expect(chalk.annotations[0]!.comment).toContain('projects=api,web');
    expect(chalk.annotations[0]!.comment).toContain('scope=direct');
    expect(chalk.annotations[1]!.comment).toBe(chalkWarning);
    const shared = spdx.packages.find((p) => p.name === 'shared-lib')!;
    expect(shared.annotations).toHaveLength(1);
    expect(shared.annotations[0]!.comment).toContain('projects=api,web');
    expect(shared.annotations[0]!.comment).not.toContain('merge');
  });

  it('is byte-identical for lockfile-only rows when the artifact project order is reversed', () => {
    const forward = artifact([
      project('web', 'apps/web', 'node', []),
      project('api', 'apps/api', 'node', []),
    ]);
    const reversed = artifact([...forward.projects].reverse());
    const a = JSON.stringify(toCycloneDx(forward, collectLockfileGraph(forward, root)));
    const b = JSON.stringify(toCycloneDx(reversed, collectLockfileGraph(reversed, root)));
    expect(b).toBe(a);
    expect(JSON.stringify(toSpdx(reversed, collectLockfileGraph(reversed, root)))).toBe(
      JSON.stringify(toSpdx(forward, collectLockfileGraph(forward, root))),
    );

    const cdx = JSON.parse(a) as {
      components: Array<{ name: string; version: string; properties: Array<{ name: string; value: string }> }>;
    };
    const shared = cdx.components.find((c) => c.name === 'shared-lib')!;
    // apps/api sorts before apps/web, so the path-order winner is api even though the name "web" sorts later.
    expect(prop(shared.properties, 'vibgrate:project')).toBe('api');
    expect(prop(shared.properties, 'vibgrate:projects')).toBe('api,web');
    expect(collectMergeWarnings(forward, collectLockfileGraph(forward, root))).toEqual([]);
  });

  it('keeps the earliest project path when that name sorts after another contributor', () => {
    fs.mkdirSync(path.join(root, 'early'), { recursive: true });
    fs.mkdirSync(path.join(root, 'late'), { recursive: true });
    fs.writeFileSync(path.join(root, 'early', 'package-lock.json'), packageLock('z', { only: '1.0.0' }));
    fs.writeFileSync(path.join(root, 'late', 'package-lock.json'), packageLock('a', { only: '1.0.0' }));
    const scan = artifact([
      project('a', 'late', 'node', []),
      project('z', 'early', 'node', []),
    ]);
    const cdx = toCycloneDx(scan, collectLockfileGraph(scan, root)) as {
      components: Array<{ name: string; properties: Array<{ name: string; value: string }> }>;
    };
    const only = cdx.components.find((c) => c.name === 'only')!;
    expect(prop(only.properties, 'vibgrate:project')).toBe('z');
    expect(prop(only.properties, 'vibgrate:projects')).toBe('a,z');
    expect(JSON.stringify(toCycloneDx(scan, collectLockfileGraph(scan, root)))).toBe(JSON.stringify(cdx));
  });
});

describe('sbom export: mixed-ecosystem lockfiles', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-sbom-eco-'));
    fs.mkdirSync(path.join(root, 'crates', 'util'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      packageLock('app', { 'left-pad': '1.0.0' }),
    );
    fs.writeFileSync(
      path.join(root, 'crates', 'util', 'Cargo.lock'),
      ['# generated', 'version = 3', '', '[[package]]', 'name = "left-pad"', 'version = "1.0.0"', '', '[[package]]', 'name = "serde"', 'version = "1.0.0"', ''].join('\n'),
    );
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('does not give a Cargo package the root npm purl', () => {
    const scan = artifact([
      project('app', '.', 'node', [dep('left-pad', '1.0.0')]),
      project('util', 'crates/util', 'rust', [dep('left-pad', '1.0.0')]),
    ]);
    const graph = collectLockfileGraph(scan, root);
    const first = JSON.stringify(toCycloneDx(scan, graph));
    const second = JSON.stringify(toCycloneDx(scan, collectLockfileGraph(scan, root)));
    expect(second).toBe(first);

    const cdx = JSON.parse(first) as {
      components: Array<{ name: string; version: string; purl: string; 'bom-ref': string; properties: Array<{ name: string; value: string }> }>;
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    expect(cdx.components.map((c) => ({ name: c.name, purl: c.purl, project: prop(c.properties, 'vibgrate:project'), scope: prop(c.properties, 'vibgrate:scope') }))).toEqual([
      { name: 'left-pad', purl: 'pkg:npm/left-pad@1.0.0', project: 'app', scope: 'direct' },
      { name: 'left-pad', purl: 'pkg:cargo/left-pad@1.0.0', project: 'util', scope: 'direct' },
      { name: 'serde', purl: 'pkg:cargo/serde@1.0.0', project: 'util', scope: 'transitive' },
    ]);
    expect(cdx.components.map((c) => c['bom-ref'])).toEqual(cdx.components.map((c) => c.purl));
    const refs = cdx.dependencies.map((d) => d.ref);
    expect(refs).toContain('pkg:cargo/left-pad@1.0.0');
    expect(refs).toContain('pkg:cargo/serde@1.0.0');
    expect(refs).not.toContain('pkg:npm/serde@1.0.0');
    expect(JSON.stringify(cdx.dependencies)).not.toContain('pkg:npm/serde');
    expect(collectMergeWarnings(scan, graph)).toEqual([]);
    expect(collectPurlWarnings(scan, graph)).toEqual([]);

    const spdx = toSpdx(scan, graph) as {
      packages: Array<{ name: string; externalRefs: Array<{ referenceLocator: string }>; annotations: Array<{ comment: string }> }>;
    };
    expect(spdx.packages.map((p) => p.externalRefs[0]!.referenceLocator)).toEqual([
      'pkg:npm/left-pad@1.0.0',
      'pkg:cargo/left-pad@1.0.0',
      'pkg:cargo/serde@1.0.0',
    ]);
    expect(spdx.packages[2]!.annotations[0]!.comment).toContain('project=util');
    expect(spdx.packages[2]!.annotations[0]!.comment).toContain('scope=transitive');
    expect(JSON.stringify(toSpdx(scan, collectLockfileGraph(scan, root)))).toBe(JSON.stringify(spdx));
  });
});
