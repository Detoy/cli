import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  baselineFileReference,
  findingId,
  formatSarif,
  readBaselineComparison,
  runCoreScan,
  suppressedBaselineFindings,
  type Finding,
  type ScanOptions,
} from '../core-open/index.js';

function finding(overrides: Partial<Finding> & Pick<Finding, 'ruleId' | 'location'>): Finding {
  return {
    level: 'warning',
    message: 'placeholder',
    ...overrides,
  };
}

describe('baseline finding ids', () => {
  it('locks the id for a location-only rule', () => {
    expect(findingId(finding({
      ruleId: 'vibgrate/dependency-rot',
      message: '40% of dependencies are 2+ major versions behind in app.',
      location: 'package.json',
    }))).toBe('af173ea1c1efa4fd');
  });

  it('keeps the same id when a location-only message changes', () => {
    const older = finding({ ruleId: 'vibgrate/runtime-lag', location: 'app', message: 'is 2 behind' });
    const newer = finding({ ruleId: 'vibgrate/runtime-lag', location: 'app', message: 'is 3 behind' });
    expect(findingId(older)).toBe(findingId(newer));
    expect(findingId(older)).toBe('a0b24c8fa1d80216');
  });

  it('distinguishes major-lag findings by package name, not by how far behind they are', () => {
    const lodash = finding({
      ruleId: 'vibgrate/dependency-major-lag',
      level: 'error',
      location: 'app',
      message: 'lodash is 3 major versions behind (spec: ^1.0.0, latest: 4.0.0).',
    });
    const lodashLater = finding({
      ...lodash,
      message: 'lodash is 4 major versions behind (spec: ^1.0.0, latest: 5.0.0).',
    });
    const react = finding({
      ...lodash,
      message: 'react is 3 major versions behind (spec: ^17.0.0, latest: 19.0.0).',
    });
    expect(findingId(lodash)).toBe(findingId(lodashLater));
    expect(findingId(lodash)).toBe('07cc9e594585d05c');
    expect(findingId(lodash)).not.toBe(findingId(react));
  });

  it('identifies a vulnerability by advisory, not by the message', () => {
    const first = finding({
      ruleId: 'vibgrate/vulnerability',
      level: 'error',
      location: 'lodash',
      message: 'lodash@1.0.0: GHSA-example (high) — introduced by a maintainer',
      details: { advisoryId: 'GHSA-example', ecosystem: 'npm', package: 'lodash' },
    });
    const rewritten = finding({ ...first, message: 'wording changed; still the same advisory' });
    const other = finding({
      ...first,
      message: first.message,
      details: { advisoryId: 'GHSA-other', ecosystem: 'npm', package: 'lodash' },
    });
    expect(findingId(first)).toBe(findingId(rewritten));
    expect(findingId(first)).toBe('db61f217df4c7b5e');
    expect(findingId(first)).not.toBe(findingId(other));
  });
});

