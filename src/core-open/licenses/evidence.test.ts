import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSarif } from '../formatters/sarif.js';
import { runCoreScan } from '../run-core-scan.js';
import type { ScanArtifact } from '../types.js';
import {
  LICENSE_UNPARSEABLE_RULE_ID,
  collectLicenseFindings,
  type LicenseEvidenceSource,
} from './evidence.js';

const SECRET = 'DO-NOT-LEAK-TOKEN';

function findingPaths(findings: Array<{ location: string; details?: Record<string, unknown> }>): string[] {
  return findings.map((finding) => finding.location);
}

describe('collectLicenseFindings', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-license-evidence-'));
    roots.push(root);
    return root;
  }

  function write(root: string, rel: string, body: string): void {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }

  it('reports an unparseable license file at a stable repo-relative path', async () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ name: 'fixture', license: 'Apache-2.0' }));
    write(
      root,
      'LICENSE',
      ['Example Internal Terms', SECRET, 'Use requires a separate agreement.'].join('\n'),
    );

    const first = await collectLicenseFindings(root, [{ path: '.' }]);
    const second = await collectLicenseFindings(root, [{ path: '.' }, { path: '.' }]);

    expect(findingPaths(first)).toEqual(['LICENSE']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify(first)).not.toContain(SECRET);
    expect(first[0]).toEqual({
      ruleId: LICENSE_UNPARSEABLE_RULE_ID,
      level: 'warning',
      message: 'Unparseable license text at LICENSE.',
      location: 'LICENSE',
      details: { path: 'LICENSE', source: 'license-file' satisfies LicenseEvidenceSource },
    });
    expect(path.isAbsolute(first[0]!.location)).toBe(false);
    expect(first[0]!.location.includes(root)).toBe(false);
  });

  it('points an unparseable package.json license field at the manifest', async () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({
      name: 'fixture',
      license: { url: `https://example.invalid/${SECRET}` },
    }));

    const findings = await collectLicenseFindings(root, [{ path: '.' }]);
    expect(findingPaths(findings)).toEqual(['package.json']);
    expect(findings[0]?.details).toEqual({ path: 'package.json', source: 'manifest' });
    expect(JSON.stringify(findings)).not.toContain(SECRET);
    expect(JSON.stringify(findings)).not.toContain('example.invalid');
  });

  it('keeps a failed SPDX tag from falling through to a later title', async () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ name: 'fixture' }));
    write(root, 'LICENSE', ['SPDX-License-Identifier: NotAReal-License-9.9', 'MIT License', SECRET].join('\n'));

    const findings = await collectLicenseFindings(root, [{ path: '.' }]);
    expect(findingPaths(findings)).toEqual(['LICENSE']);
    expect(JSON.stringify(findings)).not.toContain(SECRET);
    expect(JSON.stringify(findings)).not.toContain('NotAReal');
  });

  it('does not flag standard license titles or an identified manifest', async () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ name: 'fixture', license: 'Apache-2.0' }));
    write(root, 'LICENSE', 'Apache License\nVersion 2.0, January 2004\n');
    write(root, 'COPYING', 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n');
    write(root, 'NOTICE', 'Licensed under the Apache License, Version 2.0 (the "License").\n');

    const findings = await collectLicenseFindings(root, [{ path: '.' }]);
    expect(findings).toEqual([]);
  });

  it('sorts paths and scans a nested project directory once', async () => {
    const root = makeRoot();
    write(root, 'pkg/package.json', JSON.stringify({ name: 'pkg', license: 'NotAReal-License-9.9' }));
    write(root, 'pkg/NOTICE', 'Custom notice terms without a recognizable license.\n');
    write(root, 'pkg/LICENSE', 'Example Internal Terms\n');

    const findings = await collectLicenseFindings(root, [
      { path: 'pkg' },
      { path: 'pkg' },
    ]);
    expect(findings.map((finding) => `${finding.location}:${String(finding.details?.source)}`)).toEqual([
      'pkg/LICENSE:license-file',
      'pkg/NOTICE:notice',
      'pkg/package.json:manifest',
    ]);
  });

  it('does not follow a license symlink outside the repository', async () => {
    const root = makeRoot();
    const outside = path.join(os.tmpdir(), `vg-license-outside-${process.pid}`);
    fs.writeFileSync(outside, `${SECRET}\n`);
    roots.push(outside);
    write(root, 'package.json', JSON.stringify({ name: 'fixture', license: 'MIT' }));
    fs.symlinkSync(outside, path.join(root, 'LICENSE'));

    const findings = await collectLicenseFindings(root, [{ path: '.' }]);
    expect(findings).toEqual([]);
    expect(JSON.stringify(findings)).not.toContain(SECRET);
  });

  it('puts the same path on SARIF artifact location and properties', async () => {
    const root = makeRoot();
    write(root, 'package.json', JSON.stringify({ name: 'fixture', license: 'MIT' }));
    write(root, 'LICENSE', 'Example Internal Terms\n');

    const findings = await collectLicenseFindings(root, [{ path: '.' }]);
    const sarif = formatSarif({
      schemaVersion: '1.0',
      timestamp: '2026-01-01T00:00:00.000Z',
      vibgrateVersion: 'test',
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
        measured: [],
        methodologyVersion: 'test',
      },
      findings,
    } as ScanArtifact) as {
      runs: Array<{
        tool: { driver: { rules: Array<{ id: string; shortDescription: { text: string } }> } };
        results: Array<{
          ruleId: string;
          message: { text: string };
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
          properties: { path: string; source: string };
        }>;
      }>;
    };

    const result = sarif.runs[0]!.results[0]!;
    expect(result.ruleId).toBe(LICENSE_UNPARSEABLE_RULE_ID);
    expect(result.message.text).toBe('Unparseable license text at LICENSE.');
    expect(result.locations[0]!.physicalLocation.artifactLocation.uri).toBe('LICENSE');
    expect(result.properties.path).toBe('LICENSE');
    expect(sarif.runs[0]!.tool.driver.rules[0]).toMatchObject({
      id: LICENSE_UNPARSEABLE_RULE_ID,
      shortDescription: { text: 'License text could not be parsed as SPDX' },
    });
    expect(JSON.stringify(sarif)).not.toContain(root);
  });
});

