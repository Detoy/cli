/**
 * Build a review document for a scope: the one pipeline behind `vg review
 * doc`, `vg review groups --session` and the `review_doc` MCP tool, so the
 * three can never disagree about what a change contains.
 *
 * A scope is either the change (working tree vs HEAD, or HEAD against a base
 * ref) or one VG Code session. Resolving it gives the checkout to read, the
 * change set, and the pin resolver; building runs grouping, the deterministic
 * findings and the graph-derived diagrams when a code map exists, and the
 * session's provenance for a session scope. vg never returns a document that
 * fails its own validation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveGraphPath } from '../engine/artifacts.js';
import { overviewOf } from '../engine/chart/server.js';
import { readHaileSidecar } from '../engine/haile/sidecar.js';
import { loadHaileProvider } from '../engine/haile/haile-provider.js';
import { loadGraph } from '../engine/load.js';
import { CliError, ExitCode } from '../util/exit.js';
import { buildBaseGraph, type BaseGraphResult } from './base-graph.js';
import { readDataModels } from './data-models.js';
import { deriveDiagrams, type DerivedDiagrams } from './derive.js';
import { buildReviewDoc, makePinResolver, validateReviewDoc, type PinResolver, type ReviewDoc } from './doc.js';
import { collectChangeSet, defaultRun, isGitRepo, repoKey, type ChangeSet } from './git.js';
import { collectGroupSignals, groupChangeSet, type DiffGroups } from './groups.js';
import { runReview, type RunReviewResult } from './run.js';
import { resolveReviewSession, scopeChangeToSession, sessionBlocks, type ReviewSession, type ScopedChange } from './session.js';

/** What a document covers. `latest` is resolved to a concrete session id before a document is saved. */
export type DocScope =
  | { kind: 'change'; base: string | null; in_place: boolean }
  | { kind: 'session'; session: string; base?: string | null };

export interface ResolvedScope {
  /** The scope with `latest` replaced by the session it named. */
  scope: DocScope;
  /** The checkout the change is read from (a worktree for a worktree chat). */
  root: string;
  /** The change, already narrowed to the session's files for a session scope. */
  change: ChangeSet;
  /** The options git and the pin resolver read the two sides with. */
  sides: { base?: string; inPlace?: boolean };
  session: { review: ReviewSession; scoped: ScopedChange } | null;
}

function requireChange(root: string, sides: { base?: string; inPlace?: boolean }): ChangeSet {
  if (!isGitRepo(root)) {
    throw new CliError(`\`vg review\` needs a git repository — ${root} is not one (or git is not on PATH)`, ExitCode.USAGE_ERROR);
  }
  return collectChangeSet(root, sides.base, defaultRun, { inPlace: sides.inPlace });
}

/** Turn a scope into a checkout, a change and its sides. Throws a CliError the caller can show as is. */
export function resolveScope(mainRoot: string, scope: DocScope): ResolvedScope {
  if (scope.kind === 'change') {
    const sides = { base: scope.base ?? undefined, inPlace: scope.in_place || undefined };
    return { scope, root: mainRoot, change: requireChange(mainRoot, sides), sides, session: null };
  }
  const rs = resolveReviewSession(mainRoot, scope.session);
  if ('error' in rs) throw new CliError(rs.error, ExitCode.NOT_FOUND);
  const resolved: DocScope = { kind: 'session', session: rs.session.id, ...(scope.base && !rs.base ? { base: scope.base } : {}) };
  if (rs.base) {
    if (!fs.existsSync(rs.root)) {
      throw new CliError(
        `session ${rs.session.id} ran in worktree ${rs.session.worktree?.id ?? ''}, which no longer exists — after Apply, review the main tree with \`vg review doc\``,
        ExitCode.NOT_FOUND,
      );
    }
    // A worktree chat's change is everything since the worktree branched, committed or not.
    const sides = { base: rs.base, inPlace: true };
    const scoped = scopeChangeToSession(requireChange(rs.root, sides), rs);
    return { scope: resolved, root: rs.root, change: scoped.change, sides, session: { review: rs, scoped } };
  }
  // A chat in the main tree: its uncommitted work, or with a base ref, its commits too.
  const sides = scope.base ? { base: scope.base, inPlace: true } : {};
  const scoped = scopeChangeToSession(requireChange(mainRoot, sides), rs);
  return { scope: resolved, root: mainRoot, change: scoped.change, sides, session: { review: rs, scoped } };
}

