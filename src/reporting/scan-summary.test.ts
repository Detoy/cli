import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildScanSummary, writeScanSummary } from './scan-summary.js';
import { runCoreScan } from '../core-open/index.js';
import type { ScanArtifact } from '../core-open/types.js';

function artifact(score: number | null, delta?: number): ScanArtifact {
  return {
    schemaVersion: '1.0',
    timestamp: '2026-10-06T00:00:00.000Z',
    vibgrateVersion: 'test',
    rootPath: '/test',
    projects: [],
    drift: {
      score,
      riskLevel: 'moderate',
      components: { runtimeScore: 10, frameworkScore: 62, dependencyScore: 30, eolScore: 0 },
    },
    findings: [],
    ...(delta !== undefined ? { delta } : {}),
  };
}

describe('buildScanSummary', () => {
  it('carries the score, risk level and components', () => {
    expect(buildScanSummary(artifact(47))).toEqual({
      schemaVersion: 1,
      driftScore: 47,
      riskLevel: 'moderate',
      components: { runtimeScore: 10, frameworkScore: 62, dependencyScore: 30, eolScore: 0 },
      delta: null,
      baselineScore: null,
    });
  });

  it('derives the baseline score from the delta (positive delta = worse)', () => {
    const s = buildScanSummary(artifact(47, 5));
    expect(s.delta).toBe(5);
    expect(s.baselineScore).toBe(42);
  });

  it('keeps a measured 0 as 0', () => {
    const s = buildScanSummary(artifact(0, 0));
    expect(s.driftScore).toBe(0);
    expect(s.delta).toBe(0);
    expect(s.baselineScore).toBe(0);
  });

  it('keeps an unmeasured score as null, never 0', () => {
    const s = buildScanSummary(artifact(null));
    expect(s.driftScore).toBeNull();
    expect(s.baselineScore).toBeNull();
  });
});

describe('writeScanSummary', () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes JSON, creating the parent directory', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-summary-'));
    const file = path.join(dir, 'out', 'summary.json');
    await writeScanSummary(file, artifact(47));
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).driftScore).toBe(47);
  });

  it('reports an unmeasured real scan as null', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-summary-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', dependencies: {} }));
    vi.stubEnv('VIBGRATE_DSN', '');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const real = await runCoreScan(dir, {
      format: 'text', concurrency: 4, offline: true, noLocalArtifacts: true, vibgrateVersion: 'test', quiet: true,
    });
    const file = path.join(dir, 'summary.json');
    await writeScanSummary(file, real);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.driftScore).toBe(real.drift.score);
  });
});
