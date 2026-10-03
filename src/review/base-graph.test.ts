import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildBaseGraph } from './base-graph.js';
import { collectChangeSet, type GitRunner } from './git.js';

const run: GitRunner = (args, cwd) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { stdout: res.stdout ?? '', status: res.status ?? 1 };
};
const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
};
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

describe('buildBaseGraph', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  function repo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-base-graph-'));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    write(root, 'pkg/src/a.ts', "export function oldName() {\n  return 1;\n}\n");
    write(root, 'pkg/src/b.ts', "import { oldName } from './a';\nexport function caller() {\n  return oldName();\n}\n");
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, 'pkg/src/a.ts', "export function newName() {\n  return 2;\n}\n");
    write(root, 'pkg/src/b.ts', "import { newName } from './a';\nexport function caller() {\n  return newName();\n}\n");
    git(root, 'commit', '-q', '-am', 'rename');
    return root;
  }

  it('maps the base commit in a throwaway worktree and leaves the checkout alone', async () => {
    const root = repo();
    const change = collectChangeSet(root, 'main', run);
    const res = await buildBaseGraph(change, path.join(root, 'pkg'), run);
    expect(res.reason).toBeUndefined();
    const names = res.graph!.nodes.map((n) => n.qualifiedName);
    expect(names).toContain('oldName');
    expect(names).not.toContain('newName');
    // Graph paths are relative to the map root, exactly like the head map's.
    expect(res.graph!.nodes.find((n) => n.qualifiedName === 'oldName')!.file).toBe('src/a.ts');
    // The checkout still has the change, and no worktree is left behind.
    expect(fs.readFileSync(path.join(root, 'pkg/src/a.ts'), 'utf8')).toContain('newName');
    expect(run(['worktree', 'list'], root).stdout.trim().split('\n')).toHaveLength(1);
  }, 60_000);

  it('reports, rather than throws, when the map root did not exist at the base', async () => {
    const root = repo();
    write(root, 'newpkg/x.ts', 'export const x = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'new package');
    const change = collectChangeSet(root, 'main', run);
    const res = await buildBaseGraph(change, path.join(root, 'newpkg'), run);
    expect(res.graph).toBeNull();
    expect(res.reason).toMatch(/does not exist at the base commit/);
    expect(run(['worktree', 'list'], root).stdout.trim().split('\n')).toHaveLength(1);
  }, 60_000);
});
