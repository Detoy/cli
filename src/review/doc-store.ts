/**
 * Saved review documents an agent or a person can edit, block by block.
 *
 * `vg review doc` writes a document and forgets it. This module keeps one per
 * scope (the change, or one VG Code chat) under `.vibgrate/review-docs/`, with
 * every version kept, so an agent can open it, patch a block by id, check it,
 * and a reader can see who wrote what and go back to any earlier version.
 *
 * Rules, enforced here rather than trusted to the caller:
 *
 *   - A patch is atomic. Every operation applies, and the whole document then
 *     passes the same validation `vg review doc --check` runs (schema, section
 *     order, one primary diagram, every pin lands on the reviewed change), or
 *     nothing is saved and the issues come back.
 *   - Provenance cannot be forged. Text an agent writes is marked
 *     `origin: "agent"`. A diagram element keeps `origin: "graph"` only when it
 *     is unchanged from what vg derived; anything new or edited becomes
 *     `agent`, whatever the patch claimed.
 *   - Writes never lose work. A patch or a restore adds a version; nothing is
 *     overwritten. Two writers are kept apart by the version number: a patch
 *     names the version it was written against, and a stale one is refused.
 *   - The store holds only Vibgrate's own state, never the repository's files.
 *
 * Retention (GUARDRAILS §1.7): a review document is derived from the source
 * plus words written about it, so it inherits the **Repository** schedule
 * (365 days). A document not updated for 365 days is deleted the next time
 * any document is saved.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureVibgrateGitignore } from '../engine/artifacts.js';
import { buildDocument, resolveScope, scopeResolver, type BuildOptions, type DocScope, type ResolvedScope } from './doc-build.js';
import {
  blockId,
  SECTION_ORDER,
  sealReviewDoc,
  targetIssues,
  validateReviewDoc,
  type DocBlock,
  type DocIssue,
  type DocSection,
  type PinResolver,
  type ReviewDoc,
  type SectionKind,
} from './doc.js';

export const STORE_SCHEMA = 'vg.review.docstore.v1' as const;
/** Repository retention (GUARDRAILS §1.7): 365 days since the last update. */
export const RETENTION_DAYS = 365;
/** Operations one patch may carry. */
export const MAX_OPS = 50;
/** Versions kept per document; the oldest go first, the current never. */
export const MAX_VERSIONS = 200;

export interface VersionEntry {
  version: number;
  at: string;
  by: 'vg' | 'agent';
  /** What this version did, in a few words: "built", "3 operations", "restored version 2". */
  summary: string;
  digest: string;
}

export interface StoreMeta {
  schema: typeof STORE_SCHEMA;
  doc_id: string;
  scope: DocScope;
  current: number;
  updated_at: string;
  versions: VersionEntry[];
}

export type Clock = () => Date;
const systemClock: Clock = () => new Date();

export function storeDir(mainRoot: string): string {
  return path.join(mainRoot, '.vibgrate', 'review-docs');
}

