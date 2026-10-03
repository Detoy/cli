import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { addEdgeSite, MAX_EDGE_SITES } from '../src/engine/edge-sites.js';
import { makeProject, cleanup } from './helpers.js';
import type { GraphEdge, VgGraph } from '../src/schema.js';

/**
 * Call-site lines on `call` edges: what a review's call-stack frame pins its
 * call site to. Every resolver rung records them; the stored set depends only
 * on which lines exist, never on visit order.
 */

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function edgeByQn(graph: VgGraph, srcQn: string, dstQn: string): GraphEdge | undefined {
  const qn = new Map(graph.nodes.map((n) => [n.id, n.qualifiedName]));
  return graph.edges.find((e) => e.kind === 'call' && qn.get(e.src) === srcQn && qn.get(e.dst) === dstQn);
}

const edge = (kind: GraphEdge['kind'] = 'call'): GraphEdge => ({ id: 'e', kind, src: 'a', dst: 'b', resolution: 'heuristic', confidence: 1 });

describe('addEdgeSite', () => {
  it('keeps the smallest lines, sorted and unique, whatever the order', () => {
    const lines = [40, 3, 17, 3, 99, 1, 55, 23, 8, 61, 12];
    const a = edge();
    const b = edge();
    for (const l of lines) addEdgeSite(a, l);
    for (const l of [...lines].reverse()) addEdgeSite(b, l);
    expect(a.sites).toEqual([1, 3, 8, 12, 17, 23, 40, 55]);
    expect(a.sites).toHaveLength(MAX_EDGE_SITES);
    expect(b.sites).toEqual(a.sites);
  });

  it('ignores non-call edges and invalid lines', () => {
    const imp = edge('import');
    addEdgeSite(imp, 4);
    expect(imp.sites).toBeUndefined();
    const call = edge();
    addEdgeSite(call, 0);
    addEdgeSite(call, 2.5);
    expect(call.sites).toBeUndefined();
  });
});

describe('resolvers record call-site lines', () => {
  const files = {
    'src/math.ts': 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
    'src/use.ts': "import { add } from './math';\nexport function calc() {\n  const x = add(1, 2);\n  return add(x, 3);\n}\n",
  };

  it('the precise TypeScript rung', async () => {
    const root = makeProject(files);
    dirs.push(root);
    const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true });
    const e = edgeByQn(graph, 'calc', 'add');
    expect(e?.resolution).toBe('tsc');
    expect(e?.sites).toEqual([3, 4]);
  });

  it('the heuristic rung', async () => {
    const root = makeProject(files);
    dirs.push(root);
    const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true, noTsc: true });
    const e = edgeByQn(graph, 'calc', 'add');
    expect(e?.resolution).toBe('heuristic');
    expect(e?.sites).toEqual([3, 4]);
  });
});

describe('resolvers record awaited calls', () => {
  const files = {
    'src/io.ts': 'export async function load() {\n  return 1;\n}\nexport function sync() {\n  return 2;\n}\n',
    'src/use.ts':
      "import { load, sync } from './io';\nexport async function run() {\n  const a = await load();\n  return a + sync();\n}\n",
  };

  for (const [rung, opts] of [
    ['the precise TypeScript rung', {}],
    ['the heuristic rung', { noTsc: true }],
  ] as const) {
    it(rung, async () => {
      const root = makeProject(files);
      dirs.push(root);
      const { graph } = await buildGraph({ root, generatedAt: PIN, inline: true, ...opts });
      expect(edgeByQn(graph, 'run', 'load')?.awaited).toBe(true);
      expect(edgeByQn(graph, 'run', 'sync')?.awaited).toBeUndefined();
    });
  }
});
