/**
 * Review document — `vg.review.doc.v1`.
 *
 * A structured, reader-ordered explanation of one change: what and why,
 * requirements, design (exactly one primary diagram), implementation. It is
 * built from typed blocks — prose, code peeks, flow diagrams, sequence
 * diagrams, call-stack diffs, data-store views and system maps — so the same
 * document renders as Markdown on a pull request, in a terminal, or on a
 * canvas, and an agent can patch one node or edge at a time by id.
 *
 * The evidence rule is enforced here, not left to the author: every claim
 * about real code carries a pin (`side`, `path`, line range), and a pin that
 * does not land on the file it names is an error, never a fuzzy match. Every
 * diagram element records its origin — `graph` when vg derived it, `agent`
 * when a model or a person drew it — so a reader can always tell the two apart.
 *
 * This module is pure: validation takes a resolver for line counts, building
 * takes the change set and groups. No clock, no randomness, sorted output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultRun, type ChangeSet, type GitRunner } from './git.js';
import type { DiffGroups } from './groups.js';
import { headIsWorkingTree, READ_KINDS } from './groups.js';
import { digest, type AnalysisCapsule, type ReviewFinding, type ReviewFindings } from './schemas.js';

export const DOC_SCHEMA = 'vg.review.doc.v1' as const;

// ─── Shapes ─────────────────────────────────────────────────────────────────

export type PinSide = 'base' | 'head';

/** A repo-relative, 1-based, inclusive line range on one side of the change. */
export interface Pin {
  side: PinSide;
  path: string;
  start: number;
  end: number;
  /** In a multi-repo document, the `repos[].id` the path belongs to; omitted means the document's own repository. */
  repo?: string;
}

/** Another repository a multi-repo document covers (`vg review doc --also`). */
export interface DocRepo {
  /** Short id pins name (`repo`) and links use (`head@<id>:path#L1`). */
  id: string;
  /** `owner/repo` when the remote names one. */
  name: string | null;
  repo_key: string;
  base_sha: string;
  head_sha: string;
  merge_base: string | null;
  dirty_tree_hash: string | null;
}

/** A repos[].id: lowercase, short, safe in a link. */
export const REPO_ID = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

/** Who produced a diagram element. */
export type Origin = 'graph' | 'agent';

export type ChangeStatus = 'added' | 'removed' | 'modified' | 'unchanged';

export interface MarkdownBlock {
  type: 'markdown';
  id?: string;
  /** Who wrote the text: absent or `graph` when vg did, `agent` when a model or a person did. */
  origin?: Origin;
  /** Inline evidence links use `[label](head:path#L10-L24)` or `base:`. */
  text: string;
}

export interface CalloutBlock {
  type: 'callout';
  id?: string;
  origin?: Origin;
  tone: 'note' | 'warning' | 'risk';
  text: string;
  pins?: Pin[];
}

export interface CodePeekBlock {
  type: 'code_peek';
  id?: string;
  origin?: Origin;
  pin: Pin;
  caption?: string;
  primary?: boolean;
}

export interface DividerBlock {
  type: 'divider';
  id?: string;
}

export interface FlowNode {
  key: string;
  label: string;
  description?: string;
  kind?: 'process' | 'decision' | 'terminal';
  /** Code that backs the node. Omit only for start/exit nodes no code backs. */
  pins?: Pin[];
  status?: ChangeStatus;
  origin?: Origin;
  /** Swimlane: an actor, package, or policy column. */
  lane?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  /** `branch_true` / `branch_false` leave a decision; `error` and `async` render dashed. */
  kind?: 'call' | 'callback' | 'async' | 'error' | 'branch_true' | 'branch_false' | 'loop' | 'return';
  status?: ChangeStatus;
  origin?: Origin;
}

