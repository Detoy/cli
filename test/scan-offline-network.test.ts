import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCoreScan } from '../src/core-open/index.js';

describe('offline scan network boundary', () => {
  let root: string;
  let fetchTripwire: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-offline-network-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'offline-network-fixture',
        version: '1.0.0',
        dependencies: { 'left-pad': '^1.3.0' },
      }),
    );
    fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM node:22\n');
    fs.mkdirSync(path.join(root, 'chart'));
    fs.writeFileSync(
      path.join(root, 'chart', 'Chart.yaml'),
      [
        'apiVersion: v2',
        'name: offline-fixture',
        'version: 0.1.0',
        'dependencies:',
        '  - name: redis',
        '    version: ">=1.0.0"',
        '    repository: https://example.invalid/charts',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'main.tf'),
      [
        'terraform {',
        '  required_providers {',
        '    random = { source = "hashicorp/random", version = ">= 3.0" }',
        '  }',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'offline-package-manifest.json'),
      JSON.stringify({
        npm: {
          'left-pad': {
            latest: '1.3.0',
            versions: ['1.3.0'],
            vulns: [
              {
                id: 'GHSA-offline-fixture',
                summary: 'Fixture advisory for the offline path',
                severity: 'moderate',
                ranges: [{ introduced: '0', fixed: '1.3.1' }],
                epss: 0.42,
                epssPercentile: 0.91,
                kev: true,
              },
            ],
          },
        },
      }),
    );

    fetchTripwire = vi.fn(async () => {
      throw new Error('unexpected network access during offline scan');
    });
    vi.stubGlobal('fetch', fetchTripwire);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not call fetch and writes a manifest-backed local report', async () => {
    const reportPath = path.join(root, 'offline-report.json');

    await runCoreScan(root, {
      format: 'json',
      out: reportPath,
      concurrency: 2,
      offline: true,
      vulns: true,
      quiet: true,
      packageManifest: path.join(root, 'offline-package-manifest.json'),
      vibgrateVersion: 'test',
    });

    expect(fetchTripwire).not.toHaveBeenCalled();
    expect(fs.existsSync(reportPath)).toBe(true);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
      findings: Array<{ ruleId?: string; message?: string }>;
      extended?: {
        vulnerabilities?: {
          source?: string;
          totalAdvisories?: number;
          packages?: Array<{ advisories?: Array<Record<string, unknown>> }>;
        };
      };
    };
    expect(report.extended?.vulnerabilities).toMatchObject({ source: 'manifest', totalAdvisories: 1 });
    expect(report.extended?.vulnerabilities?.packages?.[0]?.advisories?.[0]).toMatchObject({
      id: 'GHSA-offline-fixture',
      epss: 0.42,
      epssPercentile: 0.91,
      kev: true,
    });
    expect(report.findings.some((finding) => finding.message?.includes('GHSA-offline-fixture'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.vibgrate', 'scan_result.json'))).toBe(true);
  });
});

describe('offline scan findings order', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-offline-order-'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: 'offline-order-fixture',
        version: '1.0.0',
        dependencies: { ms: '2.1.3', 'left-pad': '1.3.0' },
      }),
    );
    fs.writeFileSync(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'offline-order-fixture',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'offline-order-fixture',
            version: '1.0.0',
            dependencies: { ms: '2.1.3', 'left-pad': '1.3.0' },
          },
          'node_modules/left-pad': { version: '1.3.0' },
          'node_modules/ms': { version: '2.1.3' },
        },
      }),
    );
    // Advisory and package key order here is the reverse of the scan order.
    fs.writeFileSync(
      path.join(root, 'package-versions.json'),
      JSON.stringify({
        npm: {
          ms: {
            latest: '2.1.3',
            versions: ['2.1.3'],
            vulns: [
              {
                id: 'GHSA-ms-moderate',
                severity: 'moderate',
                ranges: [{ introduced: '0', fixed: '3.0.0' }],
              },
            ],
          },
          'left-pad': {
            latest: '1.3.0',
            versions: ['1.3.0'],
            vulns: [
              {
                id: 'GHSA-low-example',
                severity: 'low',
                ranges: [{ introduced: '0', fixed: '1.3.1' }],
              },
              {
                id: 'GHSA-high-example',
                severity: 'high',
                ranges: [{ introduced: '0', fixed: '1.3.1' }],
              },
            ],
          },
        },
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('unexpected network access during offline scan');
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function vulnIdentity(artifact: Awaited<ReturnType<typeof runCoreScan>>) {
    return {
      findings: artifact.findings
        .filter((finding) => finding.ruleId === 'vibgrate/vulnerability')
        .map((finding) => ({
          ruleId: finding.ruleId,
          level: finding.level,
          message: finding.message,
          location: finding.location,
          advisoryId: typeof finding.details?.advisoryId === 'string' ? finding.details.advisoryId : undefined,
        })),
      packages: (artifact.extended?.vulnerabilities?.packages ?? []).map((pkg) => ({
        package: pkg.package,
        ids: (pkg.advisories ?? []).map((advisory) => advisory.id),
      })),
      source: artifact.extended?.vulnerabilities?.source,
    };
  }

  it('keeps vulnerability finding order and advisory ids stable for the same tree and manifest', async () => {
    const opts = {
      format: 'json' as const,
      concurrency: 2,
      offline: true,
      vulns: true,
      quiet: true,
      noLocalArtifacts: true,
      packageManifest: path.join(root, 'package-versions.json'),
      vibgrateVersion: 'test',
    };
    const first = vulnIdentity(await runCoreScan(root, opts));
    const second = vulnIdentity(await runCoreScan(root, opts));

    expect(first.source).toBe('manifest');
    expect(first.findings.map((finding) => finding.advisoryId)).toEqual([
      'GHSA-high-example',
      'GHSA-low-example',
      'GHSA-ms-moderate',
    ]);
    expect(first.packages).toEqual([
      { package: 'left-pad', ids: ['GHSA-high-example', 'GHSA-low-example'] },
      { package: 'ms', ids: ['GHSA-ms-moderate'] },
    ]);
    expect(second).toEqual(first);
  });
});
