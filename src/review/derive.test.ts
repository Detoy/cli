import { describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, VgGraph } from '../schema.js';
import type { HaileProvider } from '../engine/haile/haile-provider.js';
import type { ChangeSet, ChangedFile } from './git.js';
import { groupChangeSet } from './groups.js';
import { buildReviewDoc, renderReviewDocMarkdown, validateReviewDoc, type PinResolver } from './doc.js';
import { deriveDiagrams, INSTALL_HINT, mapPrefix, rolesOf, trimGraph, type DeriveInput } from './derive.js';
import type { HaileSidecar } from '../engine/haile/types.js';

/**
 * The host side of graph-derived diagrams. The derivation itself lives in the
 * Architecture module and is tested there; these tests pin what the host
 * owns: what it sends, what it refuses to show, and what it says when the
 * module is missing.
 */

const TOP = '/repo';
const MAP_ROOT = '/repo/pkg';

function node(id: string, over: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    kind: 'function',
    name: id,
    qualifiedName: id,
    file: 'src/app.ts',
    span: { start: 1, end: 10 },
    lang: 'ts',
    importance: 0.1,
    centrality: { degree: 0, pagerank: 0, betweenness: 0, eigenvector: 0 },
    area: 0,
    isHub: false,
    tested: false,
    ...over,
  };
}

function edge(kind: GraphEdge['kind'], src: string, dst: string, over: Partial<GraphEdge> = {}): GraphEdge {
  return { id: `${kind}:${src}>${dst}`, kind, src, dst, resolution: 'tsc', confidence: 1, ...over };
}

const graph = (nodes: GraphNode[], edges: GraphEdge[]) => ({ schemaVersion: 'vg-graph/1.1', nodes, edges, areas: [] }) as unknown as VgGraph;

const files: ChangedFile[] = [{ path: 'pkg/src/store.ts', op: 'modified', addedLines: 3, removedLines: 1, hunks: [{ start: 42, end: 44 }] }];
const change: ChangeSet = { topLevel: TOP, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), mergeBase: null, ref: null, dirty: false, dirtyTreeHash: null, files, remote: null };
const resolve: PinResolver = (_side, p) => (p.startsWith('pkg/src/') ? 200 : null);

const save = node('save', { file: 'src/store.ts', span: { start: 40, end: 60 }, duties: [{ k: 'persist', live: true, line: 43 }] });
const head = graph(
  [node('main'), save, node('Order', { kind: 'interface' }), node('helper', { file: 'src/other.ts', duties: [{ k: 'log', live: true, line: 3 }] })],
  [
    edge('call', 'main', 'save', { sites: [12], awaited: true }),
    edge('import', 'main', 'save'),
    edge('references', 'save', 'Order'),
  ],
);
const input = (over: Partial<DeriveInput> = {}): DeriveInput => ({ change, head, mapRoot: MAP_ROOT, resolve, ...over });

const stackBlock = {
  type: 'call_stack_diff',
  title: 'How save is reached',
  primary: true,
  base_status: 'not_computed',
  base: [],
  head: [
    { key: 'pkg/src/app.ts#main', label: 'main', pin: { side: 'head', path: 'pkg/src/app.ts', start: 1, end: 10 }, origin: 'graph' },
    { key: 'pkg/src/store.ts#save', parent_key: 'pkg/src/app.ts#main', label: 'save', pin: { side: 'head', path: 'pkg/src/store.ts', start: 40, end: 60 }, via: { kind: 'async' }, status: 'modified', origin: 'graph' },
  ],
};
const contractBlock = {
  type: 'callout',
  tone: 'warning',
  text: '**Signature changed:** `save`',
  pins: [{ side: 'base', path: 'pkg/src/store.ts', start: 40, end: 58 }, { side: 'head', path: 'pkg/src/store.ts', start: 40, end: 60 }],
};

function fakeProvider(result: ReturnType<NonNullable<HaileProvider['reviewDiagrams']>>, seen?: { payload?: unknown }): HaileProvider {
  return {
    version: () => 'test',
    classify: () => null,
    reviewDiagrams: (payload) => {
      if (seen) seen.payload = payload;
      return result;
    },
  };
}

describe('mapPrefix', () => {
  it('is the map root relative to the repository, empty at the root', () => {
    expect(mapPrefix(change, MAP_ROOT)).toBe('pkg');
    expect(mapPrefix(change, TOP)).toBe('');
  });
});

