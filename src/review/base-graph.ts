/**
 * The code map at the change's base commit, for before/after call paths.
 *
 * Built in a throwaway `git worktree` so the user's checkout is never touched.
 * Unchanged files are served from the machine's content-addressed parse store
 * (engine/cas.ts), so on a repository that has been mapped before the cost is
 * mostly the files that differ and the precise resolver pass. The worktree is
 * removed on every path out, including failure.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildGraph } from '../engine/build.js';
import type { VgGraph } from '../schema.js';
import { defaultRun, type ChangeSet, type GitRunner } from './git.js';

export interface BaseGraphResult {
  graph: VgGraph | null;
  /** Wall time for checkout and build, for the document's notes. */
  ms: number;
  /** Why no graph came back, when none did. */
  reason?: string;
}

export async function buildBaseGraph(
  change: ChangeSet,
  mapRoot: string,
  run: GitRunner = defaultRun,
  now: () => number = () => performance.now(),
): Promise<BaseGraphResult> {
  const t0 = now();
  if (!change.baseSha) return { graph: null, ms: 0, reason: 'the change has no base commit' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-base-'));
  const added = run(['worktree', 'add', '--detach', '--quiet', dir, change.baseSha], change.topLevel);
  try {
    if (added.status !== 0) return { graph: null, ms: now() - t0, reason: 'git could not check out the base commit' };
    const rel = path.relative(change.topLevel, mapRoot);
    const root = rel && rel !== '.' ? path.join(dir, rel) : dir;
    if (!fs.existsSync(root)) return { graph: null, ms: now() - t0, reason: `${rel} does not exist at the base commit` };
    const built = await buildGraph({ root, noCoverage: true, noGround: true });
    return { graph: built.graph, ms: now() - t0 };
  } catch (err) {
    return { graph: null, ms: now() - t0, reason: `the base build failed: ${(err as Error).message}` };
  } finally {
    if (added.status === 0) run(['worktree', 'remove', '--force', dir], change.topLevel);
    fs.rmSync(dir, { recursive: true, force: true });
    run(['worktree', 'prune'], change.topLevel);
  }
}
