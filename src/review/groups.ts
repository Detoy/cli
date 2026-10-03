/**
 * Diff groups — `vg.review.groups.v1`, the host side.
 *
 * Partitions a change set into groups a reader can take in one sitting, in
 * reading order: implementation by area and architecture layer first, then
 * everything that is not implementation, peeled off with a reason.
 *
 * Which rule places a file where — the peel order, the path and content
 * rules, import detection, areas, layer order, how big groups split — is
 * decided by the Architecture module (`HaileProvider.reviewGroups`). This file
 * only collects what the module reads (git signals, and facts the public
 * code map already computes for every file), checks that what comes back is
 * a partition of the change, and seals it with a digest.
 *
 * Without the module, the change is one honest "not grouped" group: every
 * file still listed, nothing guessed. {@link validateGroups} enforces the
 * partition on any groups file an agent or person edits.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyFile } from '../core-open/scanners/architecture/classify.js';
import { isTestFilePath, isToolingConfigFile } from '../core-open/scanners/architecture/folders.js';
import { isContractOrIacFile } from '../core-open/scanners/architecture/walker.js';
import { SKIP_FILES } from '../engine/discover.js';
import { isTestFile } from '../engine/tests.js';
import type { HaileProvider } from '../engine/haile/haile-provider.js';
import { defaultRun, type ChangeSet, type ChangedFile, type GitRunner } from './git.js';
import { digest } from './schemas.js';
import { isDependencyManifest } from './surface.js';

export const GROUPS_SCHEMA = 'vg.review.groups.v1' as const;

export type GroupKind =
  | 'implementation'
  | 'tests'
  | 'fixtures'
  | 'data'
  | 'config'
  | 'dependencies'
  | 'generated'
  | 'docs'
  | 'assets'
  | 'moved'
  | 'formatting'
  | 'imports'
  /** Every changed file, unsorted — the Architecture module was not available. */
  | 'ungrouped';

/** Every kind a groups file may carry, in reading order. */
export const GROUP_KIND_ORDER: readonly GroupKind[] = [
  'implementation',
  'tests',
  'fixtures',
  'data',
  'config',
  'dependencies',
  'generated',
  'docs',
  'assets',
  'moved',
  'formatting',
  'imports',
  'ungrouped',
];

/** Kinds a reviewer reads line by line; everything else is peeled off. */
export const READ_KINDS: ReadonlySet<GroupKind> = new Set(['implementation', 'ungrouped']);

export const UNGROUPED_NOTE = 'files are not grouped — grouping needs the Architecture module: run `vg module install arch`';

export interface GroupFile {
  path: string;
  op: ChangedFile['op'];
  added_lines: number;
  removed_lines: number;
  /** The deterministic signal that placed the file here. */
  reason: string;
}

export interface DiffGroup {
  /** Content-derived: `grp:<kind>:<key>`. */
  id: string;
  kind: GroupKind;
  label: string;
  /** Monorepo area (`packages/api`), or null at the repository root. */
  area: string | null;
  /** Architecture layer for implementation groups; null otherwise. */
  layer: string | null;
  files: GroupFile[];
  added_lines: number;
  removed_lines: number;
}

export interface DiffGroups {
  schema_version: typeof GROUPS_SCHEMA;
  target: {
    base_sha: string;
    head_sha: string;
    merge_base: string | null;
    dirty_tree_hash: string | null;
  };
  groups: DiffGroup[];
  counts: { files: number; groups: number; implementation_files: number; peeled_files: number };
  /** Why the files are not grouped, when they are not; null when the module grouped them. */
  note: string | null;
  /** `sha256:` over every field above. */
  digest: string;
}

/** Signals read from git and the working tree. */
export interface GroupSignals {
  /** Changed line text per path, from a zero-context diff. */
  changedLines: Map<string, { added: string[]; removed: string[] }>;
  /** Paths whose diff is empty once whitespace and blank lines are ignored. */
  whitespaceOnly: Set<string>;
  /** Paths git marks `linguist-generated` (via `.gitattributes`). */
  generatedAttr: Set<string>;
  /** The first bytes of each changed file on the head side. */
  headHeader: Map<string, string>;
}

export function emptySignals(): GroupSignals {
  return { changedLines: new Map(), whitespaceOnly: new Set(), generatedAttr: new Set(), headHeader: new Map() };
}

