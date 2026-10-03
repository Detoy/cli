/**
 * The explain view: a review document for code as it is, not for a change.
 * `vg show <name> --diagram` and the VS Code "Show diagrams" command both
 * build it here.
 *
 * The symbol's own span stands in for a change, so the Architecture module
 * derives the same diagrams it derives for a review (how the code is reached,
 * its flow, the data it reads and writes, where it sits). The module gets
 * `mode: "explain"`, so nothing is marked new or edited and the call path has
 * no before side. The text around the diagrams is graph facts only: what the
 * symbol is, where it lives, and its pinned callers and callees.
 */

import * as path from 'node:path';
import { resolveGraphPath } from '../engine/artifacts.js';
import { overviewOf } from '../engine/chart/server.js';
import { readHaileSidecar } from '../engine/haile/sidecar.js';
import type { HaileProvider } from '../engine/haile/haile-provider.js';
import { indexFor } from '../engine/relations.js';
import type { GraphNode, VgGraph } from '../schema.js';
import { readDataModels } from './data-models.js';
import { deriveDiagrams, mapPrefix, rolesOf } from './derive.js';
import {
  DOC_SCHEMA,
  makePinResolver,
  mdEscape,
  pinLink,
  plural,
  sealReviewDoc,
  validateReviewDoc,
  withIds,
  type DocBlock,
  type DocSection,
  type PinResolver,
  type ReviewDoc,
} from './doc.js';
import { defaultRun, gitTopLevel, isGitRepo, normalizeRemote, repoKey, type ChangeSet, type GitRunner } from './git.js';

/** Callers and callees listed under implementation, each. */
export const MAX_LISTED = 12;

export interface ExplainOptions {
  /** Directory the code map was built from. */
  root: string;
  graph: VgGraph;
  node: GraphNode;
  graphPath?: string;
  provider: HaileProvider | null;
  run?: GitRunner;
}

export interface BuiltExplainDoc {
  doc: ReviewDoc;
  resolve: PinResolver;
}

/** A change whose one "edit" is the symbol's span, read from the working tree. */
export function explainChange(root: string, node: GraphNode, run: GitRunner = defaultRun): ChangeSet {
  const git = isGitRepo(root, run);
  const topLevel = git ? gitTopLevel(root, run) : root;
  const prefix = path.relative(topLevel, root).split(path.sep).join('/');
  const rel = node.file.replace(/\\/g, '/');
  const head = git ? run(['rev-parse', 'HEAD'], root).stdout.trim() : '';
  const remoteRaw = git ? run(['config', '--get', 'remote.origin.url'], root) : null;
  const sha = head || 'working-tree';
  return {
    topLevel,
    baseSha: sha,
    headSha: sha,
    mergeBase: null,
    ref: null,
    dirty: false,
    dirtyTreeHash: null,
    files: [
      {
        path: prefix && prefix !== '.' ? `${prefix}/${rel}` : rel,
        op: 'modified',
        addedLines: 0,
        removedLines: 0,
        hunks: [{ start: node.span.start, end: Math.max(node.span.start, node.span.end) }],
      },
    ],
    remote: remoteRaw && remoteRaw.status === 0 ? normalizeRemote(remoteRaw.stdout) : null,
  };
}

function dedupe(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
}

