import * as path from 'node:path';
import { ensureDir, writeJsonFile } from './utils/fs.js';
import type { ScanArtifact } from '../core-open/types.js';

/**
 * The small, stable result of a scan that CI steps read (`vg scan --summary-out`).
 * Absent is `null`, never `0`: an unmeasured DriftScore must not read as perfect.
 */
export interface ScanSummary {
  schemaVersion: 1;
  /** 0-100, lower is better; `null` when drift could not be measured. */
  driftScore: number | null;
  riskLevel: ScanArtifact['drift']['riskLevel'];
  components: ScanArtifact['drift']['components'];
  /** Score change since `--baseline` (positive = worse); `null` without a comparison. */
  delta: number | null;
  /** The baseline's score; `null` without a comparison or when it was unmeasured. */
  baselineScore: number | null;
}

export function buildScanSummary(artifact: ScanArtifact): ScanSummary {
  const score = artifact.drift.score;
  const delta = typeof artifact.delta === 'number' ? artifact.delta : null;
  return {
    schemaVersion: 1,
    driftScore: score,
    riskLevel: artifact.drift.riskLevel,
    components: artifact.drift.components,
    delta,
    baselineScore: score !== null && delta !== null ? score - delta : null,
  };
}

export async function writeScanSummary(file: string, artifact: ScanArtifact): Promise<void> {
  const target = path.resolve(file);
  await ensureDir(path.dirname(target));
  await writeJsonFile(target, buildScanSummary(artifact));
}
