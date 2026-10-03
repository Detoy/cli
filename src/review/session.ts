/**
 * "Show me what you did": a review document scoped to one VG Code session.
 *
 * VG Code already records, per chat, what was asked each turn, the files each
 * turn touched, how the turn stopped, and the agent's closing answer
 * (`.vibgrate/code-sessions/<id>.json`, see code/session-store.ts). That is
 * first-party provenance: no trace capture, no hook, nothing new written.
 * This module reads it and does three things:
 *
 *   1. resolves which checkout the session edited (the main tree, or its own
 *      worktree and the commit that worktree branched from),
 *   2. narrows the change set to the files the session touched, and says
 *      which touched files are no longer in the change and which changed
 *      files were left out,
 *   3. turns each turn's request into a pinned requirement, and quotes the
 *      agent's last summary as the agent's own words, marked unverified.
 *
 * Nothing here judges the change; the document's evidence rule still applies
 * to every pin, and a requirement only links lines that land.
 */

import * as path from 'node:path';
import { loadLatestSession, loadSession, sessionTitle, type StoredSession } from '../code/session-store.js';
import type { ChangeSet, ChangedFile } from './git.js';
import { MAX_HUNK_LINKS, mdEscape, pinLink, plural, type DocBlock, type PinResolver } from './doc.js';

/** How much of one request a requirement quotes; the session file keeps the rest. */
const MAX_ASK_CHARS = 600;
/** How much of the agent's closing answer is quoted. */
const MAX_SUMMARY_CHARS = 1500;
/** Turns listed as requirements, newest kept when there are more. */
const MAX_TURNS = 30;
/** Touched files listed per turn. */
const MAX_FILES_PER_TURN = 12;

export interface ReviewSession {
  session: StoredSession;
  /** The directory the session's file paths are relative to (the worktree for a worktree chat). */
  root: string;
  /** For a worktree chat: the commit the worktree branched from, which is the change's base. */
  base: string | null;
}

/** Turn a `--session` value (`latest` or an id) into a stored session, or a reason it cannot be read. */
export function resolveReviewSession(mainRoot: string, spec: string): ReviewSession | { error: string } {
  const session = spec === 'latest' ? loadLatestSession(mainRoot) : loadSession(mainRoot, spec);
  if (!session) {
    return {
      error:
        spec === 'latest'
          ? 'no VG Code session found in this repository — run `vg code` first'
          : `no VG Code session ${spec} in .vibgrate/code-sessions`,
    };
  }
  if (session.worktree) return { session, root: session.worktree.path, base: session.worktree.base };
  return { session, root: mainRoot, base: null };
}

/** Every file the session touched, repo-relative to the change's top level, forward slashes. */
export function sessionFiles(rs: ReviewSession, change: ChangeSet): Map<string, number[]> {
  const byFile = new Map<string, number[]>();
  rs.session.tasks.forEach((t, i) => {
    for (const f of t.files ?? []) {
      const rel = toRepoPath(rs.root, change.topLevel, f);
      if (!rel) continue;
      const turns = byFile.get(rel) ?? [];
      if (!turns.includes(i)) turns.push(i);
      byFile.set(rel, turns);
    }
  });
  return byFile;
}

function toRepoPath(sessionRoot: string, topLevel: string, file: string): string | null {
  const rel = path.relative(topLevel, path.resolve(sessionRoot, file)).split(path.sep).join('/');
  return !rel || rel.startsWith('..') || path.isAbsolute(rel) ? null : rel;
}

export interface ScopedChange {
  change: ChangeSet;
  /** Files the session touched that are not in the change any more (committed past the base, or reverted). */
  missing: string[];
  /** Changed files the session did not touch, left out of the document. */
  excluded: string[];
}

/** Keep only the files the session touched; never invents a file the change does not have. */
export function scopeChangeToSession(change: ChangeSet, rs: ReviewSession): ScopedChange {
  const touched = sessionFiles(rs, change);
  const norm = (f: ChangedFile) => f.path.replace(/\\/g, '/');
  const kept = change.files.filter((f) => touched.has(norm(f)));
  const present = new Set(kept.map(norm));
  return {
    change: { ...change, files: kept },
    missing: [...touched.keys()].filter((p) => !present.has(p)).sort(),
    excluded: change.files.filter((f) => !touched.has(norm(f))).map(norm).sort(),
  };
}

/** One line, at most `max` characters, cut at a word boundary when there is one nearby. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.—-]+$/, '')}…`;
}

/** The chat's own name, or its first request, without sessionTitle's hard 80-character cut. */
function chatName(session: StoredSession): string {
  return session.title?.trim() || (session.tasks.find((t) => t.instruction?.trim())?.instruction ?? sessionTitle(session));
}

/** A request quoted inline: escaped so nothing in it reads as a link, code span or emphasis. */
function quote(text: string, max: number): string {
  return `“${mdEscape(clip(text, max)).replace(/\(/g, '\\(').replace(/\)/g, '\\)')}”`;
}

