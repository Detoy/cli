/**
 * Agent provenance in Vibgrate Cloud: share the VG Code sessions behind
 * `Vibgrate-Session` trailers so a teammate's `vg why <file:line> --cloud`
 * can show what a session was asked, not just its id.
 *
 * Opt-in on both sides: `vg review trailer push` sends sessions only when run,
 * and Cloud stores them only when a workspace admin has turned on Agent
 * provenance. What is sent per turn is what `vg why` shows: the request, the
 * agent's summary, the repo-relative files it changed and a timestamp. No file
 * contents, diffs or attachments. Credential shapes are masked first, and a
 * session that still carries one after masking is not sent.
 */

import * as path from 'node:path';
import { redactText, secretEgressRefusal } from '../code/secrets.js';
import { loadSession, sessionTitle, type StoredSession } from '../code/session-store.js';
import { CliError, ExitCode } from '../util/exit.js';
import { VERSION } from '../version.js';
import { defaultRun, normalizeRemote, repoKey, type GitRunner } from './git.js';
import { postIngest, type ParsedDsn } from './push.js';
import { TRAILER } from './provenance.js';

const SESSION_ID = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_TEXT = 4000;
/** The mask `redactText` leaves in place of a value. */
const REDACTED = '***redacted***';
/** Sessions per upload; the API takes at most 50. */
export const MAX_SESSIONS_PER_PUSH = 50;

export interface CloudTurn {
  turn: number;
  asked: string;
  answered: string;
  files: string[];
  ts: number;
}

export interface CloudSession {
  id: string;
  title: string;
  provider: string | null;
  model: string | null;
  turns: CloudTurn[];
}

export interface RepoIdentity {
  repo_key: string;
  name: string;
}

/** The repository's identity as Cloud keys it: the same repo key and name a review receipt uses. */
export function repoIdentity(topLevel: string, run: GitRunner = defaultRun): RepoIdentity {
  const raw = run(['config', '--get', 'remote.origin.url'], topLevel);
  const remote = raw.status === 0 ? normalizeRemote(raw.stdout) : null;
  return { repo_key: repoKey(remote, topLevel), name: remote ? remote.split('/').slice(-2).join('/') : path.basename(topLevel) };
}

/**
 * Session ids named by trailers on the commits to share: `<base>..HEAD` with
 * `--base`, else the commits on HEAD that no remote branch has yet.
 */
export function trailerSessionIds(topLevel: string, base: string | undefined, run: GitRunner = defaultRun): string[] {
  const range = base ? [`${base}..HEAD`] : ['HEAD', '--not', '--remotes'];
  const res = run(['log', `--format=%(trailers:key=${TRAILER},valueonly,separator=%x2C)`, ...range, '--'], topLevel);
  if (res.status !== 0) throw new CliError(`git could not list commits${base ? ` in ${base}..HEAD` : ''}`, ExitCode.USAGE_ERROR);
  const ids = res.stdout.split(/[\n,]/).map((s) => s.trim()).filter((s) => SESSION_ID.test(s));
  return [...new Set(ids)];
}

/** A repo-relative path for a session file, or null when outside the repository. */
function relTo(topLevel: string, sessionRoot: string, file: string): string | null {
  const rel = path.relative(topLevel, path.resolve(sessionRoot, file)).split(path.sep).join('/');
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/**
 * What Cloud receives for one session: masked text, repo-relative files.
 * Returns the reason when the session cannot be sent.
 */
export function cloudSession(s: StoredSession, topLevel: string): CloudSession | { refused: string } {
  const root = s.worktree?.path ?? topLevel;
  const turns = s.tasks.map((t, i) => ({
    turn: i + 1,
    asked: clip(redactText(t.instruction ?? '')),
    answered: clip(redactText(t.summary ?? '')),
    files: [...new Set((t.files ?? []).map((f) => relTo(topLevel, root, f)).filter((f): f is string => f !== null))],
    ts: t.ts,
  }));
  const out: CloudSession = { id: s.id, title: clip(redactText(sessionTitle(s))).slice(0, 300), provider: s.provider || null, model: s.model || null, turns };
  if (turns.length === 0) return { refused: 'it has no turns' };
  // A masked value still reads as an assignment (`API_KEY=***redacted***`), so
  // the check runs on the text without the masks: what is left is unmasked.
  const refusal = secretEgressRefusal(JSON.stringify(out).split(REDACTED).join(''), `session ${s.id}`);
  return refusal ? { refused: refusal } : out;
}

export interface PreparedPush {
  repo: RepoIdentity;
  sessions: CloudSession[];
  /** Named by a trailer but not on this machine. */
  missing: string[];
  /** On this machine but not sent, with why. */
  refused: { id: string; reason: string }[];
}

export function preparePush(topLevel: string, ids: string[], run: GitRunner = defaultRun): PreparedPush {
  const out: PreparedPush = { repo: repoIdentity(topLevel, run), sessions: [], missing: [], refused: [] };
  for (const id of ids) {
    const s = loadSession(topLevel, id);
    if (!s) {
      out.missing.push(id);
      continue;
    }
    const c = cloudSession(s, topLevel);
    if ('refused' in c) out.refused.push({ id, reason: c.refused });
    else out.sessions.push(c);
  }
  return out;
}

function failure(res: { status: number; code?: string; detail?: string }): CliError {
  if (res.code === 'provenance_upload_disabled') {
    return new CliError(
      'this workspace does not accept agent provenance — a workspace admin can turn on Agent provenance in Vibgrate Cloud settings; nothing was uploaded',
      ExitCode.ERROR,
    );
  }
  return new CliError(`Vibgrate Cloud answered ${res.status} — ${res.detail ?? ''}`, ExitCode.ERROR);
}

/** Upload sessions, 50 at a time. Returns how many Cloud stored. */
export async function pushProvenance(dsn: ParsedDsn, prepared: PreparedPush, fetchImpl: typeof fetch = fetch): Promise<number> {
  let stored = 0;
  for (let i = 0; i < prepared.sessions.length; i += MAX_SESSIONS_PER_PUSH) {
    const body = { kind: 'code_session_provenance', cli_version: VERSION, repo: prepared.repo, sessions: prepared.sessions.slice(i, i + MAX_SESSIONS_PER_PUSH) };
    const res = await postIngest(dsn, '/v1/ingest/provenance', body, fetchImpl);
    if (!res.ok) throw failure(res);
    stored += Number((res.json as { stored?: unknown } | undefined)?.stored ?? 0);
  }
  return stored;
}

export interface CloudLookup extends CloudSession {
  pushedAt: string;
}

/** The sessions Cloud has for these ids in this repository. Ids never pushed are absent. */
export async function lookupProvenance(dsn: ParsedDsn, repo: RepoIdentity, ids: string[], fetchImpl: typeof fetch = fetch): Promise<CloudLookup[]> {
  if (ids.length === 0) return [];
  const res = await postIngest(dsn, '/v1/ingest/provenance/lookup', { repo_key: repo.repo_key, session_ids: ids.slice(0, MAX_SESSIONS_PER_PUSH) }, fetchImpl);
  if (!res.ok) throw failure(res);
  const sessions = (res.json as { sessions?: unknown } | undefined)?.sessions;
  return Array.isArray(sessions) ? (sessions as CloudLookup[]) : [];
}
