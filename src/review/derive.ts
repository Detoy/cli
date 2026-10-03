/**
 * Graph-derived diagrams for the review document — the host side.
 *
 * Which changed function a review leads with, how its call path is chosen and
 * folded, how each hop is labelled, how a function's duties become a flow, and
 * when a signature change is reported are decided by the Architecture module
 * (`HaileProvider.reviewDiagrams`), not here. This file only:
 *
 *   1. trims the code maps to the fields the module reads,
 *   2. hands them over with the change's files and hunks,
 *   3. validates every returned block against the reviewed base and head,
 *      dropping any whose pins do not land, and says so.
 *
 * Without the module there are no diagrams, and the document says how to get
 * them. The validation stays here, in the open, so anyone can check a
 * document without the module.
 */

import * as path from 'node:path';
import type { GraphNode, VgGraph } from '../schema.js';
import type { HaileProvider } from '../engine/haile/haile-provider.js';
import type { ChangeSet } from './git.js';
import { DOC_SCHEMA, validateReviewDoc, type DocBlock, type PinResolver } from './doc.js';
import type { ModelStore } from './data-models.js';
import type { ArchOverview } from '../engine/chart/arch-types.js';
import type { HaileSidecar } from '../engine/haile/types.js';

export interface DerivedDiagrams {
  /** Design blocks, the primary first. */
  blocks: DocBlock[];
  /** Implementation callouts (signature changes). */
  implementation: DocBlock[];
  /** What was derived, what was not, and why. */
  notes: string[];
  /** The structural fold: per changed file (repo path), Markdown sub-bullets of its changed functions. */
  fold?: Map<string, string>;
}

export interface DeriveInput {
  change: ChangeSet;
  head: VgGraph;
  /** Graph built at the change's base commit, when the caller asked for one. */
  base?: VgGraph | null;
  /** Directory the code map was built from, so graph paths map to repo paths. */
  mapRoot: string;
  /** Data models the repository declares on the head side (data-models.ts), repo-relative. */
  models?: ModelStore[];
  /** The architecture sidecar (`graph.arch.json`), for each node's role and purposes. */
  sidecar?: HaileSidecar | null;
  /** The architecture overview (`vg show arch`): packages and package edges. */
  overview?: ArchOverview | null;
  /** What the system is called on the map (the repository's name). */
  system?: string;
  /** `explain`: the change's one span is code to explain, not an edit — no statuses, no before side. */
  mode?: 'change' | 'explain';
  resolve: PinResolver;
}

export const INSTALL_HINT = 'diagrams need the Architecture module — run `vg module install arch`, then run this again';

const CALLER_KINDS = new Set(['function', 'method', 'class', 'component', 'route', 'file']);

/** The map root relative to the repository, as the module joins paths with it. */
export function mapPrefix(change: ChangeSet, mapRoot: string): string {
  const rel = path.relative(change.topLevel, mapRoot).split(path.sep).join('/');
  return rel === '.' ? '' : rel;
}

type Roles = Map<string, { role: string; purposes: string[] }>;

/**
 * Each node's architecture role and top purposes, from the sidecar. The
 * sidecar classifies types; a method takes the role of the type whose span
 * encloses it. Facts the module already decided, passed back to it.
 */
