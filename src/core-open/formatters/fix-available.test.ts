import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { formatText as formatScanText } from './text.js';
import { formatText as formatReportText } from '../../reporting/formatters/text.js';
import { fixAvailableHint, presentFinding } from './fix-available.js';
import { generateVulnerabilityFindings } from '../scanners/vulnerability-scanner.js';
import type { ScanArtifact, VulnerabilityScanResult } from '../types.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/fix-available-findings.json', import.meta.url), 'utf8'),
) as {
  withFix: ScanArtifact['findings'][number];
  withoutFix: ScanArtifact['findings'][number];
  remediationOnly: ScanArtifact['findings'][number];
};

function artifact(findings: ScanArtifact['findings']): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-02-16T00:00:00.000Z',
    vibgrateVersion: '0.0.0-test',
    rootPath: '/fixture',
    projects: [],
    drift: {
      score: 10,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
      measured: ['runtime', 'framework', 'dependency', 'eol'],
    },
    findings,
  };
}

describe('fixAvailableHint', () => {
  it('names published fixed versions in payload order and drops duplicates', () => {
    expect(fixAvailableHint({ fixedVersions: ['4.17.21', '4.17.21', '5.0.0'] })).toBe(
      'fix available: 4.17.21, 5.0.0',
    );
    expect(fixAvailableHint({ fixed_versions: ['1.2.3-beta.1', '2.0.0'] })).toBe(
      'fix available: 1.2.3-beta.1, 2.0.0',
    );
  });

  it('uses a remediation string when no version is known', () => {
    expect(fixAvailableHint({ fixedVersions: [], remediation: 'replace with node:util' })).toBe(
      'fix available: replace with node:util',
    );
    expect(fixAvailableHint({ fix: 'upgrade the lockfile' })).toBe('fix available: upgrade the lockfile');
  });

  it('prefers versions over a remediation string', () => {
    expect(fixAvailableHint({ fixedVersions: ['9.0.0'], remediation: 'upgrade' })).toBe('fix available: 9.0.0');
  });

  it('returns null when the fix is unknown', () => {
    expect(fixAvailableHint(undefined)).toBeNull();
    expect(fixAvailableHint({})).toBeNull();
    expect(fixAvailableHint({ fixedVersions: [] })).toBeNull();
    expect(fixAvailableHint({ fixedVersions: ['', '  '] })).toBeNull();
    expect(fixAvailableHint({ remediation: 'no fix available' })).toBeNull();
    expect(fixAvailableHint({ remediation: 'none' })).toBeNull();
    expect(fixAvailableHint({ fix: 'unknown' })).toBeNull();
    expect(fixAvailableHint({ fixAvailable: false })).toBeNull();
    expect(fixAvailableHint({ fixAvailable: true })).toBeNull();
  });

  it('is deterministic for the same details', () => {
    const details = { patchedVersions: ['2.0.0', '1.5.0'], fixedVersion: '2.0.0' };
    expect(fixAvailableHint(details)).toBe(fixAvailableHint(details));
    expect(fixAvailableHint(details)).toBe('fix available: 2.0.0, 1.5.0');
  });
});

