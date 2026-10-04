import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatText as formatScanText } from '../../core-open/formatters/text.js';
import { fixAvailableHint, presentFinding } from '../../core-open/formatters/fix-hint.js';
import { generateVulnerabilityFindings } from '../../core-open/scanners/vulnerability-scanner.js';
import type { VulnerabilityAdvisory, VulnerabilityScanResult } from '../../core-open/types.js';
import type { ScanArtifact } from '../types.js';
import { formatText as formatReportText } from './text.js';

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const FIXTURE_PATH = new URL('../../../test/fixtures/fix-available-scan.json', import.meta.url);

function loadFixture(): ScanArtifact {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as ScanArtifact;
}

function findingLines(text: string): string[] {
  const lines = stripAnsi(text).split('\n');
  const start = lines.findIndex((line) => line.includes('Findings'));
  const end = lines.findIndex((line, i) => i > start && line.includes('╭'));
  return lines
    .slice(start, end === -1 ? undefined : end)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('fixAvailableHint', () => {
  it('joins known fixed versions and drops blanks and duplicates', () => {
    expect(fixAvailableHint({ fixedVersions: ['4.17.21', '', '4.17.21', ' 5.0.0 '] })).toBe(
      'fix available: 4.17.21, 5.0.0',
    );
  });

  it('reads a single fixedVersion string', () => {
    expect(fixAvailableHint({ fixedVersion: '5.4.0' })).toBe('fix available: 5.4.0');
  });

  it('uses a remediation string when no version is present', () => {
    expect(fixAvailableHint({ remediation: '  Upgrade the package.  ' })).toBe('fix available: Upgrade the package.');
  });

  it('prefers versions over a remediation string', () => {
    expect(fixAvailableHint({ fixedVersions: ['1.2.3'], remediation: 'Upgrade the package.' })).toBe(
      'fix available: 1.2.3',
    );
  });

  it('omits the hint when fix metadata is missing, empty, or blank', () => {
    expect(fixAvailableHint(undefined)).toBeNull();
    expect(fixAvailableHint(null)).toBeNull();
    expect(fixAvailableHint({})).toBeNull();
    expect(fixAvailableHint({ fixedVersions: [] })).toBeNull();
    expect(fixAvailableHint({ fixedVersions: ['', '  '] })).toBeNull();
    expect(fixAvailableHint({ fixedVersion: '   ' })).toBeNull();
    expect(fixAvailableHint({ remediation: '   ' })).toBeNull();
    expect(fixAvailableHint({ summary: 'no published fix' })).toBeNull();
  });

  it('does not invent a no-fix claim from an empty list', () => {
    const presented = presentFinding({
      message: 'minimist@1.2.5: GHSA-2 (moderate) — no fix available — introduced by Ada in aaaaaaa (12d exposed)',
      details: { fixedVersions: [] },
    });
    expect(presented.hint).toBeNull();
    expect(presented.message).toBe('minimist@1.2.5: GHSA-2 (moderate) — introduced by Ada in aaaaaaa (12d exposed)');
    expect(presented.message).not.toMatch(/no fix/i);
  });
});

describe('scan and report human text', () => {
  const artifact = loadFixture();

  it('prints fix-available hints from the fixture and omits them when unknown', () => {
    const scanLines = findingLines(formatScanText(artifact as never));
    const reportLines = findingLines(formatReportText(artifact));

    const expected = [
      'Findings (1 error, 2 warnings, 2 notes)',
      '✖ lodash@4.17.20: GHSA-1 (CVE-2021-1) (critical 9.8)',
      'vibgrate/vulnerability in lodash',
      'fix available: 4.17.21, 5.0.0',
      '⚠ minimist@1.2.5: GHSA-2 (moderate 5.3) — introduced by Ada in aaaaaaa (12d exposed)',
      'vibgrate/vulnerability in minimist',
      'ℹ left-pad@1.3.0: GHSA-3 (low)',
      'vibgrate/vulnerability in left-pad',
      'fix available: Replace left-pad with a direct implementation.',
      '⚠ Node.js runtime ">=20.0.0" is 2 major versions behind.',
      'vibgrate/runtime-lag in /fixture',
      'ℹ chalk is 1 major behind.',
      'vibgrate/dependency-major-lag in /fixture',
      'fix available: 5.4.0',
    ];

    expect(scanLines).toEqual(expected);
    expect(reportLines).toEqual(expected);
  });

  it('is deterministic for the same artifact', () => {
    const once = stripAnsi(formatScanText(artifact as never));
    const twice = stripAnsi(formatScanText(artifact as never));
    expect(once).toBe(twice);
    expect(stripAnsi(formatReportText(artifact))).toBe(stripAnsi(formatReportText(artifact)));
    expect(once).not.toMatch(/no fix/i);
    expect(stripAnsi(formatReportText(artifact))).not.toMatch(/no fix/i);
  });
});

describe('generateVulnerabilityFindings', () => {
  function advisory(overrides: Partial<VulnerabilityAdvisory> = {}): VulnerabilityAdvisory {
    return {
      id: 'GHSA-1',
      aliases: [],
      summary: null,
      severity: 'high',
      cvss: 7.2,
      cvssVector: null,
      fixedVersions: [],
      published: null,
      withdrawn: null,
      references: [],
      ...overrides,
    };
  }

  function result(adv: VulnerabilityAdvisory): VulnerabilityScanResult {
    return {
      source: 'manifest',
      packages: [{ ecosystem: 'npm', package: 'lodash', version: '4.17.20', advisories: [adv] }],
      totalAdvisories: 1,
      severityCounts: { low: 0, moderate: 0, high: 1, critical: 0, unknown: 0 },
    };
  }

  it('keeps fixed versions on the payload and does not write a no-fix claim', () => {
    const withFix = generateVulnerabilityFindings(result(advisory({ fixedVersions: ['4.17.21'] })));
    expect(withFix[0].message).toBe('lodash@4.17.20: GHSA-1 (high 7.2)');
    expect(withFix[0].message).not.toMatch(/no fix/i);
    expect(withFix[0].details).toMatchObject({ fixedVersions: ['4.17.21'] });
    expect(presentFinding(withFix[0]).hint).toBe('fix available: 4.17.21');

    const unknown = generateVulnerabilityFindings(result(advisory({ fixedVersions: [] })));
    expect(unknown[0].message).toBe('lodash@4.17.20: GHSA-1 (high 7.2)');
    expect(unknown[0].message).not.toMatch(/no fix|fix available/i);
    expect(presentFinding(unknown[0]).hint).toBeNull();
  });

  it('keeps a CVSS parse note and attribution on the message', () => {
    const finding = generateVulnerabilityFindings(
      result(
        advisory({
          fixedVersions: [],
          cvss: null,
          cvssVector: 'CVSS:3.1/not-a-vector',
          cvssDiagnostic: { code: 'cvss-vector-parse-failed', message: 'CVSS vector could not be parsed' },
          introduced: {
            sha: 'a'.repeat(40),
            shortSha: 'aaaaaaa',
            authorName: 'Ada',
            authorEmail: 'ada@example.com',
            date: '2021-01-01T00:00:00Z',
            subject: 'add lodash',
          },
          exposureDays: 12,
        }),
      ),
    )[0];

    expect(finding.message).toBe(
      'lodash@4.17.20: GHSA-1 (high) — CVSS vector could not be parsed — introduced by Ada in aaaaaaa (12d exposed)',
    );
    expect(finding.message).not.toMatch(/no fix/i);
    expect(presentFinding(finding).hint).toBeNull();
    expect(finding.details).toMatchObject({ fixedVersions: [], exposureDays: 12 });
  });
});
