/**
 * The deterministic fast-apply merge engine (VG-CLI-CODE §4).
 *
 * Speed in the fast coding tools comes from letting the planner emit a *terse*
 * edit instead of rewriting a whole file; correctness comes from applying that
 * edit **deterministically and scoped**, never by letting the model free-hand
 * the merge. This module is that deterministic floor: it parses the
 * search/replace edit form and applies it with three escalating match
 * strategies — exact, whitespace-flexible, then graph-span-scoped — so an
 * ambiguous SEARCH is resolved to the symbol the planner actually named rather
 * than the first textual hit. No model is required to apply an edit; a hosted
 * fast-apply model is only ever an *acceleration* over this same contract.
 *
 * Everything here is pure and deterministic: identical (content, edit) always
 * yields the identical outcome, which is what makes it unit- and
 * benchmark-testable offline.
 */

import type { CodeEdit, EditOutcome, ToolCall } from './types.js';

/** A symbol span the graph knows about, used to disambiguate a SEARCH match. */
export interface SymbolSpan {
  /** Qualified name, matched against `anchorSymbol`. */
  qualifiedName: string;
  file: string;
  /** 1-based inclusive line range. */
  start: number;
  end: number;
}

/**
 * Parse a model's reply into structured edits. The accepted form is the
 * widely-supported search/replace block (robust to surrounding prose and code
 * fences), plus explicit whole-file create/delete markers:
 *
 * ```
 * path/to/file.ts
 * <<<<<<< SEARCH
 * old code
 * =======
 * new code
 * >>>>>>> REPLACE
 * ```
 *
 * `CREATE path/to/new.ts` … `END CREATE` wraps a new file's whole body;
 * `DELETE path/to/gone.ts` removes a file. Parsing is forgiving of blank lines
 * and fences but strict about the block markers, so a malformed block surfaces
 * as an `invalid` outcome at apply time rather than silently corrupting a file.
 */
export interface ParseEditsOptions {
  /**
   * When a SEARCH/REPLACE block has no path (common on live Code Mode replies
   * that already saw a cited file), apply the block to this file.
   */
  defaultFile?: string;
}