describe('trimGraph', () => {
  const trimmed = trimGraph(head, new Set(['src/store.ts']));

  it('keeps callables and call / reference edges between them, nothing else', () => {
    expect((trimmed.nodes as { id: string }[]).map((n) => n.id)).toEqual(['main', 'save', 'helper']);
    expect(trimmed.edges).toEqual([{ kind: 'call', src: 'main', dst: 'save', res: 'tsc', conf: 1, sites: [12], awaited: true }]);
  });

  it('sends duties only for nodes in changed files', () => {
    const byId = new Map((trimmed.nodes as { id: string; duties?: unknown }[]).map((n) => [n.id, n]));
    expect(byId.get('save')!.duties).toBeDefined();
    expect(byId.get('helper')!.duties).toBeUndefined();
  });

  it('also sends the duties of functions a changed one calls, where its reads and writes often run', () => {
    const repo = node('repo', { file: 'src/repo.ts', duties: [{ k: 'persist', o: 'Order', live: true, line: 7 }] });
    const g = graph([save, repo, node('far', { file: 'src/far.ts', duties: [{ k: 'log', live: true, line: 1 }] })], [edge('call', 'save', 'repo'), edge('call', 'repo', 'far')]);
    const byId = new Map((trimGraph(g, new Set(['src/store.ts'])).nodes as { id: string; duties?: unknown }[]).map((n) => [n.id, n]));
    expect(byId.get('repo')!.duties).toBeDefined();
    expect(byId.get('far')!.duties).toBeDefined();
  });

  it('names where every function dispatches work without a call edge (its inherited duties)', () => {
    const controller = node('ctl', { file: 'src/ctl.ts', duties: [{ k: 'persist', via: 'Handler.Handle', live: true, line: 0, hop: 1 }, { k: 'query', via: 'Handler.Handle', live: true, line: 0, hop: 1 }] });
    const out = trimGraph(graph([controller], []), new Set()).nodes as { id: string; disp?: string[]; duties?: unknown }[];
    expect(out[0].disp).toEqual(['Handler.Handle']);
    expect(out[0].duties).toBeUndefined();
  });
});

describe('rolesOf', () => {
  const sym = (node_id: string, primary: string, band = 'high', purposes: { purpose: string; confidence: number }[] = []) =>
    ({ node_id, role: { primary, alternatives: [], confidence: 0.9, band }, purposes }) as unknown as HaileSidecar['symbols'][0];

  it('takes each node’s role from the sidecar, and a method takes its type’s', () => {
    const cls = node('Handler', { kind: 'class', file: 'src/h.cs', span: { start: 1, end: 40 } });
    const m = node('Handler.Handle', { kind: 'method', file: 'src/h.cs', span: { start: 5, end: 20 } });
    const other = node('Other.Run', { kind: 'method', file: 'src/o.cs', span: { start: 5, end: 20 } });
    const sidecar = { symbols: [sym('Handler', 'use_case', 'high', [{ purpose: 'persist', confidence: 0.9 }, { purpose: 'log', confidence: 0.2 }])] } as unknown as HaileSidecar;
    const roles = rolesOf(graph([cls, m, other], []), sidecar);
    expect(roles.get('Handler.Handle')).toEqual({ role: 'use_case', purposes: ['persist'] });
    expect(roles.has('Other.Run')).toBe(false);
  });

  it('an abstained classification is not a role', () => {
    const sidecar = { symbols: [sym('save', 'repository', 'abstain')] } as unknown as HaileSidecar;
    expect(rolesOf(graph([save], []), sidecar).get('save')?.role).toBe('unknown');
    const trimmed = trimGraph(graph([save], []), new Set(['src/store.ts']), rolesOf(graph([save], []), sidecar)).nodes as { role?: string }[];
    expect(trimmed[0].role).toBeUndefined();
  });
});

