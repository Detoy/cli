/**
 * Comments on a pushed review document, for the agent that wrote the change.
 *
 * People comment on blocks on the Review run page in Vibgrate Cloud. An agent
 * reads the open threads and answers them here (`vg review doc --comments`,
 * `--reply`, or the `review_doc` MCP tool), with the workspace DSN. Cloud
 * stores every reply sent this way as an agent's, and an agent can only
 * answer: it cannot start or resolve a thread.
 */

import { CliError, ExitCode } from '../util/exit.js';
import { parseDsn } from '../reporting/commands/push.js';
import { resolveDsn } from '../reporting/credentials.js';
import type { ReviewDoc } from './doc.js';
import { postIngest, type ParsedDsn } from './push.js';

export interface DocTarget {
  repo_key: string;
  head_sha: string;
  base_sha: string;
}

export interface DocComment {
  id: string;
  blockId: string;
  blockTitle: string | null;
  parentId: string | null;
  authorKind: 'person' | 'agent';
  authorName: string;
  body: string;
  createdAt: string;
  resolvedAt: string | null;
}

export interface DocThread {
  id: string;
  blockId: string;
  blockTitle: string | null;
  resolved: boolean;
  comments: DocComment[];
}

/** The pushed document a local one corresponds to: same repository, head and base. */
export function targetOf(doc: Pick<ReviewDoc, 'target'>): DocTarget {
  return { repo_key: doc.target.repo_key ?? '', head_sha: doc.target.head_sha, base_sha: doc.target.base_sha };
}

/** The DSN for Cloud calls, or a CliError saying how to provide one. */
export function cloudDsn(explicit?: string): ParsedDsn {
  const dsn = resolveDsn(explicit);
  if (!dsn) throw new CliError('no DSN — run `vg login`, set VIBGRATE_DSN, or pass --dsn', ExitCode.USAGE_ERROR);
  const parsed = parseDsn(dsn);
  if (!parsed) throw new CliError('invalid DSN format (expected vibgrate+https://<key>:<secret>@<host>/<workspace>)', ExitCode.USAGE_ERROR);
  return parsed;
}

function failure(res: { status: number; code?: string; detail?: string }): CliError {
  if (res.code === 'review_doc_upload_disabled') {
    return new CliError('this workspace does not accept review documents — a workspace admin can turn on Review documents in Vibgrate Cloud settings', ExitCode.ERROR);
  }
  if (res.code === 'review_doc_not_found') {
    return new CliError('no review document was pushed for this change — run `vg review doc --base <ref> --push` first', ExitCode.NOT_FOUND);
  }
  return new CliError(`Vibgrate Cloud answered ${res.status} — ${res.detail ?? ''}`, ExitCode.ERROR);
}

/** Group comments into threads, oldest first, each with its replies in order. */
export function threadsOf(comments: DocComment[]): DocThread[] {
  const threads = new Map<string, DocThread>();
  for (const c of comments) {
    if (c.parentId === null) threads.set(c.id, { id: c.id, blockId: c.blockId, blockTitle: c.blockTitle, resolved: c.resolvedAt !== null, comments: [c] });
  }
  for (const c of comments) if (c.parentId !== null) threads.get(c.parentId)?.comments.push(c);
  return [...threads.values()];
}

export async function fetchComments(dsn: ParsedDsn, target: DocTarget, fetchImpl: typeof fetch = fetch): Promise<{ title: string; threads: DocThread[] }> {
  const res = await postIngest(dsn, '/v1/ingest/review-doc/comments', target, fetchImpl);
  if (!res.ok) throw failure(res);
  const body = (res.json ?? {}) as { title?: unknown; comments?: unknown };
  const comments = Array.isArray(body.comments) ? (body.comments as DocComment[]) : [];
  return { title: typeof body.title === 'string' ? body.title : '', threads: threadsOf(comments) };
}

export async function replyToComment(
  dsn: ParsedDsn,
  target: DocTarget,
  parentId: string,
  text: string,
  author: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DocComment> {
  const res = await postIngest(dsn, '/v1/ingest/review-doc/reply', { ...target, parent_id: parentId, body: text, ...(author ? { author } : {}) }, fetchImpl);
  if (!res.ok) throw failure(res);
  return (res.json as { comment: DocComment }).comment;
}

/** Threads as terminal text: open ones first, each comment with who wrote it. */
export function formatThreads(threads: DocThread[]): string[] {
  if (threads.length === 0) return ['no comments on this document yet'];
  const out: string[] = [];
  const ordered = [...threads.filter((t) => !t.resolved), ...threads.filter((t) => t.resolved)];
  for (const t of ordered) {
    out.push(`${t.id}  ${t.resolved ? '(resolved) ' : ''}on ${t.blockTitle ?? t.blockId}`);
    for (const c of t.comments) {
      out.push(`  ${c.authorKind === 'agent' ? `${c.authorName} [agent]` : c.authorName}: ${c.body.replace(/\n/g, '\n    ')}`);
    }
  }
  return out;
}
