import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDocument, resolveScope, scopeResolver } from './doc-build.js';
import { checkAgainstChange } from './doc-store.js';
import { parsePinLink, pinLink, renderReviewDocMarkdown, validateReviewDoc, type DocBlock, type ReviewDoc } from './doc.js';
import { repoKey } from './git.js';
import { mergeDocuments, multiResolver, parseAlso, repoId, tagBlock } from './multi-repo.js';

/**
 * Multi-repo review documents (`vg review doc --also`): each repository is
 * built where it lives, then folded in with every pin naming its repository,
 * and checked pin by pin against the repository it came from.
 */

describe('pins that name a repository', () => {
  it('round-trip through links', () => {
    expect(parsePinLink('head@client:src/a.ts#L3-L4')).toEqual({ side: 'head', path: 'src/a.ts', start: 3, end: 4, repo: 'client' });
    expect(pinLink({ side: 'base', path: 'a.ts', start: 2, end: 2, repo: 'client' })).toBe('base@client:a.ts#L2');
    expect(parsePinLink('head:src/a.ts#L3')).toEqual({ side: 'head', path: 'src/a.ts', start: 3, end: 3 });
  });

  it('must name one of the document repos', () => {
    const doc = {
      schema_version: 'vg.review.doc.v1',
      title: 't',
      target: { repo_key: null, base_sha: 'a', head_sha: 'b', merge_base: null, dirty_tree_hash: null },
      sections: [{ kind: 'what_why', blocks: [{ type: 'markdown', text: 'see [x](head@ghost:a.ts#L1)' }] }],
      groups_digest: null,
      generator: { by: 'vg', notes: [] },
    };
    expect(validateReviewDoc(doc).map((i) => i.code)).toContain('pin_repo');
    const named = { ...doc, repos: [{ id: 'ghost', name: null, repo_key: 'k', base_sha: 'a', head_sha: 'b', merge_base: null, dirty_tree_hash: null }] };
    expect(validateReviewDoc(named)).toEqual([]);
    expect(validateReviewDoc({ ...named, repos: [named.repos[0], named.repos[0]] }).map((i) => i.code)).toContain('duplicate_id');
  });
});

describe('folding documents together', () => {
  it('reads --also specs and gives each repository a short unique id', () => {
    expect(parseAlso('../client=origin/main')).toEqual({ dir: '../client', base: 'origin/main' });
    expect(parseAlso('../client')).toEqual({ dir: '../client', base: null });
    expect(repoId('acme/Web.Client', '../x', new Set())).toBe('web.client');
    expect(repoId(null, '/work/Client App', new Set(['client-app']))).toBe('client-app-2');
  });

  it('tags every pin and pin link in a block, and never keeps it primary', () => {
    const block = {
      type: 'call_stack_diff',
      id: 'blk_1',
      primary: true,
      title: 'How get is reached',
      base: [],
      head: [{ key: 'k', label: 'get', pin: { side: 'head', path: 'src/a.ts', start: 1, end: 3 }, call_site: { side: 'head', path: 'src/b.ts', start: 2, end: 2 } }],
    } as unknown as DocBlock;
    const tagged = tagBlock(block, 'client') as unknown as { id?: string; primary: boolean; head: { pin: { repo: string }; call_site: { repo: string } }[] };
    expect(tagged.id).toBeUndefined();
    expect(tagged.primary).toBe(false);
    expect(tagged.head[0].pin.repo).toBe('client');
    expect(tagged.head[0].call_site.repo).toBe('client');
    expect((tagBlock({ type: 'markdown', text: 'a [L2](head:src/a.ts#L2) b' }, 'client') as { text: string }).text).toBe('a [L2](head@client:src/a.ts#L2) b');
  });
});

describe('a change across two checkouts', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
  };
  function repo(name: string, lines: number): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `vg-multi-${name}-`)));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'remote', 'add', 'origin', `https://github.com/acme/${name}.git`);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'branch', 'base');
    fs.writeFileSync(path.join(root, 'src/a.ts'), Array.from({ length: lines }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n');
    git(root, 'commit', '-q', '-am', 'change');
    return root;
  }

  it('builds, folds, checks every pin in its own repository, and catches a pin that does not land', async () => {
    const api = repo('api', 3);
    const client = repo('client', 9);
    const opts = { findings: false, diagrams: false };
    const primary = await buildDocument(api, { kind: 'change', base: 'base', in_place: false }, opts);
    const other = await buildDocument(client, { kind: 'change', base: 'base', in_place: false }, opts);
    const doc = mergeDocuments(primary.doc, [{ id: 'client', name: 'acme/client', doc: other.doc }]);
    const resolve = multiResolver(primary.resolve, new Map([['client', other.resolve]]));
    expect(validateReviewDoc(doc, resolve)).toEqual([]);
    expect(doc.repos).toMatchObject([{ id: 'client', name: 'acme/client', head_sha: other.doc.target.head_sha }]);
    expect(JSON.stringify(doc)).toContain('head@client:src/a.ts#L1-L9');
    expect(renderReviewDocMarkdown(doc)).toMatch(/Also covers: `client` \(acme\/client\)/);

    // The client's L1-L9 does not fit the api's 3-line file: checked in the wrong repository it fails.
    expect(validateReviewDoc(doc, primary.resolve).map((i) => i.code)).toContain('pin_missing_file');
    // --check without the other checkout says so once; with it, the document is valid.
    const resolved = resolveScope(api, { kind: 'change', base: 'base', in_place: false });
    expect(checkAgainstChange(doc as ReviewDoc, resolved).map((i) => i.code)).toEqual(['repo_not_checked']);
    const clientScope = resolveScope(client, { kind: 'change', base: 'base', in_place: false });
    const others = new Map([[repoKey(clientScope.change.remote, clientScope.change.topLevel), scopeResolver(clientScope)]]);
    expect(checkAgainstChange(doc as ReviewDoc, resolved, others)).toEqual([]);
  });
});
