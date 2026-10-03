/**
 * Data models declared in a repository, with the line each table, column and
 * key is declared on — the facts behind the review document's data-store view.
 *
 * Raw facts only, and public: which tables a schema file declares, their
 * fields, primary keys and foreign keys. Deciding which of them a change
 * touches, which reads and writes to show and which entry points are the use
 * cases is the Architecture module's job (`vg_review_diagrams`), not this
 * file's.
 *
 * Sources, each parsed from the file text as it is on the reviewed side:
 *
 *   - Prisma (`*.prisma`): `model` blocks, `@id`, `@@map`, and `@relation(fields,
 *     references)` turned into a foreign key on the scalar field.
 *   - SQL DDL (`*.sql`): `CREATE TABLE`, column and table-level `PRIMARY KEY`,
 *     `REFERENCES` and `FOREIGN KEY`.
 *   - EF Core (`*.cs`): every `DbSet<T>` on a context class, and the auto
 *     properties of `T` (and its base classes): `[Key]`, `Id` / `TId` keys,
 *     and `XId` beside a navigation `X` as a foreign key.
 *
 * Credentials are never read: Prisma `datasource` blocks yield only the
 * provider name, and SQL files are read for `CREATE TABLE` statements alone.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultRun, type ChangeSet, type GitRunner } from './git.js';
import { headIsWorkingTree } from './groups.js';

export interface ModelField {
  key: string;
  label: string;
  data_type: string;
  nullable?: boolean;
  primary_key?: boolean;
  /** Collection key and field key in the same store. */
  references?: { collection: string; field: string };
  line: number;
}

export interface ModelCollection {
  /** The entity or table name as code refers to it (`Product`, `orders`). */
  key: string;
  /** The name to show: the table name when it is mapped to one. */
  label: string;
  path: string;
  start: number;
  end: number;
  fields: ModelField[];
}

export interface ModelStore {
  key: string;
  label: string;
  source: 'prisma' | 'sql' | 'efcore';
  storage: 'relational' | 'document';
  /** The file that declares the store: the schema file, or the context class. */
  path: string;
  line: number;
  collections: ModelCollection[];
}

/** Limits that keep one malformed or generated file from flooding the payload. */
const MAX_COLLECTIONS = 400;
const MAX_FIELDS = 120;

export interface SourceFile {
  path: string;
  text: string;
}

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Index of the `}` matching the `{` at `open`, or -1. Ignores braces in strings and comments, roughly. */
function matchBrace(text: string, open: number): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inStr = c;
    else if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? text.length : nl;
    } else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

// ─── Prisma ─────────────────────────────────────────────────────────────────

const PRISMA_SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes', 'Unsupported']);

