import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocScope } from './doc-build.js';
import { DOC_SCHEMA, renderReviewDocMarkdown, type ReviewDoc } from './doc.js';
import {
  applyPatch,
  checkDocument,
  docIdFor,
  documentHistory,
  getDocument,
  listDocuments,
  openDocument,
  outline,
  patchDocument,
  pruneExpired,
  restoreVersion,
  savedOrBuilt,
  storeDir,
} from './doc-store.js';

/**
 * Saved review documents, patched block by block, against a real git
 * repository: atomic patches, version conflicts, provenance that cannot be
 * forged, restore, and the retention window.
 */

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
const at = (iso: string) => () => new Date(iso);
const tree: DocScope = { kind: 'change', base: null, in_place: false };
const quiet = { findings: false, diagrams: false };

describe('saved review documents', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  });

  function repo(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vg-doc-store-')));
    roots.push(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    write(root, '.gitignore', '.vibgrate/\n');
    write(root, 'src/a.ts', lines(20, 'a'));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    write(root, 'src/a.ts', lines(20, 'a').replace('a3 = 3', 'a3 = validate(3)'));
    return root;
  }

  const whatWhy = (doc: ReviewDoc) => doc.sections.find((s) => s.kind === 'what_why')!.blocks[0].id!;

  it('opens one document per scope, and reopening returns the saved version', async () => {
    const root = repo();
    const first = await openDocument(root, tree, { ...quiet, clock: at('2026-10-02T10:00:00Z') });
    expect(first).toMatchObject({ doc_id: docIdFor(tree), version: 1, built: true });
    expect(first.doc.revision).toEqual({ doc_id: first.doc_id, version: 1, by: 'vg', at: '2026-10-02T10:00:00.000Z' });
    expect(first.doc.schema_version).toBe(DOC_SCHEMA);
    const again = await openDocument(root, tree, quiet);
    expect(again).toMatchObject({ doc_id: first.doc_id, version: 1, built: false });
    expect(again.doc.digest).toBe(first.doc.digest);
    expect(docIdFor({ kind: 'change', base: 'origin/main', in_place: false })).not.toBe(first.doc_id);
    // Never committed by accident: the store is in vg's own .gitignore.
    expect(fs.readFileSync(path.join(root, '.vibgrate', '.gitignore'), 'utf8')).toContain('review-docs/');
  });

  it('a patch is saved as a new version, marked as the agent’s, with vg’s parts left as they were', async () => {
    const root = repo();
    const { doc_id, doc } = await openDocument(root, tree, quiet);
    const res = patchDocument(
      root,
      doc_id,
      1,
      [
        { op: 'set_text', block: whatWhy(doc), text: 'Adds validation to `a3`, see [the change](head:src/a.ts#L4).' },
        { op: 'insert', section: 'requirements', block: { type: 'markdown', text: '- Reject invalid input before it is stored.' } },
        { op: 'set_title', title: 'Validate a3' },
      ],
      at('2026-10-02T11:00:00Z'),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe(2);
    expect(res.doc.title).toBe('Validate a3');
    expect(res.doc.generator.by).toBe('mixed');
    expect(res.doc.revision).toMatchObject({ version: 2, by: 'agent' });
    expect(res.doc.sections.map((s) => s.kind)).toEqual(['what_why', 'requirements', 'implementation']);
    const req = res.doc.sections[1].blocks[0];
    expect(req).toMatchObject({ type: 'markdown', origin: 'agent' });
    expect(req.id).toMatch(/^blk_[0-9a-f]{12}$/);
    // The rewritten block keeps its id, so anything pointing at it still does.
    expect(res.doc.sections[0].blocks[0]).toMatchObject({ id: whatWhy(doc), origin: 'agent' });
    // vg's implementation section is untouched and unmarked.
    expect(res.doc.sections[2]).toEqual(doc.sections.find((s) => s.kind === 'implementation'));
    expect(renderReviewDocMarkdown(res.doc)).toContain('(written by an agent)');
    const h = documentHistory(root, doc_id);
    expect(h.versions.map((v) => [v.version, v.by, v.summary])).toEqual([
      [2, 'agent', '3 operations'],
      [1, 'vg', 'built'],
    ]);
  });

  it('all or nothing: a pin that does not land saves nothing and says which', async () => {
    const root = repo();
    const { doc_id, doc } = await openDocument(root, tree, quiet);
    const res = patchDocument(root, doc_id, 1, [
      { op: 'set_title', title: 'renamed' },
      { op: 'set_text', block: whatWhy(doc), text: 'See [here](head:src/a.ts#L90-L99).' },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues.map((i) => i.code)).toContain('pin_out_of_range');
    expect(getDocument(root, doc_id)).toMatchObject({ version: 1 });
    expect(getDocument(root, doc_id).doc.title).not.toBe('renamed');
  });

  it('refuses a patch written against an older version', async () => {
    const root = repo();
    const { doc_id } = await openDocument(root, tree, quiet);
    expect(patchDocument(root, doc_id, 1, [{ op: 'set_title', title: 'one' }]).ok).toBe(true);
    const late = patchDocument(root, doc_id, 1, [{ op: 'set_title', title: 'two' }]);
    expect(late).toMatchObject({ ok: false, conflict: true, version: 2 });
    expect(getDocument(root, doc_id).doc.title).toBe('one');
  });

  it('names unknown blocks and ops instead of guessing', async () => {
    const root = repo();
    const { doc_id } = await openDocument(root, tree, quiet);
    const res = patchDocument(root, doc_id, 1, [
      { op: 'remove', block: 'blk_nope' },
      { op: 'rewrite_everything' },
      { op: 'insert', section: 'appendix', block: { type: 'divider' } },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual([
      'ops[0] (remove): no block blk_nope',
      'ops[1] (rewrite_everything): unknown op — use set_title, set_text, insert, replace, remove, move or set_primary',
      'ops[2] (insert): section must be one of what_why, requirements, design, implementation',
    ]);
  });

  it('restores an earlier version as a new one; history is never rewritten', async () => {
    const root = repo();
    const { doc_id, doc } = await openDocument(root, tree, quiet);
    patchDocument(root, doc_id, 1, [{ op: 'set_title', title: 'edited' }]);
    const res = restoreVersion(root, doc_id, 1);
    expect(res).toMatchObject({ ok: true, version: 3 });
    if (!res.ok) return;
    expect(res.doc.title).toBe(doc.title);
    expect(res.doc.revision).toMatchObject({ version: 3, by: 'vg' });
    expect(documentHistory(root, doc_id).versions.map((v) => v.summary)).toEqual(['restored version 1', '1 operation', 'built']);
    expect(getDocument(root, doc_id, 2).doc.title).toBe('edited');
  });

  it('rebuilds when the commits move, keeping the edited versions in history', async () => {
    const root = repo();
    const { doc_id } = await openDocument(root, tree, quiet);
    patchDocument(root, doc_id, 1, [{ op: 'set_title', title: 'edited' }]);
    git(root, 'commit', '-q', '-am', 'step');
    write(root, 'src/a.ts', lines(21, 'a'));
    const moved = await openDocument(root, tree, quiet);
    expect(moved).toMatchObject({ doc_id, version: 3, built: true });
    expect(moved.reason).toMatch(/written for .*the change is/);
    expect(checkDocument(root, doc_id)).toMatchObject({ valid: true, issues: [] });
    expect(getDocument(root, doc_id, 2).doc.title).toBe('edited');
  });

  it('reading never saves: the saved version while it matches, a fresh build otherwise', async () => {
    const root = repo();
    expect((await savedOrBuilt(root, tree, quiet)).saved).toBeNull();
    expect(listDocuments(root)).toEqual([]);
    const { doc_id } = await openDocument(root, tree, quiet);
    patchDocument(root, doc_id, 1, [{ op: 'set_title', title: 'edited' }]);
    const shown = await savedOrBuilt(root, tree, quiet);
    expect(shown).toMatchObject({ saved: { doc_id, version: 2 } });
    expect(shown.doc.title).toBe('edited');
    git(root, 'commit', '-q', '-am', 'step');
    const moved = await savedOrBuilt(root, tree, quiet);
    expect(moved.saved).toBeNull();
    expect(moved.note).toMatch(/version 2\) was written for an earlier commit/);
    expect(documentHistory(root, doc_id).current).toBe(2);
  });

  it('deletes a document not updated for 365 days, the Repository retention window', async () => {
    const root = repo();
    const { doc_id } = await openDocument(root, tree, { ...quiet, clock: at('2026-01-01T00:00:00Z') });
    expect(pruneExpired(root, new Date('2026-12-31T00:00:00Z'))).toEqual([]);
    expect(pruneExpired(root, new Date('2027-01-02T00:00:00Z'))).toEqual([doc_id]);
    expect(listDocuments(root)).toEqual([]);
    expect(fs.existsSync(path.join(storeDir(root), doc_id))).toBe(false);
  });
});

describe('applyPatch: provenance cannot be forged', () => {
  const pin = (start: number, end = start) => ({ side: 'head' as const, path: 'src/a.ts', start, end });
  const doc = (): ReviewDoc => ({
    schema_version: DOC_SCHEMA,
    title: 't',
    target: { repo_key: null, base_sha: 'a', head_sha: 'b', merge_base: null, dirty_tree_hash: null },
    sections: [
      {
        kind: 'design',
        blocks: [
          {
            type: 'call_stack_diff',
            id: 'blk_stack',
            title: 'How save is reached',
            primary: true,
            base_status: 'not_computed',
            base: [],
            head: [
              { key: 'main', label: 'main', pin: pin(1, 3), origin: 'graph' },
              { key: 'save', parent_key: 'main', label: 'save', pin: pin(4, 9), origin: 'graph' },
            ],
          },
        ],
      },
    ],
    groups_digest: null,
    generator: { by: 'vg', notes: [] },
  });

  it('an edited frame becomes the agent’s; an untouched one stays graph-derived', () => {
    const d = doc();
    const stack = d.sections[0].blocks[0] as Extract<ReviewDoc['sections'][0]['blocks'][0], { type: 'call_stack_diff' }>;
    const edited = { ...stack, head: [stack.head[0], { ...stack.head[1], label: 'save (persists the order)' }] };
    const res = applyPatch(d, [{ op: 'replace', block: 'blk_stack', with: edited }]);
    expect(res.errors).toEqual([]);
    const head = (res.doc.sections[0].blocks[0] as typeof stack).head;
    expect(head.map((f) => f.origin)).toEqual(['graph', 'agent']);
    expect(res.doc.sections[0].blocks[0].id).toBe('blk_stack');
    // It still said "graph" for the frame it edited; vg says what it did about that.
    expect(res.notes).toEqual(['1 element marked origin "graph" is new or changed, not what vg derived, so it is recorded as "agent"']);
  });

  it('an agent cannot claim origin graph for what it drew', () => {
    const res = applyPatch(doc(), [
      {
        op: 'insert',
        section: 'design',
        block: {
          type: 'flow',
          title: 'What save does',
          nodes: [
            { key: 'v', label: 'validate', pins: [pin(4)], origin: 'graph' },
            { key: 'p', label: 'persist', pins: [pin(5)] },
          ],
          edges: [{ from: 'v', to: 'p', origin: 'graph' }],
        },
      },
      { op: 'set_primary', block: 'blk_stack' },
    ]);
    expect(res.errors).toEqual([]);
    const flow = res.doc.sections[0].blocks[1] as { nodes: { origin: string }[]; edges: { origin: string }[]; id: string };
    expect(flow.nodes.map((n) => n.origin)).toEqual(['agent', 'agent']);
    expect(flow.edges.map((e) => e.origin)).toEqual(['agent']);
    expect(flow.id).toMatch(/^blk_/);
    expect(res.notes).toEqual(['2 elements marked origin "graph" are new or changed, not what vg derived, so they are recorded as "agent"']);
  });

  it('moving the primary leaves exactly one, and removing the last block drops the section', () => {
    const withFlow = applyPatch(doc(), [{ op: 'insert', section: 'design', block: { type: 'flow', title: 'f', nodes: [{ key: 'a', label: 'a', pins: [pin(1)] }], edges: [] } }]).doc;
    const flowId = withFlow.sections[0].blocks[1].id!;
    const moved = applyPatch(withFlow, [{ op: 'set_primary', block: flowId }]).doc;
    expect(moved.sections[0].blocks.map((b) => Boolean((b as { primary?: boolean }).primary))).toEqual([false, true]);
    const gone = applyPatch(doc(), [{ op: 'remove', block: 'blk_stack' }]).doc;
    expect(gone.sections).toEqual([]);
  });

  it('outlines a document by block id, type and size', () => {
    expect(outline(doc())).toEqual({
      title: 't',
      sections: [{ kind: 'design', blocks: [{ id: 'blk_stack', type: 'call_stack_diff', title: 'How save is reached', primary: true, chars: expect.any(Number) }] }],
    });
  });
});