export function scopeResolver(r: ResolvedScope): PinResolver {
  return makePinResolver(r.change, r.sides);
}

export interface BuildOptions {
  findings?: boolean;
  diagrams?: boolean;
  baseGraph?: boolean;
  graphPath?: string;
  generatedAt?: string;
  /** Progress lines for a person watching (the CLI's stderr); omitted for MCP. */
  log?: (line: string) => void;
}

export interface BuiltDocument {
  doc: ReviewDoc;
  groups: DiffGroups;
  resolved: ResolvedScope;
  resolve: PinResolver;
}

/** The deterministic document for a scope, validated. */
export async function buildDocument(mainRoot: string, scope: DocScope, o: BuildOptions = {}): Promise<BuiltDocument> {
  const resolved = resolveScope(mainRoot, scope);
  const { root, change, sides } = resolved;
  const resolve = scopeResolver(resolved);
  const provider = await loadHaileProvider();
  const groups = groupChangeSet(change, collectGroupSignals(change, sides), provider);
  let reviewed: RunReviewResult | null = null;
  // Findings and diagrams need the code map. Use one that exists; never build
  // one here — the document is still useful without them, and says so.
  const head = change.files.length > 0 && (o.findings !== false || o.diagrams !== false) ? loadGraph(root, o.graphPath) : null;
  if (o.findings !== false && head) {
    reviewed = await runReview({
      root,
      base: sides.base,
      inPlace: sides.inPlace,
      local: true,
      offline: true,
      graphPath: o.graphPath,
      generatedAt: o.generatedAt,
      signingKey: null,
      change,
    });
  }
  let design: DerivedDiagrams | null = null;
  if (o.diagrams !== false && head) {
    let base: BaseGraphResult | null = null;
    if (o.baseGraph) {
      o.log?.('building the code map at the base commit…');
      base = await buildBaseGraph(change, root);
      o.log?.(base.graph ? `base code map built in ${(base.ms / 1000).toFixed(1)}s` : `base code map not built: ${base.reason}`);
    }
    const models = readDataModels(change, sides);
    // The architecture the module already projected for `vg show arch`:
    // packages become the map's containers, roles its components.
    const sidecar = readHaileSidecar(resolveGraphPath(root, o.graphPath));
    const overview = sidecar ? overviewOf(head, sidecar, provider) : null;
    const system = change.remote ? (change.remote.split('/').pop() ?? '').replace(/\.git$/, '') : path.basename(change.topLevel);
    design = deriveDiagrams({ change, head, base: base?.graph ?? null, mapRoot: root, resolve, models, sidecar, overview, system }, provider);
    if (base && !base.graph) design.notes.unshift(`the base code map was not built: ${base.reason}`);
  } else if (o.diagrams !== false && change.files.length > 0) {
    design = { blocks: [], implementation: [], notes: ['no code map was found, so no diagram was derived — run `vg` first'] };
  }
  const doc = buildReviewDoc({
    change,
    groups,
    repoKey: repoKey(change.remote, change.topLevel),
    resolve,
    findings: reviewed ? reviewed.receipt.findings : null,
    capsule: reviewed ? reviewed.capsule : null,
    design,
    session: resolved.session ? sessionBlocks(resolved.session.review, resolved.session.scoped, resolve) : null,
  });
  const issues = validateReviewDoc(doc, resolve);
  if (issues.length > 0) {
    // vg must never emit a document that fails its own rules.
    throw new CliError(`internal: generated review document failed validation — ${issues[0].path}: ${issues[0].message}`, ExitCode.ERROR);
  }
  return { doc, groups, resolved, resolve };
}