export function parsePrisma(file: SourceFile): ModelStore | null {
  const { text, path } = file;
  const provider = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"([\w-]+)"/.exec(text)?.[1] ?? null;
  const models: { name: string; start: number; end: number; body: string; bodyLine: number }[] = [];
  const re = /^[ \t]*model\s+(\w+)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const open = text.indexOf('{', m.index);
    const close = matchBrace(text, open);
    if (close < 0) continue;
    models.push({ name: m[1], start: lineAt(text, m.index), end: lineAt(text, close), body: text.slice(open + 1, close), bodyLine: lineAt(text, open) });
  }
  if (models.length === 0) return null;
  const modelNames = new Set(models.map((x) => x.name));
  const collections: ModelCollection[] = [];
  for (const model of models.slice(0, MAX_COLLECTIONS)) {
    const fields: ModelField[] = [];
    const fks = new Map<string, { collection: string; field: string }>();
    let table = model.name;
    model.body.split('\n').forEach((raw, i) => {
      const line = model.bodyLine + i;
      const l = raw.replace(/\/\/.*$/, '').trim();
      const map = /^@@map\(\s*"([^"]+)"/.exec(l);
      if (map) table = map[1];
      const ids = /^@@id\(\s*\[([^\]]+)\]/.exec(l);
      if (ids) for (const f of ids[1].split(',').map((s) => s.trim())) fks.set(`@id:${f}`, { collection: '', field: '' });
      const fm = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(l);
      if (!fm || l.startsWith('@@')) return;
      const [, name, type, list, optional, rest] = fm;
      if (modelNames.has(type)) {
        // A relation field: its scalar side carries the foreign key.
        const rel = /@relation\([^)]*fields:\s*\[([^\]]+)\][^)]*references:\s*\[([^\]]+)\]/.exec(rest);
        if (rel) {
          const from = rel[1].split(',').map((s) => s.trim());
          const to = rel[2].split(',').map((s) => s.trim());
          from.forEach((f, k) => fks.set(f, { collection: type, field: to[k] ?? to[0] }));
        }
        return;
      }
      if (!PRISMA_SCALARS.has(type) && !/^[A-Z]/.test(type)) return;
      fields.push({
        key: name,
        label: (/@map\(\s*"([^"]+)"/.exec(rest)?.[1]) ?? name,
        data_type: `${type}${list ? '[]' : ''}`,
        ...(optional ? { nullable: true } : {}),
        ...(/@id\b/.test(rest) ? { primary_key: true } : {}),
        line,
      });
    });
    for (const f of fields) {
      const fk = fks.get(f.key);
      if (fk && fk.collection) f.references = fk;
      if (fks.has(`@id:${f.key}`)) f.primary_key = true;
    }
    collections.push({ key: model.name, label: table, path, start: model.start, end: model.end, fields: fields.slice(0, MAX_FIELDS) });
  }
  return {
    key: `prisma:${path}`,
    label: provider ? `Prisma (${provider})` : 'Prisma',
    source: 'prisma',
    storage: provider === 'mongodb' ? 'document' : 'relational',
    path,
    line: 1,
    collections,
  };
}

// ─── SQL DDL ────────────────────────────────────────────────────────────────

