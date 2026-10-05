/**
 * Pins the multi-version SBOM rule documented in DOCS.md
 * ("Multiple versions of the same package"): one component per name@version,
 * direct scope winning over a lockfile copy, lexicographic lockfile-only
 * order, and the single-lockfile dependency graph.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, makeProject } from './helpers.js';
import { collectLockfileGraph, toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { DependencyRow, ProjectScan, ScanArtifact } from '../src/reporting/types.js';

const NESTED_LOCK = JSON.stringify({
  name: 'multiver-fixture',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'multiver-fixture',
      version: '1.0.0',
      dependencies: { 'left-pad': '^1.3.0', 'nested-holder': '1.0.0' },
    },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/nested-holder': {
      version: '1.0.0',
      dependencies: { 'left-pad': '1.2.0', once: '1.4.0' },
    },
    'node_modules/nested-holder/node_modules/left-pad': { version: '1.2.0' },
    'node_modules/once': { version: '1.4.0', dependencies: { wrappy: '1.0.2' } },
    'node_modules/nested-holder/node_modules/once': { version: '1.4.0', dependencies: { wrappy: '1.0.1' } },
    'node_modules/wrappy': { version: '1.0.2' },
    'node_modules/nested-holder/node_modules/wrappy': { version: '1.0.1' },
    'node_modules/semver-demo': { version: '10.0.0' },
    'node_modules/nested-holder/node_modules/semver-demo': { version: '2.0.0' },
  },
});

function dep(name: string, spec: string, resolved: string | null = spec): DependencyRow {
  return {
    package: name,
    section: 'dependencies',
    currentSpec: spec,
    resolvedVersion: resolved,
    latestStable: null,
    majorsBehind: null,
    drift: 'unknown',
  };
}

function project(name: string, path: string, dependencies: DependencyRow[]): ProjectScan {
  return {
    type: 'node',
    path,
    name,
    frameworks: [],
    dependencies,
    dependencyAgeBuckets: { current: 0, oneBehind: 0, twoPlusBehind: 0, unknown: dependencies.length },
  };
}

function artifact(rootPath: string, projects: ProjectScan[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-19T00:00:00.000Z',
    vibgrateVersion: '0.0.1',
    rootPath,
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings: [],
    projects,
  };
}

interface CdxComponent {
  name: string;
  version: string;
  'bom-ref': string;
  purl?: string;
  properties: Array<{ name: string; value: string }>;
}

function prop(component: CdxComponent, name: string): string | undefined {
  return component.properties.find((p) => p.name === name)?.value;
}

describe('sbom multiple versions of one package', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) cleanup(dirs.pop()!);
  });

  it('emits one component per version, keeps direct scope, and repeats exactly', () => {
    const root = makeProject({ 'package-lock.json': NESTED_LOCK });
    dirs.push(root);
    const scanned = artifact('multiver', [
      project('multiver-fixture', '.', [dep('left-pad', '^1.3.0', '1.3.0'), dep('nested-holder', '1.0.0', '1.0.0')]),
    ]);
    const graph = collectLockfileGraph(scanned, root);
    const cdx = toCycloneDx(scanned, graph) as {
      components: CdxComponent[];
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    expect(toCycloneDx(scanned, graph)).toEqual(cdx);

    const rows = cdx.components.map((c) => ({
      name: c.name,
      version: c.version,
      ref: c['bom-ref'],
      purl: c.purl,
      scope: prop(c, 'vibgrate:scope'),
      project: prop(c, 'vibgrate:project'),
    }));
    expect(rows).toEqual([
      { name: 'left-pad', version: '1.3.0', ref: 'pkg:npm/left-pad@1.3.0', purl: 'pkg:npm/left-pad@1.3.0', scope: 'direct', project: 'multiver-fixture' },
      { name: 'nested-holder', version: '1.0.0', ref: 'pkg:npm/nested-holder@1.0.0', purl: 'pkg:npm/nested-holder@1.0.0', scope: 'direct', project: 'multiver-fixture' },
      { name: 'left-pad', version: '1.2.0', ref: 'pkg:npm/left-pad@1.2.0', purl: 'pkg:npm/left-pad@1.2.0', scope: 'transitive', project: 'multiver' },
      { name: 'once', version: '1.4.0', ref: 'pkg:npm/once@1.4.0', purl: 'pkg:npm/once@1.4.0', scope: 'transitive', project: 'multiver' },
      { name: 'semver-demo', version: '10.0.0', ref: 'pkg:npm/semver-demo@10.0.0', purl: 'pkg:npm/semver-demo@10.0.0', scope: 'transitive', project: 'multiver' },
      { name: 'semver-demo', version: '2.0.0', ref: 'pkg:npm/semver-demo@2.0.0', purl: 'pkg:npm/semver-demo@2.0.0', scope: 'transitive', project: 'multiver' },
      { name: 'wrappy', version: '1.0.1', ref: 'pkg:npm/wrappy@1.0.1', purl: 'pkg:npm/wrappy@1.0.1', scope: 'transitive', project: 'multiver' },
      { name: 'wrappy', version: '1.0.2', ref: 'pkg:npm/wrappy@1.0.2', purl: 'pkg:npm/wrappy@1.0.2', scope: 'transitive', project: 'multiver' },
    ]);
    expect(new Set(rows.map((r) => r.ref)).size).toBe(rows.length);

    // once@1.4.0 is installed twice. The later packages entry (the nested path,
    // depending on wrappy@1.0.1) replaces the earlier edge to wrappy@1.0.2.
    // wrappy@1.0.2 stays a component with nothing pointing at it.
    expect(cdx.dependencies).toEqual([
      { ref: 'vibgrate-root', dependsOn: ['pkg:npm/left-pad@1.3.0', 'pkg:npm/nested-holder@1.0.0'] },
      { ref: 'pkg:npm/left-pad@1.3.0', dependsOn: [] },
      { ref: 'pkg:npm/nested-holder@1.0.0', dependsOn: ['pkg:npm/left-pad@1.2.0', 'pkg:npm/once@1.4.0'] },
      { ref: 'pkg:npm/left-pad@1.2.0', dependsOn: [] },
      { ref: 'pkg:npm/once@1.4.0', dependsOn: ['pkg:npm/wrappy@1.0.1'] },
      { ref: 'pkg:npm/semver-demo@10.0.0', dependsOn: [] },
      { ref: 'pkg:npm/semver-demo@2.0.0', dependsOn: [] },
      { ref: 'pkg:npm/wrappy@1.0.1', dependsOn: [] },
      { ref: 'pkg:npm/wrappy@1.0.2', dependsOn: [] },
    ]);
    const inbound = cdx.dependencies.flatMap((d) => d.dependsOn);
    expect(inbound).not.toContain('pkg:npm/wrappy@1.0.2');

    const spdx = toSpdx(scanned, graph) as {
      packages: Array<{ SPDXID: string; name: string; versionInfo: string; externalRefs: Array<{ referenceLocator: string }> }>;
      relationships: Array<{ spdxElementId: string; relatedSpdxElementId: string; relationshipType: string }>;
    };
    expect(toSpdx(scanned, graph)).toEqual(spdx);
    expect(spdx.packages.map((p) => `${p.SPDXID} ${p.name}@${p.versionInfo} ${p.externalRefs[0]!.referenceLocator}`)).toEqual([
      'SPDXRef-Package-1 left-pad@1.3.0 pkg:npm/left-pad@1.3.0',
      'SPDXRef-Package-2 nested-holder@1.0.0 pkg:npm/nested-holder@1.0.0',
      'SPDXRef-Package-3 left-pad@1.2.0 pkg:npm/left-pad@1.2.0',
      'SPDXRef-Package-4 once@1.4.0 pkg:npm/once@1.4.0',
      'SPDXRef-Package-5 semver-demo@10.0.0 pkg:npm/semver-demo@10.0.0',
      'SPDXRef-Package-6 semver-demo@2.0.0 pkg:npm/semver-demo@2.0.0',
      'SPDXRef-Package-7 wrappy@1.0.1 pkg:npm/wrappy@1.0.1',
      'SPDXRef-Package-8 wrappy@1.0.2 pkg:npm/wrappy@1.0.2',
    ]);
    expect(spdx.relationships).toContainEqual({
      spdxElementId: 'SPDXRef-Package-4',
      relatedSpdxElementId: 'SPDXRef-Package-7',
      relationshipType: 'DEPENDS_ON',
    });

    // --no-transitive passes no lockfile graph: manifest rows only, no graph.
    const directOnly = toCycloneDx(scanned) as { components: CdxComponent[]; dependencies?: unknown };
    expect(directOnly.components.map((c) => `${c.name}@${c.version}`)).toEqual(['left-pad@1.3.0', 'nested-holder@1.0.0']);
    expect(directOnly.dependencies).toBeUndefined();
  });

  it('collapses the same name@version across sub-projects onto the first project, and keeps both versions when they differ', () => {
    const root = makeProject({
      'packages/a/package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { dependencies: { ms: '2.1.3' } },
          'node_modules/ms': { version: '2.1.3' },
        },
      }),
      'packages/b/package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { dependencies: { ms: '2.1.3', debug: '4.3.4' } },
          'node_modules/ms': { version: '2.1.3' },
          'node_modules/debug': { version: '4.3.4', dependencies: { ms: '2.1.3' } },
        },
      }),
    });
    dirs.push(root);

    const aFirst = artifact('multiproj', [
      project('pkg-a', 'packages/a', [dep('ms', '2.1.3')]),
      project('pkg-b', 'packages/b', [dep('ms', '2.1.3')]),
    ]);
    const aGraph = collectLockfileGraph(aFirst, root);
    const aCdx = toCycloneDx(aFirst, aGraph) as {
      components: CdxComponent[];
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    expect(aCdx.components.map((c) => `${c.name}@${c.version} ${prop(c, 'vibgrate:scope')} ${prop(c, 'vibgrate:project')}`)).toEqual([
      'ms@2.1.3 direct pkg-a',
      'debug@4.3.4 transitive multiproj',
    ]);
    expect(aCdx.components[0]!['bom-ref']).toBe('pkg:npm/ms@2.1.3');

    const bFirst = artifact('multiproj', [
      project('pkg-b', 'packages/b', [dep('ms', '2.1.3')]),
      project('pkg-a', 'packages/a', [dep('ms', '2.1.3')]),
    ]);
    const bCdx = toCycloneDx(bFirst, collectLockfileGraph(bFirst, root)) as { components: CdxComponent[] };
    expect(bCdx.components[0]!['bom-ref']).toBe('pkg:npm/ms@2.1.3');
    expect(prop(bCdx.components[0]!, 'vibgrate:project')).toBe('pkg-b');

    // No root lockfile: the graph is the first sorted path that has one (packages/a),
    // so debug from packages/b is a component whose edges are absent.
    expect(aCdx.dependencies[0]).toEqual({ ref: 'vibgrate-root', dependsOn: ['pkg:npm/ms@2.1.3'] });
    expect(aCdx.dependencies.find((d) => d.ref === 'pkg:npm/debug@4.3.4')?.dependsOn).toEqual([]);
  });

  it('lists both direct versions, in artifact project order, while the graph stays on the sorted lockfile', () => {
    const root = makeProject({
      'packages/a/package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { dependencies: { ms: '2.1.3' } },
          'node_modules/ms': { version: '2.1.3' },
        },
      }),
      'packages/b/package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': { dependencies: { ms: '2.1.2' } },
          'node_modules/ms': { version: '2.1.2' },
        },
      }),
    });
    dirs.push(root);

    const bThenA = artifact('diff', [
      project('pkg-b', 'packages/b', [dep('ms', '2.1.2')]),
      project('pkg-a', 'packages/a', [dep('ms', '2.1.3')]),
    ]);
    const cdx = toCycloneDx(bThenA, collectLockfileGraph(bThenA, root)) as {
      components: CdxComponent[];
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    expect(cdx.components.map((c) => `${c.version} ${prop(c, 'vibgrate:scope')} ${prop(c, 'vibgrate:project')}`)).toEqual([
      '2.1.2 direct pkg-b',
      '2.1.3 direct pkg-a',
    ]);
    expect(cdx.components.map((c) => c['bom-ref'])).toEqual(['pkg:npm/ms@2.1.2', 'pkg:npm/ms@2.1.3']);
    expect(cdx.dependencies[0]).toEqual({ ref: 'vibgrate-root', dependsOn: ['pkg:npm/ms@2.1.3'] });

    const aThenB = artifact('diff', [
      project('pkg-a', 'packages/a', [dep('ms', '2.1.3')]),
      project('pkg-b', 'packages/b', [dep('ms', '2.1.2')]),
    ]);
    const flipped = toCycloneDx(aThenB, collectLockfileGraph(aThenB, root)) as {
      components: CdxComponent[];
      dependencies: Array<{ ref: string; dependsOn: string[] }>;
    };
    expect(flipped.components.map((c) => c.version)).toEqual(['2.1.3', '2.1.2']);
    expect(flipped.dependencies[0]).toEqual({ ref: 'vibgrate-root', dependsOn: ['pkg:npm/ms@2.1.3'] });

    const spdx = toSpdx(bThenA, collectLockfileGraph(bThenA, root)) as { packages: Array<{ SPDXID: string; versionInfo: string }> };
    expect(spdx.packages.map((p) => `${p.SPDXID}@${p.versionInfo}`)).toEqual(['SPDXRef-Package-1@2.1.2', 'SPDXRef-Package-2@2.1.3']);
  });
});
