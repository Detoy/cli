import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GraphEdge, GraphNode, VgGraph } from '../schema.js';
import type { HaileProvider } from '../engine/haile/haile-provider.js';
import { renderReviewDocMarkdown, validateReviewDoc } from './doc.js';
import { buildExplainDoc, explainChange } from './explain-doc.js';
import type { GitRunner } from './git.js';

/**
 * The explain view's host side: the symbol's span stands in for a change,
 * the module is asked in explain mode, and the document around the diagrams
 * is graph facts with pins that land.
 */

const noGit: GitRunner = () => ({ stdout: '', status: 1 });

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

function edge(src: string, dst: string): GraphEdge {
  return { id: `call:${src}>${dst}`, kind: 'call', src, dst, resolution: 'tsc', confidence: 1 };
}

const save = node('save', { file: 'src/store.ts', span: { start: 40, end: 60 }, signature: 'save(order: Order)' });
const graph = {
  schemaVersion: 'vg-graph/1.1',
  nodes: [node('main'), save, node('audit', { file: 'src/audit.ts', span: { start: 1, end: 5 } })],
  edges: [edge('main', 'save'), edge('save', 'audit')],
  areas: [{ id: 0, label: 'orders' }],
} as unknown as VgGraph;

const stackBlock = {
  type: 'call_stack_diff',
  title: 'How save is reached',
  primary: true,
  base_status: 'not_computed',
  base: [],
  head: [
    { key: 'src/app.ts#main', label: 'main', pin: { side: 'head', path: 'src/app.ts', start: 1, end: 10 }, origin: 'graph' },
    { key: 'src/store.ts#save', parent_key: 'src/app.ts#main', label: 'save', pin: { side: 'head', path: 'src/store.ts', start: 40, end: 60 }, origin: 'graph' },
  ],
};

function provider(seen: { payload?: unknown }): HaileProvider {
  return {
    version: () => 'test',
    classify: () => null,
    reviewDiagrams: (p: unknown) => {
      seen.payload = p;
      return { blocks: [stackBlock], contract: [], notes: ['from the module'] };
    },
  } as HaileProvider;
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-explain-'));
  fs.mkdirSync(path.join(root, 'src'));
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `// ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(root, 'src/app.ts'), lines(20));
  fs.writeFileSync(path.join(root, 'src/store.ts'), lines(80));
  fs.writeFileSync(path.join(root, 'src/audit.ts'), lines(5));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('explainChange', () => {
  it('turns the symbol span into the one changed file, read from the working tree', () => {
    const c = explainChange(root, save, noGit);
    expect(c.files).toEqual([{ path: 'src/store.ts', op: 'modified', addedLines: 0, removedLines: 0, hunks: [{ start: 40, end: 60 }] }]);
    expect(c.baseSha).toBe(c.headSha);
  });
});

describe('buildExplainDoc', () => {
  it('asks the module in explain mode and builds a valid explain document', () => {
    const seen: { payload?: unknown } = {};
    const { doc, resolve } = buildExplainDoc({ root, graph, node: save, provider: provider(seen), run: noGit });
    expect(seen.payload).toMatchObject({ mode: 'explain', base: null, files: [{ path: 'src/store.ts', hunks: [[40, 60]] }] });
    expect(doc.kind).toBe('explain');
    expect(doc.title).toBe('Explain: save');
    expect(validateReviewDoc(doc, resolve)).toEqual([]);
    expect(doc.sections.map((s) => [s.kind, s.title])).toEqual([
      ['what_why', 'What it is'],
      ['design', 'How it works'],
      ['implementation', 'Callers and callees'],
    ]);
    const what = doc.sections[0].blocks[0] as { text: string };
    expect(what.text).toContain('[save](head:src/store.ts#L40-L60) is a function');
    expect(what.text).toContain('area: orders');
    expect(what.text).toContain('1 caller, 1 callee');
    const impl = doc.sections[2].blocks.map((b) => (b as { text: string }).text).join('\n');
    expect(impl).toContain('**Called by** (1)');
    expect(impl).toContain('[main](head:src/app.ts#L1-L10)');
    expect(impl).toContain('[audit](head:src/audit.ts#L1-L5)');
    expect(doc.generator.notes[0]).toMatch(/nothing here is a change/);
    expect(doc.generator.notes).toContain('from the module');
  });

  it('renders the call path without a before column', () => {
    const { doc } = buildExplainDoc({ root, graph, node: save, provider: provider({}), run: noGit });
    const md = renderReviewDocMarkdown(doc);
    expect(md).not.toContain('| Before | After |');
    expect(md).toContain('**save** `src/store.ts:40-60`');
  });

  it('without the module: facts and callers only, and the install hint', () => {
    const { doc } = buildExplainDoc({ root, graph, node: save, provider: null, run: noGit });
    expect(doc.sections.map((s) => s.kind)).toEqual(['what_why', 'implementation']);
    expect(doc.generator.notes.join(' ')).toContain('vg module install arch');
  });

  it('never links a declaration whose pin does not land', () => {
    const ghost = node('ghost', { file: 'src/gone.ts', span: { start: 1, end: 3 } });
    const g = { ...graph, nodes: [...graph.nodes, ghost], edges: [...graph.edges, edge('ghost', 'save')] } as VgGraph;
    const { doc } = buildExplainDoc({ root, graph: g, node: save, provider: null, run: noGit });
    const impl = (doc.sections[1].blocks[0] as { text: string }).text;
    expect(impl).toContain('- `ghost`');
    expect(impl).not.toContain('src/gone.ts');
  });
});

describe('document kind', () => {
  it('is change or explain', () => {
    const { doc } = buildExplainDoc({ root, graph, node: save, provider: null, run: noGit });
    expect(validateReviewDoc({ ...doc, kind: 'scratch' }).map((i) => i.code)).toEqual(['enum']);
  });
});
