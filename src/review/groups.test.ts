import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HaileProvider } from '../engine/haile/haile-provider.js';
import { collectChangeSet, renamedNewPath, type ChangeSet, type ChangedFile, type GitRunner } from './git.js';
import {
  collectGroupSignals,
  emptySignals,
  fileFacts,
  groupChangeSet,
  groupsPayload,
  UNGROUPED_NOTE,
  validateGroups,
  type DiffGroup,
} from './groups.js';

/**
 * The host side of diff groups. Which file lands in which group is decided by
 * the Architecture module and tested there; these tests pin what the host
 * owns: the facts and signals it sends, the partition it enforces, and the
 * honest fallback when the module is missing.
 */

function file(p: string, over: Partial<ChangedFile> = {}): ChangedFile {
  return { path: p, op: 'modified', addedLines: 3, removedLines: 1, hunks: [{ start: 1, end: 3 }], ...over };
}

function change(files: ChangedFile[]): ChangeSet {
  return {
    topLevel: '/repo',
    baseSha: 'b'.repeat(40),
    headSha: 'h'.repeat(40),
    mergeBase: 'b'.repeat(40),
    ref: null,
    dirty: false,
    dirtyTreeHash: null,
    files,
    remote: null,
  };
}

const groupOf = (kind: DiffGroup['kind'], id: string, paths: string[]): DiffGroup => ({
  id,
  kind,
  label: kind,
  area: null,
  layer: null,
  files: paths.map((p) => ({ path: p, op: 'modified', added_lines: 3, removed_lines: 1, reason: 'test' })),
  added_lines: 3 * paths.length,
  removed_lines: paths.length,
});

function provider(groups: DiffGroup[] | null, seen?: { payload?: unknown }): HaileProvider {
  return {
    version: () => 'test',
    classify: () => null,
    reviewGroups: (payload) => {
      if (seen) seen.payload = payload;
      return groups ? { groups } : null;
    },
  };
}

describe('fileFacts', () => {
  it('reports what the public code map already knows about a path', () => {
    expect(fileFacts('src/order.test.ts')).toMatchObject({ test: true });
    expect(fileFacts('pnpm-lock.yaml')).toMatchObject({ lockfile: true });
    expect(fileFacts('package.json')).toMatchObject({ manifest: true });
    expect(fileFacts('vitest.config.ts')).toMatchObject({ tooling: true });
    expect(fileFacts('proto/orders.proto')).toMatchObject({ contract: true });
    expect(fileFacts('src/controllers/orderController.ts').layer).toBeTruthy();
    expect(fileFacts('zzz/qqq.ts')).not.toHaveProperty('test');
  });
});

describe('groupsPayload', () => {
  it('sends each file with its facts and only the signals that apply', () => {
    const s = emptySignals();
    s.whitespaceOnly.add('src/a.ts');
    s.changedLines.set('src/b.ts', { added: ["import x from './x';"], removed: [] });
    s.headHeader.set('src/b.ts', '// header');
    const p = groupsPayload(change([file('src/a.ts'), file('src/b.ts')]), s);
    expect(p.files).toEqual([
      expect.objectContaining({ path: 'src/a.ts', op: 'modified', added_lines: 3, removed_lines: 1, whitespace_only: true }),
      expect.objectContaining({ path: 'src/b.ts', header: '// header', added: ["import x from './x';"], removed: [] }),
    ]);
    expect(p.files[0]).not.toHaveProperty('header');
  });
});

describe('groupChangeSet', () => {
  const c = change([file('src/a.ts'), file('src/a.test.ts'), file('README.md')]);
  const good = [groupOf('implementation', 'grp:i', ['src/a.ts']), groupOf('tests', 'grp:t', ['src/a.test.ts']), groupOf('docs', 'grp:d', ['README.md'])];

  it('uses the module\'s groups when they cover the change exactly', () => {
    const seen: { payload?: unknown } = {};
    const g = groupChangeSet(c, emptySignals(), provider(good, seen));
    expect(g.groups.map((x) => x.kind)).toEqual(['implementation', 'tests', 'docs']);
    expect(g.counts).toEqual({ files: 3, groups: 3, implementation_files: 1, peeled_files: 2 });
    expect(g.note).toBeNull();
    expect((seen.payload as { files: unknown[] }).files).toHaveLength(3);
    expect(validateGroups(g, c)).toEqual([]);
  });

  it('refuses module groups that drop or duplicate a file, and falls back to one honest group', () => {
    const missing = groupChangeSet(c, emptySignals(), provider(good.slice(0, 2)));
    expect(missing.groups.map((x) => x.kind)).toEqual(['ungrouped']);
    expect(missing.note).toMatch(/do not cover this change exactly/);
    const dup = groupChangeSet(c, emptySignals(), provider([...good, groupOf('docs', 'grp:d2', ['README.md'])]));
    expect(dup.groups.map((x) => x.kind)).toEqual(['ungrouped']);
  });

  it('without the module: every file in one "not grouped" group, and the install command', () => {
    const g = groupChangeSet(c);
    expect(g.groups).toHaveLength(1);
    expect(g.groups[0]).toMatchObject({ kind: 'ungrouped', label: 'Changed files (not grouped)' });
    expect(g.groups[0].files.map((f) => f.path)).toEqual(['README.md', 'src/a.test.ts', 'src/a.ts']);
    expect(g.counts.implementation_files).toBe(3);
    expect(g.note).toBe(UNGROUPED_NOTE);
    expect(validateGroups(g, c)).toEqual([]);
  });

  it('with a module that predates diff groups: says so', () => {
    expect(groupChangeSet(c, emptySignals(), { version: () => 'old', classify: () => null }).note).toMatch(/predates diff groups/);
  });

  it('survives a module that abstains or throws', () => {
    expect(groupChangeSet(c, emptySignals(), provider(null)).groups[0].kind).toBe('ungrouped');
    const throwing: HaileProvider = { version: () => 'x', classify: () => null, reviewGroups: () => { throw new Error('boom'); } };
    expect(groupChangeSet(c, emptySignals(), throwing).groups[0].kind).toBe('ungrouped');
  });

  it('is deterministic, and an empty change has no groups', () => {
    expect(JSON.stringify(groupChangeSet(c, emptySignals(), provider(good)))).toBe(JSON.stringify(groupChangeSet(c, emptySignals(), provider(good))));
    expect(groupChangeSet(change([])).groups).toEqual([]);
  });
});

