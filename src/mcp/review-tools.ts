/**
 * `review_doc` — an agent writes the review document for a change, over MCP.
 *
 * One tool with an `op` argument, listed only under `vg serve --review`
 * (`VG_REVIEW=1`): a default `vg serve` lists exactly the tools it did before,
 * because every listed schema is billed on every agent step
 * (IDE-INTEGRATION-PLAN §2, FEATURE-DESIGN-PRINCIPLES P2).
 *
 * A thin adapter: every rule (one document per scope, atomic patches, version
 * checks, provenance that cannot be forged, pins checked against the change,
 * retention) lives in `review/doc-store.ts`, shared with `vg review doc`, so
 * the CLI and the tool cannot disagree.
 *
 * Annotations: it writes only Vibgrate's own state (`.vibgrate/review-docs/`),
 * never the repository, and every write adds a version rather than replacing
 * one, so nothing an agent does here can lose work: `readOnlyHint: false`,
 * `destructiveHint: false`, as for `compress_content` and `memory_save`.
 * `openWorldHint: true` because ops `comments` and `reply` read and answer
 * the comments people left on the pushed document in Vibgrate Cloud.
 */

import type { DocScope } from '../review/doc-build.js';
import type { ReviewDoc } from '../review/doc.js';
import {
  checkDocument,
  documentHistory,
  getDocument,
  MAX_OPS,
  openDocument,
  outline,
  patchDocument,
  restoreVersion,
} from '../review/doc-store.js';
import type { VgTool } from './tools.js';
import { cloudDsn, fetchComments, replyToComment, targetOf } from '../review/doc-comments.js';

/** Inline the whole document only below this size; above it the outline plus `get` by block keeps every result inside the token budget. */
const INLINE_DOC_CHARS = 60_000;

const DESCRIPTION = [
  'Write the review document for a change: what and why, requirements, one primary design diagram, implementation — every claim about code pinned to lines.',
  'Order: (1) op "open" (the change, or `session` for a VG Code chat) and read the outline; (2) write what and why first (set_text on its first block);',
  '(3) add requirements from the task; (4) add or correct diagrams — pin every node to code as {side:"head"|"base", path, start, end}, or link text as [label](head:path#L10-L24);',
  '(5) op "check" and re-read before you finish.',
  'Patches are all or nothing and name the version they were written against; a pin that does not land, or a stale version, saves nothing and says why.',
  'Whatever you write is recorded as origin "agent"; only unchanged graph-derived elements stay "graph".',
  'After the document is pushed (`vg review doc --push`), op "comments" lists what people asked on its blocks in Vibgrate Cloud, and op "reply" answers a thread (comment_id, text); replies are shown as written by an agent.',
].join(' ');

const PIN = {
  type: 'object',
  properties: {
    side: { type: 'string', enum: ['base', 'head'] },
    path: { type: 'string' },
    start: { type: 'integer', minimum: 1 },
    end: { type: 'integer', minimum: 1 },
  },
  required: ['side', 'path', 'start', 'end'],
};

const SCHEMA = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: ['open', 'get', 'patch', 'check', 'history', 'restore', 'comments', 'reply'] },
    doc_id: { type: 'string', description: 'from open (rd_…); required for every op but open' },
    base: { type: 'string', description: 'open: review HEAD against the merge-base with this ref (default: working tree vs HEAD)' },
    in_place: { type: 'boolean', description: 'open: with base, include the working tree' },
    session: { type: 'string', description: 'open: a VG Code chat id, or "latest" — only the files it touched, its requests as requirements' },
    fresh: { type: 'boolean', description: 'open: rebuild from the change as a new version instead of reusing the saved one' },
    base_graph: { type: 'boolean', description: 'open: also map the base commit for before/after call paths (slower)' },
    block: { type: 'string', description: 'get: return one block by id' },
    comment_id: { type: 'string', description: 'reply: the comment (rdc_…) to answer, from op "comments"' },
    text: { type: 'string', description: 'reply: your answer, plain text, at most 4000 characters' },
    version: { type: 'integer', minimum: 1, description: 'patch: the version you read (required); get/restore: which version' },
    ops: {
      type: 'array',
      maxItems: MAX_OPS,
      description:
        'patch: [{op:"set_text",block,text} | {op:"insert",section,block,after?|at?:"start"} | {op:"replace",block,with} | {op:"remove",block} | {op:"move",block,section,after?} | {op:"set_primary",block} | {op:"set_title",title}]. section: what_why | requirements | design | implementation. Block types: markdown, callout{tone,text,pins?}, code_peek{pin,caption?}, flow{title,nodes[{key,label,kind?,pins}],edges[{from,to,label?,kind?}]}, sequence{title,actors,steps[{from,to,label,pins|note}]}, call_stack_diff, data_store, system_map, divider.',
      items: { type: 'object' },
    },
  },
  required: ['op'],
  additionalProperties: false,
  $defs: { pin: PIN },
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** The document, or only its outline when inlining it would crowd the agent's context. */
function view(doc_id: string, version: number, doc: ReviewDoc): Record<string, unknown> {
  const json = JSON.stringify(doc);
  return {
    doc_id,
    version,
    outline: outline(doc),
    ...(json.length <= INLINE_DOC_CHARS ? { doc } : { doc: null, hint: `the document is ${json.length} characters; read blocks with op "get" and block <id>` }),
  };
}

