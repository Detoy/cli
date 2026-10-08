import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discover } from '../src/engine/discover.js';
import { buildGraph } from '../src/engine/build.js';
import { runBuild } from '../src/commands/build.js';
import { DEFAULT_MAX_FILES } from '../src/engine/limits.js';
import { CliError, ExitCode } from '../src/util/exit.js';
import { runCoreScan } from '../src/core-open/index.js';
import {
  assertSafeWalkRoot,
  DEFAULT_WALK_ENTRY_BUDGET,
  UnsafeRootError,
} from '../src/core-open/utils/root-safety.js';
import { makeProject, cleanup } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function keep(dir: string): string {
  dirs.push(dir);
  return dir;
}

/** FHS-shaped directory. Empty children — the check is the layout, not the size. */
function osImage(): string {
  const root = keep(makeProject({ 'etc/hostname': 'box\n' }));
  for (const name of ['bin', 'lib', 'usr', 'var', 'sbin']) {
    fs.mkdirSync(path.join(root, name));
  }
  return root;
}

describe('unsafe scan and build roots', () => {
  it('keeps the walk budget aligned with the graph file cap', () => {
    expect(DEFAULT_WALK_ENTRY_BUDGET).toBe(DEFAULT_MAX_FILES);
  });

  it('refuses the filesystem root with a stable, actionable message', () => {
    const root = path.parse(process.cwd()).root;
    const once = () => {
      try {
        assertSafeWalkRoot(root);
      } catch (err) {
        return err as UnsafeRootError;
      }
      throw new Error('expected a refusal');
    };
    const a = once();
    const b = once();
    expect(a).toBeInstanceOf(UnsafeRootError);
    expect(a.reason).toBe('filesystem-root');
    expect(a.message).toBe(b.message);
    expect(a.message).toContain('Narrow the path to a project directory.');
    expect(a.message).toContain('--exclude');
    expect(a.message).not.toContain('VG_MAX_FILES');
  });

  it('refuses an OS image from discover, build, and scan', async () => {
    const root = osImage();
    expect(() => discover({ root })).toThrow(UnsafeRootError);
    await expect(buildGraph({ root, inline: true })).rejects.toMatchObject({ reason: 'os-image' });
    await expect(runBuild([], { html: false, report: false }, { json: true, cwd: root, offline: true, quiet: true })).rejects.toMatchObject({
      message: expect.stringContaining('operating-system image'),
      code: ExitCode.ERROR,
    });
    await expect(
      runCoreScan(root, { format: 'json', concurrency: 1, offline: true, noLocalArtifacts: true }),
    ).rejects.toMatchObject({ reason: 'os-image' });
    try {
      await runBuild([], { html: false, report: false }, { json: true, cwd: root, offline: true, quiet: true });
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
    }
  });

  it('stops a build walk at the entry budget and lets --exclude narrow it', () => {
    const root = keep(makeProject({
      'keep.ts': 'export const keep = 1;\n',
      'huge/a.ts': 'export const a = 1;\n',
      'huge/b.ts': 'export const b = 2;\n',
      'huge/c.ts': 'export const c = 3;\n',
    }));

    const fail = () => discover({ root, maxEntries: 2 });
    expect(fail).toThrow(UnsafeRootError);
    let first = '';
    let second = '';
    try {
      fail();
    } catch (err) {
      first = (err as Error).message;
    }
    try {
      fail();
    } catch (err) {
      second = (err as Error).message;
    }
    expect(first).toBe(second);
    expect(first).toContain('2-entry budget');
    expect(first).toContain('VG_MAX_FILES');
    expect(first).toContain('--exclude');
    expect(first).toContain('Narrow the path to a project directory.');

    const narrowed = discover({ root, maxEntries: 2, exclude: ['huge'] }).map((f) => f.rel);
    expect(narrowed).toEqual(['keep.ts']);

    const disabled = discover({ root, maxEntries: 0 }).map((f) => f.rel);
    expect(disabled).toEqual(['huge/a.ts', 'huge/b.ts', 'huge/c.ts', 'keep.ts']);
  });
});
