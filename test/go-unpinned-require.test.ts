import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractManifests } from '../src/engine/manifests.js';
import { inventory } from '../src/engine/drift.js';
import { GoCache } from '../src/core-open/scanners/go-cache.js';
import { scanGoProjects } from '../src/core-open/scanners/go-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { findPackageLine } from '../src/lsp/manifest-positions.js';
import { toCycloneDx, toSpdx } from '../src/reporting/commands/sbom.js';
import type { ScanArtifact } from '../src/reporting/types.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'go-unpinned-require');
const fixtureText = readFileSync(path.join(fixtureDir, 'go.mod'), 'utf8');

const PINNED = 'github.com/foo/bar';
const BARE = 'github.com/gin-gonic/gin';
const RANGED = 'example.com/ranged';
const BARE_SINGLE = 'example.com/also-unpinned';
const INDIRECT = 'rsc.io/quote';
const INDIRECT_BARE = 'example.com/skipped-indirect';

const GRAPH_NAMES = [BARE_SINGLE, RANGED, INDIRECT_BARE, PINNED, BARE, INDIRECT].sort();
const SCAN_NAMES = [BARE_SINGLE, RANGED, PINNED, BARE].sort();

function offlineCache(): GoCache {
  return new GoCache(new Semaphore(1), undefined, true);
}

