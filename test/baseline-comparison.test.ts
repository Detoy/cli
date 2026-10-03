import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import {
  compareBaselineFindings,
  driftFindingId,
  baselineSuppressionSummary,
} from '../src/core-open/baseline-comparison.js';
import { formatSarif } from '../src/core-open/formatters/sarif.js';
import { formatText } from '../src/core-open/formatters/text.js';
import { formatMarkdown } from '../src/core-open/formatters/markdown.js';
import { runCoreScan } from '../src/core-open/index.js';
import type { Finding, ScanArtifact } from '../src/core-open/types.js';

const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/baseline-suppressions.json', import.meta.url), 'utf8'),
) as { baselineFindings: Finding[]; currentFindings: Finding[] };

const LOCKED_COMPARISON = {
  compared: true as const,
  suppressedCount: 2,
  suppressed: [
    {
      ruleId: 'vibgrate/dependency-major-lag',
      location: 'package.json',
      id: '4b6faf5c74f7e7066f2434c6fb0bf1b0',
    },
    {
      ruleId: 'vibgrate/dependency-rot',
      location: 'package.json',
      id: 'b3d2b31a1ca6957f33dd815aa237a031',
    },
  ],
};

function miniArtifact(findings: Finding[], comparison = compareBaselineFindings(findings, fixture.baselineFindings)): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-01-01T00:00:00.000Z',
    vibgrateVersion: 'test',
    rootPath: 'demo',
    projects: [],
    drift: {
      score: 10,
      riskLevel: 'low',
      components: { runtimeScore: 0, frameworkScore: 0, dependencyScore: 0, eolScore: 0 },
    },
    findings,
    delta: 0,
    baseline: '.vibgrate/baseline.json',
    baselineComparison: comparison,
  };
}

describe('baseline comparison record', () => {
  it('records matched findings without removing them from the primary array', () => {
    const findings = fixture.currentFindings.map((finding) => ({ ...finding }));
    const before = JSON.stringify(findings);
    const comparison = compareBaselineFindings(findings, fixture.baselineFindings);

    expect(JSON.stringify(findings)).toBe(before);
    expect(comparison).toEqual(LOCKED_COMPARISON);
    expect(comparison.suppressedCount).toBe(comparison.suppressed.length);

    const document = { findings, baselineComparison: comparison };
    expect(document.findings).toHaveLength(fixture.currentFindings.length);
    expect(document.findings.map((finding) => finding.ruleId)).toContain('vibgrate/framework-major-lag');
    for (const entry of document.baselineComparison.suppressed) {
      expect(document.findings.some((finding) =>
        finding.ruleId === entry.ruleId
        && finding.location === entry.location
        && driftFindingId(finding) === entry.id,
      )).toBe(true);
    }
  });

  it('is deterministic and sorts by ruleId, location, then id', () => {
    const shuffled = [...fixture.currentFindings].reverse();
    const once = compareBaselineFindings(shuffled, [...fixture.baselineFindings].reverse());
    const twice = compareBaselineFindings(fixture.currentFindings, fixture.baselineFindings);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    expect(JSON.stringify(once)).toBe(JSON.stringify(LOCKED_COMPARISON));
  });

  it('derives a stable content id and ignores a changed message', () => {
    const matched = fixture.currentFindings[2]!;
    expect(driftFindingId(matched)).toBe('b3d2b31a1ca6957f33dd815aa237a031');
    expect(driftFindingId(matched)).toBe(driftFindingId({ ...matched }));
    expect(driftFindingId({ ...matched, message: '10% of dependencies are 2+ major versions behind in demo.' }))
      .not.toBe(driftFindingId(matched));
  });

  it('collapses duplicate ids and skips entries that are not findings', () => {
    const matched = fixture.baselineFindings[1]!;
    const comparison = compareBaselineFindings(
      [matched, { ...matched }, { ruleId: 'vibgrate/dependency-rot' }],
      [null, { ruleId: 'incomplete' }, matched],
    );
    expect(comparison).toEqual({
      compared: true,
      suppressedCount: 1,
      suppressed: [{ ruleId: matched.ruleId, location: matched.location, id: driftFindingId(matched) }],
    });
  });

  it('reports an empty suppression list when nothing matched', () => {
    expect(compareBaselineFindings([], [])).toEqual({
      compared: true,
      suppressedCount: 0,
      suppressed: [],
    });
    expect(compareBaselineFindings(fixture.currentFindings, undefined).suppressed).toEqual([]);
  });

  it('keeps every finding in SARIF and puts the same ids on suppressions', () => {
    const findings = fixture.currentFindings;
    const comparison = compareBaselineFindings(findings, fixture.baselineFindings);
    const sarif = formatSarif(miniArtifact(findings, comparison)) as {
      runs: Array<{ results: Array<{ suppressions?: Array<{ kind: string; status: string; properties: { id: string } }> }> }>;
    };
    const results = sarif.runs[0]!.results;
    expect(results).toHaveLength(findings.length);
    const suppressedIds = results
      .filter((result) => result.suppressions)
      .map((result) => result.suppressions![0]!.properties.id);
    expect(suppressedIds).toEqual(comparison.suppressed.map((entry) => entry.id));
    for (const result of results) {
      if (!result.suppressions) continue;
      expect(result.suppressions[0]).toMatchObject({
        kind: 'external',
        status: 'accepted',
        properties: { id: result.suppressions[0]!.properties.id },
      });
    }
    const unmatched = formatSarif(miniArtifact(findings, { compared: true, suppressedCount: 0, suppressed: [] })) as {
      runs: Array<{ results: Array<{ suppressions?: unknown }> }>;
    };
    expect(unmatched.runs[0]!.results.every((result) => result.suppressions === undefined)).toBe(true);
  });

  it('includes the suppression count in human output', () => {
    const artifact = miniArtifact(fixture.currentFindings);
    const text = formatText(artifact);
    const markdown = formatMarkdown(artifact);
    const summary = baselineSuppressionSummary(2);
    expect(text).toContain(summary);
    expect(markdown).toContain(summary);
    expect(text).toContain('package.json (baselined)');
    expect(markdown).toContain('package.json (baselined)');
    expect(text).toContain('vibgrate/framework-major-lag');
    expect(markdown).toContain('vibgrate/framework-major-lag');
  });
});

