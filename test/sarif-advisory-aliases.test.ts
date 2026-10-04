/**
 * Pins the SARIF shape documented under "Advisory aliases" in DOCS.md.
 *
 * One advisory record is one result, even when it lists several ids. Two
 * records that name each other in `aliases` stay two results. Order comes from
 * the offline scan (ecosystem, package, version, then severity, then id), not
 * from the order of the manifest.
 */
import { describe, expect, it } from 'vitest';
import {
  formatSarif,
  generateVulnerabilityFindings,
  scanVulnerabilities,
  Semaphore,
  type Finding,
  type ScanArtifact,
  type VulnerabilityScanResult,
} from '../src/core-open/index.js';

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
  properties?: Record<string, unknown>;
  partialFingerprints?: Record<string, string>;
}

interface SarifDoc {
  version: string;
  runs: Array<{
    tool: { driver: { rules: Array<{ id: string }> } };
    results: SarifResult[];
  }>;
}

function toSarif(result: VulnerabilityScanResult, leading: Finding[] = []): SarifDoc {
  const artifact: ScanArtifact = {
    schemaVersion: '1.0',
    timestamp: '2026-01-01T00:00:00.000Z',
    vibgrateVersion: '0.0.0-test',
    rootPath: 'fixture',
    projects: [],
    drift: {
      score: 0,
      riskLevel: 'low',
      components: {
        runtimeScore: 0,
        frameworkScore: 0,
        dependencyScore: 0,
        eolScore: 0,
      },
    },
    findings: [...leading, ...generateVulnerabilityFindings(result)],
  };
  return formatSarif(artifact) as SarifDoc;
}