describe('presentFinding', () => {
  it('replaces a baked-in fixed-in clause with the structured hint', () => {
    const presented = presentFinding(fixture.withFix);
    expect(presented.fixHint).toBe('fix available: 4.17.21');
    expect(presented.message).toBe(
      'lodash@4.17.20: GHSA-35jh-r3h4-6jhm (CVE-2021-23337) (high 7.2) — introduced by Ada Lovelace in abc1234 (12d exposed)',
    );
    expect(presented.message).not.toMatch(/no fix/i);
    expect(presented.message).not.toMatch(/fixed in/i);
  });

  it('drops an invented no-fix claim and omits the hint', () => {
    const presented = presentFinding(fixture.withoutFix);
    expect(presented.fixHint).toBeNull();
    expect(presented.message).toBe(
      'minimist@1.2.5: GHSA-vh95-rmgr-6w4m (moderate 5.6) — introduced by Grace Hopper in def5678 (3d exposed)',
    );
    expect(presented.message).not.toMatch(/no fix/i);
    expect(`${presented.message} ${presented.fixHint ?? ''}`).not.toMatch(/fix available/i);
  });

  it('keeps a prerelease version intact when stripping the prose clause', () => {
    const presented = presentFinding({
      message: 'left-pad@1.0.0: GHSA-x (low) — fixed in 1.2.3-beta.1 — introduced by Ada in abc',
      details: { fixedVersions: ['1.2.3-beta.1'] },
    });
    expect(presented.fixHint).toBe('fix available: 1.2.3-beta.1');
    expect(presented.message).toBe('left-pad@1.0.0: GHSA-x (low) — introduced by Ada in abc');
  });

  it('surfaces remediation text and still drops a no-fix claim', () => {
    const presented = presentFinding(fixture.remediationOnly);
    expect(presented.fixHint).toBe('fix available: replace with the built-in node:util debug API');
    expect(presented.message).toBe('debug@2.6.9: GHSA-example (low)');
    expect(presented.message).not.toMatch(/no fix/i);
  });
});

describe('human scan and report text', () => {
  const sample = artifact([fixture.withFix, fixture.withoutFix, fixture.remediationOnly]);

  it.each([
    ['scan', formatScanText],
    ['report', formatReportText as (artifact: ScanArtifact) => string],
  ])('%s text shows a fix hint only when the payload has one', (_label, format) => {
    const once = stripVTControlCharacters(format(sample));
    const twice = stripVTControlCharacters(format(sample));
    expect(twice).toBe(once);

    expect(once).toContain('fix available: 4.17.21');
    expect(once).toContain('fix available: replace with the built-in node:util debug API');
    expect(once).toContain('lodash@4.17.20: GHSA-35jh-r3h4-6jhm (CVE-2021-23337) (high 7.2) — introduced by Ada Lovelace in abc1234 (12d exposed)');
    expect(once).toContain('minimist@1.2.5: GHSA-vh95-rmgr-6w4m (moderate 5.6) — introduced by Grace Hopper in def5678 (3d exposed)');
    expect(once).not.toMatch(/no fix/i);
    expect(once).not.toMatch(/fixed in/i);
    expect(once.match(/fix available:/g)).toHaveLength(2);
  });
});

describe('generateVulnerabilityFindings', () => {
  const base = {
    id: 'GHSA-1',
    aliases: ['CVE-2024-1'],
    summary: null,
    severity: 'high' as const,
    cvss: 7.5,
    cvssVector: null,
    published: null,
    withdrawn: null,
    references: [],
  };

  function result(fixedVersions: string[]): VulnerabilityScanResult {
    return {
      source: 'manifest',
      totalAdvisories: 1,
      severityCounts: { low: 0, moderate: 0, high: 1, critical: 0, unknown: 0 },
      packages: [
        {
          ecosystem: 'npm',
          package: 'lodash',
          version: '4.17.20',
          advisories: [{ ...base, fixedVersions }],
        },
      ],
    };
  }

  it('keeps a fixed version in the message and in details', () => {
    const [finding] = generateVulnerabilityFindings(result(['4.17.21']));
    expect(finding.message).toContain('fixed in 4.17.21');
    expect(finding.message).not.toMatch(/no fix/i);
    expect(finding.details?.fixedVersions).toEqual(['4.17.21']);
    expect(presentFinding(finding).fixHint).toBe('fix available: 4.17.21');
  });

  it('omits any fix claim when no fixed version is published', () => {
    const [finding] = generateVulnerabilityFindings(result([]));
    expect(finding.message).toBe('lodash@4.17.20: GHSA-1 (CVE-2024-1) (high 7.5)');
    expect(finding.message).not.toMatch(/no fix/i);
    expect(finding.message).not.toMatch(/fix available/i);
    expect(presentFinding(finding).fixHint).toBeNull();
  });
});