describe('validateGroups — uncategorized fails', () => {
  const c = change([file('src/a.ts'), file('src/b.ts')]);

  it('reports a file left out, a duplicate, a stranger, an empty group and a bad kind', () => {
    const g = groupChangeSet(c);
    const edited = {
      ...g,
      groups: [
        { id: 'grp:x', kind: 'implementation', label: 'A', files: [{ path: 'src/a.ts' }, { path: 'src/a.ts' }, { path: 'src/zzz.ts' }] },
        { id: 'grp:x', kind: 'mystery', label: 'B', files: [] },
      ],
    };
    const codes = validateGroups(edited, c).map((i) => i.code).sort();
    expect(codes).toEqual(['duplicate_file', 'duplicate_id', 'empty_group', 'not_in_change', 'uncategorized', 'unknown_kind']);
  });

  it('accepts an agent merge of two groups', () => {
    const g = groupChangeSet(c);
    const merged = { ...g, groups: [{ id: 'grp:merged', kind: 'implementation', label: 'All', files: g.groups.flatMap((x) => x.files) }] };
    expect(validateGroups(merged, c)).toEqual([]);
  });

  it('flags groups written for a different change', () => {
    const g = groupChangeSet(c);
    const stale = { ...g, target: { ...g.target, head_sha: 'f'.repeat(40) } };
    expect(validateGroups(stale, c).map((i) => i.code)).toContain('stale_target');
  });

  it('rejects a non-object', () => {
    expect(validateGroups(null, c)[0].code).toBe('not_object');
  });
});

describe('renamedNewPath', () => {
  it.each([
    ['packages/web/post/{outbox => posted}/a.json', 'packages/web/post/posted/a.json'],
    ['src/{a => b}.ts', 'src/b.ts'],
    ['{old => }/x.ts', 'x.ts'],
    ['src/{ => nested}/x.ts', 'src/nested/x.ts'],
    ['a.ts => b.ts', 'b.ts'],
  ])('%s → %s', (input, expected) => expect(renamedNewPath(input)).toBe(expected));

  it('returns null for an ordinary path', () => {
    expect(renamedNewPath('src/a.ts')).toBeNull();
  });
});

describe('signals from a real repository', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });
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

  it('collects whitespace-only, changed lines, generated attributes and headers; a rename with edits is one entry', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-groups-'));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    const body = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join('\n');
    write(root, 'src/services/fmt.ts', 'export function f(a: number) {\n  return a + 1;\n}\n');
    write(root, 'src/services/imp.ts', "import { a } from './a.js';\nexport const x = a;\n");
    write(root, 'src/services/logic.ts', 'export function g() {\n  return 1;\n}\n');
    write(root, 'src/gen/client.ts', 'export const c = 1;\n');
    write(root, 'src/inbox/moved.ts', `${body}\n`);
    write(root, '.gitattributes', 'src/gen/** linguist-generated=true\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');

    write(root, 'src/services/fmt.ts', 'export function f(a: number) {\n    return a + 1;\n}\n\n');
    write(root, 'src/services/imp.ts', "import { a } from './a2.js';\nexport const x = a;\n");
    write(root, 'src/services/logic.ts', 'export function g() {\n  return 2;\n}\n');
    write(root, 'src/gen/client.ts', 'export const c = 2;\n');
    fs.mkdirSync(path.join(root, 'src/outbox'), { recursive: true });
    fs.renameSync(path.join(root, 'src/inbox/moved.ts'), path.join(root, 'src/outbox/moved.ts'));
    write(root, 'src/outbox/moved.ts', `${body}\nexport const extra = 1;\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'change');

    const cs = collectChangeSet(root, 'main', run);
    const moved = cs.files.filter((f) => f.path.includes('moved.ts'));
    // One entry, under the new path, with the edit's line counts — not two.
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ path: 'src/outbox/moved.ts', op: 'renamed', addedLines: 1 });

    const signals = collectGroupSignals(cs, { base: 'main' }, run);
    expect(signals.whitespaceOnly.has('src/services/fmt.ts')).toBe(true);
    expect(signals.whitespaceOnly.has('src/services/logic.ts')).toBe(false);
    expect(signals.changedLines.get('src/services/imp.ts')).toEqual({ added: ["import { a } from './a2.js';"], removed: ["import { a } from './a.js';"] });
    expect(signals.generatedAttr.has('src/gen/client.ts')).toBe(true);
    expect(signals.headHeader.get('src/services/logic.ts')).toContain('return 2');
  });
});