describe('vg scan --baseline wiring', () => {
  let dir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), 'vg-baseline-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'baseline-fixture', version: '0.0.0', private: true }),
    );
    vi.stubEnv('VIBGRATE_DSN', '');
    vi.stubGlobal('fetch', async () => {
      throw new Error('unexpected network access during baseline scan');
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function scanOpts(extra: Partial<Parameters<typeof runCoreScan>[1]> = {}) {
    return {
      format: 'text' as const,
      concurrency: 2,
      offline: true,
      noLocalArtifacts: true,
      quiet: true,
      vibgrateVersion: 'test',
      ...extra,
    };
  }

  it('omits the block when the baseline file is missing or unreadable', async () => {
    const missing = await runCoreScan(dir, scanOpts({ baseline: path.join(dir, 'missing.json') }));
    expect(missing.baseline).toBeUndefined();
    expect(missing.baselineComparison).toBeUndefined();
    expect(missing.delta).toBeUndefined();

    const badPath = path.join(dir, 'bad.json');
    fs.writeFileSync(badPath, '{');
    const bad = await runCoreScan(dir, scanOpts({ baseline: badPath }));
    expect(bad.baselineComparison).toBeUndefined();
    expect(bad.findings.length).toBe(missing.findings.length);
  });

  it('writes the comparison onto the artifact and the human report', async () => {
    const first = await runCoreScan(dir, scanOpts());
    const baselinePath = path.join(dir, '.vibgrate', 'baseline.json');
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(first));

    logSpy.mockClear();
    const second = await runCoreScan(dir, scanOpts({ baseline: baselinePath }));

    expect(second.findings).toEqual(first.findings);
    expect(second.baseline).toBe(path.join('.vibgrate', 'baseline.json'));
    expect(second.baselineComparison).toEqual(compareBaselineFindings(second.findings, first.findings));
    expect(second.baselineComparison?.compared).toBe(true);
    expect(logSpy.mock.calls.flat().join('\n')).toContain(
      baselineSuppressionSummary(second.baselineComparison?.suppressedCount ?? -1),
    );

    const sarif = formatSarif(second) as {
      runs: Array<{ results: Array<{ suppressions?: Array<{ properties: { id: string } }> }> }>;
    };
    const ids = new Set(second.baselineComparison?.suppressed.map((entry) => entry.id));
    expect(sarif.runs[0]!.results).toHaveLength(second.findings.length);
    for (const result of sarif.runs[0]!.results) {
      expect(result.suppressions).toHaveLength(1);
      expect(ids.has(result.suppressions![0]!.properties.id)).toBe(true);
    }
  });
});