describe('suppressedBaselineFindings', () => {
  const rot = finding({ ruleId: 'vibgrate/dependency-rot', location: 'package.json', message: 'rot' });
  const lagA = finding({ ruleId: 'vibgrate/runtime-lag', location: 'a', message: 'lag a' });
  const lagB = finding({ ruleId: 'vibgrate/runtime-lag', location: 'b', message: 'lag b' });

  it('sorts by ruleId, then location, then id, independent of input order', () => {
    const forward = suppressedBaselineFindings([lagB, rot, lagA], [lagA, lagB, rot]);
    const backward = suppressedBaselineFindings([rot, lagA, lagB], [lagB, rot, lagA]);
    expect(forward).toEqual(backward);
    expect(forward.map((row) => `${row.ruleId} ${row.location}`)).toEqual([
      'vibgrate/dependency-rot package.json',
      'vibgrate/runtime-lag a',
      'vibgrate/runtime-lag b',
    ]);
    expect(forward.map((row) => row.id)).toEqual([
      'af173ea1c1efa4fd',
      findingId(lagA),
      findingId(lagB),
    ]);
  });

  it('lists only findings that are in the baseline and does not copy the message', () => {
    const current = finding({
      ruleId: 'vibgrate/dependency-rot',
      location: 'package.json',
      message: 'placeholder-token-do-not-copy',
    });
    const fresh = finding({ ruleId: 'vibgrate/runtime-eol', location: 'package.json', message: 'new' });
    const rows = suppressedBaselineFindings([current, fresh], [current]);
    expect(rows).toEqual([{
      ruleId: 'vibgrate/dependency-rot',
      location: 'package.json',
      id: 'af173ea1c1efa4fd',
    }]);
    expect(JSON.stringify(rows)).not.toContain('placeholder-token');
    expect(Object.keys(rows[0]).sort()).toEqual(['id', 'location', 'ruleId']);
  });

  it('does not mutate either findings array', () => {
    const current = [rot, lagA];
    const baseline = [rot];
    const beforeCurrent = JSON.stringify(current);
    const beforeBaseline = JSON.stringify(baseline);
    suppressedBaselineFindings(current, baseline);
    expect(JSON.stringify(current)).toBe(beforeCurrent);
    expect(JSON.stringify(baseline)).toBe(beforeBaseline);
  });

  it('collapses duplicate current findings to one record', () => {
    expect(suppressedBaselineFindings([rot, rot], [rot])).toHaveLength(1);
  });

  it('returns an empty list when nothing matches', () => {
    expect(suppressedBaselineFindings([lagA], [rot])).toEqual([]);
  });
});

describe('baselineFileReference', () => {
  it('stores a repo-relative path and only a basename for a file outside the repo', () => {
    expect(baselineFileReference('/repo', '/repo/.vibgrate/baseline.json')).toBe('.vibgrate/baseline.json');
    expect(baselineFileReference('/repo', '/tmp/elsewhere/baseline.json')).toBe('baseline.json');
  });
});

describe('readBaselineComparison', () => {
  it('ignores the legacy string path', () => {
    expect(readBaselineComparison('.vibgrate/baseline.json')).toBeUndefined();
    expect(readBaselineComparison(undefined)).toBeUndefined();
  });
});