describe('Go require lines without a v version', () => {
  it('keeps them in the graph, twice, with the same node ids', () => {
    const first = extractManifests(fixtureDir);
    const second = extractManifests(fixtureDir);
    const names = (out: ReturnType<typeof extractManifests>) =>
      out.nodes
        .filter((n) => n.kind === 'external')
        .map((n) => n.name)
        .sort();
    expect(names(first)).toEqual(GRAPH_NAMES);
    expect(first.deps).toBe(GRAPH_NAMES.length);
    expect(first.nodes.map((n) => n.id)).toEqual(second.nodes.map((n) => n.id));
    expect(first.edges.map((e) => e.id)).toEqual(second.edges.map((e) => e.id));
    expect(names(first)).not.toContain('example.com/excluded');
    expect(names(first)).not.toContain('example.com/replaced');
    expect(names(first)).not.toContain('example.com/commented');
    expect(names(first)).not.toContain('example.com/commented-block');
    expect(names(first)).not.toContain('example.com/svc');
    const pkg = first.nodes.find((n) => n.kind === 'package');
    expect(pkg?.qualifiedName).toBe('example.com/svc');
  });

  it('keeps them in the scan with a null resolved version and no invented number', async () => {
    const [first] = await scanGoProjects(fixtureDir, offlineCache());
    const [second] = await scanGoProjects(fixtureDir, offlineCache());
    expect(first.dependencies.map((d) => d.package)).toEqual(second.dependencies.map((d) => d.package));
    expect(first.dependencies.map((d) => [d.package, d.currentSpec, d.resolvedVersion])).toEqual(
      second.dependencies.map((d) => [d.package, d.currentSpec, d.resolvedVersion]),
    );

    const byName = new Map(first.dependencies.map((d) => [d.package, d]));
    expect([...byName.keys()].sort()).toEqual(SCAN_NAMES);

    const pinned = byName.get(PINNED)!;
    expect(pinned.currentSpec).toBe('v1.2.3');
    expect(pinned.resolvedVersion).toBe('1.2.3');

    for (const name of [BARE, BARE_SINGLE]) {
      const row = byName.get(name)!;
      expect(row.currentSpec).toBe('*');
      expect(row.resolvedVersion).toBeNull();
      expect(row.drift).toBe('unknown');
      expect(row.majorsBehind).toBeNull();
    }

    const ranged = byName.get(RANGED)!;
    expect(ranged.currentSpec).toBe('>=1.4.0');
    expect(ranged.resolvedVersion).toBeNull();
    expect(ranged.drift).toBe('unknown');

    expect(byName.has(INDIRECT)).toBe(false);
    expect(byName.has(INDIRECT_BARE)).toBe(false);

    const gin = first.frameworks.find((f) => f.name === 'Gin');
    expect(gin?.currentVersion).toBeNull();
    expect(first.dependencyAgeBuckets.unknown).toBe(SCAN_NAMES.length);
    expect(first.dependencyAgeBuckets.current).toBe(0);
  });

  it('records an SBOM row whose version is the non-concrete sentinel, not a range', async () => {
    const [project] = await scanGoProjects(fixtureDir, offlineCache());
    const artifact = {
      schemaVersion: '1.0',
      timestamp: '2026-02-19T00:00:00.000Z',
      vibgrateVersion: '0.0.1',
      rootPath: 'repo',
      drift: {
        score: 0,
        riskLevel: 'low',
        components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
      },
      findings: [],
      projects: [project],
    } as ScanArtifact;

    const cdx = toCycloneDx(artifact) as {
      components: Array<{ name: string; version: string; purl?: string; properties: Array<{ name: string; value: string }> }>;
    };
    const again = toCycloneDx(artifact) as { serialNumber: string; components: unknown[] };
    const once = toCycloneDx(artifact) as { serialNumber: string; components: unknown[] };
    expect(again).toEqual(once);

    const byName = new Map(cdx.components.map((c) => [c.name, c]));
    expect(byName.get(PINNED)?.version).toBe('v1.2.3');
    expect(byName.get(PINNED)?.purl).toBe('pkg:golang/github.com/foo/bar@v1.2.3');

    for (const name of [BARE, BARE_SINGLE, RANGED]) {
      const row = byName.get(name)!;
      expect(row.version).toBe('unknown');
      expect(row.version).not.toMatch(/[<>^~*]/);
      expect(row.purl).toBe(`pkg:golang/${name}`);
      expect(row.purl).not.toContain('@');
    }

    const rangedSpec = byName.get(RANGED)!.properties.find((p) => p.name === 'vibgrate:currentSpec')?.value;
    expect(rangedSpec).toBe('>=1.4.0');

    const spdx = toSpdx(artifact) as { packages: Array<{ name: string; versionInfo: string }> };
    expect(spdx.packages.find((p) => p.name === RANGED)?.versionInfo).toBe('unknown');
    expect(spdx.packages.find((p) => p.name === BARE)?.versionInfo).toBe('unknown');
  });

  it('lists the same modules in the dependency inventory without inventing a version', () => {
    const go = inventory(fixtureDir).records.filter((r) => r.ecosystem === 'go');
    const declared = Object.fromEntries(go.map((r) => [r.name, r.declared]));
    expect(Object.keys(declared).sort()).toEqual(GRAPH_NAMES);
    expect(declared[PINNED]).toBe('v1.2.3');
    expect(declared[INDIRECT]).toBe('v1.5.2');
    expect(declared[BARE]).toBe('*');
    expect(declared[BARE_SINGLE]).toBe('*');
    expect(declared[INDIRECT_BARE]).toBe('*');
    expect(declared[RANGED]).toBe('>=1.4.0');
    expect(declared).not.toHaveProperty('example.com/excluded');
    expect(declared).not.toHaveProperty('example.com/replaced');
  });

  it('finds the declaration line of a require that has no version', () => {
    expect(findPackageLine(fixtureText, BARE, 'go.mod')).toBeGreaterThanOrEqual(0);
    expect(findPackageLine(fixtureText, BARE_SINGLE, 'go.mod')).toBeGreaterThanOrEqual(0);
    expect(findPackageLine(fixtureText, RANGED, 'go.mod')).toBeGreaterThanOrEqual(0);
    expect(findPackageLine(fixtureText, 'example.com/commented', 'go.mod')).toBe(-1);
    const bareLine = fixtureText.split('\n')[findPackageLine(fixtureText, BARE, 'go.mod')]!;
    expect(bareLine.trim()).toBe(BARE);
  });
});
