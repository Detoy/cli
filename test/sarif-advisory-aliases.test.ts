import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatSarif } from '../src/core-open/formatters/sarif.js';
import { generateVulnerabilityFindings, scanVulnerabilities } from '../src/core-open/index.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import type { Finding, ScanArtifact } from '../src/core-open/types.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
  properties?: Record<string, unknown>;
}

interface SarifDoc {
  runs: Array<{
    tool: { driver: { rules: Array<{ id: string }> } };
    results: SarifResult[];
  }>;
}

/** Manifest order is deliberately not the documented SARIF order. */
const MANIFEST: PackageVersionManifest = {
  pypi: {
    requests: {
      vulns: [
        {
          id: 'GHSA-req',
          aliases: ['CVE-2023-1'],
          severity: 'low',
          cvss: 2.1,
          ranges: [{ introduced: '0' }],
        },
      ],
    },
  },
  npm: {
    lodash: {
      vulns: [
        {
          id: 'CVE-2024-1111',
          aliases: ['GHSA-bbbb'],
          severity: 'high',
          cvss: 7.5,
          ranges: [{ introduced: '0', fixed: '4.17.21' }],
        },
        {
          id: 'GHSA-cccc',
          aliases: [],
          severity: 'moderate',
          ranges: [{ introduced: '0' }],
        },
        {
          id: 'GHSA-bbbb',
          aliases: ['CVE-2024-1111', 'OSV-1'],
          severity: 'critical',
          cvss: 9.1,
          ranges: [{ introduced: '0', fixed: '4.17.21' }],
        },
      ],
    },
    'left-pad': {
      vulns: [
        {
          id: 'GHSA-zzzz',
          aliases: ['CVE-2024-2000'],
          severity: 'moderate',
          ranges: [{ introduced: '0' }],
        },
      ],
    },
  },
};

const TARGETS = [
  { ecosystem: 'pypi' as const, package: 'requests', version: '2.31.0' },
  { ecosystem: 'npm' as const, package: 'lodash', version: '4.17.20' },
  { ecosystem: 'npm' as const, package: 'left-pad', version: '1.0.0' },
];

function artifact(findings: Finding[]): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-10-04T00:00:00.000Z',
    vibgrateVersion: '0.0.0-test',
    rootPath: '.',
    projects: [],
    drift: {
      score: 0,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings,
  };
}

const DRIFT: Finding = {
  ruleId: 'vibgrate/runtime-lag',
  level: 'warning',
  message: 'Node.js runtime is 2 major versions behind.',
  location: 'app',
};

