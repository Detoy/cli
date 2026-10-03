/**
 * Multi-repo review documents: `vg review doc --also ../client` for a change
 * that spans repositories (an API and the client that calls it).
 *
 * Each repository's document is built on its own, from its own checkout, code
 * map and diff, exactly as `vg review doc` builds it there. The others are
 * then folded into the first: their blocks join the same four sections under
 * a heading naming the repository, and every pin they carry is tagged with
 * that repository's id (`pin.repo`, `head@<id>:path#L1` in text), so each pin
 * is still checked against the repository it came from. The first document
 * keeps its primary diagram; the others' diagrams stay, not primary.
 */

import * as path from 'node:path';
import { REPO_ID, sealReviewDoc, withIds, type DocBlock, type DocRepo, type DocSection, type PinResolver, type ReviewDoc, type SectionKind } from './doc.js';

export interface AlsoSpec {
  /** The other checkout, as given. */
  dir: string;
  /** `--also <dir>=<ref>`: review it against this base instead of the document's own. */
  base: string | null;
}

/** `../client` or `../client=origin/main`. */
export function parseAlso(spec: string): AlsoSpec {
  const eq = spec.lastIndexOf('=');
  if (eq > 0) return { dir: spec.slice(0, eq), base: spec.slice(eq + 1) || null };
  return { dir: spec, base: null };
}

/** A short id for a repository: the remote's last segment or the directory name, made link-safe and unique. */
export function repoId(name: string | null, dir: string, taken: ReadonlySet<string>): string {
  const raw = (name?.split('/').pop() || path.basename(path.resolve(dir)) || 'repo').toLowerCase();
  let id = raw.replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 32) || 'repo';
  if (!REPO_ID.test(id)) id = 'repo';
  let out = id;
  for (let n = 2; taken.has(out); n += 1) out = `${id}-${n}`;
  return out;
}

const LINK = /\]\((base|head)(@[a-z0-9][a-z0-9_.-]*)?:/g;

/** A copy of a block with every pin, and every pin link in its text, naming `repo`. */
export function tagBlock(block: DocBlock, repo: string): DocBlock {
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key === 'text' ? v.replace(LINK, (_m, side: string) => `](${side}@${repo}:`) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const isPin = (o.side === 'base' || o.side === 'head') && typeof o.path === 'string' && typeof o.start === 'number';
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) {
        if (k === 'id') continue; // ids are re-derived after the merge
        out[k] = walk(x, k);
      }
      if (isPin) out.repo = repo;
      return out;
    }
    return v;
  };
  const tagged = walk(block) as DocBlock;
  if ('primary' in tagged && (tagged as { primary?: boolean }).primary) (tagged as { primary?: boolean }).primary = false;
  return tagged;
}

export interface OtherDoc {
  id: string;
  name: string | null;
  doc: ReviewDoc;
}

function heading(o: OtherDoc): DocBlock {
  return { type: 'markdown', text: `**In ${o.name ?? o.id}** (\`${o.id}\`)` };
}

/**
 * The first document, with the others folded in, re-sealed. Notes from the
 * others are kept, prefixed with their repository.
 */
export function mergeDocuments(primary: ReviewDoc, others: OtherDoc[]): ReviewDoc {
  if (others.length === 0) return primary;
  const sections = new Map<SectionKind, DocBlock[]>();
  const titles = new Map<SectionKind, string | undefined>();
  for (const s of primary.sections) {
    sections.set(s.kind, s.blocks.map((b) => ({ ...b })));
    titles.set(s.kind, s.title);
  }
  for (const o of others) {
    for (const s of o.doc.sections) {
      const blocks = s.blocks.map((b) => tagBlock(b, o.id));
      if (blocks.length === 0) continue;
      const into = sections.get(s.kind) ?? [];
      into.push(heading(o), ...blocks);
      sections.set(s.kind, into);
    }
  }
  const order: SectionKind[] = ['what_why', 'requirements', 'design', 'implementation'];
  // Ids are unique across the document, not per section: assign them in one pass.
  const kinds = order.filter((k) => (sections.get(k)?.length ?? 0) > 0);
  const flat = withIds(kinds.flatMap((k) => (sections.get(k) ?? []).map(({ id: _id, ...b }) => b as DocBlock)));
  let at = 0;
  const merged: DocSection[] = kinds.map((k) => {
    const n = sections.get(k)?.length ?? 0;
    const blocks = flat.slice(at, at + n);
    at += n;
    return { kind: k, ...(titles.get(k) ? { title: titles.get(k) } : {}), blocks };
  });
  // A design section that only the others filled has no primary diagram: promote its first diagram.
  const design = merged.find((s) => s.kind === 'design');
  if (design && !design.blocks.some((b) => (b as { primary?: boolean }).primary)) {
    const first = design.blocks.find((b) => ['flow', 'sequence', 'call_stack_diff', 'data_store', 'system_map', 'code_peek'].includes(b.type));
    if (first) (first as { primary?: boolean }).primary = true;
  }
  const repos: DocRepo[] = others.map((o) => ({
    id: o.id,
    name: o.name,
    repo_key: o.doc.target.repo_key ?? '',
    base_sha: o.doc.target.base_sha,
    head_sha: o.doc.target.head_sha,
    merge_base: o.doc.target.merge_base,
    dirty_tree_hash: o.doc.target.dirty_tree_hash,
  }));
  const notes = [...primary.generator.notes, ...others.flatMap((o) => o.doc.generator.notes.map((n) => `${o.id}: ${n}`))];
  const by = [primary, ...others.map((o) => o.doc)].some((d) => d.generator.by !== 'vg') ? 'mixed' : 'vg';
  const { digest: _drop, ...body } = primary;
  return sealReviewDoc({
    ...body,
    title: `${primary.title} + ${others.map((o) => o.id).join(', ')}`.slice(0, 300),
    sections: merged,
    repos,
    generator: { by, notes },
  });
}

/** One resolver for the merged document: a pin's `repo` picks the repository it is read from. */
export function multiResolver(primary: PinResolver, others: ReadonlyMap<string, PinResolver>): PinResolver {
  return (side, p, repo) => (repo ? (others.get(repo)?.(side, p) ?? null) : primary(side, p));
}