export interface FlowBlock {
  type: 'flow';
  id?: string;
  title: string;
  description?: string;
  direction?: 'right' | 'down';
  primary?: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface SequenceStep {
  from: string;
  to: string;
  label: string;
  style?: 'call' | 'return' | 'async';
  pins?: Pin[];
  /** An explanation, for a step no single span of code shows. */
  note?: string;
  origin?: Origin;
}

export interface SequenceBlock {
  type: 'sequence';
  id?: string;
  title: string;
  primary?: boolean;
  actors: { key: string; label: string }[];
  steps: SequenceStep[];
}

export interface StackFrame {
  /** Aligns a frame across base and head, so a moved frame still compares. */
  key?: string;
  parent_key?: string;
  label?: string;
  pin: Pin;
  call_site?: Pin;
  /** Supporting code (initializers, constants) that shares the frame but adds no edge. */
  context?: Pin[];
  via?: { kind: 'call' | 'async' | 'queue' | 'callback' | 'rpc'; reason?: string };
  /** Whether the frame is new, gone, edited, or untouched by this change. */
  status?: ChangeStatus;
  origin?: Origin;
}

export interface CallStackDiffBlock {
  type: 'call_stack_diff';
  id?: string;
  title: string;
  primary?: boolean;
  /**
   * `computed`: `base` is the real before-side path. `not_computed`: nobody
   * built the base side, so an empty `base` means nothing. `absent`: the
   * target did not exist at the base commit. Omitted means `computed`.
   */
  base_status?: 'computed' | 'not_computed' | 'absent';
  base: StackFrame[];
  head: StackFrame[];
}

export interface StoreField {
  key: string;
  label: string;
  data_type: string;
  nullable?: boolean;
  primary_key?: boolean;
  references?: { store: string; collection: string; field: string };
  /** Nested fields, for document stores. */
  fields?: StoreField[];
  /** Where the field is declared (a schema file, an entity class). */
  pin?: Pin;
}

export interface DataStoreBlock {
  type: 'data_store';
  id?: string;
  /** Data-store parts carry no per-element origin; the block's says who drew it. */
  origin?: Origin;
  title: string;
  primary?: boolean;
  actors: { key: string; label: string; map_path?: string }[];
  stores: {
    key: string;
    label: string;
    storage: 'relational' | 'document';
    kind?: 'database' | 'object_store' | 'bucket' | 'artifact_store' | 'file_store';
    map_path?: string;
    /** `pin`: where the collection (table, entity, model) is declared. */
    collections: { key: string; label: string; fields: StoreField[]; pin?: Pin }[];
  }[];
  use_cases: {
    label: string;
    summary?: string;
    operations: {
      kind: 'read' | 'write';
      store: string;
      collection: string;
      /** Dotted for nested document fields: `address.city`. */
      field?: string;
      actor: string;
      label: string;
      pin: Pin;
    }[];
  }[];
}

export type MapElementType = 'person' | 'system' | 'container' | 'data_store' | 'component' | 'code';

export interface SystemMapBlock {
  type: 'system_map';
  id?: string;
  title: string;
  primary?: boolean;
  /** Dotted paths express the hierarchy: `shop.api.orders`. */
  elements: { path: string; label: string; type: MapElementType; status?: ChangeStatus; pins?: Pin[]; origin?: Origin }[];
  relationships: {
    from: string;
    to: string;
    kind: 'call' | 'semantic';
    label?: string;
    pins?: Pin[];
    status?: ChangeStatus;
    origin?: Origin;
  }[];
}

export type DocBlock =
  | MarkdownBlock
  | CalloutBlock
  | CodePeekBlock
  | DividerBlock
  | FlowBlock
  | SequenceBlock
  | CallStackDiffBlock
  | DataStoreBlock
  | SystemMapBlock;

export type SectionKind = 'what_why' | 'requirements' | 'design' | 'implementation';

/** Reading order. A section that does not earn its place is left out. */
export const SECTION_ORDER: readonly SectionKind[] = ['what_why', 'requirements', 'design', 'implementation'];

export const SECTION_TITLE: Record<SectionKind, string> = {
  what_why: 'What and why',
  requirements: 'Requirements',
  design: 'Design',
  implementation: 'Implementation',
};

export interface DocSection {
  kind: SectionKind;
  title?: string;
  blocks: DocBlock[];
}

export interface ReviewDoc {
  schema_version: typeof DOC_SCHEMA;
  /**
   * `explain`: the document explains code as it is (`vg show <name>
   * --diagram`), so nothing in it is a change and the call path has no before
   * side. Omitted means `change`.
   */
  kind?: 'change' | 'explain';
  title: string;
  target: {
    repo_key: string | null;
    base_sha: string;
    head_sha: string;
    merge_base: string | null;
    dirty_tree_hash: string | null;
  };
  sections: DocSection[];
  /** The other repositories a multi-repo document covers; pins name them with `repo`. */
  repos?: DocRepo[];
  /** The diff groups this document was written against (`grp:*` ids). */
  groups_digest: string | null;
  generator: { by: 'vg' | 'agent' | 'mixed'; notes: string[] };
  /**
   * Set when the document was saved (doc-store.ts): which saved document and
   * version this is, and who wrote that version. Covered by the digest.
   */
  revision?: { doc_id: string; version: number; by: 'vg' | 'agent'; at: string };
  /** `sha256:` over every field above. */
  digest?: string;
}

// ─── Limits ─────────────────────────────────────────────────────────────────

export const LIMITS = {
  flowNodes: 100,
  flowEdges: 300,
  sequenceSteps: 200,
  frames: 200,
  framePins: 1000,
  mapElements: 500,
  mapRelationships: 1500,
  blocks: 400,
  text: 20_000,
  repos: 8,
} as const;

const DIAGRAM_TYPES = new Set(['flow', 'sequence', 'call_stack_diff', 'data_store', 'system_map', 'code_peek']);

// ─── Pin resolution ─────────────────────────────────────────────────────────

/** Line count of `path` on `side`, or null when the file does not exist there. */
export type PinResolver = (side: PinSide, path: string, repo?: string) => number | null;

function lineCount(text: string): number {
  if (text === '') return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

const MAX_PIN_FILE_BYTES = 4 * 1024 * 1024;

/**
 * Resolve pins against the change: `base` reads the base commit, `head` reads
 * the working tree when the review is in place and the head commit otherwise
 * — the same two sides `vg review` compared.
 */
export function makePinResolver(
  change: ChangeSet,
  opts: { base?: string; inPlace?: boolean },
  run: GitRunner = defaultRun,
): PinResolver {
  const cache = new Map<string, number | null>();
  const fromTree = headIsWorkingTree(opts);
  return (side, rel, repo) => {
    // Another repository's pin cannot land in this checkout; a multi-repo check pairs each with its own.
    if (repo) return null;
    const key = `${side}\0${rel}`;
    if (cache.has(key)) return cache.get(key)!;
    let value: number | null = null;
    if (side === 'head' && fromTree) {
      try {
        const abs = path.join(change.topLevel, rel);
        const stat = fs.statSync(abs);
        if (stat.isFile() && stat.size <= MAX_PIN_FILE_BYTES) value = lineCount(fs.readFileSync(abs, 'utf8'));
      } catch {
        value = null;
      }
    } else {
      const sha = side === 'base' ? change.baseSha : change.headSha;
      if (sha) {
        const res = run(['show', `${sha}:${rel}`], change.topLevel);
        if (res.status === 0 && res.stdout.length <= MAX_PIN_FILE_BYTES) value = lineCount(res.stdout);
      }
    }
    cache.set(key, value);
    return value;
  };
}

/**
 * `head:src/a.ts#L10-L24` → a pin. Single line `#L7` is a one-line range.
 * In a multi-repo document `head@client:src/a.ts#L3` names another repository.
 */
export function parsePinLink(href: string): Pin | null {
  const m = href.match(/^(base|head)(?:@([a-z0-9][a-z0-9_.-]{0,39}))?:([^#\s]+)#L(\d+)(?:-L?(\d+))?$/);
  if (!m) return null;
  const start = Number(m[4]);
  return { side: m[1] as PinSide, path: m[3], start, end: m[5] === undefined ? start : Number(m[5]), ...(m[2] ? { repo: m[2] } : {}) };
}

export function pinLink(pin: Pin): string {
  return `${pin.side}${pin.repo ? `@${pin.repo}` : ''}:${pin.path}#L${pin.start}${pin.end !== pin.start ? `-L${pin.end}` : ''}`;
}

/** Every `[label](base:…|head:…)` link in a Markdown string, in order. */
export function markdownPinLinks(text: string): { href: string; pin: Pin | null }[] {
  const out: { href: string; pin: Pin | null }[] = [];
  const re = /\]\(((?:base|head)(?:@[a-z0-9][a-z0-9_.-]*)?:[^)\s]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ href: m[1], pin: parsePinLink(m[1]) });
  return out;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface DocIssue {
  /** JSON path into the document, e.g. `$.sections[2].blocks[0].nodes[3]`. */
  path: string;
  code: string;
  message: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

class Checker {
  readonly issues: DocIssue[] = [];
  private readonly blockIds = new Set<string>();

  constructor(
    private readonly resolve: PinResolver | null,
    /** The ids a pin may name with `repo` (a multi-repo document's `repos`). */
    private readonly repoIds: ReadonlySet<string> = new Set(),
  ) {}

  add(at: string, code: string, message: string): void {
    this.issues.push({ path: at, code, message });
  }

  str(o: Obj, key: string, at: string, opts: { required?: boolean; max?: number } = {}): void {
    const v = o[key];
    if (v === undefined) {
      if (opts.required) this.add(`${at}.${key}`, 'missing', `${key} is required`);
      return;
    }
    if (typeof v !== 'string' || (opts.required && !v.trim())) {
      this.add(`${at}.${key}`, 'type', `${key} must be a non-empty string`);
      return;
    }
    if (v.length > (opts.max ?? LIMITS.text)) this.add(`${at}.${key}`, 'too_long', `${key} exceeds ${opts.max ?? LIMITS.text} characters`);
  }

  oneOf(o: Obj, key: string, allowed: readonly string[], at: string, required = false): void {
    const v = o[key];
    if (v === undefined) {
      if (required) this.add(`${at}.${key}`, 'missing', `${key} is required`);
      return;
    }
    if (typeof v !== 'string' || !allowed.includes(v)) {
      this.add(`${at}.${key}`, 'enum', `${key} must be one of ${allowed.join(', ')}`);
    }
  }

  arr(o: Obj, key: string, at: string, opts: { min?: number; max?: number; required?: boolean } = {}): unknown[] {
    const v = o[key];
    if (v === undefined) {
      if (opts.required || (opts.min ?? 0) > 0) this.add(`${at}.${key}`, 'missing', `${key} is required`);
      return [];
    }
    if (!Array.isArray(v)) {
      this.add(`${at}.${key}`, 'type', `${key} must be an array`);
      return [];
    }
    if (opts.min !== undefined && v.length < opts.min) this.add(`${at}.${key}`, 'too_few', `${key} needs at least ${opts.min}`);
    if (opts.max !== undefined && v.length > opts.max) this.add(`${at}.${key}`, 'too_many', `${key} allows at most ${opts.max}`);
    return v;
  }

  /** A pin must be well-formed, repo-relative, and land on the file it names. */
  pin(v: unknown, at: string): void {
    if (!isObj(v)) {
      this.add(at, 'pin', 'pin must be an object { side, path, start, end }');
      return;
    }
    const { side, path: p, start, end } = v;
    if (side !== 'base' && side !== 'head') {
      this.add(`${at}.side`, 'pin', 'side must be base or head');
      return;
    }
    if (typeof p !== 'string' || !p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split(/[\\/]/).includes('..')) {
      this.add(`${at}.path`, 'pin_path', 'path must be repository-relative');
      return;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 1 || (end as number) < (start as number)) {
      this.add(at, 'pin_range', 'start and end must be integers with 1 <= start <= end');
      return;
    }
    const repo = v.repo;
    if (repo !== undefined && (typeof repo !== 'string' || !this.repoIds.has(repo))) {
      this.add(`${at}.repo`, 'pin_repo', `repo must name one of the document's repos (${[...this.repoIds].join(', ') || 'none'})`);
      return;
    }
    if (!this.resolve) return;
    const lines = this.resolve(side, p, repo as string | undefined);
    const where = repo ? `${p} in ${String(repo)}` : p;
    if (lines === null) {
      this.add(at, 'pin_missing_file', `${where} does not exist on the ${side} side`);
    } else if ((end as number) > lines) {
      this.add(at, 'pin_out_of_range', `${where} has ${lines} line${lines === 1 ? '' : 's'} on the ${side} side; the pin ends at line ${String(end)}`);
    }
  }

  pins(o: Obj, key: string, at: string, opts: { min?: number; max?: number } = {}): void {
    this.arr(o, key, at, { max: opts.max ?? LIMITS.framePins, min: opts.min }).forEach((p, i) => this.pin(p, `${at}.${key}[${i}]`));
  }

  markdown(text: unknown, at: string): void {
    if (typeof text !== 'string') return;
    for (const link of markdownPinLinks(text)) {
      if (!link.pin) this.add(at, 'pin_link', `malformed evidence link ${link.href} — use head:path#L10-L24`);
      else this.pin(link.pin, `${at}<${link.href}>`);
    }
  }

  origin(o: Obj, at: string): void {
    this.oneOf(o, 'origin', ['graph', 'agent'], at);
  }

  status(o: Obj, at: string): void {
    this.oneOf(o, 'status', ['added', 'removed', 'modified', 'unchanged'], at);
  }

  uniqueKeys(items: unknown[], key: string, at: string, label: string): Set<string> {
    const keys = new Set<string>();
    items.forEach((item, i) => {
      if (!isObj(item)) {
        this.add(`${at}[${i}]`, 'type', `${label} must be an object`);
        return;
      }
      const k = item[key];
      if (!nonEmpty(k)) {
        this.add(`${at}[${i}].${key}`, 'missing', `${label} ${key} is required`);
        return;
      }
      if (keys.has(k)) this.add(`${at}[${i}].${key}`, 'duplicate_key', `duplicate ${label} ${key} ${k}`);
      keys.add(k);
    });
    return keys;
  }

  block(b: unknown, at: string): boolean {
    if (!isObj(b)) {
      this.add(at, 'type', 'block must be an object');
      return false;
    }
    if (b.id !== undefined) {
      if (!nonEmpty(b.id)) this.add(`${at}.id`, 'type', 'id must be a non-empty string');
      else if (this.blockIds.has(b.id)) this.add(`${at}.id`, 'duplicate_id', `duplicate block id ${b.id}`);
      else this.blockIds.add(b.id);
    }
    if (b.primary !== undefined && typeof b.primary !== 'boolean') this.add(`${at}.primary`, 'type', 'primary must be a boolean');
    if (b.primary === true && !DIAGRAM_TYPES.has(String(b.type))) {
      this.add(`${at}.primary`, 'primary_type', `a ${String(b.type)} block cannot be the primary diagram`);
    }
    switch (b.type) {
      case 'markdown':
        this.str(b, 'text', at, { required: true });
        this.markdown(b.text, `${at}.text`);
        this.origin(b, at);
        break;
      case 'callout':
        this.origin(b, at);
        this.oneOf(b, 'tone', ['note', 'warning', 'risk'], at, true);
        this.str(b, 'text', at, { required: true });
        this.markdown(b.text, `${at}.text`);
        this.pins(b, 'pins', at);
        break;
      case 'code_peek':
        this.origin(b, at);
        this.pin(b.pin, `${at}.pin`);
        this.str(b, 'caption', at);
        break;
      case 'divider':
        break;
      case 'flow':
        this.flow(b, at);
        break;
      case 'sequence':
        this.sequence(b, at);
        break;
      case 'call_stack_diff':
        this.callStack(b, at);
        break;
      case 'data_store':
        this.origin(b, at);
        this.dataStore(b, at);
        break;
      case 'system_map':
        this.systemMap(b, at);
        break;
      default:
        this.add(`${at}.type`, 'unknown_block', `unknown block type ${String(b.type)}`);
    }
    return b.primary === true;
  }

  flow(b: Obj, at: string): void {
    this.str(b, 'title', at, { required: true });
    this.str(b, 'description', at);
    this.oneOf(b, 'direction', ['right', 'down'], at);
    const nodes = this.arr(b, 'nodes', at, { min: 1, max: LIMITS.flowNodes });
    const keys = this.uniqueKeys(nodes, 'key', `${at}.nodes`, 'node');
    const decisions = new Set<string>();
    nodes.forEach((n, i) => {
      if (!isObj(n)) return;
      const nat = `${at}.nodes[${i}]`;
      this.str(n, 'label', nat, { required: true });
      this.str(n, 'description', nat);
      this.oneOf(n, 'kind', ['process', 'decision', 'terminal'], nat);
      this.status(n, nat);
      this.origin(n, nat);
      this.str(n, 'lane', nat);
      this.pins(n, 'pins', nat);
      if (n.kind === 'decision' && typeof n.key === 'string') decisions.add(n.key);
      // The evidence rule: a process node describes code, so it must point at it.
      if ((n.kind === undefined || n.kind === 'process') && (!Array.isArray(n.pins) || n.pins.length === 0)) {
        this.add(nat, 'unpinned_node', `process node ${String(n.key)} has no pins — link the code it stands for, or mark it terminal`);
      }
    });
    const edges = this.arr(b, 'edges', at, { max: LIMITS.flowEdges });
    edges.forEach((e, i) => {
      const eat = `${at}.edges[${i}]`;
      if (!isObj(e)) {
        this.add(eat, 'type', 'edge must be an object');
        return;
      }
      for (const end of ['from', 'to'] as const) {
        if (!nonEmpty(e[end])) this.add(`${eat}.${end}`, 'missing', `${end} is required`);
        else if (!keys.has(e[end])) this.add(`${eat}.${end}`, 'dangling_edge', `no node with key ${e[end]}`);
      }
      this.str(e, 'label', eat);
      this.oneOf(e, 'kind', ['call', 'callback', 'async', 'error', 'branch_true', 'branch_false', 'loop', 'return'], eat);
      this.status(e, eat);
      this.origin(e, eat);
      if ((e.kind === 'branch_true' || e.kind === 'branch_false') && typeof e.from === 'string' && keys.has(e.from) && !decisions.has(e.from)) {
        this.add(`${eat}.kind`, 'branch_from_non_decision', `${e.kind} must leave a decision node`);
      }
    });
  }

  sequence(b: Obj, at: string): void {
    this.str(b, 'title', at, { required: true });
    const actors = this.arr(b, 'actors', at, { min: 2 });
    const keys = this.uniqueKeys(actors, 'key', `${at}.actors`, 'actor');
    actors.forEach((a, i) => isObj(a) && this.str(a, 'label', `${at}.actors[${i}]`, { required: true }));
    this.arr(b, 'steps', at, { min: 1, max: LIMITS.sequenceSteps }).forEach((s, i) => {
      const sat = `${at}.steps[${i}]`;
      if (!isObj(s)) {
        this.add(sat, 'type', 'step must be an object');
        return;
      }
      for (const end of ['from', 'to'] as const) {
        if (!nonEmpty(s[end])) this.add(`${sat}.${end}`, 'missing', `${end} is required`);
        else if (!keys.has(s[end])) this.add(`${sat}.${end}`, 'unknown_actor', `no actor with key ${s[end]}`);
      }
      this.str(s, 'label', sat, { required: true });
      this.oneOf(s, 'style', ['call', 'return', 'async'], sat);
      this.str(s, 'note', sat);
      this.origin(s, sat);
      this.pins(s, 'pins', sat);
      const pinned = Array.isArray(s.pins) && s.pins.length > 0;
      if (!pinned && !nonEmpty(s.note)) this.add(sat, 'unpinned_step', 'a step needs pins, or a note explaining why no code shows it');
    });
  }

  frames(frames: unknown[], at: string): void {
    const seen = new Set<string>();
    frames.forEach((f, i) => {
      const fat = `${at}[${i}]`;
      if (!isObj(f)) {
        this.add(fat, 'type', 'frame must be an object');
        return;
      }
      this.pin(f.pin, `${fat}.pin`);
      if (f.call_site !== undefined) this.pin(f.call_site, `${fat}.call_site`);
      this.pins(f, 'context', fat, { max: LIMITS.framePins });
      this.str(f, 'label', fat);
      this.origin(f, fat);
      this.status(f, fat);
      if (f.via !== undefined) {
        if (!isObj(f.via)) this.add(`${fat}.via`, 'type', 'via must be an object');
        else {
          this.oneOf(f.via, 'kind', ['call', 'async', 'queue', 'callback', 'rpc'], `${fat}.via`, true);
          this.str(f.via, 'reason', `${fat}.via`);
        }
      }
      if (f.parent_key !== undefined) {
        if (!nonEmpty(f.parent_key) || !seen.has(f.parent_key)) {
          this.add(`${fat}.parent_key`, 'parent_order', 'parent_key must name an earlier frame on the same side');
        }
      }
      if (f.key !== undefined) {
        if (!nonEmpty(f.key)) this.add(`${fat}.key`, 'type', 'key must be a non-empty string');
        else if (seen.has(f.key)) this.add(`${fat}.key`, 'duplicate_key', `duplicate frame key ${f.key}`);
        else seen.add(f.key);
      }
    });
  }

  callStack(b: Obj, at: string): void {
    this.str(b, 'title', at, { required: true });
    const base = this.arr(b, 'base', at, { max: LIMITS.frames, required: true });
    const head = this.arr(b, 'head', at, { max: LIMITS.frames, required: true });
    if (base.length + head.length === 0) this.add(at, 'too_few', 'a call-stack diff needs at least one frame');
    this.oneOf(b, 'base_status', ['computed', 'not_computed', 'absent'], at);
    if ((b.base_status === 'not_computed' || b.base_status === 'absent') && base.length > 0) {
      this.add(`${at}.base`, 'base_status', `base must be empty when base_status is ${b.base_status}`);
    }
    this.frames(base, `${at}.base`);
    this.frames(head, `${at}.head`);
  }

  fields(fields: unknown[], at: string, prefix: string, out: Set<string>): void {
    this.uniqueKeys(fields, 'key', at, 'field');
    fields.forEach((f, i) => {
      if (!isObj(f) || !nonEmpty(f.key)) return;
      const fat = `${at}[${i}]`;
      this.str(f, 'label', fat, { required: true });
      this.str(f, 'data_type', fat, { required: true });
      if (f.pin !== undefined) this.pin(f.pin, `${fat}.pin`);
      const dotted = prefix ? `${prefix}.${f.key}` : f.key;
      out.add(dotted);
      if (f.fields !== undefined) this.fields(this.arr(f, 'fields', fat), `${fat}.fields`, dotted, out);
    });
  }

  dataStore(b: Obj, at: string): void {
    this.str(b, 'title', at, { required: true });
    const actors = this.arr(b, 'actors', at, { min: 1 });
    const actorKeys = this.uniqueKeys(actors, 'key', `${at}.actors`, 'actor');
    const stores = this.arr(b, 'stores', at, { min: 1 });
    this.uniqueKeys(stores, 'key', `${at}.stores`, 'store');
    // store → collection → dotted field set, for resolving operations and references.
    const schema = new Map<string, Map<string, Set<string>>>();
    const refs: { at: string; ref: Obj }[] = [];
    stores.forEach((s, i) => {
      if (!isObj(s) || !nonEmpty(s.key)) return;
      const sat = `${at}.stores[${i}]`;
      this.str(s, 'label', sat, { required: true });
      this.oneOf(s, 'storage', ['relational', 'document'], sat, true);
      this.oneOf(s, 'kind', ['database', 'object_store', 'bucket', 'artifact_store', 'file_store'], sat);
      const collections = this.arr(s, 'collections', sat, { min: 1 });
      this.uniqueKeys(collections, 'key', `${sat}.collections`, 'collection');
      const colMap = new Map<string, Set<string>>();
      collections.forEach((c, j) => {
        if (!isObj(c) || !nonEmpty(c.key)) return;
        const cat = `${sat}.collections[${j}]`;
        this.str(c, 'label', cat, { required: true });
        if (c.pin !== undefined) this.pin(c.pin, `${cat}.pin`);
        const fieldSet = new Set<string>();
        const fields = this.arr(c, 'fields', cat);
        this.fields(fields, `${cat}.fields`, '', fieldSet);
        const walk = (list: unknown[], fat: string): void => {
          list.forEach((f, k) => {
            if (!isObj(f)) return;
            if (f.references !== undefined) {
              if (isObj(f.references)) refs.push({ at: `${fat}[${k}].references`, ref: f.references });
              else this.add(`${fat}[${k}].references`, 'type', 'references must be an object');
            }
            if (Array.isArray(f.fields)) walk(f.fields, `${fat}[${k}].fields`);
          });
        };
        walk(fields, `${cat}.fields`);
        colMap.set(c.key, fieldSet);
      });
      schema.set(s.key, colMap);
    });
    const resolves = (store: unknown, collection: unknown, field: unknown): string | null => {
      const cols = typeof store === 'string' ? schema.get(store) : undefined;
      if (!cols) return `no store ${String(store)}`;
      const fieldSet = typeof collection === 'string' ? cols.get(collection) : undefined;
      if (!fieldSet) return `no collection ${String(collection)} in ${String(store)}`;
      if (field !== undefined && (typeof field !== 'string' || !fieldSet.has(field))) {
        return `no field ${String(field)} in ${String(store)}.${String(collection)}`;
      }
      return null;
    };
    for (const r of refs) {
      const err = resolves(r.ref.store, r.ref.collection, r.ref.field);
      if (err) this.add(r.at, 'dangling_reference', err);
    }
    this.arr(b, 'use_cases', at, { min: 1 }).forEach((u, i) => {
      const uat = `${at}.use_cases[${i}]`;
      if (!isObj(u)) {
        this.add(uat, 'type', 'use case must be an object');
        return;
      }
      this.str(u, 'label', uat, { required: true });
      this.str(u, 'summary', uat);
      this.arr(u, 'operations', uat, { min: 1 }).forEach((o, j) => {
        const oat = `${uat}.operations[${j}]`;
        if (!isObj(o)) {
          this.add(oat, 'type', 'operation must be an object');
          return;
        }
        this.oneOf(o, 'kind', ['read', 'write'], oat, true);
        this.str(o, 'label', oat, { required: true });
        if (!nonEmpty(o.actor) || !actorKeys.has(o.actor)) this.add(`${oat}.actor`, 'unknown_actor', `no actor with key ${String(o.actor)}`);
        const err = resolves(o.store, o.collection, o.field);
        if (err) this.add(oat, 'dangling_reference', err);
        this.pin(o.pin, `${oat}.pin`);
      });
    });
  }

  systemMap(b: Obj, at: string): void {
    this.str(b, 'title', at, { required: true });
    const elements = this.arr(b, 'elements', at, { min: 1, max: LIMITS.mapElements });
    const paths = this.uniqueKeys(elements, 'path', `${at}.elements`, 'element');
    elements.forEach((e, i) => {
      if (!isObj(e) || !nonEmpty(e.path)) return;
      const eat = `${at}.elements[${i}]`;
      this.str(e, 'label', eat, { required: true });
      this.oneOf(e, 'type', ['person', 'system', 'container', 'data_store', 'component', 'code'], eat, true);
      this.status(e, eat);
      this.origin(e, eat);
      this.pins(e, 'pins', eat);
      if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(e.path)) {
        this.add(`${eat}.path`, 'map_path', 'path must be dot-separated segments of letters, digits, _ or -');
      } else if (e.path.includes('.')) {
        const parent = e.path.slice(0, e.path.lastIndexOf('.'));
        if (!paths.has(parent)) this.add(`${eat}.path`, 'map_parent', `parent ${parent} is not an element`);
      }
    });
    this.arr(b, 'relationships', at, { max: LIMITS.mapRelationships }).forEach((r, i) => {
      const rat = `${at}.relationships[${i}]`;
      if (!isObj(r)) {
        this.add(rat, 'type', 'relationship must be an object');
        return;
      }
      for (const end of ['from', 'to'] as const) {
        if (!nonEmpty(r[end]) || !paths.has(r[end])) this.add(`${rat}.${end}`, 'dangling_edge', `no element at ${String(r[end])}`);
      }
      this.oneOf(r, 'kind', ['call', 'semantic'], rat, true);
      this.str(r, 'label', rat);
      this.status(r, rat);
      this.origin(r, rat);
      this.pins(r, 'pins', rat);
    });
  }
}

/**
 * Validate a review document. Structural checks always run; pin checks run
 * when a resolver is given. Issues come back in document order, so the same
 * document always yields the same list.
 */
export function validateReviewDoc(value: unknown, resolve: PinResolver | null = null): DocIssue[] {
  if (!isObj(value)) return [{ path: '$', code: 'not_object', message: 'review document must be a JSON object' }];
  const repoIds = new Set<string>();
  const repoIssues: DocIssue[] = [];
  if (value.repos !== undefined) {
    if (!Array.isArray(value.repos) || value.repos.length > LIMITS.repos) {
      repoIssues.push({ path: '$.repos', code: 'type', message: `repos must be an array of at most ${LIMITS.repos}` });
    } else {
      value.repos.forEach((r, i) => {
        const at = `$.repos[${i}]`;
        if (!isObj(r) || typeof r.id !== 'string' || !REPO_ID.test(r.id)) {
          repoIssues.push({ path: `${at}.id`, code: 'repo_id', message: 'id must be lowercase letters, digits, ".", "_" or "-", at most 40' });
        } else if (repoIds.has(r.id)) {
          repoIssues.push({ path: `${at}.id`, code: 'duplicate_id', message: `duplicate repo id ${r.id}` });
        } else if (!nonEmpty(r.head_sha) || typeof r.base_sha !== 'string' || typeof r.repo_key !== 'string') {
          repoIssues.push({ path: at, code: 'missing', message: 'a repo needs repo_key, base_sha and head_sha' });
        } else {
          repoIds.add(r.id);
        }
      });
    }
  }
  const ck = new Checker(resolve, repoIds);
  for (const i of repoIssues) ck.add(i.path, i.code, i.message);
  if (value.schema_version !== DOC_SCHEMA) ck.add('$.schema_version', 'schema', `expected ${DOC_SCHEMA}`);
  ck.oneOf(value, 'kind', ['change', 'explain'], '$');
  ck.str(value, 'title', '$', { required: true, max: 300 });
  if (!isObj(value.target) || !nonEmpty(value.target.head_sha) || typeof value.target.base_sha !== 'string') {
    ck.add('$.target', 'missing', 'target { base_sha, head_sha } is required');
  }
  const sections = ck.arr(value, 'sections', '$', { min: 1 });
  let lastIndex = -1;
  let blockCount = 0;
  const seenKinds = new Set<string>();
  sections.forEach((s, i) => {
    const at = `$.sections[${i}]`;
    if (!isObj(s)) {
      ck.add(at, 'type', 'section must be an object');
      return;
    }
    const kind = s.kind as SectionKind;
    const idx = SECTION_ORDER.indexOf(kind);
    if (idx < 0) {
      ck.add(`${at}.kind`, 'enum', `kind must be one of ${SECTION_ORDER.join(', ')}`);
    } else if (seenKinds.has(kind)) {
      ck.add(`${at}.kind`, 'duplicate_section', `${kind} appears more than once`);
    } else if (idx < lastIndex) {
      ck.add(`${at}.kind`, 'section_order', `${kind} must come before ${SECTION_ORDER[lastIndex]}`);
    }
    seenKinds.add(kind);
    lastIndex = Math.max(lastIndex, idx);
    ck.str(s, 'title', at, { max: 300 });
    const blocks = ck.arr(s, 'blocks', at, { min: 1 });
    blockCount += blocks.length;
    let primaries = 0;
    blocks.forEach((b, j) => {
      if (ck.block(b, `${at}.blocks[${j}]`)) primaries += 1;
    });
    if (kind === 'design' && primaries !== 1) {
      ck.add(at, 'primary_diagram', `design needs exactly one primary diagram (found ${primaries})`);
    }
    if (kind !== 'design' && primaries > 0) {
      ck.add(at, 'primary_outside_design', 'only the design section carries a primary diagram');
    }
  });
  if (blockCount > LIMITS.blocks) ck.add('$.sections', 'too_many', `at most ${LIMITS.blocks} blocks per document`);
  return ck.issues;
}

/** Same document as a stale target? Pins are only meaningful against the change they were written for. */
export function targetIssues(doc: ReviewDoc, change: ChangeSet): DocIssue[] {
  const t = doc.target;
  if (!t) return [];
  if (t.base_sha !== change.baseSha || t.head_sha !== change.headSha) {
    return [
      {
        path: '$.target',
        code: 'stale_target',
        message: `written for ${t.base_sha.slice(0, 7)}..${t.head_sha.slice(0, 7)}; the change is ${change.baseSha.slice(0, 7)}..${change.headSha.slice(0, 7)} — repin before reading`,
      },
    ];
  }
  return [];
}

// ─── Building (deterministic first pass) ────────────────────────────────────

/** Content-derived block id: identical content always gets the identical id. */
export function blockId(block: DocBlock): string {
  const { id: _id, ...rest } = block as DocBlock & { id?: string };
  return `blk_${digest(rest).slice('sha256:'.length, 'sha256:'.length + 12)}`;
}

export function withIds(blocks: DocBlock[]): DocBlock[] {
  const seen = new Map<string, number>();
  return blocks.map((b) => {
    const base = blockId(b);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { ...b, id: n === 0 ? base : `${base}_${n}` };
  });
}

export const MAX_HUNK_LINKS = 6;
const MAX_PEELED_LISTED = 25;

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function mdEscape(text: string): string {
  return text.replace(/([\\[\]`*_])/g, '\\$1');
}

export interface BuildDocInput {
  change: ChangeSet;
  groups: DiffGroups;
  repoKey: string | null;
  resolve: PinResolver;
  /** Deterministic findings, when a code map was available. */
  findings?: ReviewFindings | null;
  capsule?: AnalysisCapsule | null;
  /** Diagrams derived from the code map (derive.ts): the primary first, plus implementation callouts. */
  design?: { blocks: DocBlock[]; notes: string[]; implementation?: DocBlock[]; fold?: Map<string, string> } | null;
  /**
   * The VG Code session the change came from (session.ts): a title, the why
   * and the agent's own account for what_why, and each request as a pinned
   * requirement. Its presence marks the document `generator.by: "mixed"`,
   * because it quotes the person's requests and the agent's words.
   */
  session?: { title: string; what: DocBlock[]; requirements: DocBlock[]; notes: string[] } | null;
}

function findingPins(finding: ReviewFinding, capsule: AnalysisCapsule | null | undefined, resolve: PinResolver): { pins: Pin[]; dropped: number } {
  if (!capsule) return { pins: [], dropped: 0 };
  const byId = new Map(capsule.evidence.map((e) => [e.id, e]));
  const pins: Pin[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const id of finding.evidence_ids) {
    const ev = byId.get(id);
    if (!ev?.path || !ev.start_line) continue;
    const pin: Pin = { side: 'head', path: ev.path, start: ev.start_line, end: Math.max(ev.start_line, ev.end_line ?? ev.start_line) };
    const key = pinLink(pin);
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = resolve('head', pin.path);
    // The evidence rule cuts both ways: vg never emits a pin it cannot land.
    if (lines === null || pin.end > lines) {
      dropped += 1;
      continue;
    }
    pins.push(pin);
  }
  return { pins, dropped };
}

/**
 * The deterministic first pass of a review document: what changed, grouped
 * and linked to every hunk, plus the deterministic findings with their
 * evidence pinned. It writes no "why" it cannot know and no design diagram it
 * has not derived — those sections are left for the graph-derived diagrams and
 * for the author, and the generator notes say so.
 */
export function buildReviewDoc(input: BuildDocInput): ReviewDoc {
  const { change, groups, resolve } = input;
  const notes: string[] = [];
  const fileByPath = new Map(change.files.map((f) => [f.path.replace(/\\/g, '/'), f]));
  const c = groups.counts;
  const totalAdded = groups.groups.reduce((n, g) => n + g.added_lines, 0);
  const totalRemoved = groups.groups.reduce((n, g) => n + g.removed_lines, 0);

  const impl = groups.groups.filter((g) => READ_KINDS.has(g.kind));
  const peeled = groups.groups.filter((g) => !READ_KINDS.has(g.kind));
  if (groups.note) notes.push(groups.note);

  const summary: string[] = [];
  if (c.files === 0) {
    summary.push('No reviewable changes.');
  } else {
    summary.push(
      `${plural(c.files, 'file')} changed (+${totalAdded} −${totalRemoved}) in ${plural(c.groups, 'group')}: ${plural(c.implementation_files, 'implementation file')}, ${c.peeled_files} peeled off.`,
    );
    if (impl.length > 0) {
      summary.push('');
      summary.push('Implementation, in reading order:');
      for (const g of impl) summary.push(`- ${mdEscape(g.label)} — ${plural(g.files.length, 'file')} (+${g.added_lines} −${g.removed_lines})`);
    }
    if (peeled.length > 0) {
      summary.push('');
      summary.push(`Peeled off: ${peeled.map((g) => `${g.label.toLowerCase()} (${g.files.length})`).join(', ')}.`);
    }
  }
  const whatWhy: DocBlock[] = [...(input.session?.what ?? []), { type: 'markdown', text: summary.join('\n') }];
  if (input.session) notes.push(...input.session.notes);
  else notes.push('what_why states what changed; the why is left to the author or the session that made the change');

  const implBlocks: DocBlock[] = [];
  const findings = input.findings
    ? [...input.findings.security_findings, ...input.findings.architecture_findings]
    : [];
  let droppedPins = 0;
  for (const f of findings) {
    const { pins, dropped } = findingPins(f, input.capsule, resolve);
    droppedPins += dropped;
    const tone = f.severity === 'high' || f.severity === 'critical' || f.protected_finding ? 'risk' : 'warning';
    implBlocks.push({
      type: 'callout',
      tone,
      text: `**${f.severity}** · ${mdEscape(f.claim)}${f.remediation ? `\n\n${mdEscape(f.remediation)}` : ''}\n\nFinding \`${f.id}\` — \`vg review explain ${f.id}\` shows the evidence.`,
      ...(pins.length > 0 ? { pins } : {}),
    });
  }
  if (droppedPins > 0) notes.push(`${plural(droppedPins, 'finding evidence span')} did not land on the head side and ${droppedPins === 1 ? 'was' : 'were'} left out`);
  if (input.findings === undefined || input.findings === null) notes.push('no code map was read, so deterministic findings are not included');

  for (const g of impl) {
    const lines: string[] = [`**${mdEscape(g.label)}** · ${plural(g.files.length, 'file')} (+${g.added_lines} −${g.removed_lines})`, ''];
    for (const gf of g.files) {
      const file = fileByPath.get(gf.path);
      const links: string[] = [];
      if (gf.op === 'removed') {
        const n = resolve('base', gf.path);
        if (n && n > 0) links.push(`[removed, ${plural(n, 'line')}](${pinLink({ side: 'base', path: gf.path, start: 1, end: n })})`);
      } else {
        const n = resolve('head', gf.path);
        for (const h of (file?.hunks ?? []).slice(0, MAX_HUNK_LINKS)) {
          if (n === null || h.end > n) continue;
          links.push(`[L${h.start}${h.end !== h.start ? `–${h.end}` : ''}](${pinLink({ side: 'head', path: gf.path, start: h.start, end: h.end })})`);
        }
        const more = (file?.hunks.length ?? 0) - MAX_HUNK_LINKS;
        if (more > 0) links.push(`+${more} more`);
      }
      lines.push(`- \`${gf.path}\` ${gf.op} +${gf.added_lines} −${gf.removed_lines}${links.length ? ` · ${links.join(' · ')}` : ''}`);
      // The structural fold: the file's changed functions, signatures first, long new ones folded to their steps.
      const fold = input.design?.fold?.get(gf.path);
      if (fold) lines.push(...fold.split('\n').map((l) => `  ${l}`));
    }
    implBlocks.push({ type: 'markdown', text: lines.join('\n') });
  }

  implBlocks.push(...(input.design?.implementation ?? []));

  if (peeled.length > 0) {
    const lines: string[] = ['**Peeled off** — not implementation; skim, do not review line by line.', ''];
    for (const g of peeled) {
      const listed = g.files.slice(0, MAX_PEELED_LISTED).map((f) => `\`${f.path}\``);
      const more = g.files.length - listed.length;
      lines.push(`- ${mdEscape(g.label)} (${g.files.length}): ${listed.join(', ')}${more > 0 ? `, +${more} more` : ''}`);
    }
    implBlocks.push({ type: 'markdown', text: lines.join('\n') });
  }
  const design = input.design?.blocks ?? [];
  if (input.design) notes.push(...input.design.notes);
  if (design.length === 0) notes.push('design is left out until a diagram is derived from the code map or drawn by the author');

  const sections: DocSection[] = [{ kind: 'what_why', blocks: withIds(whatWhy) }];
  if (input.session && input.session.requirements.length > 0) sections.push({ kind: 'requirements', blocks: withIds(input.session.requirements) });
  if (design.length > 0) sections.push({ kind: 'design', blocks: withIds(design) });
  if (implBlocks.length > 0) sections.push({ kind: 'implementation', blocks: withIds(implBlocks) });

  const shortRange = change.baseSha === change.headSha
    ? `working tree vs ${change.headSha.slice(0, 7)}`
    : `${change.baseSha.slice(0, 7)}..${change.headSha.slice(0, 7)}${change.dirty ? ' + working tree' : ''}`;
  const body: ReviewDoc = {
    schema_version: DOC_SCHEMA,
    title: input.session ? `${input.session.title} (${shortRange})` : `Review: ${shortRange}`,
    target: {
      repo_key: input.repoKey,
      base_sha: change.baseSha,
      head_sha: change.headSha,
      merge_base: change.mergeBase,
      dirty_tree_hash: change.dirtyTreeHash,
    },
    sections,
    groups_digest: groups.digest,
    generator: { by: input.session ? 'mixed' : 'vg', notes },
  };
  return { ...body, digest: digest(body) };
}

/** Recompute the digest after an edit (the digest never covers itself). */
export function sealReviewDoc(doc: ReviewDoc): ReviewDoc {
  const { digest: _old, ...body } = doc;
  return { ...body, digest: digest(body) };
}

// ─── Markdown rendering ─────────────────────────────────────────────────────

function pinText(pin: Pin): string {
  return `\`${pin.repo ? `${pin.repo}:` : ''}${pin.path}:${pin.start}${pin.end !== pin.start ? `-${pin.end}` : ''}\`${pin.side === 'base' ? ' (before)' : ''}`;
}

/** Evidence links become plain `path:line` references a PR comment can show. */
function renderLinks(text: string): string {
  return text.replace(/\[([^\]]*)\]\(((?:base|head)(?:@[a-z0-9][a-z0-9_.-]*)?:[^)\s]*)\)/g, (_m, label: string, href: string) => {
    const pin = parsePinLink(href);
    if (!pin) return label;
    // A hunk link (`L10–24`) already sits beside its file's path; repeating
    // the path on every link only makes the line harder to read.
    if (/^L\d/.test(label)) return `\`${label}\``;
    return `${label} (${pinText(pin)})`;
  });
}

function mermaidLabel(text: string): string {
  return `"${text.replace(/"/g, '#quot;').replace(/\n/g, ' ')}"`;
}

function mermaidId(key: string): string {
  return `n_${key.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function renderFlow(b: FlowBlock): string[] {
  const out = ['```mermaid', `flowchart ${b.direction === 'down' ? 'TD' : 'LR'}`];
  for (const n of b.nodes) {
    const id = mermaidId(n.key);
    const label = mermaidLabel(n.label);
    out.push(n.kind === 'decision' ? `  ${id}{${label}}` : n.kind === 'terminal' ? `  ${id}([${label}])` : `  ${id}[${label}]`);
  }
  for (const e of b.edges) {
    const dashed = e.kind === 'error' || e.kind === 'async' || e.kind === 'callback';
    const label = e.label ?? (e.kind === 'branch_true' ? 'yes' : e.kind === 'branch_false' ? 'no' : undefined);
    const arrow = dashed ? '-.->' : '-->';
    out.push(`  ${mermaidId(e.from)} ${arrow}${label ? `|${mermaidLabel(label)}|` : ''} ${mermaidId(e.to)}`);
  }
  for (const status of ['added', 'removed', 'modified'] as const) {
    const ids = b.nodes.filter((n) => n.status === status).map((n) => mermaidId(n.key));
    if (ids.length > 0) out.push(`  class ${ids.join(',')} ${status}`);
  }
  out.push('  classDef added stroke:#2da44e,stroke-width:2px');
  out.push('  classDef removed stroke:#cf222e,stroke-width:2px,stroke-dasharray: 4 3');
  out.push('  classDef modified stroke:#bf8700,stroke-width:2px');
  out.push('```');
  const pinned = b.nodes.filter((n) => n.pins && n.pins.length > 0);
  if (pinned.length > 0) {
    out.push('');
    for (const n of pinned) out.push(`- **${mdEscape(n.label)}** — ${n.pins!.map(pinText).join(', ')}${n.origin ? ` · ${n.origin}` : ''}`);
  }
  return out;
}

function renderSequence(b: SequenceBlock): string[] {
  const out = ['```mermaid', 'sequenceDiagram'];
  for (const a of b.actors) out.push(`  participant ${mermaidId(a.key)} as ${a.label.replace(/[\n;]/g, ' ')}`);
  for (const s of b.steps) {
    const arrow = s.style === 'return' ? '-->>' : s.style === 'async' ? '-)' : '->>';
    out.push(`  ${mermaidId(s.from)}${arrow}${mermaidId(s.to)}: ${s.label.replace(/[\n;]/g, ' ')}`);
  }
  out.push('```');
  return out;
}

function renderFrames(frames: StackFrame[]): string[] {
  const depth = new Map<string, number>();
  return frames.map((f) => {
    const d = f.parent_key ? (depth.get(f.parent_key) ?? 0) + 1 : 0;
    if (f.key) depth.set(f.key, d);
    const via = f.via && f.via.kind !== 'call' ? ` _(via ${f.via.kind})_` : '';
    const mark = f.status === 'added' ? ' _(new)_' : f.status === 'removed' ? ' _(gone)_' : f.status === 'modified' ? ' _(edited)_' : '';
    return `${'&nbsp;&nbsp;'.repeat(d)}${d > 0 ? '↳ ' : ''}${f.label ? `**${mdEscape(f.label)}** ` : ''}${pinText(f.pin)}${mark}${via}`;
  });
}

/** Appended to text an agent or a person wrote, so a reader never takes it for vg's. */
const AGENT_MARK = ' <sub>(written by an agent)</sub>';

function renderBlock(b: DocBlock, explain = false): string[] {
  switch (b.type) {
    case 'markdown':
      return [renderLinks(b.text) + (b.origin === 'agent' ? AGENT_MARK : '')];
    case 'callout': {
      const head = b.tone === 'risk' ? '[!CAUTION]' : b.tone === 'warning' ? '[!WARNING]' : '[!NOTE]';
      const body = (renderLinks(b.text) + (b.origin === 'agent' ? AGENT_MARK : '')).split('\n');
      const pins = b.pins && b.pins.length > 0 ? ['', `Evidence: ${b.pins.map(pinText).join(', ')}`] : [];
      return [`> ${head}`, ...[...body, ...pins].map((l) => (l ? `> ${l}` : '>'))];
    }
    case 'code_peek':
      return [`${b.caption ? `${mdEscape(b.caption)} — ` : ''}${pinText(b.pin)}`];
    case 'divider':
      return ['---'];
    case 'flow':
      return [`**${mdEscape(b.title)}**`, '', ...renderFlow(b)];
    case 'sequence':
      return [`**${mdEscape(b.title)}**`, '', ...renderSequence(b)];
    case 'call_stack_diff':
      // Explaining code as it is: one call path, no before side to compare.
      if (explain) return [`**${mdEscape(b.title)}**`, '', ...renderFrames(b.head).map((f) => `${f}<br>`)];
      return [
        `**${mdEscape(b.title)}**`,
        '',
        '| Before | After |',
        '| --- | --- |',
        `| ${b.base_status === 'not_computed' ? '_not computed_' : b.base_status === 'absent' ? '_did not exist_' : renderFrames(b.base).join('<br>') || '—'} | ${renderFrames(b.head).join('<br>') || '—'} |`,
      ];
    case 'data_store': {
      const out = [`**${mdEscape(b.title)}**`, ''];
      for (const s of b.stores) {
        for (const c of s.collections) {
          const keys = c.fields
            .filter((f) => f.primary_key || f.references)
            .map((f) => `\`${f.key}\`${f.primary_key ? ' (key)' : ''}${f.references ? ` → ${f.references.collection}.${f.references.field}` : ''}`);
          out.push(`- **${mdEscape(c.label)}** (${mdEscape(s.label)})${c.pin ? ` ${pinText(c.pin)}` : ''}${keys.length ? ` · ${keys.join(', ')}` : ''}`);
        }
      }
      out.push('', '| Use case | Op | Store | Collection | Field | Actor | Code |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const u of b.use_cases) {
        for (const o of u.operations) {
          out.push(`| ${mdEscape(u.label)} | ${o.kind} | ${o.store} | ${o.collection} | ${o.field ?? '—'} | ${o.actor} | ${pinText(o.pin)} |`);
        }
      }
      return out;
    }
    case 'system_map': {
      const out = [`**${mdEscape(b.title)}**`, '', '```mermaid', 'flowchart LR'];
      for (const e of b.elements) out.push(`  ${mermaidId(e.path)}[${mermaidLabel(`${e.label} · ${e.type}`)}]`);
      for (const r of b.relationships) out.push(`  ${mermaidId(r.from)} ${r.kind === 'semantic' ? '-.->' : '-->'}${r.label ? `|${mermaidLabel(r.label)}|` : ''} ${mermaidId(r.to)}`);
      out.push('```');
      return out;
    }
  }
}

/** Render for a pull request comment or a terminal: GitHub Markdown with Mermaid diagrams. */
export function renderReviewDocMarkdown(doc: ReviewDoc): string {
  const out: string[] = [`## ${mdEscape(doc.title)}`];
  if (doc.repos?.length) {
    out.push('', `Also covers: ${doc.repos.map((r) => `\`${r.id}\`${r.name ? ` (${mdEscape(r.name)})` : ''} ${r.base_sha.slice(0, 7)}..${r.head_sha.slice(0, 7)}`).join(', ')}.`);
  }
  for (const s of doc.sections) {
    out.push('', `### ${s.title ?? SECTION_TITLE[s.kind]}`);
    for (const b of s.blocks) out.push('', ...renderBlock(b, doc.kind === 'explain'));
  }
  if (doc.generator.notes.length > 0) {
    out.push('', '<sub>', ...doc.generator.notes.map((n) => `· ${n}`), '</sub>');
  }
  return `${out.join('\n')}\n`;
}