describe('vg scan SARIF advisory aliases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pins one result per advisory, copies aliases onto properties, and keeps a stable order', async () => {
    const sem = new Semaphore(2);
    const first = await scanVulnerabilities(TARGETS, { sem, offline: true, manifest: MANIFEST });
    const second = await scanVulnerabilities([...TARGETS].reverse(), { sem, offline: true, manifest: MANIFEST });
    expect(second.packages).toEqual(first.packages);

    const findings = generateVulnerabilityFindings(first);
    const scan = artifact([DRIFT, ...findings]);
    const sarif = formatSarif(scan) as SarifDoc;
    expect(formatSarif(scan)).toEqual(sarif);

    const run = sarif.runs[0]!;
    expect(run.tool.driver.rules.map((rule) => rule.id)).toEqual([
      'vibgrate/runtime-lag',
      'vibgrate/vulnerability',
    ]);

    const results = run.results;
    expect(results.map((result) => result.ruleId)).toEqual([
      'vibgrate/runtime-lag',
      'vibgrate/vulnerability',
      'vibgrate/vulnerability',
      'vibgrate/vulnerability',
      'vibgrate/vulnerability',
      'vibgrate/vulnerability',
    ]);

    const vulns = results.slice(1);
    expect(vulns.map((result) => result.properties?.advisoryId)).toEqual([
      'GHSA-zzzz',
      'GHSA-bbbb',
      'CVE-2024-1111',
      'GHSA-cccc',
      'GHSA-req',
    ]);
    expect(vulns.map((result) => result.level)).toEqual(['warning', 'error', 'error', 'warning', 'note']);
    expect(vulns.map((result) => result.locations[0]?.physicalLocation.artifactLocation.uri)).toEqual([
      'left-pad',
      'lodash',
      'lodash',
      'lodash',
      'requests',
    ]);

    // The alias list does not become extra results, and it does not merge the two ids.
    expect(vulns.map((result) => result.properties?.advisoryId)).not.toContain('OSV-1');
    expect(vulns.map((result) => result.properties?.advisoryId)).not.toContain('CVE-2024-2000');
    expect(vulns.filter((result) => result.properties?.advisoryId === 'GHSA-bbbb')).toHaveLength(1);
    expect(vulns.filter((result) => result.properties?.advisoryId === 'CVE-2024-1111')).toHaveLength(1);

    const ghsa = vulns[1]!;
    expect(ghsa.message.text).toBe(
      'lodash@4.17.20: GHSA-bbbb (CVE-2024-1111) (critical 9.1) — fix available (4.17.21)',
    );
    expect(ghsa.properties).toEqual({
      ecosystem: 'npm',
      package: 'lodash',
      installedVersion: '4.17.20',
      advisoryId: 'GHSA-bbbb',
      aliases: ['CVE-2024-1111', 'OSV-1'],
      severity: 'critical',
      cvss: 9.1,
      fixedVersions: ['4.17.21'],
    });

    const cve = vulns[2]!;
    expect(cve.message.text).toBe('lodash@4.17.20: CVE-2024-1111 (high 7.5) — fix available (4.17.21)');
    expect(cve.properties?.aliases).toEqual(['GHSA-bbbb']);
    expect(cve.message.text).not.toContain('GHSA-bbbb');

    expect(vulns[0]!.message.text).toBe('left-pad@1.0.0: GHSA-zzzz (CVE-2024-2000) (moderate)');
    expect(vulns[0]!.properties?.aliases).toEqual(['CVE-2024-2000']);
    expect(vulns[3]!.message.text).toBe('lodash@4.17.20: GHSA-cccc (moderate)');
    expect(vulns[3]!.properties?.aliases).toEqual([]);
    expect(vulns[4]!.message.text).toBe('requests@2.31.0: GHSA-req (CVE-2023-1) (low 2.1)');

    for (const [index, result] of vulns.entries()) {
      expect(result.properties).toEqual(findings[index]!.details);
    }
  });

  it('keeps two OSV advisories that alias each other as two SARIF results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes('querybatch')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ results: [{ vulns: [{ id: 'CVE-2024-1111' }, { id: 'GHSA-bbbb' }] }] }),
          };
        }
        const id = decodeURIComponent(u.split('/v1/vulns/')[1] ?? '');
        const aliases = id === 'GHSA-bbbb' ? ['CVE-2024-1111', 'OSV-1'] : ['GHSA-bbbb'];
        const severity = id === 'GHSA-bbbb' ? 'CRITICAL' : 'HIGH';
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id,
            aliases,
            database_specific: { severity },
            affected: [
              {
                package: { ecosystem: 'npm', name: 'lodash' },
                ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
              },
            ],
          }),
        };
      }),
    );

    const scanned = await scanVulnerabilities(
      [{ ecosystem: 'npm', package: 'lodash', version: '4.17.20' }],
      { sem: new Semaphore(2) },
    );
    const findings = generateVulnerabilityFindings(scanned);
    const sarif = formatSarif(artifact(findings)) as SarifDoc;
    const results = sarif.runs[0]!.results;

    expect(results.map((result) => result.ruleId)).toEqual(['vibgrate/vulnerability', 'vibgrate/vulnerability']);
    expect(results.map((result) => result.properties?.advisoryId)).toEqual(['GHSA-bbbb', 'CVE-2024-1111']);
    expect(results[0]!.properties?.aliases).toEqual(['CVE-2024-1111', 'OSV-1']);
    expect(results[0]!.message.text).toBe(
      'lodash@4.17.20: GHSA-bbbb (CVE-2024-1111) (critical) — fix available (4.17.21)',
    );
    expect(results[1]!.properties?.aliases).toEqual(['GHSA-bbbb']);
    expect(results[1]!.message.text).toBe('lodash@4.17.20: CVE-2024-1111 (high) — fix available (4.17.21)');
    expect(results.map((result) => result.properties?.advisoryId)).not.toContain('OSV-1');
  });
});
