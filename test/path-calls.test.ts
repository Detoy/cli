import { describe, it, expect, afterEach } from 'vitest';
import { buildGraph } from '../src/engine/build.js';
import { callPath, describeHops, shortestPath } from '../src/engine/paths.js';
import { makeProject, cleanup } from './helpers.js';
import type { VgGraph } from '../src/schema.js';

/**
 * `vg path --calls` / `find_path calls_only`: follow call edges only, and say
 * how each hop is joined (kind, resolver, call-site line, awaited).
 */

const PIN = '2020-01-01T00:00:00.000Z';
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

const files = {
  'src/db.ts': 'export async function insert(x: number) {\n  return x;\n}\n',
  'src/service.ts':
    "import { insert } from './db';\nexport async function place(x: number) {\n  return await insert(x);\n}\n",
  'src/api.ts': "import { place } from './service';\nexport async function handler() {\n  // entry\n  return place(1);\n}\n",
};

async function graph(): Promise<VgGraph> {
  const root = makeProject(files);
  dirs.push(root);
  return (await buildGraph({ root, generatedAt: PIN, inline: true })).graph;
}

const id = (g: VgGraph, qn: string) => g.nodes.find((n) => n.qualifiedName === qn)!.id;
const names = (g: VgGraph, ids: string[]) => ids.map((i) => g.nodes.find((n) => n.id === i)!.qualifiedName);

describe('callPath', () => {
  it('follows calls, with the call-site line and awaited flag per hop', async () => {
    const g = await graph();
    const p = callPath(g, id(g, 'handler'), id(g, 'insert'))!;
    expect(p.direction).toBe('forward');
    expect(names(g, p.ids)).toEqual(['handler', 'place', 'insert']);
    const hops = describeHops(g, p.ids, p.direction);
    expect(hops.map((h) => [h.kind, h.line, h.file])).toEqual([
      ['call', 4, 'src/api.ts'],
      ['call', 3, 'src/service.ts'],
    ]);
    expect(hops[1].awaited).toBe(true);
    expect(hops[0].awaited).toBeUndefined();
  });

  it('answers in reverse when the call arrow points the other way', async () => {
    const g = await graph();
    const p = callPath(g, id(g, 'insert'), id(g, 'handler'))!;
    expect(p.direction).toBe('reverse');
    expect(names(g, p.ids)).toEqual(['insert', 'place', 'handler']);
  });

  it('never crosses an import or contains edge, unlike the plain shortest path', async () => {
    const g = await graph();
    const file = (rel: string) => g.nodes.find((n) => n.kind === 'file' && n.file === rel)!.id;
    // api.ts reaches db.ts only through imports.
    const plain = shortestPath(g, file('src/api.ts'), file('src/db.ts'))!;
    expect(describeHops(g, plain.ids, plain.direction).every((h) => h.kind === 'import')).toBe(true);
    expect(callPath(g, file('src/api.ts'), file('src/db.ts'))).toBeNull();
  });
});
