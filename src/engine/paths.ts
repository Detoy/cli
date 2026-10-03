import { bidirectional } from 'graphology-shortest-path/unweighted.js';
import { buildGraphologyGraph } from './graph-model.js';
import { indexFor } from './relations.js';
import type { GraphEdge, VgGraph } from '../schema.js';

/**
 * Shortest connection between two nodes (`vg path`). Uses graphology's
 * bidirectional BFS over the directed graph; falls back to the reverse direction
 * so "how does A connect to B" still answers when the dependency arrow runs B→A.
 */
export interface PathResult {
  ids: string[];
  direction: 'forward' | 'reverse';
}

export function shortestPath(graph: VgGraph, srcId: string, dstId: string): PathResult | null {
  const g = buildGraphologyGraph(graph.nodes, graph.edges);
  if (!g.hasNode(srcId) || !g.hasNode(dstId)) return null;
  const forward = bidirectional(g, srcId, dstId);
  if (forward) return { ids: forward, direction: 'forward' };
  const reverse = bidirectional(g, dstId, srcId);
  if (reverse) return { ids: reverse.slice().reverse(), direction: 'reverse' };
  return null;
}

/** One-hop usage neighbors used when endpoints are not connected. */
export interface EndpointNeighborhood {
  name: string;
  calls: string[];
  calledBy: string[];
  imports: string[];
  importedBy: string[];
}

/**
 * Actionable disconnect context for `vg path` / `find_path` when BFS finds no
 * route. Agents otherwise treat a bare "no path" as a dead end; neighbors make
 * the next query (`show` / `impact` / a different endpoint) obvious.
 */
export interface PathDisconnect {
  connected: false;
  from: EndpointNeighborhood;
  to: EndpointNeighborhood;
  hint: string;
}

const NEIGHBOR_CAP = 6;

export function pathDisconnect(graph: VgGraph, srcId: string, dstId: string): PathDisconnect {
  const idx = indexFor(graph);
  const from = neighborhood(idx, srcId);
  const to = neighborhood(idx, dstId);
  const hint =
    from.calls.length || from.calledBy.length || to.calls.length || to.calledBy.length
      ? 'No direct call/import chain links these symbols. Try `vg show` / `vg impact` on each end, or path via a shared hub.'
      : 'Neither endpoint has call/import neighbors in the map — they may be isolated docs/externals, or the link needs a more precise build.';
  return { connected: false, from, to, hint };
}

function neighborhood(
  idx: ReturnType<typeof indexFor>,
  id: string,
): EndpointNeighborhood {
  const node = idx.node(id);
  const name = node?.qualifiedName ?? id;
  const calls = uniqueNames(idx.callees(id).map((x) => x.node.qualifiedName));
  const calledBy = uniqueNames(idx.callers(id).map((x) => x.node.qualifiedName));
  const imports = uniqueNames(
    idx
      .out(id, 'import')
      .map((e) => idx.node(e.dst)?.qualifiedName)
      .filter((n): n is string => !!n),
  );
  const importedBy = uniqueNames(
    idx
      .in(id, 'import')
      .map((e) => idx.node(e.src)?.qualifiedName)
      .filter((n): n is string => !!n),
  );
  return { name, calls, calledBy, imports, importedBy };
}

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b)).slice(0, NEIGHBOR_CAP);
}

/** One step of a path: the edge that joins two consecutive nodes. */
export interface PathHop {
  from: string;
  to: string;
  /** The joining edge's kind; for a reverse path, the edge runs to → from. */
  kind: string;
  resolution: string;
  confidence: number;
  /** First call-site line in the caller's file, for call edges that record one. */
  line?: number;
  /** The caller's file, so `line` can be opened. */
  file?: string;
  awaited?: boolean;
}

/** Relational kinds first: when two nodes are joined twice, the call explains more than the import. */
const HOP_KIND_ORDER = ['call', 'references', 'extends', 'implements', 'import', 'test', 'coverage', 'contains'];

function hopKindRank(kind: string): number {
  const i = HOP_KIND_ORDER.indexOf(kind);
  return i < 0 ? HOP_KIND_ORDER.length : i;
}

/**
 * Describe each hop of a path with the edge that joins it. For a forward path
 * the edge runs a → b; for a reverse path (the dependency arrow points back)
 * it runs b → a.
 */
export function describeHops(graph: VgGraph, ids: string[], direction: PathResult['direction']): PathHop[] {
  const byPair = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const k = `${e.src}\0${e.dst}`;
    const list = byPair.get(k);
    if (list) list.push(e);
    else byPair.set(k, [e]);
  }
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const hops: PathHop[] = [];
  for (let i = 0; i + 1 < ids.length; i++) {
    const [a, b] = direction === 'forward' ? [ids[i], ids[i + 1]] : [ids[i + 1], ids[i]];
    const edges = [...(byPair.get(`${a}\0${b}`) ?? [])].sort((x, y) => hopKindRank(x.kind) - hopKindRank(y.kind));
    const e = edges[0];
    const from = nodeById.get(ids[i])?.qualifiedName ?? ids[i];
    const to = nodeById.get(ids[i + 1])?.qualifiedName ?? ids[i + 1];
    if (!e) {
      hops.push({ from, to, kind: 'unknown', resolution: 'heuristic', confidence: 0 });
      continue;
    }
    const hop: PathHop = { from, to, kind: e.kind, resolution: e.resolution, confidence: e.confidence };
    if (e.sites?.length) {
      hop.line = e.sites[0];
      hop.file = nodeById.get(e.src)?.file;
    }
    if (e.awaited) hop.awaited = true;
    hops.push(hop);
  }
  return hops;
}

/**
 * Shortest path that follows `call` edges only — what actually runs, not what
 * merely imports or contains what. Breadth-first and deterministic: at equal
 * depth, precise resolution beats a name match, then node id. Falls back to
 * the reverse direction like {@link shortestPath}.
 */
export function callPath(graph: VgGraph, srcId: string, dstId: string): PathResult | null {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  if (!nodeIds.has(srcId) || !nodeIds.has(dstId)) return null;
  const rank: Record<string, number> = { scip: 0, tsc: 1, stackgraph: 2, heuristic: 3 };
  const out = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    if (e.kind !== 'call') continue;
    const list = out.get(e.src);
    if (list) list.push(e);
    else out.set(e.src, [e]);
  }
  for (const list of out.values()) {
    list.sort((x, y) => (rank[x.resolution] ?? 9) - (rank[y.resolution] ?? 9) || (x.dst < y.dst ? -1 : x.dst > y.dst ? 1 : 0));
  }
  const bfs = (from: string, to: string): string[] | null => {
    const prev = new Map<string, string | null>([[from, null]]);
    let frontier = [from];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const e of out.get(id) ?? []) {
          if (prev.has(e.dst)) continue;
          prev.set(e.dst, id);
          if (e.dst === to) {
            const path = [to];
            let cur: string | null | undefined = id;
            while (cur) {
              path.push(cur);
              cur = prev.get(cur);
            }
            return path.reverse();
          }
          next.push(e.dst);
        }
      }
      frontier = next;
    }
    return null;
  };
  if (srcId === dstId) return { ids: [srcId], direction: 'forward' };
  const forward = bfs(srcId, dstId);
  if (forward) return { ids: forward, direction: 'forward' };
  const reverse = bfs(dstId, srcId);
  if (reverse) return { ids: reverse.slice().reverse(), direction: 'reverse' };
  return null;
}