export function rolesOf(g: VgGraph, sidecar: HaileSidecar | null | undefined): Roles {
  const roles: Roles = new Map();
  if (!sidecar) return roles;
  for (const s of sidecar.symbols) {
    if (!s.role?.primary) continue;
    roles.set(s.node_id, {
      role: s.role.band === 'abstain' ? 'unknown' : s.role.primary,
      purposes: (s.purposes ?? []).filter((p) => p.confidence >= 0.5).slice(0, 3).map((p) => p.purpose),
    });
  }
  const typesByFile = new Map<string, GraphNode[]>();
  for (const n of g.nodes) {
    if (roles.has(n.id) && n.kind !== 'function' && n.kind !== 'method') typesByFile.set(n.file, [...(typesByFile.get(n.file) ?? []), n]);
  }
  for (const n of g.nodes) {
    if ((n.kind !== 'function' && n.kind !== 'method') || roles.has(n.id)) continue;
    const owner = (typesByFile.get(n.file) ?? [])
      .filter((t) => t.span.start <= n.span.start && t.span.end >= n.span.end)
      .sort((a, b) => a.span.end - a.span.start - (b.span.end - b.span.start))[0];
    if (owner) roles.set(n.id, roles.get(owner.id)!);
  }
  return roles;
}

function trimNode(n: GraphNode, withDetail: boolean, roles?: Roles): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: n.id,
    kind: n.kind,
    name: n.name,
    qn: n.qualifiedName,
    file: n.file,
    start: n.span.start,
    end: n.span.end,
    importance: n.importance,
  };
  if (n.signature) out.sig = n.signature;
  if (withDetail && n.duties) out.duties = n.duties;
  const r = roles?.get(n.id);
  if (r && r.role !== 'unknown') out.role = r.role;
  if (r && withDetail && r.purposes.length > 0) out.purp = r.purposes;
  // Where this function hands work to another without a call edge the map
  // resolved (a mediator, a bus): the sources of its inherited duties. Names
  // only, for every callable, so an entry point is found from any change.
  const dispatch = [...new Set((n.duties ?? []).filter((d) => (d.hop ?? 0) > 0 && d.via).map((d) => d.via as string))].sort();
  if (dispatch.length > 0) out.disp = dispatch.slice(0, 8);
  if (withDetail && n.effects) {
    const e = n.effects as unknown as Record<string, number>;
    out.effects = { branches: e.branches ?? 0, loops: e.loops ?? 0, throws: e.throws ?? 0, awaits: e.awaits ?? 0 };
  }
  return out;
}

/**
 * The module reads callables and their callers, call and callback-reference
 * edges, and duties only for nodes in changed files and the functions they
 * call within two hops (a changed handler's reads and writes often run in a
 * repository it calls). Everything else stays behind, which keeps the payload
 * a fraction of the map.
 */
export function trimGraph(g: VgGraph, changedFiles: Set<string>, roles?: Roles): { nodes: unknown[]; edges: unknown[] } {
  const nodes = g.nodes.filter((n) => CALLER_KINDS.has(n.kind));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = g.edges
    .filter((e) => (e.kind === 'call' || e.kind === 'references') && ids.has(e.src) && ids.has(e.dst))
    .map((e) => ({
      kind: e.kind,
      src: e.src,
      dst: e.dst,
      res: e.resolution,
      conf: e.confidence,
      ...(e.sites ? { sites: e.sites } : {}),
      ...(e.awaited ? { awaited: true } : {}),
    }));
  const detail = new Set(nodes.filter((n) => changedFiles.has(n.file)).map((n) => n.id));
  let frontier = new Set(detail);
  for (let hop = 0; hop < 2 && frontier.size > 0; hop++) {
    const next = new Set<string>();
    for (const e of edges) {
      if (e.kind === 'call' && frontier.has(e.src) && !detail.has(e.dst)) {
        detail.add(e.dst);
        next.add(e.dst);
      }
    }
    frontier = next;
  }
  return { nodes: nodes.map((n) => trimNode(n, detail.has(n.id), roles)), edges };
}

/** True when a block passes every rule, pins included, on its own. */
function blockIsValid(block: DocBlock, resolve: PinResolver, design: boolean): boolean {
  const probe = {
    schema_version: DOC_SCHEMA,
    title: 'probe',
    target: { repo_key: null, base_sha: '', head_sha: 'probe', merge_base: null, dirty_tree_hash: null },
    sections: [{ kind: design ? 'design' : 'implementation', blocks: [design ? { ...block, primary: true } : block] }],
    groups_digest: null,
    generator: { by: 'vg', notes: [] },
  };
  return validateReviewDoc(probe, resolve).length === 0;
}

