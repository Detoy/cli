import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveSession, type StoredSession } from '../code/session-store.js';
import { buildReviewDoc, makePinResolver, markdownPinLinks, renderReviewDocMarkdown, validateReviewDoc } from './doc.js';
import { collectChangeSet, type GitRunner } from './git.js';
import { groupChangeSet } from './groups.js';
import { resolveReviewSession, scopeChangeToSession, sessionBlocks, type ReviewSession } from './session.js';

/**
 * "Show me what you did": a review document scoped to one VG Code session,
 * against a real git repository and a session file shaped exactly as
 * code/session-store.ts writes it.
 */

const run: GitRunner = (args, cwd) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { stdout: res.stdout ?? '', status: res.status ?? 1 };
};
const git = (cwd: string, ...args: string[]) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
};
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';

function session(over: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'sabc123',
    provider: 'relay',
    model: 'forge',
    startedAt: 1,
    updatedAt: 2,
    tasks: [
      { instruction: 'Add input validation to the orders store', summary: 'Added validate().', files: ['src/a.ts'], stopped: 'finished', ts: 1 },
      {
        instruction: 'Also log rejected orders — see [the spec](head:src/a.ts#L1-L2) and `logger`',
        summary: 'I added logging in **b.ts** and updated a.ts.',
        files: ['src/b.ts', 'src/a.ts', 'src/gone.ts'],
        stopped: 'finished',
        ts: 2,
      },
    ],
    lastChanges: [],
    ...over,
  };
}