function scopeFrom(args: Record<string, unknown>): DocScope {
  const session = str(args.session);
  const base = str(args.base) ?? null;
  return session ? { kind: 'session', session, base } : { kind: 'change', base, in_place: args.in_place === true };
}

async function run(root: string, args: Record<string, unknown>): Promise<unknown> {
  const op = str(args.op);
  if (op === 'open') {
    const opened = await openDocument(root, scopeFrom(args), { fresh: args.fresh === true, baseGraph: args.base_graph === true });
    return { ...view(opened.doc_id, opened.version, opened.doc), built: opened.built, ...(opened.reason ? { rebuilt_because: opened.reason } : {}) };
  }
  const id = str(args.doc_id);
  if (!id) return { error: 'bad_request', message: `op "${op ?? ''}" needs doc_id — call op "open" first` };
  const version = typeof args.version === 'number' ? args.version : undefined;
  switch (op) {
    case 'get': {
      const got = getDocument(root, id, version);
      const block = str(args.block);
      if (!block) return view(got.doc_id, got.version, got.doc);
      for (const s of got.doc.sections) {
        const b = s.blocks.find((x) => x.id === block);
        if (b) return { doc_id: id, version: got.version, section: s.kind, block: b };
      }
      return { error: 'not_found', message: `no block ${block} in version ${got.version}`, outline: outline(got.doc) };
    }
    case 'patch': {
      if (version === undefined) return { error: 'bad_request', message: 'patch needs version: the version you read' };
      const res = patchDocument(root, id, version, args.ops);
      if (!res.ok) return { saved: false, ...res };
      return { saved: true, notes: res.notes, ...view(res.doc_id, res.version, res.doc) };
    }
    case 'check':
      return checkDocument(root, id);
    case 'history':
      return documentHistory(root, id);
    case 'restore': {
      if (version === undefined) return { error: 'bad_request', message: 'restore needs version' };
      const res = restoreVersion(root, id, version);
      if (!res.ok) return { saved: false, ...res };
      return { saved: true, ...view(res.doc_id, res.version, res.doc) };
    }
    case 'comments': {
      // The pushed copy of this document: same repository, head and base.
      const { doc } = getDocument(root, id);
      const { title, threads } = await fetchComments(cloudDsn(), targetOf(doc));
      return { doc_id: id, title, open: threads.filter((t) => !t.resolved), resolved: threads.filter((t) => t.resolved).length };
    }
    case 'reply': {
      const commentId = str(args.comment_id);
      const text = str(args.text);
      if (!commentId || !text) return { error: 'bad_request', message: 'reply needs comment_id and text' };
      const { doc } = getDocument(root, id);
      return { replied: true, comment: await replyToComment(cloudDsn(), targetOf(doc), commentId, text, 'review_doc') };
    }
    default:
      return { error: 'bad_request', message: 'op must be one of open, get, patch, check, history, restore, comments, reply' };
  }
}

export const REVIEW_TOOLS: VgTool[] = [
  {
    name: 'review_doc',
    description: DESCRIPTION,
    inputSchema: SCHEMA,
    // It reads the code map itself when one exists, and works without one.
    graphless: true,
    // comments and reply reach Vibgrate Cloud with the workspace DSN.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    handler: async (_graph, args, ctx) => {
      try {
        return await run(ctx.root, args);
      } catch (err) {
        return { error: 'review_doc_failed', message: (err as Error).message };
      }
    },
  },
];