describe('vg scan --baseline audit record', () => {
  const dirs: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    logSpy?.mockRestore();
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function scanOpts(extra: Partial<ScanOptions> = {}): ScanOptions {
    return {
      format: 'text',
      concurrency: 2,
      offline: true,
      noLocalArtifacts: true,
      quiet: true,
      vibgrateVersion: 'test',
      ...extra,
    };
  }

  it('records matched findings without removing them, and echoes the ids in SARIF', async () => {
    vi.stubEnv('VIBGRATE_DSN', '');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir('vg-baseline-audit-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'baseline-audit-fixture',
      version: '0.0.0',
      private: true,
      engines: { node: '18.0.0' },
    }));

    const first = await runCoreScan(dir, scanOpts());
    expect(first.findings.length).toBeGreaterThan(0);
    expect(first.findings.some((f) => f.ruleId === 'vibgrate/runtime-eol')).toBe(true);
    expect(first.baseline).toBeUndefined();

    const baselinePath = path.join(dir, 'baseline.json');
    fs.writeFileSync(baselinePath, JSON.stringify(first));

    logSpy.mockClear();
    const second = await runCoreScan(dir, scanOpts({ baseline: baselinePath }));

    expect(second.findings.map((f) => `${f.ruleId}\0${f.location}\0${f.message}`)).toEqual(
      first.findings.map((f) => `${f.ruleId}\0${f.location}\0${f.message}`),
    );
    expect(second.baseline).toMatchObject({
      compared: true,
      file: 'baseline.json',
      suppressedCount: second.baseline?.suppressed.length,
    });
    expect(second.baseline?.suppressedCount).toBeGreaterThan(0);
    expect(second.baseline?.suppressed).toEqual(suppressedBaselineFindings(second.findings, first.findings));
    expect(second.delta).toBe(0);

    const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('\n');
    expect(printed).toContain(`${second.baseline?.suppressedCount} finding`);
    expect(printed).toContain('suppressed');
    for (const findingRow of second.findings) expect(printed).toContain(findingRow.ruleId);

    const sarif = formatSarif(second) as {
      runs: Array<{
        results: Array<{ ruleId: string; suppressions?: Array<{ properties?: { id?: string } }> }>;
        invocations: Array<{ properties?: { baselineCompared?: boolean; baselineSuppressedCount?: number } }>;
      }>;
    };
    const results = sarif.runs[0].results;
    expect(results).toHaveLength(second.findings.length);
    const suppressedIds = results.flatMap((result) => result.suppressions?.map((s) => s.properties?.id) ?? []);
    expect(suppressedIds.sort()).toEqual(second.baseline?.suppressed.map((row) => row.id).sort());
    expect(sarif.runs[0].invocations[0].properties).toEqual({
      baselineCompared: true,
      baselineSuppressedCount: second.baseline?.suppressedCount,
    });
    expect(JSON.stringify(second.baseline)).not.toContain(dir);
  });

  it('records a comparison with zero matches and still keeps every finding', async () => {
    vi.stubEnv('VIBGRATE_DSN', '');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir('vg-baseline-empty-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'baseline-audit-fixture',
      version: '0.0.0',
      private: true,
      engines: { node: '18.0.0' },
    }));

    const first = await runCoreScan(dir, scanOpts());
    const baselinePath = path.join(dir, 'baseline.json');
    fs.writeFileSync(baselinePath, JSON.stringify({ ...first, findings: [] }));

    logSpy.mockClear();
    const second = await runCoreScan(dir, scanOpts({ baseline: baselinePath }));
    expect(second.findings.length).toBe(first.findings.length);
    expect(second.baseline).toMatchObject({
      compared: true,
      file: 'baseline.json',
      suppressedCount: 0,
      suppressed: [],
    });
    const printed = logSpy.mock.calls.map((call: unknown[]) => String(call[0] ?? '')).join('\n');
    expect(printed).toContain('0 findings suppressed');

    const sarif = formatSarif(second) as {
      runs: Array<{
        results: Array<{ suppressions?: unknown }>;
        invocations: Array<{ properties?: { baselineSuppressedCount?: number } }>;
      }>;
    };
    expect(sarif.runs[0].results.every((result) => result.suppressions === undefined)).toBe(true);
    expect(sarif.runs[0].invocations[0].properties?.baselineSuppressedCount).toBe(0);
  });

  it('stores only the basename when the baseline file is outside the repo', async () => {
    vi.stubEnv('VIBGRATE_DSN', '');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dir = tempDir('vg-baseline-root-');
    const outside = tempDir('vg-baseline-outside-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'baseline-audit-fixture',
      version: '0.0.0',
      private: true,
      engines: { node: '18.0.0' },
    }));
    const first = await runCoreScan(dir, scanOpts());
    const outsideFile = path.join(outside, 'baseline.json');
    fs.writeFileSync(outsideFile, JSON.stringify(first));

    const second = await runCoreScan(dir, scanOpts({ baseline: outsideFile }));
    expect(second.baseline?.file).toBe('baseline.json');
    expect(JSON.stringify(second.baseline)).not.toContain(outside);
  });

  it('does not pretend a comparison happened when the baseline cannot be read', async () => {
    vi.stubEnv('VIBGRATE_DSN', '');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = tempDir('vg-baseline-bad-');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'baseline-audit-fixture',
      version: '0.0.0',
      private: true,
    }));
    const baselinePath = path.join(dir, 'baseline.json');
    fs.writeFileSync(baselinePath, '{ not json');

    const artifact = await runCoreScan(dir, scanOpts({ baseline: baselinePath }));
    expect(artifact.baseline).toBeUndefined();
    expect(artifact.delta).toBeUndefined();
    expect(errSpy.mock.calls.flat().join('\n')).toContain('Could not read baseline file');
    errSpy.mockRestore();
  });
});