describe('review document for a VG Code session', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  function repo(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-review-session-')));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    write(root, '.gitignore', '.vibgrate/\n');
    write(root, 'src/a.ts', lines(20, 'a'));
    write(root, 'src/b.ts', lines(20, 'b'));
    write(root, 'src/c.ts', lines(20, 'c'));
    write(root, 'src/gone.ts', lines(3, 'g'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    // The session's edits, plus one change it did not make.
    write(root, 'src/a.ts', lines(20, 'a').replace('a3 = 3', 'a3 = validate(3)'));
    write(root, 'src/b.ts', lines(20, 'b') + 'export const rejected = log();\n');
    write(root, 'src/c.ts', lines(20, 'c').replace('c1 = 1', 'c1 = 100'));
    return root;
  }

  it('resolves `latest` and an id, and names a missing session plainly', () => {
    const root = repo();
    expect(resolveReviewSession(root, 'latest')).toEqual({ error: expect.stringMatching(/no VG Code session found/) });
    saveSession(root, session());
    const latest = resolveReviewSession(root, 'latest') as ReviewSession;
    expect(latest.session.id).toBe('sabc123');
    expect(latest.root).toBe(root);
    expect(latest.base).toBeNull();
    expect(resolveReviewSession(root, 'snope')).toEqual({ error: 'no VG Code session snope in .vibgrate/code-sessions' });
  });

  it('keeps only the files the session touched, and says what was left out and what is gone', () => {
    const root = repo();
    saveSession(root, session());
    const rs = resolveReviewSession(root, 'sabc123') as ReviewSession;
    const scoped = scopeChangeToSession(collectChangeSet(root, undefined, run), rs);
    expect(scoped.change.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(scoped.excluded).toEqual(['src/c.ts']);
    expect(scoped.missing).toEqual(['src/gone.ts']);
  });

  it('turns each request into a pinned requirement, never a link the person typed', () => {
    const root = repo();
    saveSession(root, session());
    const rs = resolveReviewSession(root, 'sabc123') as ReviewSession;
    const change = collectChangeSet(root, undefined, run);
    const scoped = scopeChangeToSession(change, rs);
    const resolve = makePinResolver(scoped.change, {}, run);
    const s = sessionBlocks(rs, scoped, resolve);
    expect(s.title).toBe('What VG Code did: Add input validation to the orders store');
    const req = s.requirements[0] as { text: string };
    expect(req.text).toMatch(/\*\*Turn 1\*\* “Add input validation to the orders store” → `src\/a\.ts` \[L4\]\(head:src\/a\.ts#L4\)/);
    expect(req.text).toMatch(/\*\*Turn 2\*\*/);
    expect(req.text).toMatch(/`src\/gone\.ts` \(not in this change\)/);
    // The only links are the ones vg made from the change, not the one inside the request.
    const links = markdownPinLinks(req.text).map((l) => l.href);
    expect(links).toEqual(['head:src/a.ts#L4', 'head:src/b.ts#L21', 'head:src/a.ts#L4']);
    // The agent's words are quoted as its own account and marked unverified.
    const account = s.what.find((b) => b.type === 'callout') as { text: string };
    expect(account.text).toMatch(/The agent's own account of turn 2.*not checked it against the code/s);
    expect(account.text).toContain('\\*\\*b.ts\\*\\*');
    expect(s.notes.join(' ')).toMatch(/1 changed file the session did not touch was left out/);
    expect(s.notes.join(' ')).toMatch(/1 file the session touched is not in this change.*src\/gone\.ts/);
  });

  it('builds a mixed-provenance document that validates and renders, requirements before implementation', () => {
    const root = repo();
    saveSession(root, session({ tasks: [...session().tasks, { instruction: 'Now add tests', summary: '', files: [], stopped: 'max-steps', ts: 3 }] }));
    const rs = resolveReviewSession(root, 'latest') as ReviewSession;
    const scoped = scopeChangeToSession(collectChangeSet(root, undefined, run), rs);
    const resolve = makePinResolver(scoped.change, {}, run);
    const doc = buildReviewDoc({ change: scoped.change, groups: groupChangeSet(scoped.change), repoKey: null, resolve, session: sessionBlocks(rs, scoped, resolve) });
    expect(doc.sections.map((s) => s.kind)).toEqual(['what_why', 'requirements', 'implementation']);
    expect(doc.generator.by).toBe('mixed');
    expect(doc.title).toMatch(/^What VG Code did: Add input validation/);
    expect(validateReviewDoc(doc, resolve)).toEqual([]);
    const md = renderReviewDocMarkdown(doc);
    expect(md).toContain('1 turn did not finish: turn 3 stopped (max-steps)');
    expect(md).toContain('**Turn 3** “Now add tests” → no files changed');
    expect(md).not.toContain('src/c.ts');
  });

  it('reads a worktree chat from its worktree, against the commit it branched from', () => {
    const root = repo();
    git(root, 'stash', '-q', '-u');
    const base = git(root, 'rev-parse', 'HEAD');
    const wt = path.join(root, '.vibgrate', 'worktrees', 'wtabc1');
    git(root, 'worktree', 'add', '-q', '--detach', wt, base);
    // A commit and an uncommitted edit, both inside the worktree.
    write(wt, 'src/a.ts', lines(20, 'a').replace('a3 = 3', 'a3 = validate(3)'));
    git(wt, 'commit', '-q', '-am', 'agent step');
    write(wt, 'src/b.ts', lines(20, 'b') + 'export const rejected = log();\n');
    saveSession(root, session({ worktree: { id: 'wtabc1', path: wt, base } }));
    const rs = resolveReviewSession(root, 'latest') as ReviewSession;
    expect(rs.root).toBe(wt);
    expect(rs.base).toBe(base);
    const change = collectChangeSet(rs.root, rs.base!, run, { inPlace: true });
    const scoped = scopeChangeToSession(change, rs);
    expect(scoped.change.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts']);
    const resolve = makePinResolver(scoped.change, { base: rs.base!, inPlace: true }, run);
    const doc = buildReviewDoc({ change: scoped.change, groups: groupChangeSet(scoped.change), repoKey: null, resolve, session: sessionBlocks(rs, scoped, resolve) });
    expect(validateReviewDoc(doc, resolve)).toEqual([]);
    expect(JSON.stringify(doc.sections[0])).toContain('in worktree wtabc1');
    // The main checkout is untouched by any of this.
    expect(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8')).not.toContain('validate');
  });
});
