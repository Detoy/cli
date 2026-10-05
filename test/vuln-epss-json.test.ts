import { describe, it, expect, afterEach, vi } from 'vitest';
import { Semaphore } from '../src/core-open/utils/semaphore.js';
import { generateVulnerabilityFindings, parseOsvAdvisory, scanVulnerabilities } from '../src/core-open/index.js';
import type { PackageVersionManifest } from '../src/core-open/package-version-manifest.js';

describe('vg scan --vulns JSON exploitability fields', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits EPSS when the advisory does not carry it, and keeps a real 0', () => {
    const absent = parseOsvAdvisory({ id: 'GHSA-absent', database_specific: { severity: 'HIGH' } }, 'pkg');
    expect(absent).not.toHaveProperty('epss');
    expect(absent).not.toHaveProperty('epssPercentile');
    expect(absent).not.toHaveProperty('kev');
    expect(JSON.stringify(absent)).not.toContain('"epss":0');

    const zero = parseOsvAdvisory({ id: 'GHSA-zero', database_specific: { epss: 0, kev: false } }, 'pkg');
    expect(zero.epss).toBe(0);
    expect(zero.kev).toBe(false);
  });

  it('does not phone home for EPSS on the offline manifest path, and does not reorder advisories by score', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('offline --package-manifest must not fetch EPSS');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const manifest: PackageVersionManifest = {
      npm: {
        lodash: {
          vulns: [
            { id: 'GHSA-low-hot', severity: 'low', epss: 0.99, ranges: [{ introduced: '0', fixed: '4.17.21' }] },
            { id: 'GHSA-crit-cold', severity: 'critical', ranges: [{ introduced: '0', fixed: '4.17.21' }] },
          ],
        },
      },
    };
    const result = await scanVulnerabilities([{ ecosystem: 'npm', package: 'lodash', version: '4.17.20' }], {
      sem: new Semaphore(2),
      offline: true,
      manifest,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.packages[0].advisories.map((a) => a.id)).toEqual(['GHSA-crit-cold', 'GHSA-low-hot']);
    expect(result.packages[0].advisories[0]).not.toHaveProperty('epss');
    expect(result.packages[0].advisories[1].epss).toBe(0.99);
  });

  it('leaves SARIF finding details without exploitability fields', () => {
    const findings = generateVulnerabilityFindings({
      source: 'osv',
      totalAdvisories: 1,
      severityCounts: { low: 1, moderate: 0, high: 0, critical: 0, unknown: 0 },
      packages: [
        {
          ecosystem: 'npm',
          package: 'lodash',
          version: '4.17.20',
          advisories: [
            {
              id: 'GHSA-a',
              aliases: [],
              summary: null,
              severity: 'low',
              cvss: 3.1,
              cvssVector: null,
              fixedVersions: [],
              published: null,
              withdrawn: null,
              references: [],
              epss: 0.1,
              kev: true,
            },
          ],
        },
      ],
    });
    expect(findings[0].details).not.toHaveProperty('epss');
    expect(findings[0].details).not.toHaveProperty('kev');
    expect(findings[0].message).not.toMatch(/EPSS/);
  });
});