export interface SessionBlocks {
  title: string;
  /** Prepended to what and why. */
  what: DocBlock[];
  requirements: DocBlock[];
  notes: string[];
}

/**
 * The session's part of the document. Requirements link only lines that land
 * on the head side; a touched file with no hunk in the change is named, not
 * linked.
 */
export function sessionBlocks(rs: ReviewSession, scoped: ScopedChange, resolve: PinResolver): SessionBlocks {
  const { session } = rs;
  const change = scoped.change;
  const fileByPath = new Map(change.files.map((f) => [f.path.replace(/\\/g, '/'), f]));
  const name = chatName(session);
  const turns = session.tasks.map((t, i) => ({ t, i })).filter(({ t }) => (t.instruction ?? '').trim());
  const shown = turns.slice(-MAX_TURNS);
  const notes: string[] = [];

  const what: DocBlock[] = [];
  const first = turns[0]?.t.instruction;
  const intro: string[] = [
    `**Why** — made by VG Code in the session “${mdEscape(clip(name, 100))}” (${plural(session.tasks.length, 'turn')}, ${mdEscape(session.provider)} · ${mdEscape(session.model)}${session.worktree ? `, in worktree ${mdEscape(session.worktree.id)}` : ''}).`,
  ];
  if (first) intro.push('', `First request: ${quote(first, MAX_ASK_CHARS)}`);
  what.push({ type: 'markdown', text: intro.join('\n') });

  const unfinished = session.tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.stopped && t.stopped !== 'finished' && t.stopped !== 'compacted');
  if (unfinished.length > 0) {
    what.push({
      type: 'callout',
      tone: 'warning',
      text: `${plural(unfinished.length, 'turn')} did not finish: ${unfinished
        .map(({ t, i }) => `turn ${i + 1} stopped (${mdEscape(t.stopped)})`)
        .join(', ')}. What it changed is below; what it meant to do next is not.`,
    });
  }

  const last = [...session.tasks].reverse().find((t) => (t.summary ?? '').trim());
  if (last) {
    what.push({
      type: 'callout',
      tone: 'note',
      text: `**The agent's own account of turn ${session.tasks.indexOf(last) + 1}** — written by the model and quoted as it was written; vg has not checked it against the code. The pinned lines below are what changed.\n\n${quote(last.summary, MAX_SUMMARY_CHARS)}`,
    });
  }

  const lines: string[] = [
    `What was asked, turn by turn, and the changed lines each turn touched${turns.length > shown.length ? ` (the last ${shown.length} of ${turns.length} turns)` : ''}.`,
    '',
  ];
  let linked = 0;
  for (const { t, i } of shown) {
    const files = [...new Set((t.files ?? []).map((f) => toRepoPath(rs.root, change.topLevel, f)).filter((p): p is string => !!p))];
    const parts: string[] = [];
    for (const p of files.slice(0, MAX_FILES_PER_TURN)) {
      const file = fileByPath.get(p);
      if (!file) {
        parts.push(`\`${mdEscape(p)}\` (not in this change)`);
        continue;
      }
      if (file.op === 'removed') {
        parts.push(`\`${mdEscape(p)}\` removed`);
        continue;
      }
      const n = resolve('head', p);
      const links = file.hunks
        .filter((h) => n !== null && h.end <= n)
        .slice(0, MAX_HUNK_LINKS)
        .map((h) => `[L${h.start}${h.end !== h.start ? `–${h.end}` : ''}](${pinLink({ side: 'head', path: p, start: h.start, end: h.end })})`);
      linked += links.length;
      parts.push(`\`${mdEscape(p)}\`${links.length ? ` ${links.join(' · ')}` : ''}`);
    }
    const more = files.length - MAX_FILES_PER_TURN;
    if (more > 0) parts.push(`+${more} more`);
    lines.push(`- **Turn ${i + 1}** ${quote(t.instruction, MAX_ASK_CHARS)}${parts.length ? ` → ${parts.join(', ')}` : ' → no files changed'}`);
  }
  const requirements: DocBlock[] = shown.length > 0 ? [{ type: 'markdown', text: lines.join('\n') }] : [];

  notes.push(
    `requirements quote VG Code session ${session.id} from .vibgrate/code-sessions; the requests are the person's, the summary is the agent's and is not verified`,
  );
  if (linked === 0 && change.files.length > 0) notes.push('no requirement could link a changed line');
  if (scoped.missing.length > 0) {
    notes.push(
      `${plural(scoped.missing.length, 'file')} the session touched ${scoped.missing.length === 1 ? 'is' : 'are'} not in this change (committed past the base, or reverted): ${scoped.missing.slice(0, 8).join(', ')}${scoped.missing.length > 8 ? ', …' : ''} — pass --base to include commits`,
    );
  }
  if (scoped.excluded.length > 0) {
    notes.push(`${plural(scoped.excluded.length, 'changed file')} the session did not touch ${scoped.excluded.length === 1 ? 'was' : 'were'} left out`);
  }
  return { title: `What VG Code did: ${clip(name, 72)}`, what, requirements, notes };
}