describe('SARIF advisory aliases', () => {
  it('emits one result for an advisory that lists several ids', async () => {
    const scanned = await scanVulnerabilities(
      [{ ecosystem: 'npm', package: 'widget', version: '1.2.0' }],
      {
        sem: new Semaphore(1),
        offline: true,
        manifest: {
          npm: {
            widget: {
              latest: '1.2.0',
              vulns: [
                {
                  id: 'GHSA-widg-et00-0001',
                  // OSV id first, CVE second: the message still picks the CVE,
                  // and properties.aliases keeps this order.
                  aliases: ['OSV-2099-9', 'CVE-2099-9999'],
                  severity: 'high',
                  cvss: 7.5,
                  ranges: [{ introduced: '0', fixed: '1.2.1' }],
                },
              ],
            },
          },
        },
      },
    );

    const sarif = toSarif(scanned);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.rules.map((rule) => rule.id)).toEqual(['vibgrate/vulnerability']);
    expect(sarif.runs[0].results).toHaveLength(1);

    const [result] = sarif.runs[0].results;
    expect(result).toEqual({
      ruleId: 'vibgrate/vulnerability',
      level: 'error',
      message: {
        text: 'widget@1.2.0: GHSA-widg-et00-0001 (CVE-2099-9999) (high 7.5) — fixed in 1.2.1',
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: 'widget' },
          },
        },
      ],
      properties: {
        ecosystem: 'npm',
        package: 'widget',
        installedVersion: '1.2.0',
        advisoryId: 'GHSA-widg-et00-0001',
        aliases: ['OSV-2099-9', 'CVE-2099-9999'],
        severity: 'high',
        cvss: 7.5,
        fixedVersions: ['1.2.1'],
      },
    });
    expect(result.partialFingerprints).toBeUndefined();
    expect(JSON.stringify(toSarif(scanned))).toBe(JSON.stringify(sarif));
  });

  it('keeps aliasing records separate and orders results independent of manifest order', async () => {
    // Targets and advisories are listed backwards from the documented order.
    const scanned = await scanVulnerabilities(
      [
        { ecosystem: 'npm', package: 'zeta', version: '1.0.0' },
        { ecosystem: 'npm', package: 'alpha', version: '2.0.0' },
        { ecosystem: 'cargo', package: 'zzz-crate', version: '0.1.0' },
      ],
      {
        sem: new Semaphore(1),
        offline: true,
        manifest: {
          npm: {
            zeta: {
              vulns: [
                {
                  id: 'CVE-2099-0001',
                  aliases: ['GHSA-aaaa-bbbb-cccc'],
                  severity: 'moderate',
                  cvss: 5.3,
                  ranges: [{ introduced: '0', fixed: '1.2.0' }],
                },
                {
                  id: 'GHSA-aaaa-bbbb-cccc',
                  aliases: ['CVE-2099-0001', 'OSV-2099-1'],
                  severity: 'high',
                  cvss: 7.5,
                  ranges: [{ introduced: '0', fixed: '1.2.0' }],
                },
              ],
            },
            alpha: {
              vulns: [
                {
                  id: 'GHSA-bbbb-0000-0002',
                  aliases: ['CVE-2099-0002'],
                  severity: 'moderate',
                  cvss: 5,
                  ranges: [{ introduced: '0', fixed: '2.1.0' }],
                },
                {
                  id: 'GHSA-aaaa-0000-0001',
                  aliases: [],
                  severity: 'moderate',
                  cvss: null,
                  ranges: [{ introduced: '0' }],
                },
              ],
            },
          },
          cargo: {
            'zzz-crate': {
              vulns: [
                {
                  id: 'RUSTSEC-2099-0001',
                  aliases: ['CVE-2099-4242'],
                  severity: 'low',
                  ranges: [{ introduced: '0', fixed: '0.2.0' }],
                },
              ],
            },
          },
        },
      },
    );

    const leading: Finding = {
      ruleId: 'vibgrate/runtime-lag',
      level: 'warning',
      message: 'runtime lag',
      location: '.',
    };
    const sarif = toSarif(scanned, [leading]);
    const rules = sarif.runs[0].tool.driver.rules.map((rule) => rule.id);
    expect(rules).toEqual(['vibgrate/runtime-lag', 'vibgrate/vulnerability']);

    const vulns = sarif.runs[0].results.slice(1);
    expect(vulns.map((result) => result.partialFingerprints)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(vulns.map((result) => ({
      uri: result.locations[0].physicalLocation.artifactLocation.uri,
      level: result.level,
      advisoryId: result.properties?.advisoryId,
      aliases: result.properties?.aliases,
      message: result.message.text,
    }))).toEqual([
      {
        uri: 'zzz-crate',
        level: 'note',
        advisoryId: 'RUSTSEC-2099-0001',
        aliases: ['CVE-2099-4242'],
        message: 'zzz-crate@0.1.0: RUSTSEC-2099-0001 (CVE-2099-4242) (low) — fixed in 0.2.0',
      },
      {
        uri: 'alpha',
        level: 'warning',
        advisoryId: 'GHSA-aaaa-0000-0001',
        aliases: [],
        message: 'alpha@2.0.0: GHSA-aaaa-0000-0001 (moderate) — no fix available',
      },
      {
        uri: 'alpha',
        level: 'warning',
        advisoryId: 'GHSA-bbbb-0000-0002',
        aliases: ['CVE-2099-0002'],
        message: 'alpha@2.0.0: GHSA-bbbb-0000-0002 (CVE-2099-0002) (moderate 5) — fixed in 2.1.0',
      },
      {
        uri: 'zeta',
        level: 'error',
        advisoryId: 'GHSA-aaaa-bbbb-cccc',
        aliases: ['CVE-2099-0001', 'OSV-2099-1'],
        message: 'zeta@1.0.0: GHSA-aaaa-bbbb-cccc (CVE-2099-0001) (high 7.5) — fixed in 1.2.0',
      },
      {
        uri: 'zeta',
        level: 'warning',
        advisoryId: 'CVE-2099-0001',
        aliases: ['GHSA-aaaa-bbbb-cccc'],
        message: 'zeta@1.0.0: CVE-2099-0001 (moderate 5.3) — fixed in 1.2.0',
      },
    ]);
  });
});
