import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GoCache } from '../src/core-open/scanners/go-cache.js';
import { scanGoProjects } from '../src/core-open/scanners/go-scanner.js';
import {
  collectVulnTargets,
  generateVulnerabilityFindings,
  scanVulnerabilities,
} from '../src/core-open/scanners/vulnerability-scanner.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { extractManifests } from '../src/engine/manifests.js';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'go-vuln-versions');

const manifest = JSON.parse(readFileSync(path.join(fixtureDir, 'advisories.json'), 'utf8')) as PackageVersionManifest;

function offlineCache(): GoCache {
  return new GoCache(new Semaphore(1), undefined, true);
}

describe('Go pseudo-versions in vg scan --vulns', () => {
  it('compares cleaned direct require versions and skips replace, exclude, indirect, and go.work', async () => {
    const [first] = await scanGoProjects(fixtureDir, offlineCache());
    const [second] = await scanGoProjects(fixtureDir, offlineCache());
    const rows = first.dependencies.map((d) => [d.package, d.currentSpec, d.resolvedVersion]);
    expect(rows).toEqual(second.dependencies.map((d) => [d.package, d.currentSpec, d.resolvedVersion]));
    expect(rows).toEqual([
      ['example.com/four', 'v1.2.3.4', null],
      ['example.com/partial', 'v1.2', null],
      ['github.com/old/major', 'v2.3.4+incompatible', '2.3.4'],
      ['github.com/pseudo/after', 'v1.2.4-0.20240615120000-abcdefabcdef', '1.2.4-0.20240615120000-abcdefabcdef'],
      ['github.com/pseudo/base', 'v0.0.0-20240615120000-abcdefabcdef', '0.0.0-20240615120000-abcdefabcdef'],
      ['github.com/pseudo/incompat', 'v2.1.0-0.20240615120000-abcdefabcdef+incompatible', '2.1.0-0.20240615120000-abcdefabcdef'],
      ['github.com/pseudo/pre', 'v1.2.3-rc.0.20240615120000-abcdefabcdef', '1.2.3-rc.0.20240615120000-abcdefabcdef'],
      ['github.com/tagged/mod', 'v1.2.3', '1.2.3'],
    ]);

    const targets = collectVulnTargets([first]);
    expect(targets.map((t) => `${t.ecosystem}:${t.package}@${t.version}`)).toEqual([
      'go:github.com/old/major@2.3.4',
      'go:github.com/pseudo/after@1.2.4-0.20240615120000-abcdefabcdef',
      'go:github.com/pseudo/base@0.0.0-20240615120000-abcdefabcdef',
      'go:github.com/pseudo/incompat@2.1.0-0.20240615120000-abcdefabcdef',
      'go:github.com/pseudo/pre@1.2.3-rc.0.20240615120000-abcdefabcdef',
      'go:github.com/tagged/mod@1.2.3',
    ]);

    const matched = await scanVulnerabilities(targets, {
      sem: new Semaphore(1),
      offline: true,
      manifest,
    });
    expect(matched.source).toBe('manifest');
    expect(matched.packages.map((pkg) => [pkg.package, pkg.version, pkg.advisories.map((a) => a.id)])).toEqual([
      ['github.com/old/major', '2.3.4', ['GO-INCOMPAT-EXACT']],
      ['github.com/pseudo/after', '1.2.4-0.20240615120000-abcdefabcdef', ['GO-AFTER-NEXT']],
      ['github.com/pseudo/base', '0.0.0-20240615120000-abcdefabcdef', ['GO-PSEUDO-BASE']],
      ['github.com/pseudo/incompat', '2.1.0-0.20240615120000-abcdefabcdef', ['GO-BOTH-NEXT']],
      ['github.com/pseudo/pre', '1.2.3-rc.0.20240615120000-abcdefabcdef', ['GO-PRE-NEXT']],
      ['github.com/tagged/mod', '1.2.3', ['GO-TAGGED']],
    ]);

    const messages = generateVulnerabilityFindings(matched).map((f) => f.message);
    expect(messages).toEqual([
      'github.com/old/major@2.3.4: GO-INCOMPAT-EXACT (low)',
      'github.com/pseudo/after@1.2.4-0.20240615120000-abcdefabcdef: GO-AFTER-NEXT (moderate) — fix available (1.2.5)',
      'github.com/pseudo/base@0.0.0-20240615120000-abcdefabcdef: GO-PSEUDO-BASE (high) — fix available (1.0.0)',
      'github.com/pseudo/incompat@2.1.0-0.20240615120000-abcdefabcdef: GO-BOTH-NEXT (moderate) — fix available (2.1.1)',
      'github.com/pseudo/pre@1.2.3-rc.0.20240615120000-abcdefabcdef: GO-PRE-NEXT (moderate) — fix available (1.2.4)',
      'github.com/tagged/mod@1.2.3: GO-TAGGED (high) — fix available (1.2.4)',
    ]);
    expect(messages.join('\n')).not.toMatch(/GO-AFTER-AT-BASE|GO-BOTH-AT-BASE|GO-PRE-AT-RELEASE|GO-INCOMPAT-RAW|GO-INDIRECT|GO-REPLACE-TARGET|GO-WORK-REPLACE/);
  });

  it('records require module paths on the graph, including indirect, and omits replace targets', () => {
    const graph = extractManifests(fixtureDir);
    const names = graph.nodes.filter((n) => n.kind === 'external').map((n) => n.name).sort();
    expect(names).toEqual([
      'example.com/four',
      'example.com/partial',
      'github.com/old/major',
      'github.com/pseudo/after',
      'github.com/pseudo/base',
      'github.com/pseudo/incompat',
      'github.com/pseudo/pre',
      'github.com/tagged/mod',
      'rsc.io/quote',
    ]);
  });
});
