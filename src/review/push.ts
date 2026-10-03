/**
 * `vg review --push` — send the receipt to Vibgrate Cloud.
 *
 * Reuses the existing workspace identity, DSN, and ingest host: Review does not
 * create a second cloud product. The envelope carries `kind: "review"` so the
 * ingest writer switches on it (spec §6.1) — drift keeps using `kind: "scan"`.
 *
 * **Source, prompts, and capsules are not telemetry.** By default the payload
 * is the receipt: decisions, claims, evidence ids, and paths. Line ranges are
 * opt-in (`--include-spans`); source snippets are a second, explicit opt-in
 * (`--include-snippets`) and are capped. The capsule body is never sent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliError, ExitCode } from '../util/exit.js';
import { VERSION } from '../version.js';
import type { AnalysisCapsule, ReviewIngestEnvelope, ReviewReceipt } from './schemas.js';
import { RECEIPT_SCHEMA } from './schemas.js';
import { DOC_SCHEMA, type ReviewDoc } from './doc.js';

/** Snippet cap — a handful of lines per finding, never a file. */
const MAX_SNIPPET_LINES = 12;
const MAX_SNIPPET_FINDINGS = 20;

export interface PushPrivacy {
  includeSpans?: boolean;
  includeSnippets?: boolean;
}

export interface ReviewSpanRef {
  evidence_id: string;
  path: string;
  start_line: number;
  end_line: number;
  /** Present only under `--include-snippets`; capped to MAX_SNIPPET_LINES. */
  snippet?: string;
}

export interface ReviewPushBody extends ReviewIngestEnvelope {
  /** Present only under `--include-spans` / `--include-snippets`. */
  spans?: ReviewSpanRef[];
}

/**
 * `--offline` / `--local` forbids `--push`. The receipt stays on disk; an
 * upload would be a network call the user explicitly ruled out.
 */
export function rejectPushWhenOffline(offline: boolean | undefined): void {
  if (!offline) return;
  throw new CliError(
    '`--push` needs the network — drop `--offline` (or `--local`) to upload the receipt, or drop `--push` to keep it on disk',
    ExitCode.USAGE_ERROR,
  );
}

export function buildEnvelope(
  receipt: ReviewReceipt,
  opts: { workspaceId?: string | null; pushedAt: string } = { pushedAt: new Date().toISOString() },
): ReviewIngestEnvelope {
  return {
    kind: 'review',
    schema_version: RECEIPT_SCHEMA,
    workspace_id: opts.workspaceId ?? receipt.workspace_id ?? null,
    pushed_at: opts.pushedAt,
    cli_version: VERSION,
    receipt,
  };
}

/**
 * Collect the opt-in span references. Returns `undefined` when neither privacy
 * flag is set — the field is then absent from the payload rather than empty,
 * so the server can tell "not sent" from "sent, none".
 */
export function collectSpans(
  root: string,
  receipt: ReviewReceipt,
  capsule: AnalysisCapsule,
  privacy: PushPrivacy,
): ReviewSpanRef[] | undefined {
  if (!privacy.includeSpans && !privacy.includeSnippets) return undefined;
  const citedIds = new Set(
    [...receipt.findings.architecture_findings, ...receipt.findings.security_findings]
      .slice(0, MAX_SNIPPET_FINDINGS)
      .flatMap((f) => f.evidence_ids),
  );
  const spans: ReviewSpanRef[] = [];
  for (const e of capsule.evidence) {
    if (!citedIds.has(e.id)) continue;
    if (!e.path || e.start_line === undefined || e.end_line === undefined) continue;
    const ref: ReviewSpanRef = {
      evidence_id: e.id,
      path: e.path,
      start_line: e.start_line,
      end_line: e.end_line,
    };
    if (privacy.includeSnippets) {
      const snippet = readSnippet(root, e.path, e.start_line, e.end_line);
      if (snippet) ref.snippet = snippet;
    }
    spans.push(ref);
  }
  return spans;
}

function readSnippet(root: string, rel: string, start: number, end: number): string | null {
  try {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return null;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    return lines.slice(Math.max(0, start - 1), Math.min(lines.length, start - 1 + MAX_SNIPPET_LINES, end)).join('\n');
  } catch {
    return null;
  }
}

export interface ParsedDsn {
  keyId: string;
  secret: string;
  host: string;
  workspaceId: string;
  scheme: 'https' | 'http';
}

export interface PushResult {
  ok: boolean;
  status: number;
  host: string;
  detail?: string;
  /** The server's machine-readable reason, when it gave one. */
  code?: string;
  /** The parsed JSON body of a successful response, when it had one. */
  json?: unknown;
}

/**
 * POST the envelope. Network failures are surfaced with the host that was
 * tried; the caller decides whether that is fatal (`--strict`) or a warning.
 */
export async function pushReceipt(
  dsn: ParsedDsn,
  body: ReviewPushBody,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  return postIngest(dsn, '/v1/ingest/review', body, fetchImpl);
}

/**
 * `vg review doc --push`: the whole review document, which carries
 * code-derived text (signatures, conditions, table and field names, agent
 * notes). Sent only when asked, and stored only when the workspace has turned
 * review documents on in Vibgrate Cloud; otherwise the server refuses it with
 * `code: "review_doc_upload_disabled"` and keeps nothing.
 */
export interface ReviewDocPushBody {
  kind: 'review_doc';
  schema_version: typeof DOC_SCHEMA;
  cli_version: string;
  repo: { repo_key: string; name: string | null; remote: string | null };
  doc: ReviewDoc;
}

export function reviewDocEnvelope(doc: ReviewDoc, remote: string | null, root: string): ReviewDocPushBody {
  return {
    kind: 'review_doc',
    schema_version: DOC_SCHEMA,
    cli_version: VERSION,
    repo: {
      repo_key: doc.target.repo_key ?? '',
      // Same naming as the receipt, so the GitHub App finds both by `owner/repo`.
      name: remote ? remote.split('/').slice(-2).join('/') : path.basename(root),
      remote,
    },
    doc,
  };
}

export async function pushReviewDoc(dsn: ParsedDsn, body: ReviewDocPushBody, fetchImpl: typeof fetch = fetch): Promise<PushResult> {
  return postIngest(dsn, '/v1/ingest/review-doc', body, fetchImpl);
}

export async function postIngest(dsn: ParsedDsn, route: string, body: unknown, fetchImpl: typeof fetch): Promise<PushResult> {
  const url = `${dsn.scheme}://${dsn.host}${route}`;
  const payload = JSON.stringify(body);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Vibgrate-Timestamp': String(Date.now()),
        Authorization: `VibgrateDSN ${dsn.keyId}:${dsn.secret}`,
      },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new CliError(
      `could not reach ${dsn.host}: ${e instanceof Error ? e.message : String(e)}`,
      ExitCode.ERROR,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let code: string | undefined;
    let error: string | undefined;
    try {
      const parsed = JSON.parse(detail) as { code?: unknown; error?: unknown };
      if (typeof parsed.code === 'string') code = parsed.code;
      if (typeof parsed.error === 'string') error = parsed.error;
    } catch {
      /* not JSON: keep the raw text */
    }
    return { ok: false, status: res.status, host: dsn.host, detail: (error ?? detail).slice(0, 200), ...(code ? { code } : {}) };
  }
  const text = await res.text().catch(() => '');
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { ok: true, status: res.status, host: dsn.host, ...(json !== undefined ? { json } : {}) };
}