function sqlIdent(raw: string): string {
  const last = raw.trim().split('.').pop() ?? raw;
  return last.replace(/^[`"[]|[`"\]]$/g, '');
}

/** Split a CREATE TABLE body on top-level commas, keeping each part's offset. */
function splitDefs(body: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if ((c === ',' && depth === 0) || i === body.length) {
      out.push({ text: body.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  return out;
}

export function parseSqlTables(file: SourceFile): ModelCollection[] {
  const { text, path } = file;
  const out: ModelCollection[] = [];
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([`"[\]\w.]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < MAX_COLLECTIONS) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) continue;
    const name = sqlIdent(m[1]);
    const body = text.slice(open + 1, close);
    const fields: ModelField[] = [];
    const tablePk: string[] = [];
    const tableFk: { cols: string[]; table: string; refCols: string[] }[] = [];
    for (const def of splitDefs(body)) {
      const d = def.text.trim().replace(/\s+/g, ' ');
      if (!d) continue;
      const line = lineAt(text, open + 1 + def.offset + (def.text.length - def.text.trimStart().length));
      const pk = /^(?:constraint \S+ )?primary key\s*\(([^)]+)\)/i.exec(d);
      if (pk) {
        tablePk.push(...pk[1].split(',').map(sqlIdent));
        continue;
      }
      const fk = /^(?:constraint \S+ )?foreign key\s*\(([^)]+)\)\s*references\s+([`"[\]\w.]+)\s*\(([^)]+)\)/i.exec(d);
      if (fk) {
        tableFk.push({ cols: fk[1].split(',').map(sqlIdent), table: sqlIdent(fk[2]), refCols: fk[3].split(',').map(sqlIdent) });
        continue;
      }
      if (/^(constraint|unique|check|index|key)\b/i.test(d)) continue;
      const col = /^([`"[\]\w]+)\s+([\w]+(?:\s*\([^)]*\))?)(.*)$/.exec(d);
      if (!col) continue;
      const rest = col[3];
      const ref = /references\s+([`"[\]\w.]+)\s*(?:\(([^)]+)\))?/i.exec(rest);
      fields.push({
        key: sqlIdent(col[1]),
        label: sqlIdent(col[1]),
        data_type: col[2].replace(/\s+/g, ''),
        ...(!/not null|primary key/i.test(rest) ? { nullable: true } : {}),
        ...(/primary key/i.test(rest) ? { primary_key: true } : {}),
        ...(ref ? { references: { collection: sqlIdent(ref[1]), field: ref[2] ? sqlIdent(ref[2]) : 'id' } } : {}),
        line,
      });
    }
    for (const f of fields) {
      if (tablePk.includes(f.key)) {
        f.primary_key = true;
        delete f.nullable;
      }
      for (const fk of tableFk) {
        const k = fk.cols.indexOf(f.key);
        if (k >= 0) f.references = { collection: fk.table, field: fk.refCols[k] ?? fk.refCols[0] };
      }
    }
    out.push({ key: name, label: name, path, start: lineAt(text, m.index), end: lineAt(text, close), fields: fields.slice(0, MAX_FIELDS) });
  }
  return out;
}

// ─── EF Core ────────────────────────────────────────────────────────────────

interface CsClass {
  name: string;
  namespace: string;
  /** `using` directives of the file the class is declared in. */
  usings: string[];
  bases: string[];
  path: string;
  start: number;
  end: number;
  body: string;
  bodyLine: number;
}

/** Every class declaration in a C# file, with its body. */
export function csClasses(file: SourceFile): CsClass[] {
  const out: CsClass[] = [];
  const namespace = /^\s*namespace\s+([\w.]+)/m.exec(file.text)?.[1] ?? '';
  const usings = [...file.text.matchAll(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm)].map((u) => u[1]);
  const re = /\b(?:class|record)\s+(\w+)(?:<[^>{]*>)?(?:\s*\([^)]*\))?\s*(?::\s*([^{\n]+?))?\s*(?:where\b[^{]*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(file.text)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBrace(file.text, open);
    if (close < 0) continue;
    out.push({
      name: m[1],
      namespace,
      usings,
      bases: (m[2] ?? '').split(',').map((s) => s.trim().replace(/<.*$/, '')).filter(Boolean),
      path: file.path,
      start: lineAt(file.text, m.index),
      end: lineAt(file.text, close),
      body: file.text.slice(open + 1, close),
      bodyLine: lineAt(file.text, open),
    });
  }
  return out;
}

const CS_PROP = /^\s*(\[[^\]]*\]\s*)*public\s+(?:(?:virtual|required|override|new)\s+)*([\w.<>,?\[\] ]+?)\s+(\w+)\s*(?:\{\s*get\s*;|=>)/;

/** Auto-properties declared directly in a class body (not in nested classes), with their lines. */
function csProps(cls: CsClass): { type: string; name: string; key: boolean; line: number }[] {
  const props: { type: string; name: string; key: boolean; line: number }[] = [];
  const lines = cls.body.split('\n');
  let depth = 0;
  let pendingKey = false;
  lines.forEach((raw, i) => {
    if (depth === 0) {
      if (/^\s*\[\s*Key\s*[\],(]/.test(raw)) pendingKey = true;
      const p = CS_PROP.exec(raw);
      if (p) {
        props.push({ type: p[2].trim(), name: p[3], key: pendingKey || /\[\s*Key\s*[\],(]/.test(raw), line: cls.bodyLine + i });
        pendingKey = false;
      } else if (raw.trim() && !raw.trim().startsWith('[') && !raw.trim().startsWith('//')) {
        pendingKey = false;
      }
    }
    for (const ch of raw.replace(/"(?:\\.|[^"\\])*"/g, '')) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    // An auto-property's own `{ get; set; }` opens and closes on its line.
    if (depth < 0) depth = 0;
  });
  return props;
}

const ENTITY_COLLECTION = /^(?:ICollection|IList|List|IEnumerable|HashSet|ISet|IReadOnlyCollection)<\s*(\w+)\s*>$/;

export function parseEfCore(files: SourceFile[]): ModelStore[] {
  const classes = files.flatMap(csClasses);
  const candidates = new Map<string, CsClass[]>();
  for (const c of classes) candidates.set(c.name, [...(candidates.get(c.name) ?? []), c]);
  // Several classes can share a name (an entity and a DTO); prefer the one the
  // referring file can see — its own namespace or one it imports (matching on
  // a suffix, since solutions rename their root namespace) — then one in a
  // domain or entities folder.
  const nsMatch = (a: string, b: string) => !!a && !!b && (a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`));
  const resolve = (name: string, from: CsClass): CsClass | undefined => {
    const list = candidates.get(name);
    if (!list || list.length === 0) return undefined;
    const score = (c: CsClass) =>
      (nsMatch(c.namespace, from.namespace) || from.usings.some((u) => nsMatch(c.namespace, u)) ? 4 : 0) +
      (/(^|\/)(Entities|Domain|Models?|Aggregates?)\//i.test(c.path) ? 2 : 0);
    return [...list].sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path) || a.start - b.start)[0];
  };
  const stores: ModelStore[] = [];
  for (const ctx of classes) {
    const sets = csProps(ctx)
      .map((p) => ({ p, entity: /^DbSet<\s*(\w+)\s*>$/.exec(p.type)?.[1] }))
      .filter((x): x is { p: (typeof x)['p']; entity: string } => !!x.entity);
    if (sets.length === 0) continue;
    const entities = new Set(sets.map((s) => s.entity));
    const collections: ModelCollection[] = [];
    for (const { p, entity } of sets.slice(0, MAX_COLLECTIONS)) {
      const cls = resolve(entity, ctx);
      if (!cls) {
        collections.push({ key: entity, label: p.name, path: ctx.path, start: p.line, end: p.line, fields: [] });
        continue;
      }
      // The entity's own properties, then its base classes' (an `Id` often lives on a base entity).
      const chain: CsClass[] = [cls];
      for (let k = 0, cur = cls; k < 4; k++) {
        const base = cur.bases.map((b) => resolve(b, cur)).find(Boolean);
        if (!base || chain.includes(base)) break;
        chain.push(base);
        cur = base;
      }
      const props = chain.flatMap((c) => csProps(c).map((x) => ({ ...x, owner: c })));
      const navs = new Map<string, string>();
      for (const x of props) if (entities.has(x.type.replace(/\?$/, ''))) navs.set(x.name, x.type.replace(/\?$/, ''));
      const fields: ModelField[] = [];
      const seen = new Set<string>();
      for (const x of props) {
        const bare = x.type.replace(/\?$/, '');
        if (seen.has(x.name) || entities.has(bare) || ENTITY_COLLECTION.test(bare)) continue;
        seen.add(x.name);
        const isKey = x.key || x.name === 'Id' || x.name === `${entity}Id`;
        // `XId` pairs with a navigation named `X`, or else with one whose type is the entity `X`.
        const stem = x.name.endsWith('Id') && x.name.length > 2 ? x.name.slice(0, -2) : null;
        const nav = stem ? (navs.get(stem) ?? (entities.has(stem) && [...navs.values()].includes(stem) ? stem : undefined)) : undefined;
        const field: ModelField = {
          key: x.name,
          label: x.name,
          data_type: x.type,
          ...(x.type.endsWith('?') ? { nullable: true } : {}),
          ...(isKey ? { primary_key: true } : {}),
          ...(nav ? { references: { collection: nav, field: 'Id' } } : {}),
          line: x.line,
        };
        // A key inherited from a base class is pinned where it is declared.
        if (x.owner !== cls) field.label = x.name;
        fields.push(field);
      }
      collections.push({ key: entity, label: p.name, path: cls.path, start: cls.start, end: cls.end, fields: fields.slice(0, MAX_FIELDS) });
    }
    stores.push({ key: `efcore:${ctx.name}`, label: ctx.name, source: 'efcore', storage: 'relational', path: ctx.path, line: ctx.start, collections });
  }
  return stores;
}

// ─── All sources ────────────────────────────────────────────────────────────

/** Which files could declare a data model. The caller reads only these. */
export function isModelFile(path: string): boolean {
  return /\.(prisma|sql)$/i.test(path) || /\.cs$/i.test(path);
}

/**
 * Data models declared across `files`. `.cs` files are passed only when they
 * mention `DbSet<` or declare classes an entity might be; the caller decides.
 * Deterministic: stores and collections are sorted.
 */
export function extractDataModels(files: SourceFile[]): ModelStore[] {
  const stores: ModelStore[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) if (/\.prisma$/i.test(f.path)) {
    const s = parsePrisma(f);
    if (s) stores.push(s);
  }
  const sqlTables = sorted.filter((f) => /\.sql$/i.test(f.path)).flatMap(parseSqlTables);
  if (sqlTables.length > 0) {
    // Migrations redeclare tables; the latest file (by path order) wins.
    const byName = new Map<string, ModelCollection>();
    for (const t of sqlTables) byName.set(t.key.toLowerCase(), t);
    const collections = [...byName.values()].sort((a, b) => a.key.localeCompare(b.key));
    stores.push({ key: 'sql', label: 'SQL schema', source: 'sql', storage: 'relational', path: collections[0].path, line: collections[0].start, collections });
  }
  stores.push(...parseEfCore(sorted.filter((f) => /\.cs$/i.test(f.path))));
  return stores.sort((a, b) => a.key.localeCompare(b.key));
}

// ─── Reading the reviewed side ──────────────────────────────────────────────

/** Files read at most, and the largest one read, so a vendored tree cannot stall a review. */
const MAX_FILES = 4000;
const MAX_BYTES = 512 * 1024;

/**
 * The data models on the head side of a change: the working tree when the
 * review is in place, the head commit otherwise. Paths are repo-relative.
 * Never throws; a repository with no model files yields none.
 */
export function readDataModels(
  change: ChangeSet,
  sides: { base?: string; inPlace?: boolean },
  run: GitRunner = defaultRun,
): ModelStore[] {
  const fromTree = headIsWorkingTree(sides);
  const listed = fromTree
    ? run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], change.topLevel)
    : run(['ls-tree', '-r', '-z', '--name-only', change.headSha], change.topLevel);
  if (listed.status !== 0) return [];
  let paths = [...new Set(listed.stdout.split('\0').filter((p) => p && isModelFile(p)))].sort();
  if (!fromTree && paths.some((p) => /\.cs$/i.test(p))) {
    // Reading a commit costs a git call per file: skip C# unless one file declares an EF Core context.
    const hits = run(['grep', '-l', '-z', '-F', 'DbSet<', change.headSha, '--', '*.cs'], change.topLevel);
    if (hits.status !== 0 || !hits.stdout.trim()) paths = paths.filter((p) => !/\.cs$/i.test(p));
  }
  paths = paths.slice(0, MAX_FILES);
  const files: SourceFile[] = [];
  for (const p of paths) {
    let text: string | null = null;
    if (fromTree) {
      try {
        const abs = path.join(change.topLevel, p);
        const st = fs.statSync(abs);
        if (st.isFile() && st.size <= MAX_BYTES) text = fs.readFileSync(abs, 'utf8');
      } catch {
        text = null;
      }
    } else {
      const res = run(['show', `${change.headSha}:${p}`], change.topLevel);
      if (res.status === 0 && res.stdout.length <= MAX_BYTES) text = res.stdout;
    }
    if (text !== null) files.push({ path: p, text });
  }
  return extractDataModels(files);
}