/** Build and validate the explain document for one symbol. */
export function buildExplainDoc(o: ExplainOptions): BuiltExplainDoc {
  const { root, graph, node } = o;
  const run = o.run ?? defaultRun;
  const change = explainChange(root, node, run);
  const sides = { inPlace: true };
  const resolve = makePinResolver(change, sides, run);
  const prefix = mapPrefix(change, root);
  const repoPath = (file: string) => (prefix ? `${prefix}/${file.replace(/\\/g, '/')}` : file.replace(/\\/g, '/'));
  /** `name` linked to its declaration when the pin lands, else plain code. */
  const linked = (n: GraphNode) => {
    const p = repoPath(n.file);
    const lines = resolve('head', p);
    const end = Math.max(n.span.start, n.span.end);
    // A link label stays plain text: renderers do not format inside it.
    return lines !== null && n.span.start >= 1 && end <= lines
      ? `[${n.qualifiedName.replace(/[[\]`]/g, '')}](${pinLink({ side: 'head', path: p, start: n.span.start, end })})`
      : `\`${n.qualifiedName.replace(/`/g, "'")}\``;
  };

  const sidecar = readHaileSidecar(resolveGraphPath(root, o.graphPath));
  const index = indexFor(graph);
  const callers = dedupe(index.callers(node.id).map((x) => x.node));
  const callees = dedupe(index.callees(node.id).map((x) => x.node));
  const area = graph.areas.find((a) => a.id === node.area);
  const role = rolesOf(graph, sidecar).get(node.id);

  const what: string[] = [`${linked(node)} is a ${node.kind} in \`${repoPath(node.file)}\`.`];
  if (node.signature) what.push('', `\`${node.signature.replace(/`/g, "'").replace(/\s+/g, ' ')}\``);
  const facts: string[] = [];
  if (role && role.role !== 'unknown') facts.push(`architecture role: ${role.role.replace(/_/g, ' ')}`);
  if (area) facts.push(`area: ${mdEscape(area.label)}`);
  facts.push(`${plural(callers.length, 'caller')}, ${plural(callees.length, 'callee')}`);
  if (node.tested !== undefined) facts.push(node.tested ? 'reached by tests' : 'not reached by tests');
  what.push('', facts.join(' · '));

  const models = readDataModels(change, sides, run);
  const overview = sidecar ? overviewOf(graph, sidecar, o.provider) : null;
  const system = change.remote ? (change.remote.split('/').pop() ?? '') : path.basename(change.topLevel);
  const design = deriveDiagrams(
    { change, head: graph, base: null, mapRoot: root, resolve, models, sidecar, overview, system, mode: 'explain' },
    o.provider,
  );

  const list = (heading: string, nodes: GraphNode[]): DocBlock | null => {
    if (nodes.length === 0) return null;
    const lines = [`**${heading}** (${nodes.length})`, '', ...nodes.slice(0, MAX_LISTED).map((n) => `- ${linked(n)}`)];
    if (nodes.length > MAX_LISTED) lines.push(`- +${nodes.length - MAX_LISTED} more — \`vg show ${node.qualifiedName}\` lists them`);
    return { type: 'markdown', text: lines.join('\n') };
  };
  const impl = [list('Called by', callers), list('Calls', callees)].filter((b): b is DocBlock => b !== null);

  const sections: DocSection[] = [{ kind: 'what_why', title: 'What it is', blocks: withIds([{ type: 'markdown', text: what.join('\n') }]) }];
  if (design.blocks.length > 0) sections.push({ kind: 'design', title: 'How it works', blocks: withIds(design.blocks) });
  if (impl.length > 0) sections.push({ kind: 'implementation', title: 'Callers and callees', blocks: withIds(impl) });

  const notes = ['explains the code as it is in the working tree; nothing here is a change', ...design.notes];
  const doc = sealReviewDoc({
    schema_version: DOC_SCHEMA,
    kind: 'explain',
    title: `Explain: ${node.qualifiedName}`.slice(0, 300),
    target: {
      repo_key: repoKey(change.remote, change.topLevel),
      base_sha: change.baseSha,
      head_sha: change.headSha,
      merge_base: null,
      dirty_tree_hash: null,
    },
    sections,
    groups_digest: null,
    generator: { by: 'vg', notes },
  });
  const issues = validateReviewDoc(doc, resolve);
  if (issues.length > 0) {
    throw new Error(`internal: generated explain document failed validation — ${issues[0].path}: ${issues[0].message}`);
  }
  return { doc, resolve };
}
