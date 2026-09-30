import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isIgnoredPath,
  loadReviewPacks,
  parseIgnoreMarkdown,
  parseMergeMarkdown,
} from './packs.js';
import type { GitRunner } from './git.js';

const dirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-packs-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseIgnoreMarkdown', () => {
  it('reads globs and skips headings', () => {
    const ignore = parseIgnoreMarkdown('# Ignore\n\n- vendor/**\n\nsrc/generated.ts\n');
    expect(ignore.patterns).toEqual(['vendor/**', 'src/generated.ts']);
    expect(isIgnoredPath('vendor/a.ts', ignore)).toBe(true);
    expect(isIgnoredPath('src/a.ts', ignore)).toBe(false);
  });
});

describe('parseMergeMarkdown', () => {
  it('reads require-human', () => {
    const merge = parseMergeMarkdown('---\nrequire-human:\n  - secrets/**\n---\nDocs only.\n');
    expect(merge.enabled).toBe(true);
    expect(merge.requireHuman).toEqual(['secrets/**']);
  });
});

describe('loadReviewPacks', () => {
  it('returns loaded:false when the tree is absent', () => {
    expect(loadReviewPacks(tmp(), ['src/a.ts']).loaded).toBe(false);
  });

  it('runs a CLI-channel check and skips a GitHub-only check with a reason', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.vibgrate/review/checks'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibgrate/review/ignore.md'), '- vendor/**\n');
    fs.writeFileSync(
      path.join(root, '.vibgrate/review/checks/web.md'),
      '---\ntitle: Web Review\nchannels: both\n---\nLook at web files.\n',
    );
    fs.writeFileSync(
      path.join(root, '.vibgrate/review/checks/hosted.md'),
      '---\ntitle: Hosted only\nchannels: github\n---\nGitHub channel.\n',
    );
    const report = loadReviewPacks(root, ['src/web.ts']);
    expect(report.loaded).toBe(true);
    expect(report.ignore.patterns).toEqual(['vendor/**']);
    const web = report.checks.find((c) => c.id === 'web');
    const hosted = report.checks.find((c) => c.id === 'hosted');
    expect(web?.ran).toBe(true);
    expect(hosted?.ran).toBe(false);
    expect(hosted?.reason).toBe('channel_github');
  });

  it('skips with file_scope when include does not match', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.vibgrate/review/checks'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.vibgrate/review/checks/docs.md'),
      '---\ntitle: Docs\ninclude:\n  - docs/**\n---\nDocs.\n',
    );
    const report = loadReviewPacks(root, ['src/a.ts']);
    expect(report.checks[0]?.ran).toBe(false);
    expect(report.checks[0]?.reason).toBe('file_scope');
  });

  it('evaluates merge.md against the change set', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.vibgrate/review'), { recursive: true });
    fs.writeFileSync(path.join(root, '.vibgrate/review/merge.md'), '---\nenabled: true\n---\nDocs only.\n');
    const docs = loadReviewPacks(root, ['README.md']);
    expect(docs.mergeDecision).toBe('approve');
    const self = loadReviewPacks(root, ['.vibgrate/review/merge.md']);
    expect(self.mergeDecision).toBe('refuse');
  });
});

describe('loadReviewPacks from the --base ref', () => {
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

  /** A repo whose `main` carries the team's rules, checked out on a feature branch. */
  function repoWithBaseRules(): string {
    const root = tmp();
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    write(root, '.vibgrate/review/ignore.md', '- vendor/**\n');
    write(root, '.vibgrate/review/policy.md', 'Keep controllers thin.\n');
    write(root, '.vibgrate/review/checks/api.md', '---\ntitle: API check\ninclude:\n  - src/**\n---\nCheck the API.\n');
    write(root, '.vibgrate/review/checks/notes.txt', 'not a check\n');
    write(root, '.vibgrate/review/checks/nested/deep.md', '---\ntitle: Nested\n---\nNot a top-level check.\n');
    write(root, '.vibgrate/review/checks/huge.md', `---\ntitle: Huge\n---\n${'x'.repeat(70 * 1024)}\n`);
    write(root, 'src/a.ts', 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'checkout', '-q', '-b', 'feature');
    return root;
  }

  it('reads the rules as committed on the base, not the change\'s edits', () => {
    const root = repoWithBaseRules();
    // The change widens ignore.md over the file it breaks and deletes the check.
    write(root, '.vibgrate/review/ignore.md', '- vendor/**\n- src/**\n');
    fs.rmSync(path.join(root, '.vibgrate/review/checks/api.md'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'hide my change');

    const fromBase = loadReviewPacks(root, ['src/a.ts'], { kind: 'ref', ref: 'main', run });
    expect(fromBase.source).toBe('base-branch');
    expect(fromBase.ignore.patterns).toEqual(['vendor/**']);
    expect(fromBase.policy?.instructions).toBe('Keep controllers thin.');
    expect(fromBase.checks.map((c) => [c.id, c.ran])).toEqual([['api', true]]);

    const fromTree = loadReviewPacks(root, ['src/a.ts']);
    expect(fromTree.source).toBe('working-tree');
    expect(fromTree.ignore.patterns).toEqual(['vendor/**', 'src/**']);
    expect(fromTree.checks.map((c) => c.id)).toEqual([]);
  });

  it('skips non-markdown, nested, and oversized check files at the ref, as on disk', () => {
    const root = repoWithBaseRules();
    const fromBase = loadReviewPacks(root, ['src/a.ts'], { kind: 'ref', ref: 'main', run });
    expect(fromBase.checks.map((c) => c.id)).toEqual(['api']);
    expect(loadReviewPacks(root, ['src/a.ts']).checks.map((c) => c.id)).toEqual(['api']);
  });

  it('treats rules the base does not have as absent — the change cannot add them', () => {
    const root = tmp();
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    write(root, 'src/a.ts', 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base without rules');
    git(root, 'checkout', '-q', '-b', 'feature');
    write(root, '.vibgrate/review/ignore.md', '- src/**\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'add my own ignore');

    const fromBase = loadReviewPacks(root, ['src/a.ts'], { kind: 'ref', ref: 'main', run });
    expect(fromBase.loaded).toBe(false);
    expect(fromBase.ignore.patterns).toEqual([]);
  });
});