// ─── What the module reads ──────────────────────────────────────────────────

/**
 * Facts the public code map already knows about a path, from the same helpers
 * the graph uses: test linkage, dependency files, tooling config, contracts
 * and infrastructure files, and the architecture layer.
 */
export function fileFacts(p: string): Record<string, unknown> {
  const rel = p.replace(/\\/g, '/');
  const base = (rel.split('/').pop() ?? rel).toLowerCase();
  const facts: Record<string, unknown> = {};
  if (isTestFile(rel) || isTestFilePath(rel)) facts.test = true;
  if (SKIP_FILES.has(base)) facts.lockfile = true;
  if (isDependencyManifest(rel)) facts.manifest = true;
  if (isToolingConfigFile(rel)) facts.tooling = true;
  if (isContractOrIacFile(rel, rel.split('/').pop() ?? rel)) facts.contract = true;
  const cls = classifyFile(rel, 'unknown');
  if (cls) {
    facts.layer = cls.layer;
    facts.layer_signal = cls.signals[0] ?? cls.source;
  }
  return facts;
}

/** The payload `HaileProvider.reviewGroups` reads. */
export function groupsPayload(change: ChangeSet, signals: GroupSignals): { files: unknown[] } {
  return {
    files: change.files.map((f) => {
      const p = f.path.replace(/\\/g, '/');
      const lines = signals.changedLines.get(p);
      return {
        path: p,
        op: f.op,
        added_lines: f.addedLines,
        removed_lines: f.removedLines,
        facts: fileFacts(p),
        ...(signals.whitespaceOnly.has(p) ? { whitespace_only: true } : {}),
        ...(signals.generatedAttr.has(p) ? { generated_attr: true } : {}),
        ...(signals.headHeader.has(p) ? { header: signals.headHeader.get(p) } : {}),
        ...(lines ? { added: lines.added, removed: lines.removed } : {}),
      };
    }),
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function ungrouped(change: ChangeSet): DiffGroup[] {
  if (change.files.length === 0) return [];
  const files: GroupFile[] = [...change.files]
    .sort((a, b) => cmp(a.path, b.path))
    .map((f) => ({ path: f.path.replace(/\\/g, '/'), op: f.op, added_lines: f.addedLines, removed_lines: f.removedLines, reason: 'not grouped' }));
  return [
    {
      id: 'grp:ungrouped:all',
      kind: 'ungrouped',
      label: 'Changed files (not grouped)',
      area: null,
      layer: null,
      files,
      added_lines: files.reduce((n, f) => n + f.added_lines, 0),
      removed_lines: files.reduce((n, f) => n + f.removed_lines, 0),
    },
  ];
}

/**
 * Build the groups for a change set. The module decides; the host checks
 * that every changed file is in exactly one group before trusting the answer.
 */
export function groupChangeSet(
  change: ChangeSet,
  signals: GroupSignals = emptySignals(),
  provider: HaileProvider | null = null,
): DiffGroups {
  let groups: DiffGroup[] | null = null;
  let note: string | null = null;
  if (change.files.length === 0) {
    groups = [];
  } else if (provider?.reviewGroups) {
    let raw: ReturnType<NonNullable<HaileProvider['reviewGroups']>> = null;
    try {
      raw = provider.reviewGroups(groupsPayload(change, signals));
    } catch {
      raw = null;
    }
    const candidate = raw ? (raw.groups as DiffGroup[]) : null;
    if (candidate && validateGroups({ schema_version: GROUPS_SCHEMA, groups: candidate }, change).length === 0) {
      groups = candidate;
    } else {
      note = 'files are not grouped — the Architecture module returned groups that do not cover this change exactly';
    }
  } else {
    note = provider ? `${UNGROUPED_NOTE} (the installed module predates diff groups)` : UNGROUPED_NOTE;
  }
  if (!groups) groups = ungrouped(change);

  const total = change.files.length;
  const readFiles = groups.filter((g) => READ_KINDS.has(g.kind)).reduce((n, g) => n + g.files.length, 0);
  const body = {
    schema_version: GROUPS_SCHEMA,
    target: {
      base_sha: change.baseSha,
      head_sha: change.headSha,
      merge_base: change.mergeBase,
      dirty_tree_hash: change.dirtyTreeHash,
    },
    groups,
    counts: { files: total, groups: groups.length, implementation_files: readFiles, peeled_files: total - readFiles },
    note,
  };
  return { ...body, digest: digest(body) };
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface GroupIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * Check that a (possibly hand- or agent-edited) groups document is a partition
 * of the change set: known kinds, unique ids, no empty group, every changed
 * file present exactly once, and nothing that is not in the change. Anything
 * left out is uncategorized, and uncategorized fails.
 */
export function validateGroups(value: unknown, change: ChangeSet): GroupIssue[] {
  const issues: GroupIssue[] = [];
  const doc = value as Partial<DiffGroups> | null;
  if (!doc || typeof doc !== 'object') {
    return [{ path: '$', code: 'not_object', message: 'groups document must be a JSON object' }];
  }
  if (doc.schema_version !== GROUPS_SCHEMA) {
    issues.push({ path: '$.schema_version', code: 'schema', message: `expected ${GROUPS_SCHEMA}` });
  }
  if (doc.target && (doc.target.base_sha !== change.baseSha || doc.target.head_sha !== change.headSha)) {
    issues.push({
      path: '$.target',
      code: 'stale_target',
      message: `groups were made for ${short(doc.target.base_sha)}..${short(doc.target.head_sha)}, the change is ${short(change.baseSha)}..${short(change.headSha)}`,
    });
  }
  if (!Array.isArray(doc.groups)) {
    issues.push({ path: '$.groups', code: 'missing', message: 'groups must be an array' });
    return issues;
  }
  const expected = new Set(change.files.map((f) => f.path.replace(/\\/g, '/')));
  const seen = new Map<string, string>();
  const ids = new Set<string>();
  doc.groups.forEach((g, i) => {
    const at = `$.groups[${i}]`;
    if (!g || typeof g !== 'object') {
      issues.push({ path: at, code: 'not_object', message: 'group must be an object' });
      return;
    }
    if (typeof g.id !== 'string' || !g.id) issues.push({ path: `${at}.id`, code: 'missing', message: 'group id is required' });
    else if (ids.has(g.id)) issues.push({ path: `${at}.id`, code: 'duplicate_id', message: `duplicate group id ${g.id}` });
    else ids.add(g.id);
    if (!GROUP_KIND_ORDER.includes(g.kind as GroupKind)) {
      issues.push({ path: `${at}.kind`, code: 'unknown_kind', message: `unknown kind ${String(g.kind)}` });
    }
    if (typeof g.label !== 'string' || !g.label.trim()) {
      issues.push({ path: `${at}.label`, code: 'missing', message: 'group label is required' });
    }
    if (!Array.isArray(g.files) || g.files.length === 0) {
      issues.push({ path: `${at}.files`, code: 'empty_group', message: 'a group must hold at least one file' });
      return;
    }
    g.files.forEach((f, j) => {
      const p = typeof f?.path === 'string' ? f.path.replace(/\\/g, '/') : '';
      if (!p) {
        issues.push({ path: `${at}.files[${j}]`, code: 'missing', message: 'file path is required' });
        return;
      }
      if (!expected.has(p)) {
        issues.push({ path: `${at}.files[${j}]`, code: 'not_in_change', message: `${p} is not part of this change` });
      } else if (seen.has(p)) {
        issues.push({ path: `${at}.files[${j}]`, code: 'duplicate_file', message: `${p} is already in ${seen.get(p)}` });
      } else {
        seen.set(p, String(g.id));
      }
    });
  });
  for (const p of [...expected].sort(cmp)) {
    if (!seen.has(p)) issues.push({ path: '$.groups', code: 'uncategorized', message: `${p} is in no group` });
  }
  return issues;
}

function short(sha: string | undefined | null): string {
  return sha ? sha.slice(0, 7) : '(none)';
}

// ─── Signal collection (git + filesystem) ───────────────────────────────────

/** The git diff range collectChangeSet used, so every signal reads the same change. */
export function diffRange(change: ChangeSet, opts: { base?: string; inPlace?: boolean }): string[] {
  if (opts.base && opts.inPlace) return [change.baseSha];
  if (opts.base) return [`${change.baseSha}..HEAD`];
  return ['HEAD'];
}

/** True when the head side of the change is the working tree rather than a commit. */
export function headIsWorkingTree(opts: { base?: string; inPlace?: boolean }): boolean {
  return !opts.base || Boolean(opts.inPlace);
}

/** Per-path added/removed line text from a zero-context unified diff. */
export function changedLinesFromDiff(diff: string): Map<string, { added: string[]; removed: string[] }> {
  const out = new Map<string, { added: string[]; removed: string[] }>();
  let oldPath: string | null = null;
  let current: { added: string[]; removed: string[] } | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = null;
      oldPath = null;
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      oldPath = p === '/dev/null' ? null : p.replace(/^a\//, '');
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      const key = p === '/dev/null' ? oldPath : p.replace(/^b\//, '');
      if (!key) {
        current = null;
        continue;
      }
      if (!out.has(key)) out.set(key, { added: [], removed: [] });
      current = out.get(key)!;
      continue;
    }
    if (!current || line.startsWith('@@')) continue;
    if (line.startsWith('+')) current.added.push(line.slice(1));
    else if (line.startsWith('-')) current.removed.push(line.slice(1));
  }
  return out;
}

const HEADER_BYTES = 1024;

function readHeader(abs: string): string | null {
  try {
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(HEADER_BYTES);
      const n = fs.readSync(fd, buf, 0, HEADER_BYTES, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Read every signal the classifier needs, with a bounded number of git calls:
 * one zero-context diff, one whitespace-insensitive numstat, one attribute
 * query, and a header read per changed file.
 */
export function collectGroupSignals(
  change: ChangeSet,
  opts: { base?: string; inPlace?: boolean },
  run: GitRunner = defaultRun,
): GroupSignals {
  const signals = emptySignals();
  if (change.files.length === 0) return signals;
  const cwd = change.topLevel;
  const range = diffRange(change, opts);

  signals.changedLines = changedLinesFromDiff(run(['diff', '-U0', '-M', ...range], cwd).stdout);

  const ws = run(['diff', '--numstat', '-M', '-w', '--ignore-blank-lines', ...range], cwd);
  if (ws.status === 0) {
    const stillChanged = new Set<string>();
    for (const line of ws.stdout.split('\n')) {
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      if (parts[0] === '0' && parts[1] === '0') continue;
      stillChanged.add(parts.length >= 4 ? parts[3] : parts[2]);
    }
    for (const f of change.files) {
      const p = f.path.replace(/\\/g, '/');
      // Only a file git listed in the plain diff can be judged; an untracked
      // file is absent from both and is not "formatting only".
      if (f.op === 'modified' && signals.changedLines.has(p) && !stillChanged.has(p)) signals.whitespaceOnly.add(p);
    }
  }

  const paths = change.files.map((f) => f.path.replace(/\\/g, '/'));
  for (let i = 0; i < paths.length; i += 200) {
    const res = run(['check-attr', 'linguist-generated', '--', ...paths.slice(i, i + 200)], cwd);
    if (res.status !== 0) continue;
    for (const line of res.stdout.split('\n')) {
      const m = line.match(/^(.*): linguist-generated: (set|true)$/);
      if (m) signals.generatedAttr.add(m[1]);
    }
  }

  const fromTree = headIsWorkingTree(opts);
  for (const f of change.files) {
    if (f.op === 'removed') continue;
    const p = f.path.replace(/\\/g, '/');
    if (fromTree) {
      const h = readHeader(path.join(cwd, p));
      if (h !== null) signals.headHeader.set(p, h);
    } else {
      const res = run(['show', `${change.headSha}:${p}`], cwd);
      if (res.status === 0) signals.headHeader.set(p, res.stdout.slice(0, HEADER_BYTES));
    }
  }
  return signals;
}

// ─── Text output ────────────────────────────────────────────────────────────

export function formatGroupsText(groups: DiffGroups): string {
  const lines: string[] = [];
  const c = groups.counts;
  lines.push(
    `${c.files} changed file${c.files === 1 ? '' : 's'} in ${c.groups} group${c.groups === 1 ? '' : 's'} — ${c.implementation_files} implementation, ${c.peeled_files} peeled off`,
  );
  if (groups.note) lines.push(groups.note);
  for (const g of groups.groups) {
    lines.push('');
    lines.push(`${g.label}  (+${g.added_lines} −${g.removed_lines})`);
    for (const f of g.files) {
      lines.push(`  ${f.op.padEnd(8)} ${f.path}  +${f.added_lines} −${f.removed_lines}  · ${f.reason}`);
    }
  }
  return lines.join('\n');
}