describe('repository license files', () => {
  it('does not flag this repository root (Apache-2.0 manifest, LICENSE, and NOTICE)', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
    const findings = await collectLicenseFindings(repoRoot, [{ path: '.' }]);
    expect(findings).toEqual([]);
  });
});

describe('vg scan license findings', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it('includes the license file path in scan JSON and SARIF', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-license-scan-'));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'license-path-fixture', version: '1.0.0', license: 'Apache-2.0' }),
    );
    fs.writeFileSync(
      path.join(root, 'LICENSE'),
      ['Example Internal Terms', SECRET, 'Contact the project authors for the terms.'].join('\n'),
    );

    const out = path.join(root, 'scan.json');
    const artifact = await runCoreScan(root, {
      format: 'json',
      out,
      concurrency: 2,
      offline: true,
      quiet: true,
      noLocalArtifacts: true,
      vibgrateVersion: 'test',
    });

    const report = JSON.parse(fs.readFileSync(out, 'utf8')) as {
      findings: Array<{ ruleId?: string; location?: string; message?: string; details?: { path?: string } }>;
    };
    const jsonFinding = report.findings.find((finding) => finding.ruleId === LICENSE_UNPARSEABLE_RULE_ID);
    expect(jsonFinding).toMatchObject({
      location: 'LICENSE',
      message: 'Unparseable license text at LICENSE.',
      details: { path: 'LICENSE', source: 'license-file' },
    });
    expect(JSON.stringify(report)).not.toContain(SECRET);

    const sarif = formatSarif(artifact) as {
      runs: Array<{
        results: Array<{
          ruleId: string;
          locations: Array<{ physicalLocation: { artifactLocation: { uri: string } } }>;
          properties?: { path?: string };
        }>;
      }>;
    };
    const sarifResult = sarif.runs.flatMap((run) => run.results).find((result) => result.ruleId === LICENSE_UNPARSEABLE_RULE_ID);
    expect(sarifResult?.locations[0]?.physicalLocation.artifactLocation.uri).toBe('LICENSE');
    expect(sarifResult?.properties?.path).toBe('LICENSE');
    expect(JSON.stringify(sarif)).not.toContain(SECRET);
  });
});