/** One document per scope: the same scope always opens the same document. */
export function docIdFor(scope: DocScope): string {
  const key =
    scope.kind === 'change'
      ? `change\0${scope.base ?? ''}\0${scope.in_place ? 1 : 0}`
      : `session\0${scope.session}\0${scope.base ?? ''}`;
  return `rd_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
}

function validId(id: string): boolean {
  return /^rd_[0-9a-f]{12}$/.test(id);
}

function docDir(mainRoot: string, id: string): string {
  if (!validId(id)) throw new Error(`not a review document id: ${id}`);
  return path.join(storeDir(mainRoot), id);
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function readMeta(mainRoot: string, id: string): StoreMeta | null {
  if (!validId(id)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(docDir(mainRoot, id), 'meta.json'), 'utf8')) as StoreMeta;
    return meta.schema === STORE_SCHEMA && meta.doc_id === id ? meta : null;
  } catch {
    return null;
  }
}

export function readVersion(mainRoot: string, id: string, version: number): ReviewDoc | null {
  if (!validId(id) || !Number.isInteger(version) || version < 1) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(docDir(mainRoot, id), `v${version}.json`), 'utf8')) as ReviewDoc;
  } catch {
    return null;
  }
}

/** Every saved document, newest first. */
export function listDocuments(mainRoot: string): StoreMeta[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(storeDir(mainRoot));
  } catch {
    return [];
  }
  return names
    .map((n) => (validId(n) ? readMeta(mainRoot, n) : null))
    .filter((m): m is StoreMeta => m !== null)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/** Delete documents past the retention window. Best-effort; never throws. */
export function pruneExpired(mainRoot: string, now: Date): string[] {
  const cutoff = now.getTime() - RETENTION_DAYS * 86_400_000;
  const removed: string[] = [];
  for (const m of listDocuments(mainRoot)) {
    if (Date.parse(m.updated_at) < cutoff) {
      try {
        fs.rmSync(docDir(mainRoot, m.doc_id), { recursive: true, force: true });
        removed.push(m.doc_id);
      } catch {
        /* next save tries again */
      }
    }
  }
  return removed;
}

export class VersionConflict extends Error {
  constructor(readonly current: number) {
    super(`the document is at version ${current}`);
  }
}

/**
 * Save `doc` as the next version. `expect` is the version the writer read;
 * a writer that read an older one gets a VersionConflict and nothing is
 * written. The version file is created exclusively, so two writers racing on
 * the same number cannot both win.
 */
function saveVersion(
  mainRoot: string,
  scope: DocScope,
  doc: ReviewDoc,
  by: 'vg' | 'agent',
  summary: string,
  expect: number | null,
  clock: Clock,
): { doc: ReviewDoc; version: number } {
  const id = docIdFor(scope);
  const dir = docDir(mainRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  // Saved documents are working state, never part of the change they describe.
  ensureVibgrateGitignore(mainRoot);
  const meta = readMeta(mainRoot, id);
  const current = meta?.current ?? 0;
  if (expect !== null && expect !== current) throw new VersionConflict(current);
  const version = current + 1;
  const at = clock().toISOString();
  const sealed = sealReviewDoc({ ...doc, revision: { doc_id: id, version, by, at } });
  try {
    fs.writeFileSync(path.join(dir, `v${version}.json`), `${JSON.stringify(sealed, null, 2)}\n`, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new VersionConflict(version);
    throw err;
  }
  const versions = [...(meta?.versions ?? []), { version, at, by, summary, digest: sealed.digest ?? '' }];
  // Bound the history; the current version is always kept.
  while (versions.length > MAX_VERSIONS) {
    const old = versions.shift()!;
    fs.rmSync(path.join(dir, `v${old.version}.json`), { force: true });
  }
  writeAtomic(path.join(dir, 'meta.json'), `${JSON.stringify({ schema: STORE_SCHEMA, doc_id: id, scope, current: version, updated_at: at, versions } satisfies StoreMeta, null, 2)}\n`);
  pruneExpired(mainRoot, clock());
  return { doc: sealed, version };
}

// ─── Patch operations ───────────────────────────────────────────────────────

export type PatchOp =
  | { op: 'set_title'; title: string }
  | { op: 'set_text'; block: string; text: string }
  | { op: 'insert'; section: SectionKind; block: DocBlock; after?: string; at?: 'start' | 'end' }
  | { op: 'replace'; block: string; with: DocBlock }
  | { op: 'remove'; block: string }
  | { op: 'move'; block: string; section: SectionKind; after?: string; at?: 'start' | 'end' }
  | { op: 'set_primary'; block: string };

export interface PatchResult {
  doc: ReviewDoc;
  /** Operation-level problems (unknown block, wrong type). Any one rejects the patch. */
  errors: string[];
  /** Things vg changed about what the agent sent, so it knows (e.g. origin it may not claim). */
  notes: string[];
}

const DIAGRAMS = new Set(['flow', 'sequence', 'call_stack_diff', 'data_store', 'system_map', 'code_peek']);
const TEXT_BLOCKS = new Set(['markdown', 'callout']);

type Obj = Record<string, unknown>;

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Obj)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function sameIgnoringOrigin(a: Obj, b: Obj): boolean {
  const { origin: _a, ...ra } = a;
  const { origin: _b, ...rb } = b;
  return stableStringify(ra) === stableStringify(rb);
}

/** The element arrays of each diagram type, and how an element is recognised across versions. */
const ELEMENT_LISTS: Record<string, { key: string; identity: (e: Obj) => string }[]> = {
  flow: [
    { key: 'nodes', identity: (e) => `n:${String(e.key)}` },
    { key: 'edges', identity: (e) => `e:${String(e.from)}>${String(e.to)}:${String(e.kind ?? '')}` },
  ],
  sequence: [{ key: 'steps', identity: (e) => `s:${String(e.from)}>${String(e.to)}:${String(e.label)}` }],
  call_stack_diff: [
    { key: 'base', identity: (e) => `b:${String(e.key ?? stableStringify(e.pin))}` },
    { key: 'head', identity: (e) => `h:${String(e.key ?? stableStringify(e.pin))}` },
  ],
  system_map: [
    { key: 'elements', identity: (e) => `m:${String(e.path)}` },
    { key: 'relationships', identity: (e) => `r:${String(e.from)}>${String(e.to)}:${String(e.kind)}` },
  ],
};

/**
 * Mark what the agent wrote. Text blocks become `origin: "agent"`. A diagram
 * element stays `graph` only when the block it replaces has the same element,
 * unchanged, derived by vg; every other element is `agent`. Returns how many
 * elements claimed `graph` and were not allowed to.
 */
function markAgent(next: DocBlock, prev: DocBlock | null): { block: DocBlock; refused: number } {
  const b = JSON.parse(JSON.stringify(next)) as Obj;
  delete b.id;
  let refused = 0;
  const lists = ELEMENT_LISTS[String(b.type)];
  if (!lists) {
    if (!(prev && sameIgnoringOrigin(b, prev as unknown as Obj) && (prev as { origin?: string }).origin !== 'agent')) {
      if (b.origin === 'graph') refused += 1;
      b.origin = 'agent';
    }
    return { block: b as unknown as DocBlock, refused };
  }
  for (const { key, identity } of lists) {
    const items = Array.isArray(b[key]) ? (b[key] as unknown[]) : [];
    const before = new Map<string, Obj>();
    if (prev && prev.type === next.type) {
      for (const e of ((prev as unknown as Obj)[key] as Obj[] | undefined) ?? []) before.set(identity(e), e);
    }
    b[key] = items.map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const e = { ...(raw as Obj) };
      const old = before.get(identity(e));
      const derived = old && old.origin === 'graph' && sameIgnoringOrigin(old, e);
      if (!derived) {
        if (e.origin === 'graph') refused += 1;
        e.origin = 'agent';
      } else {
        e.origin = 'graph';
      }
      return e;
    });
  }
  return { block: b as unknown as DocBlock, refused };
}

function findBlock(doc: ReviewDoc, id: string): { section: DocSection; index: number } | null {
  for (const section of doc.sections) {
    const index = section.blocks.findIndex((b) => b.id === id);
    if (index >= 0) return { section, index };
  }
  return null;
}

function sectionFor(doc: ReviewDoc, kind: SectionKind): DocSection {
  let s = doc.sections.find((x) => x.kind === kind);
  if (!s) {
    s = { kind, blocks: [] };
    doc.sections.push(s);
    doc.sections.sort((a, b) => SECTION_ORDER.indexOf(a.kind) - SECTION_ORDER.indexOf(b.kind));
  }
  return s;
}

function place(section: DocSection, block: DocBlock, after: string | undefined, at: 'start' | 'end' | undefined): string | null {
  if (after) {
    const i = section.blocks.findIndex((b) => b.id === after);
    if (i < 0) return `no block ${after} in ${section.kind}`;
    section.blocks.splice(i + 1, 0, block);
  } else if (at === 'start') {
    section.blocks.unshift(block);
  } else {
    section.blocks.push(block);
  }
  return null;
}

function freshId(doc: ReviewDoc, block: DocBlock): string {
  const taken = new Set(doc.sections.flatMap((s) => s.blocks.map((b) => b.id)));
  const base = blockId(block);
  let id = base;
  for (let n = 1; taken.has(id); n++) id = `${base}_${n}`;
  return id;
}

/**
 * Apply operations to a copy of `doc`. Pure: no disk, no git. The caller
 * validates the result before saving it.
 */
export function applyPatch(doc: ReviewDoc, ops: unknown): PatchResult {
  const out = JSON.parse(JSON.stringify(doc)) as ReviewDoc;
  const errors: string[] = [];
  let refused = 0;
  if (!Array.isArray(ops) || ops.length === 0) return { doc: out, errors: ['ops must be a non-empty array'], notes: [] };
  if (ops.length > MAX_OPS) return { doc: out, errors: [`at most ${MAX_OPS} operations per patch`], notes: [] };
  const sectionOk = (k: unknown): k is SectionKind => typeof k === 'string' && (SECTION_ORDER as readonly string[]).includes(k);
  const blockOk = (b: unknown): b is DocBlock => !!b && typeof b === 'object' && typeof (b as Obj).type === 'string';

  ops.forEach((raw, i) => {
    const op = (raw ?? {}) as Obj;
    const at = `ops[${i}] (${String(op.op)})`;
    const target = typeof op.block === 'string' ? findBlock(out, op.block) : null;
    switch (op.op) {
      case 'set_title':
        if (typeof op.title !== 'string' || !op.title.trim()) errors.push(`${at}: title must be a non-empty string`);
        else out.title = op.title.trim().slice(0, 200);
        return;
      case 'set_text': {
        if (!target) return void errors.push(`${at}: no block ${String(op.block)}`);
        const b = target.section.blocks[target.index];
        if (!TEXT_BLOCKS.has(b.type)) return void errors.push(`${at}: ${b.type} blocks have no text; use replace`);
        if (typeof op.text !== 'string') return void errors.push(`${at}: text must be a string`);
        target.section.blocks[target.index] = { ...b, text: op.text, origin: 'agent' } as DocBlock;
        return;
      }
      case 'insert': {
        if (!sectionOk(op.section)) return void errors.push(`${at}: section must be one of ${SECTION_ORDER.join(', ')}`);
        if (!blockOk(op.block)) return void errors.push(`${at}: block must be an object with a type`);
        const marked = markAgent(op.block, null);
        refused += marked.refused;
        const block = { ...marked.block, id: freshId(out, marked.block) } as DocBlock;
        const problem = place(sectionFor(out, op.section), block, typeof op.after === 'string' ? op.after : undefined, op.at === 'start' ? 'start' : undefined);
        if (problem) errors.push(`${at}: ${problem}`);
        return;
      }
      case 'replace': {
        if (!target) return void errors.push(`${at}: no block ${String(op.block)}`);
        if (!blockOk(op.with)) return void errors.push(`${at}: with must be an object with a type`);
        const prev = target.section.blocks[target.index];
        const marked = markAgent(op.with, prev);
        refused += marked.refused;
        // The id stays, so anything that referred to the block still does.
        target.section.blocks[target.index] = { ...marked.block, id: prev.id } as DocBlock;
        return;
      }
      case 'remove':
        if (!target) return void errors.push(`${at}: no block ${String(op.block)}`);
        target.section.blocks.splice(target.index, 1);
        return;
      case 'move': {
        if (!target) return void errors.push(`${at}: no block ${String(op.block)}`);
        if (!sectionOk(op.section)) return void errors.push(`${at}: section must be one of ${SECTION_ORDER.join(', ')}`);
        const [b] = target.section.blocks.splice(target.index, 1);
        const problem = place(sectionFor(out, op.section), b, typeof op.after === 'string' ? op.after : undefined, op.at === 'start' ? 'start' : undefined);
        if (problem) errors.push(`${at}: ${problem}`);
        return;
      }
      case 'set_primary': {
        if (!target) return void errors.push(`${at}: no block ${String(op.block)}`);
        if (target.section.kind !== 'design') return void errors.push(`${at}: only a design block can be primary`);
        if (!DIAGRAMS.has(target.section.blocks[target.index].type)) return void errors.push(`${at}: only a diagram can be primary`);
        target.section.blocks = target.section.blocks.map((b, j) => {
          const { primary: _p, ...rest } = b as DocBlock & { primary?: boolean };
          return (j === target.index ? { ...rest, primary: true } : rest) as DocBlock;
        });
        return;
      }
      default:
        errors.push(`${at}: unknown op — use set_title, set_text, insert, replace, remove, move or set_primary`);
    }
  });

  out.sections = out.sections.filter((s) => s.blocks.length > 0);
  // A design section whose only diagram is not marked primary: it is the primary.
  const design = out.sections.find((s) => s.kind === 'design');
  if (design) {
    const diagrams = design.blocks.filter((b) => DIAGRAMS.has(b.type));
    if (diagrams.length === 1 && !diagrams.some((b) => (b as { primary?: boolean }).primary)) {
      (diagrams[0] as { primary?: boolean }).primary = true;
    }
  }
  if (out.generator.by === 'vg') out.generator = { ...out.generator, by: 'mixed' };
  const notes = refused > 0 ? [`${refused} element${refused === 1 ? '' : 's'} marked origin "graph" ${refused === 1 ? 'is' : 'are'} new or changed, not what vg derived, so ${refused === 1 ? 'it is' : 'they are'} recorded as "agent"`] : [];
  return { doc: out, errors, notes };
}

// ─── The operations an agent or the CLI calls ───────────────────────────────

export interface Outline {
  title: string;
  sections: { kind: SectionKind; blocks: { id: string; type: string; title?: string; primary?: boolean; origin?: string; chars: number }[] }[];
}

/** A compact map of the document: what an agent needs to address blocks without reading them all. */
export function outline(doc: ReviewDoc): Outline {
  return {
    title: doc.title,
    sections: doc.sections.map((s) => ({
      kind: s.kind,
      blocks: s.blocks.map((b) => {
        const o = b as DocBlock & { title?: string; primary?: boolean; origin?: string; caption?: string };
        return {
          id: b.id ?? '',
          type: b.type,
          ...(o.title || o.caption ? { title: o.title ?? o.caption } : {}),
          ...(o.primary ? { primary: true } : {}),
          ...(o.origin ? { origin: o.origin } : {}),
          chars: JSON.stringify(b).length,
        };
      }),
    })),
  };
}

export interface OpenResult {
  doc_id: string;
  version: number;
  doc: ReviewDoc;
  /** True when this call built a new version from the change (first open, `fresh`, or the change moved). */
  built: boolean;
  /** Why the saved version was not reused, when it was not. */
  reason?: string;
}

/**
 * Open the document for a scope. The saved one is returned while it still
 * describes the change; otherwise (none saved, `fresh`, or the commits moved)
 * vg builds the deterministic first pass and saves it as a new version, so the
 * earlier versions stay in the history.
 */
export async function openDocument(
  mainRoot: string,
  scope: DocScope,
  o: BuildOptions & { fresh?: boolean; clock?: Clock } = {},
): Promise<OpenResult> {
  const clock = o.clock ?? systemClock;
  const resolved = resolveScope(mainRoot, scope);
  const id = docIdFor(resolved.scope);
  const meta = readMeta(mainRoot, id);
  if (meta && !o.fresh) {
    const saved = readVersion(mainRoot, id, meta.current);
    if (saved) {
      const stale = targetIssues(saved, resolved.change);
      if (stale.length === 0) return { doc_id: id, version: meta.current, doc: saved, built: false };
      const built = await buildDocument(mainRoot, resolved.scope, o);
      const saved2 = saveVersion(mainRoot, resolved.scope, built.doc, 'vg', 'rebuilt: the change moved', null, clock);
      return { doc_id: id, version: saved2.version, doc: saved2.doc, built: true, reason: stale[0].message };
    }
  }
  const built = await buildDocument(mainRoot, resolved.scope, o);
  const saved = saveVersion(mainRoot, resolved.scope, built.doc, 'vg', meta ? 'rebuilt on request' : 'built', null, clock);
  return { doc_id: id, version: saved.version, doc: saved.doc, built: true };
}

function current(mainRoot: string, id: string): { meta: StoreMeta; doc: ReviewDoc } {
  const meta = readMeta(mainRoot, id);
  const doc = meta ? readVersion(mainRoot, id, meta.current) : null;
  if (!meta || !doc) throw new Error(`no saved review document ${id} — open one first`);
  return { meta, doc };
}

/** Issues with a document against the change as it is now: target, schema, and every pin. */
/**
 * Check a document against the change. A multi-repo document's pins in other
 * repositories are checked against `others` (their checkouts, keyed by repo
 * key, from `--also`); a repository with no checkout given is named in one
 * issue rather than failing every pin in it.
 */
export function checkAgainstChange(doc: ReviewDoc, resolved: ResolvedScope, others: ReadonlyMap<string, PinResolver> = new Map()): DocIssue[] {
  const byId = new Map<string, PinResolver>();
  const missing: DocIssue[] = [];
  for (const [i, r] of (doc.repos ?? []).entries()) {
    const resolver = others.get(r.repo_key);
    if (resolver) byId.set(r.id, resolver);
    else missing.push({ path: `$.repos[${i}]`, code: 'repo_not_checked', message: `pins in ${r.id} were not checked — pass --also <its checkout> to check them` });
  }
  const own = scopeResolver(resolved);
  // A repository with no checkout given is reported once above, so its pins are not
  // each failed here: they are treated as landing (any line count), never as checked.
  const issues = validateReviewDoc(doc, (side, p, repo) =>
    !repo ? own(side, p) : byId.has(repo) ? byId.get(repo)!(side, p) : Number.MAX_SAFE_INTEGER,
  );
  return [...targetIssues(doc, resolved.change), ...missing, ...issues];
}

export function checkDocument(mainRoot: string, id: string): { doc_id: string; version: number; valid: boolean; issues: DocIssue[] } {
  const { meta, doc } = current(mainRoot, id);
  const issues = checkAgainstChange(doc, resolveScope(mainRoot, meta.scope));
  return { doc_id: id, version: meta.current, valid: issues.length === 0, issues };
}

/**
 * What a reader should see for a scope: the saved document when one still
 * describes the change, else a fresh build. Reading never saves; only an
 * explicit open or an agent's patch writes to the store.
 */
export async function savedOrBuilt(
  mainRoot: string,
  scope: DocScope,
  o: BuildOptions = {},
): Promise<{ doc: ReviewDoc; saved: { doc_id: string; version: number } | null; note?: string }> {
  const resolved = resolveScope(mainRoot, scope);
  const id = docIdFor(resolved.scope);
  const meta = readMeta(mainRoot, id);
  const saved = meta ? readVersion(mainRoot, id, meta.current) : null;
  if (meta && saved) {
    const stale = targetIssues(saved, resolved.change);
    if (stale.length === 0) return { doc: saved, saved: { doc_id: id, version: meta.current } };
    const built = await buildDocument(mainRoot, resolved.scope, o);
    return { doc: built.doc, saved: null, note: `saved document ${id} (version ${meta.current}) was written for an earlier commit — ${stale[0].message}` };
  }
  return { doc: (await buildDocument(mainRoot, resolved.scope, o)).doc, saved: null };
}

export type PatchOutcome =
  | { ok: true; doc_id: string; version: number; doc: ReviewDoc; notes: string[] }
  | { ok: false; doc_id: string; version: number; conflict?: boolean; errors: string[]; issues: DocIssue[] };

/**
 * Apply a patch written against version `expect`. All or nothing: an unknown
 * block, an invalid result or a pin that does not land saves nothing and says
 * exactly why.
 */
export function patchDocument(mainRoot: string, id: string, expect: number, ops: unknown, clock: Clock = systemClock): PatchOutcome {
  const { meta, doc } = current(mainRoot, id);
  if (expect !== meta.current) {
    return { ok: false, doc_id: id, version: meta.current, conflict: true, errors: [`written against version ${expect}; the document is at version ${meta.current} — read it again and reapply`], issues: [] };
  }
  const result = applyPatch(doc, ops);
  if (result.errors.length > 0) return { ok: false, doc_id: id, version: meta.current, errors: result.errors, issues: [] };
  const issues = checkAgainstChange(result.doc, resolveScope(mainRoot, meta.scope));
  if (issues.length > 0) return { ok: false, doc_id: id, version: meta.current, errors: [], issues };
  try {
    const n = Array.isArray(ops) ? ops.length : 0;
    const saved = saveVersion(mainRoot, meta.scope, result.doc, 'agent', `${n} operation${n === 1 ? '' : 's'}`, expect, clock);
    return { ok: true, doc_id: id, version: saved.version, doc: saved.doc, notes: result.notes };
  } catch (err) {
    if (err instanceof VersionConflict) {
      return { ok: false, doc_id: id, version: err.current, conflict: true, errors: ['another writer saved first — read the document again and reapply'], issues: [] };
    }
    throw err;
  }
}

/** Make an earlier version current again, as a new version. History is never rewritten. */
export function restoreVersion(mainRoot: string, id: string, version: number, clock: Clock = systemClock): PatchOutcome {
  const { meta } = current(mainRoot, id);
  const old = readVersion(mainRoot, id, version);
  if (!old) return { ok: false, doc_id: id, version: meta.current, errors: [`no version ${version} of ${id}`], issues: [] };
  const issues = checkAgainstChange(old, resolveScope(mainRoot, meta.scope));
  if (issues.length > 0) return { ok: false, doc_id: id, version: meta.current, errors: [`version ${version} no longer matches the change`], issues };
  const { revision: _r, digest: _d, ...body } = old;
  const prior = meta.versions.find((v) => v.version === version);
  const saved = saveVersion(mainRoot, meta.scope, body as ReviewDoc, prior?.by ?? 'agent', `restored version ${version}`, meta.current, clock);
  return { ok: true, doc_id: id, version: saved.version, doc: saved.doc, notes: [] };
}

export function documentHistory(mainRoot: string, id: string): { doc_id: string; scope: DocScope; current: number; versions: VersionEntry[] } {
  const { meta } = current(mainRoot, id);
  return { doc_id: id, scope: meta.scope, current: meta.current, versions: [...meta.versions].reverse() };
}

export function getDocument(mainRoot: string, id: string, version?: number): { doc_id: string; version: number; doc: ReviewDoc } {
  const { meta, doc } = current(mainRoot, id);
  if (version === undefined || version === meta.current) return { doc_id: id, version: meta.current, doc };
  const old = readVersion(mainRoot, id, version);
  if (!old) throw new Error(`no version ${version} of ${id}`);
  return { doc_id: id, version, doc: old };
}