export function parseEdits(text: string, opts: ParseEditsOptions = {}): CodeEdit[] {
  const edits: CodeEdit[] = [];
  const lines = text.split('\n');
  let i = 0;
  let pendingFile = '';
  const fallback = (opts.defaultFile ?? '').trim();

  const isFence = (s: string): boolean => /^\s*```/.test(s);
  const resolveFile = (inline: string): string => inline || pendingFile || fallback;

  while (i < lines.length) {
    const line = lines[i];

    // Whole-file create: `CREATE <path>` … `END CREATE`.
    const create = /^\s*CREATE\s+(\S.*?)\s*$/.exec(line);
    if (create) {
      const file = create[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*END CREATE\s*$/.test(lines[i])) {
        if (!isFence(lines[i])) body.push(lines[i]);
        i++;
      }
      i++; // consume END CREATE
      edits.push({ op: 'create', file, content: body.join('\n') });
      pendingFile = '';
      continue;
    }

    // Whole-file delete: `DELETE <path>`.
    const del = /^\s*DELETE\s+(\S.*?)\s*$/.exec(line);
    if (del) {
      edits.push({ op: 'delete', file: del[1] });
      i++;
      pendingFile = '';
      continue;
    }

    // Search/replace block. Path is (in order): inline on the SEARCH line,
    // the most recent path-looking line, or `defaultFile` (cited-file handoff).
    const searchMark = searchReplaceMarker(line);
    if (searchMark) {
      const file = resolveFile(searchMark.file);
      const search: string[] = [];
      const replace: string[] = [];
      i++;
      while (i < lines.length && !/^\s*={5,}\s*$/.test(lines[i])) {
        search.push(lines[i]);
        i++;
      }
      i++; // consume =======
      while (i < lines.length && !replaceEndMarker(lines[i])) {
        replace.push(lines[i]);
        i++;
      }
      i++; // consume >>>>>>> REPLACE / *** REPLACE
      edits.push({
        op: 'replace',
        file,
        search: search.join('\n'),
        replace: replace.join('\n'),
        anchorSymbol: undefined,
      });
      continue;
    }

    const fromLine = pathFromLine(line);
    if (fromLine && !isFence(line)) pendingFile = fromLine;
    i++;
  }

  if (edits.length === 0) {
    edits.push(...editsFromUnifiedDiff(text, fallback));
  }
  // Live Flow Review (#2662): the pack printed PatchIR / `{op,path,search,
  // replace}` JSON instead of SEARCH/REPLACE. looksLikeToolCallDump already
  // flags that; without this fallback the loop dies as no-tools.
  if (edits.length === 0) {
    edits.push(...parseEditDump(text, opts));
  }

  return edits;
}

/** `<<<<<<< SEARCH` / `*** SEARCH` / optional inline path. */
function searchReplaceMarker(line: string): { file: string } | null {
  const m =
    /^\s*<{5,}\s*SEARCH(?:\s+(\S+))?\s*$/.exec(line) ??
    /^\s*\*{3,}\s*SEARCH(?:\s+(\S+))?\s*$/.exec(line);
  if (!m) return null;
  return { file: m[1] ? normalizePathCandidate(m[1]) : '' };
}

function replaceEndMarker(line: string): boolean {
  return /^\s*>{5,}\s*REPLACE/.test(line) || /^\s*\*{3,}\s*REPLACE\b/.test(line);
}

/**
 * Strip markdown / `File:` wrappers so live Code Mode path lines still resolve.
 * `**src/scan.ts**`, `` `src/scan.ts` ``, `File: src/scan.ts`.
 */
export function normalizePathCandidate(raw: string): string {
  let t = (raw ?? '').trim();
  t = t.replace(/^File:\s*/i, '').replace(/^path:\s*/i, '');
  t = t.replace(/^[*`_#>\-\s]+/, '').replace(/[*`_]+$/g, '');
  t = t.replace(/[:`]+$/, '');
  return t.trim();
}

/** A path on its own line, or the first path-shaped token in a short prose line. */
export function pathFromLine(line: string): string {
  if (!line || /^\s*```/.test(line)) return '';
  const normalized = normalizePathCandidate(line);
  if (looksLikePath(normalized)) return normalized;
  const embedded = line.match(
    /(?:^|[\s`'"])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w.-]*)/,
  );
  return embedded && looksLikePath(embedded[1]) ? embedded[1] : '';
}

/**
 * Unified-diff residual (`--- a/file` / `+++ b/file` plus `-`/`+` lines).
 * Live hosted and local packs emit this when they skip SEARCH/REPLACE markers.
 */
export function editsFromUnifiedDiff(text: string, defaultFile = ''): CodeEdit[] {
  const edits: CodeEdit[] = [];
  let file = '';
  let oldPath: string | null = null;
  const search: string[] = [];
  const replace: string[] = [];
  const flush = (): void => {
    const target = file || defaultFile;
    if (!target || (search.length === 0 && replace.length === 0)) {
      search.length = 0;
      replace.length = 0;
      return;
    }
    if (search.join('\n') === replace.join('\n')) {
      search.length = 0;
      replace.length = 0;
      return;
    }
    edits.push({
      op: 'replace',
      file: target,
      search: search.join('\n'),
      replace: replace.join('\n'),
      anchorSymbol: undefined,
    });
    search.length = 0;
    replace.length = 0;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('--- ')) {
      flush();
      const p = line.slice(4).trim();
      oldPath = p === '/dev/null' ? null : p.replace(/^a\//, '');
      file = '';
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? oldPath ?? '' : p.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) replace.push(line.slice(1));
    else if (line.startsWith('-') && !line.startsWith('---')) search.push(line.slice(1));
    else if (line.startsWith(' ') || line === '') {
      const body = line.startsWith(' ') ? line.slice(1) : line;
      search.push(body);
      replace.push(body);
    }
  }
  flush();
  return edits;
}

/**
 * Lift residual SEARCH/REPLACE (the oneshot edit form) or a printed
 * PatchIR / `{path,search,replace}` JSON dump into tool calls.
 * Local Code Modes often emit this instead of `<tool_call>` markup. The
 * agent loop applies these as `edit_file` / `create_file` / `delete_file`
 * so a text-protocol backend still drives the loop. Skips edits with no path
 * unless {@link ParseEditsOptions.defaultFile} is set.
 */
export function residualEditsToToolCalls(text: string, opts: ParseEditsOptions = {}): ToolCall[] {
  const fromMarkers = editsToToolCalls(parseEdits(text, opts));
  if (fromMarkers.length) return fromMarkers;
  return dumpEditsToToolCalls(text, opts);
}

/** Native / rescued `edit_file` (and kin) → the same {@link CodeEdit} list `parseEdits` yields. */
export function toolCallsToEdits(calls: ToolCall[]): CodeEdit[] {
  const edits: CodeEdit[] = [];
  for (const call of calls) {
    const name = String(call.name ?? '')
      .trim()
      .replace(/[\s-]+/g, '_')
      .replace(/_+/g, '_');
    const args = call.arguments ?? {};
    const file = String(args.path ?? args.file ?? '').trim();
    if (name === 'edit_file' || name === 'replace_in_file') {
      if (!file) continue;
      edits.push({
        op: 'replace',
        file,
        search: String(args.search ?? ''),
        replace: String(args.replace ?? ''),
        anchorSymbol: typeof args.anchorSymbol === 'string' ? args.anchorSymbol : undefined,
      });
    } else if (name === 'create_file') {
      if (!file) continue;
      edits.push({ op: 'create', file, content: String(args.content ?? '') });
    } else if (name === 'delete_file') {
      if (!file) continue;
      edits.push({ op: 'delete', file });
    }
  }
  return edits;
}

function editsToToolCalls(edits: CodeEdit[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const [i, edit] of edits.entries()) {
    if (!edit.file.trim()) continue;
    if (edit.op === 'replace') {
      calls.push({
        id: `residual_${i}`,
        name: 'edit_file',
        arguments: { path: edit.file, search: edit.search, replace: edit.replace },
      });
    } else if (edit.op === 'create') {
      calls.push({
        id: `residual_${i}`,
        name: 'create_file',
        arguments: { path: edit.file, content: edit.content },
      });
    } else {
      calls.push({
        id: `residual_${i}`,
        name: 'delete_file',
        arguments: { path: edit.file },
      });
    }
  }
  return calls;
}

/**
 * Lift a printed tool / PatchIR / `{path,search,replace}` JSON dump into
 * tool calls. Live Code Mode Review (#2662) prints this instead of
 * `<tool_call>` or SEARCH/REPLACE; `looksLikeToolCallDump` already flags it,
 * but without this lift the loop dies as no-tools after the dump retries.
 */
export function dumpEditsToToolCalls(text: string, opts: ParseEditsOptions = {}): ToolCall[] {
  return editsToToolCalls(parseEditDump(text, opts));
}

/** JSON / PatchIR / named-tool dumps → the same {@link CodeEdit} list as SEARCH/REPLACE. */
export function parseEditDump(text: string, opts: ParseEditsOptions = {}): CodeEdit[] {
  const edits: CodeEdit[] = [];
  for (const value of extractJsonValues(text)) {
    edits.push(...editsFromDumpValue(value, opts.defaultFile ?? ''));
  }
  return edits;
}

function extractJsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  const seen = new Set<string>();
  const push = (raw: string): void => {
    const parsed = parseLooseJson(raw);
    if (parsed === null || typeof parsed !== 'object') return;
    const key = JSON.stringify(parsed);
    if (seen.has(key)) return;
    seen.add(key);
    values.push(parsed);
  };
  const trimmed = (text ?? '').trim();
  if (trimmed) push(stripFence(trimmed));
  for (const m of (text ?? '').matchAll(/```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/g)) {
    push(m[1] ?? '');
  }
  if (values.length === 0) {
    for (const blob of balancedJsonObjects(text ?? '')) push(blob);
  }
  return values;
}

function stripFence(text: string): string {
  return text.replace(/^```(?:json|tool_call|tool)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

/** Strict JSON first; then quote unquoted keys / identifier values (Flow dumps). */
export function parseLooseJson(raw: string): unknown | null {
  const t = stripFence(raw).trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* continue */
  }
  const quotedKeys = t.replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":');
  try {
    return JSON.parse(quotedKeys);
  } catch {
    /* continue */
  }
  const quotedVals = quotedKeys.replace(/:\s*([A-Za-z_][\w.-]*)\s*([,}])/g, ':"$1"$2');
  try {
    return JSON.parse(quotedVals);
  } catch {
    return null;
  }
}

function balancedJsonObjects(text: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

function dumpTrimKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k.trim()] = v && typeof v === 'object' && !Array.isArray(v) ? dumpTrimKeys(v) : v;
  }
  return out;
}

function dumpString(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string') return v;
  }
  return '';
}

function unwrapDumpObject(o: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['patch', 'tool_call', 'function', 'edit', 'data', 'payload'] as const) {
    const inner = o[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      return dumpTrimKeys(inner) as Record<string, unknown>;
    }
  }
  if (Array.isArray(o.tool_calls) && o.tool_calls.length === 1) {
    const first = o.tool_calls[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      return dumpTrimKeys(first) as Record<string, unknown>;
    }
  }
  return o;
}

function editsFromDumpValue(value: unknown, defaultFile: string): CodeEdit[] {
  if (Array.isArray(value)) {
    return value.flatMap((v) => editsFromDumpValue(v, defaultFile));
  }
  if (!value || typeof value !== 'object') return [];
  let o = dumpTrimKeys(value) as Record<string, unknown>;
  o = unwrapDumpObject(o);
  if (Array.isArray(o.operations)) return editsFromDumpValue(o.operations, defaultFile);
  const nested = o.arguments ?? o.parameters ?? o.input;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const inner = dumpTrimKeys(nested) as Record<string, unknown>;
    if (typeof o.name === 'string' && inner.name === undefined) inner.name = o.name;
    if (typeof o.tool === 'string' && inner.name === undefined) inner.name = o.tool;
    if (typeof o.op === 'string' && inner.op === undefined) inner.op = o.op;
    return editsFromDumpValue(inner, defaultFile);
  }
  if (typeof nested === 'string' && nested.trim().startsWith('{')) {
    const parsed = parseLooseJson(nested);
    if (parsed && typeof parsed === 'object') return editsFromDumpValue(parsed, defaultFile);
  }
  const file = dumpString(o, ['path', 'file', 'id']) || (defaultFile ?? '').trim();
  const op = dumpString(o, ['op', 'name', 'tool']).toLowerCase().replace(/[\s-]+/g, '_');
  const search = dumpString(o, ['search', 'old_string', 'oldString', 'old_text', 'oldText', 'old']);
  const replace = dumpString(o, ['replace', 'replacement', 'new_string', 'newString', 'new_text', 'newText']);
  const content = dumpString(o, ['content']);
  if ((op === 'create_file' || op === 'create') && file && content) {
    return [{ op: 'create', file, content }];
  }
  if ((op === 'delete_file' || op === 'delete') && file) {
    return [{ op: 'delete', file }];
  }
  if (file && search && replace && search !== replace) {
    return [{ op: 'replace', file, search, replace, anchorSymbol: typeof o.anchorSymbol === 'string' ? o.anchorSymbol : undefined }];
  }
  return [];
}

/**
 * One-shot assess path: residual text, then JSON/PatchIR dumps, then native
 * tool calls. Hosted Review often returns `edit_file` on the function-calling
 * wire with an empty body — that must still become a patch.
 */
export function collectProviderEdits(
  result: { text?: string; toolCalls?: ToolCall[] },
  opts: ParseEditsOptions = {},
): CodeEdit[] {
  const fromText = parseEdits(result.text ?? '', opts);
  if (fromText.some((e) => e.file.trim())) return fromText.filter((e) => e.file.trim());
  const fromDump = parseEditDump(result.text ?? '', opts);
  if (fromDump.some((e) => e.file.trim())) return fromDump.filter((e) => e.file.trim());
  return toolCallsToEdits(result.toolCalls ?? []);
}

function looksLikePath(s: string): boolean {
  if (/\s/.test(s.replace(/:$/, ''))) return false; // paths don't contain spaces
  return /\//.test(s) || /\.[A-Za-z0-9]{1,8}:?$/.test(s);
}

/**
 * Apply a single edit to a file's current content (or `null` when the file does
 * not exist). Pure: returns the new content and an outcome; never touches disk.
 * The `spans` are the graph's symbol spans for this file — when a SEARCH is
 * textually ambiguous, a match inside the `anchorSymbol` span wins, which is how
 * the graph makes a terse edit land where the planner meant it to.
 */
export function applyEdit(
  content: string | null,
  edit: CodeEdit,
  spans: SymbolSpan[] = [],
): { content: string | null; outcome: EditOutcome } {
  if (edit.op === 'create') {
    if (content !== null && content !== edit.content) {
      return { content, outcome: { edit, status: 'conflict', reason: `${edit.file} already exists — refusing to overwrite it with a create; use a replace edit instead` } };
    }
    return { content: edit.content, outcome: { edit, status: content === edit.content ? 'no-op' : 'applied', matchedBy: 'exact' } };
  }

  if (edit.op === 'delete') {
    if (content === null) return { content: null, outcome: { edit, status: 'no-op', reason: `${edit.file} does not exist — nothing to delete` } };
    return { content: null, outcome: { edit, status: 'applied', matchedBy: 'exact' } };
  }

  // op === 'replace'
  if (content === null) {
    return { content: null, outcome: { edit, status: 'not-found', reason: `${edit.file} does not exist — a replace needs an existing file (did you mean CREATE ${edit.file}?)` } };
  }
  if (edit.search === '') {
    // Empty SEARCH means "prepend" only when the file is empty; otherwise it is
    // ambiguous and we refuse rather than guess a location.
    if (content === '') return { content: edit.replace, outcome: { edit, status: 'applied', matchedBy: 'exact' } };
    return { content, outcome: { edit, status: 'invalid', reason: 'empty SEARCH on a non-empty file is ambiguous — quote the exact lines to replace' } };
  }
  if (edit.search === edit.replace) {
    return { content, outcome: { edit, status: 'no-op', reason: 'SEARCH and REPLACE are identical — no change' } };
  }

  const located = locate(content, edit.search, edit.anchorSymbol, spans, edit.file);
  if (located.kind === 'none') {
    return { content, outcome: { edit, status: 'not-found', reason: `the SEARCH text was not found in ${edit.file} — it must match the current file exactly (whitespace-flexible)` } };
  }
  if (located.kind === 'ambiguous') {
    return {
      content,
      outcome: {
        edit,
        status: 'ambiguous',
        reason: `the SEARCH text matches ${located.count} places in ${edit.file} — add more surrounding lines, or name the symbol so the graph can disambiguate`,
      },
    };
  }
  const next = content.slice(0, located.from) + edit.replace + content.slice(located.to);
  return { content: next, outcome: { edit, status: 'applied', matchedBy: located.matchedBy } };
}

/**
 * Apply a set of edits across a set of files. `read(file)` returns current
 * content or `null`. Edits are applied in the order given, threading each
 * file's evolving content so two edits to the same file compose. Returns, per
 * file, its before/after content and the per-edit outcomes — the dry-run
 * product the session turns into diffs. Deterministic given a deterministic
 * `read`.
 */
export function applyEdits(
  edits: CodeEdit[],
  read: (file: string) => string | null,
  spansByFile: (file: string) => SymbolSpan[] = () => [],
): Map<string, { before: string | null; after: string | null; outcomes: EditOutcome[] }> {
  const state = new Map<string, { before: string | null; after: string | null; outcomes: EditOutcome[] }>();
  for (const edit of edits) {
    let entry = state.get(edit.file);
    if (!entry) {
      const before = read(edit.file);
      entry = { before, after: before, outcomes: [] };
      state.set(edit.file, entry);
    }
    const { content, outcome } = applyEdit(entry.after, edit, spansByFile(edit.file));
    entry.after = content;
    entry.outcomes.push(outcome);
  }
  return state;
}

type Located =
  | { kind: 'unique'; from: number; to: number; matchedBy: 'exact' | 'whitespace' | 'graph-span' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'none' };

/**
 * Find the SEARCH text in the content. Escalates: (1) exact substring; (2)
 * whitespace-flexible (indentation/trailing-space differences tolerated); and
 * when either is ambiguous, (3) narrow to the `anchorSymbol`'s graph span so the
 * intended occurrence wins. Line-oriented so offsets map back to real edits.
 */
function locate(content: string, search: string, anchor: string | undefined, spans: SymbolSpan[], file: string): Located {
  const exact = allIndexes(content, search);
  if (exact.length === 1) return { kind: 'unique', from: exact[0], to: exact[0] + search.length, matchedBy: 'exact' };
  if (exact.length > 1) {
    const scoped = scopeToAnchor(content, exact.map((from) => ({ from, to: from + search.length })), anchor, spans, file);
    if (scoped) return { ...scoped, matchedBy: 'graph-span' };
    return { kind: 'ambiguous', count: exact.length };
  }

  // Whitespace-flexible: compare with runs of whitespace collapsed and each
  // line trimmed, then map the match back to real character offsets.
  const flex = flexIndexes(content, search);
  if (flex.length === 1) return { kind: 'unique', from: flex[0].from, to: flex[0].to, matchedBy: 'whitespace' };
  if (flex.length > 1) {
    const scoped = scopeToAnchor(content, flex, anchor, spans, file);
    if (scoped) return { ...scoped, matchedBy: 'graph-span' };
    return { kind: 'ambiguous', count: flex.length };
  }
  return { kind: 'none' };
}

/** Every start index of `needle` in `hay` (non-overlapping left-to-right). */
function allIndexes(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === '') return out;
  let from = 0;
  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

/**
 * Whitespace-flexible match: align the search's trimmed non-empty lines against
 * the content's lines, tolerating indentation and trailing-whitespace drift
 * (the single most common reason an otherwise-correct terse edit fails to
 * apply). Returns real character offset ranges for each full-block match.
 */
function flexIndexes(content: string, search: string): { from: number; to: number }[] {
  const cLines = content.split('\n');
  const sLines = search.split('\n');
  // Trim a possible leading/trailing blank line from the search block.
  while (sLines.length && sLines[0].trim() === '') sLines.shift();
  while (sLines.length && sLines[sLines.length - 1].trim() === '') sLines.pop();
  if (sLines.length === 0) return [];
  const sNorm = sLines.map((l) => l.trim());

  // Precompute char offset of the start of each content line.
  const lineStart: number[] = [];
  let acc = 0;
  for (const l of cLines) {
    lineStart.push(acc);
    acc += l.length + 1; // +1 for the '\n'
  }

  const out: { from: number; to: number }[] = [];
  for (let i = 0; i + sNorm.length <= cLines.length; i++) {
    let ok = true;
    for (let j = 0; j < sNorm.length; j++) {
      if (cLines[i + j].trim() !== sNorm[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const from = lineStart[i];
    const lastLine = i + sNorm.length - 1;
    const to = lineStart[lastLine] + cLines[lastLine].length; // end of the last matched line (exclusive of '\n')
    out.push({ from, to });
  }
  return out;
}

/** If exactly one candidate falls inside the anchor symbol's span, pick it. */
function scopeToAnchor(
  content: string,
  candidates: { from: number; to: number }[],
  anchor: string | undefined,
  spans: SymbolSpan[],
  file: string,
): { kind: 'unique'; from: number; to: number } | null {
  if (!anchor) return null;
  const span = spans.find((s) => s.file === file && s.qualifiedName === anchor);
  if (!span) return null;
  const lineOf = lineIndexer(content);
  const inside = candidates.filter((c) => {
    const line = lineOf(c.from); // 1-based
    return line >= span.start && line <= span.end;
  });
  if (inside.length === 1) return { kind: 'unique', from: inside[0].from, to: inside[0].to };
  return null;
}

/** Returns a function mapping a char offset → 1-based line number. */
function lineIndexer(content: string): (offset: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === '\n') starts.push(i + 1);
  return (offset: number) => {
    // binary search for the greatest line start <= offset
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