describe('deriveDiagrams', () => {
  it('without the module: no diagrams, and the install command', () => {
    const d = deriveDiagrams(input(), null);
    expect(d.blocks).toEqual([]);
    expect(d.notes).toEqual([INSTALL_HINT]);
    expect(INSTALL_HINT).toContain('vg module install arch');
  });

  it('with a module that predates review diagrams: says so', () => {
    const d = deriveDiagrams(input(), { version: () => 'old', classify: () => null });
    expect(d.notes[0]).toMatch(/predates review diagrams/);
  });

  it('sends the trimmed maps, the prefix and the hunks', () => {
    const seen: { payload?: unknown } = {};
    deriveDiagrams(input(), fakeProvider({ blocks: [], contract: [], notes: [] }, seen));
    expect(seen.payload).toMatchObject({
      prefix: 'pkg',
      base: null,
      files: [{ path: 'pkg/src/store.ts', op: 'modified', hunks: [[42, 44]] }],
    });
  });

  it('carries the structural fold, keeping only files whose pins land', () => {
    const fold = [
      { path: 'pkg/src/store.ts', text: '- `save(order)` [L40–60](head:pkg/src/store.ts#L40-L60) _edited_' },
      { path: 'other/gone.ts', text: '- `old()` [L1–3](head:other/gone.ts#L1-L3) _edited_' },
    ];
    const d = deriveDiagrams(input(), fakeProvider({ blocks: [stackBlock], contract: [], notes: [], fold }));
    expect([...(d.fold ?? new Map()).keys()]).toEqual(['pkg/src/store.ts']);
    expect(d.notes.join(' ')).toMatch(/one file was left unfolded/);
    const groups = groupChangeSet(change, undefined, null);
    const doc = buildReviewDoc({ change, groups, repoKey: null, resolve, design: d });
    expect(validateReviewDoc(doc, resolve)).toEqual([]);
    expect(renderReviewDocMarkdown(doc)).toMatch(/- `pkg\/src\/store.ts` modified[^\n]*\n {2}- `save\(order\)` `L40–60` _edited_/);
  });

  it('keeps blocks whose pins land, and makes the first one primary', () => {
    const d = deriveDiagrams(input(), fakeProvider({ blocks: [stackBlock], contract: [contractBlock], notes: ['from the module'] }));
    expect(d.blocks).toHaveLength(1);
    expect(d.blocks[0]).toMatchObject({ type: 'call_stack_diff', primary: true });
    expect(d.implementation).toHaveLength(1);
    expect(d.notes).toEqual(['from the module']);
  });

  it('drops a block whose pins do not land, and says so', () => {
    const short: PinResolver = (_s, p) => (p === 'pkg/src/store.ts' ? 30 : 200);
    const d = deriveDiagrams(input({ resolve: short }), fakeProvider({ blocks: [stackBlock], contract: [contractBlock], notes: [] }));
    expect(d.blocks).toEqual([]);
    expect(d.implementation).toEqual([]);
    expect(d.notes.join(' ')).toMatch(/"How save is reached" was left out because its pins do not land/);
    expect(d.notes.join(' ')).toMatch(/signature change was left out/);
  });

  it('drops a malformed block from the module rather than trusting it', () => {
    const bad = { ...stackBlock, head: [{ ...stackBlock.head[0], via: { kind: 'teleport' } }] };
    expect(deriveDiagrams(input(), fakeProvider({ blocks: [bad], contract: [], notes: [] })).blocks).toEqual([]);
  });

  it('survives a module that abstains or throws', () => {
    expect(deriveDiagrams(input(), fakeProvider(null)).notes[0]).toMatch(/could not derive/);
    const throwing: HaileProvider = { version: () => 'x', classify: () => null, reviewDiagrams: () => { throw new Error('boom'); } };
    expect(deriveDiagrams(input(), throwing).blocks).toEqual([]);
  });

  it('feeds a review document that validates and renders, with signature changes under implementation', () => {
    const design = deriveDiagrams(input(), fakeProvider({ blocks: [stackBlock], contract: [contractBlock], notes: [] }));
    const doc = buildReviewDoc({ change, groups: groupChangeSet(change), repoKey: null, resolve, design });
    expect(doc.sections.map((s) => s.kind)).toEqual(['what_why', 'design', 'implementation']);
    expect(doc.sections[2].blocks.some((b) => b.type === 'callout')).toBe(true);
    expect(validateReviewDoc(doc, resolve)).toEqual([]);
    const md = renderReviewDocMarkdown(doc);
    expect(md).toContain('**How save is reached**');
    expect(md).toContain('_not computed_');
    expect(md).toContain('Signature changed');
  });
});