function title(block: DocBlock): string {
  return 'title' in block && typeof block.title === 'string' ? block.title : block.type;
}

/**
 * Ask the Architecture module for the diagrams and keep only what proves out.
 * Never throws: a missing or older module, or one that abstains, yields no
 * diagrams and a note saying why.
 */
export function deriveDiagrams(input: DeriveInput, provider: HaileProvider | null): DerivedDiagrams {
  if (!provider?.reviewDiagrams) {
    return { blocks: [], implementation: [], notes: [provider ? `${INSTALL_HINT} (the installed module predates review diagrams)` : INSTALL_HINT] };
  }
  const prefix = mapPrefix(input.change, input.mapRoot);
  const strip = (p: string) => (prefix && p.startsWith(`${prefix}/`) ? p.slice(prefix.length + 1) : prefix ? null : p);
  const changed = new Set(
    input.change.files.map((f) => strip(f.path.replace(/\\/g, '/'))).filter((p): p is string => p !== null),
  );
  const payload = {
    head: trimGraph(input.head, changed, rolesOf(input.head, input.sidecar)),
    base: input.base ? trimGraph(input.base, changed) : null,
    prefix,
    ...(input.mode === 'explain' ? { mode: 'explain' } : {}),
    models: input.models ?? [],
    ...(input.overview
      ? {
          overview: {
            packages: input.overview.packages.map((p) => ({ id: p.id, name: p.name, path: p.path, lane: p.lane, job: p.job })),
            edges: input.overview.edges.map((e) => ({ src: e.src, dst: e.dst, kind: e.kind, weight: e.weight })),
          },
          system: input.system ?? '',
        }
      : {}),
    files: input.change.files.map((f) => ({
      path: f.path.replace(/\\/g, '/'),
      op: f.op,
      hunks: f.hunks.map((h) => [h.start, h.end]),
    })),
  };
  let raw: ReturnType<NonNullable<HaileProvider['reviewDiagrams']>> = null;
  try {
    raw = provider.reviewDiagrams(payload);
  } catch {
    raw = null;
  }
  if (!raw) return { blocks: [], implementation: [], notes: ['the Architecture module could not derive diagrams for this change'] };

  const notes = [...raw.notes];
  const blocks: DocBlock[] = [];
  for (const b of raw.blocks as DocBlock[]) {
    if (blockIsValid(b, input.resolve, true)) blocks.push({ ...b, primary: blocks.length === 0 } as DocBlock);
    else notes.push(`"${title(b)}" was left out because its pins do not land — rebuild the code map with \`vg\` and run again`);
  }
  const implementation: DocBlock[] = [];
  for (const b of raw.contract as DocBlock[]) {
    if (blockIsValid(b, input.resolve, false)) implementation.push(b);
    else notes.push('a signature change was left out because its pins do not land');
  }
  // The fold is shown only where every pin it carries lands on the change.
  const fold = new Map<string, string>();
  let unfolded = 0;
  for (const f of raw.fold ?? []) {
    const probe = validateReviewDoc(
      { schema_version: DOC_SCHEMA, title: 'fold', target: { base_sha: '', head_sha: 'x' }, sections: [{ kind: 'implementation', blocks: [{ type: 'markdown', text: f.text }] }], generator: { by: 'vg', notes: [] } },
      input.resolve,
    );
    if (probe.length === 0) fold.set(f.path, f.text);
    else unfolded += 1;
  }
  if (unfolded > 0) notes.push(`${unfolded === 1 ? 'one file was' : `${unfolded} files were`} left unfolded because the code map no longer matches it — rebuild it with \`vg\``);
  return { blocks, implementation, notes, ...(fold.size > 0 ? { fold } : {}) };
}
