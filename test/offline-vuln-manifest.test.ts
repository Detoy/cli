// Offline `vg scan --vulns --package-manifest` orders vulnerability findings
// from the manifest alone: ecosystem, package, version, then severity, then
// advisory id. Input order and a live registry must not change that.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';
import {
  generateVulnerabilityFindings,
  scanVulnerabilities,
  type VulnTarget,
} from '../src/core-open/scanners/vulnerability-scanner.js';
import { Semaphore } from '../src/core-open/utils/semaphore.js';

const TARGETS: VulnTarget[] = [
  { ecosystem: 'pypi', package: 'requests', version: '2.31.0' },
  { ecosystem: 'npm', package: 'lodash', version: '4.17.20' },
  { ecosystem: 'npm', package: 'left-pad', version: '1.2.0' },
];

function manifest(reverseAdvisories: boolean): PackageVersionManifest {
  const leftPad = [
    {
      id: 'GHSA-zzzz-crit',
      severity: 'critical' as const,
      ranges: [{ introduced: '0', fixed: '1.3.0' }],
    },
    {
      id: 'GHSA-aaaa-low',
      severity: 'low' as const,
      ranges: [{ introduced: '0', fixed: '1.3.0' }],
    },
    {
      id: 'GHSA-withdrawn',
      severity: 'critical' as const,
      withdrawn: '2024-01-01T00:00:00Z',
      ranges: [{ introduced: '0', fixed: '1.3.0' }],
    },
  ];
  const lodash = [
    {
      id: 'GHSA-lodash-high',
      severity: 'high' as const,
      ranges: [{ introduced: '0', fixed: '4.17.21' }],
    },
    {
      id: 'GHSA-lodash-old',
      severity: 'critical' as const,
      ranges: [{ introduced: '0', fixed: '4.17.15' }],
    },
  ];
  const requests = [
    {
      id: 'GHSA-req-b',
      severity: 'moderate' as const,
      aliases: ['CVE-2024-00002'],
      ranges: [{ introduced: '0', fixed: '2.32.0' }],
    },
    {
      id: 'GHSA-req-a',
      severity: 'moderate' as const,
      aliases: ['CVE-2024-00001'],
      ranges: [{ introduced: '0', fixed: '2.32.0' }],
    },
  ];
  const flip = <T>(rows: T[]): T[] => (reverseAdvisories ? [...rows].reverse() : rows);
  return {
    npm: {
      'left-pad': { latest: '1.3.0', versions: ['1.2.0', '1.3.0'], vulns: flip(leftPad) },
      lodash: { latest: '4.17.21', versions: ['4.17.20', '4.17.21'], vulns: flip(lodash) },
    },
    pypi: {
      requests: { latest: '2.32.0', versions: ['2.31.0', '2.32.0'], vulns: flip(requests) },
    },
  };
}

function advisoryIds(findings: ReturnType<typeof generateVulnerabilityFindings>): string[] {
  return findings.map((finding) => String(finding.details?.advisoryId));
}

describe('offline package-manifest vulnerability findings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps advisory ids and order stable for the same manifest', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline scan must not call fetch'));
    const sem = new Semaphore(1);

    const forward = generateVulnerabilityFindings(
      await scanVulnerabilities(TARGETS, { sem, offline: true, manifest: manifest(false) }),
    );
    const reversed = generateVulnerabilityFindings(
      await scanVulnerabilities([...TARGETS].reverse(), { sem, offline: true, manifest: manifest(true) }),
    );

    // Severity outranks id: critical GHSA-zzzz sorts ahead of low GHSA-aaaa.
    // Same-severity ids sort alphabetically: GHSA-req-a before GHSA-req-b.
    expect(advisoryIds(forward)).toEqual([
      'GHSA-zzzz-crit',
      'GHSA-aaaa-low',
      'GHSA-lodash-high',
      'GHSA-req-a',
      'GHSA-req-b',
    ]);
    expect(advisoryIds(reversed)).toEqual(advisoryIds(forward));
    expect(reversed).toEqual(forward);
    expect(forward.every((finding) => finding.ruleId === 'vibgrate/vulnerability')).toBe(true);
    expect(forward.map((finding) => [finding.details?.ecosystem, finding.details?.package, finding.details?.installedVersion])).toEqual([
      ['npm', 'left-pad', '1.2.0'],
      ['npm', 'left-pad', '1.2.0'],
      ['npm', 'lodash', '4.17.20'],
      ['pypi', 'requests', '2.31.0'],
      ['pypi', 'requests', '2.31.0'],
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
