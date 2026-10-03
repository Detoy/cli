import { describe, expect, it } from 'vitest';
import type { ChangeSet, ChangedFile } from './git.js';
import type { HaileProvider } from '../engine/haile/haile-provider.js';
import { emptySignals, groupChangeSet, type DiffGroup } from './groups.js';
import {
  blockId,
  buildReviewDoc,
  DOC_SCHEMA,
  markdownPinLinks,
  parsePinLink,
  pinLink,
  renderReviewDocMarkdown,
  sealReviewDoc,
  targetIssues,
  validateReviewDoc,
  type DocBlock,
  type PinResolver,
  type ReviewDoc,
} from './doc.js';
import type { AnalysisCapsule, ReviewFindings } from './schemas.js';

const files: ChangedFile[] = [
  { path: 'src/services/orders.ts', op: 'modified', addedLines: 4, removedLines: 1, hunks: [{ start: 10, end: 13 }] },
  { path: 'src/controllers/orders.ts', op: 'added', addedLines: 20, removedLines: 0, hunks: [{ start: 1, end: 20 }] },
  { path: 'src/legacy.ts', op: 'removed', addedLines: 0, removedLines: 12, hunks: [] },
  { path: 'src/orders.test.ts', op: 'modified', addedLines: 5, removedLines: 0, hunks: [{ start: 3, end: 7 }] },
];

const change: ChangeSet = {
  topLevel: '/repo',
  baseSha: 'a'.repeat(40),
  headSha: 'c'.repeat(40),
  mergeBase: 'a'.repeat(40),
  ref: null,
  dirty: false,
  dirtyTreeHash: null,
  files,
  remote: null,
};

/** head: 40 lines per surviving file; base: legacy.ts has 12, orders.ts 30. */
const resolve: PinResolver = (side, p) => {
  if (side === 'head') return p === 'src/legacy.ts' ? null : p.startsWith('src/') ? 40 : null;
  return p === 'src/legacy.ts' ? 12 : p === 'src/services/orders.ts' ? 30 : null;
};

/** Stands in for the Architecture module: tests in their own group, the rest implementation. */
const grouper: HaileProvider = {
  version: () => 'test',
  classify: () => null,
  reviewGroups: (payload) => {
    const files = (payload as { files: { path: string; op: string; added_lines: number; removed_lines: number }[] }).files;
    const make = (kind: DiffGroup['kind'], list: typeof files): DiffGroup => ({
      id: `grp:${kind}`,
      kind,
      label: kind === 'tests' ? 'Tests' : 'Implementation',
      area: null,
      layer: null,
      files: list.map((f) => ({ path: f.path, op: f.op as DiffGroup['files'][number]['op'], added_lines: f.added_lines, removed_lines: f.removed_lines, reason: 'test' })),
      added_lines: list.reduce((n, f) => n + f.added_lines, 0),
      removed_lines: list.reduce((n, f) => n + f.removed_lines, 0),
    });
    const tests = files.filter((f) => f.path.includes('.test.'));
    const impl = files.filter((f) => !f.path.includes('.test.'));
    return { groups: [make('implementation', impl), ...(tests.length ? [make('tests', tests)] : [])] };
  },
};

function built(extra: Partial<Parameters<typeof buildReviewDoc>[0]> = {}): ReviewDoc {
  return buildReviewDoc({ change, groups: groupChangeSet(change, emptySignals(), grouper), repoKey: 'sha256:repo', resolve, ...extra });
}

function docWith(sections: ReviewDoc['sections']): ReviewDoc {
  return { ...built(), sections };
}

const pin = (start = 1, end = start, p = 'src/services/orders.ts', side: 'head' | 'base' = 'head') => ({ side, path: p, start, end });

const flow = (over: Partial<Extract<DocBlock, { type: 'flow' }>> = {}): DocBlock => ({
  type: 'flow',
  title: 'Place order',
  primary: true,
  nodes: [
    { key: 'start', label: 'POST /orders', kind: 'terminal' },
    { key: 'valid', label: 'Valid?', kind: 'decision', pins: [pin(10, 11)] },
    { key: 'save', label: 'Save order', pins: [pin(12, 13)], status: 'added', origin: 'graph' },
    { key: 'reject', label: '400', kind: 'terminal' },
  ],
  edges: [
    { from: 'start', to: 'valid' },
    { from: 'valid', to: 'save', kind: 'branch_true' },
    { from: 'valid', to: 'reject', kind: 'branch_false' },
  ],
  ...over,
});

const codes = (doc: unknown, r: PinResolver | null = resolve) => validateReviewDoc(doc, r).map((i) => i.code);

describe('buildReviewDoc — the deterministic first pass', () => {
  it('validates against its own rules, pins included', () => {
    expect(validateReviewDoc(built(), resolve)).toEqual([]);
  });

  it('is byte-identical across runs and seals a digest', () => {
    expect(JSON.stringify(built())).toBe(JSON.stringify(built()));
    expect(built().digest).toMatch(/^sha256:/);
    expect(built().schema_version).toBe(DOC_SCHEMA);
  });

  it('writes what and why plus implementation, and no design it has not derived', () => {
    const doc = built();
    expect(doc.sections.map((s) => s.kind)).toEqual(['what_why', 'implementation']);
    expect(doc.generator.notes.join(' ')).toMatch(/design is left out/);
  });

  it('links every hunk on the head side and a removed file on the base side', () => {
    const text = built().sections[1].blocks.map((b) => (b.type === 'markdown' ? b.text : '')).join('\n');
    expect(text).toContain('(head:src/services/orders.ts#L10-L13)');
    expect(text).toContain('(base:src/legacy.ts#L1-L12)');
  });

  it('peels tests into their own list rather than implementation', () => {
    const blocks = built().sections[1].blocks;
    const last = blocks[blocks.length - 1];
    expect(last.type === 'markdown' && last.text).toMatch(/Peeled off[\s\S]*src\/orders\.test\.ts/);
  });

  it('cites findings with pinned evidence, and drops spans that do not land', () => {
    const findings: ReviewFindings = {
      schema_version: 'vg.review.findings.v1',
      change_class: ['architecture'],
      architecture_findings: [
        {
          id: 'arch:skip:src/controllers/orders.ts',
          kind: 'architecture',
          severity: 'high',
          confidence: 0.9,
          claim: 'Controller calls the repository directly',
          evidence_ids: ['edge:1', 'edge:2'],
          target_alignment: 'regression',
          remediation: 'Go through the service',
          paths: ['src/controllers/orders.ts'],
        },
      ],
      security_findings: [],
      unknowns: [],
      required_checks: [],
    };
    const capsule = {
      evidence: [
        { id: 'edge:1', kind: 'graph_edge', path: 'src/controllers/orders.ts', start_line: 5, end_line: 6, protected_finding: false },
        { id: 'edge:2', kind: 'graph_edge', path: 'src/controllers/orders.ts', start_line: 90, end_line: 95, protected_finding: false },
      ],
    } as unknown as AnalysisCapsule;
    const doc = built({ findings, capsule });
    const callout = doc.sections[1].blocks.find((b) => b.type === 'callout');
    expect(callout).toMatchObject({ tone: 'risk', pins: [{ side: 'head', path: 'src/controllers/orders.ts', start: 5, end: 6 }] });
    expect(doc.generator.notes.join(' ')).toMatch(/1 finding evidence span did not land/);
    expect(validateReviewDoc(doc, resolve)).toEqual([]);
  });

  it('without the Architecture module: every file listed for reading, and the install note', () => {
    const doc = buildReviewDoc({ change, groups: groupChangeSet(change), repoKey: null, resolve });
    const text = doc.sections[1].blocks.map((b) => (b.type === 'markdown' ? b.text : '')).join('\n');
    expect(text).toContain('Changed files (not grouped)');
    expect(text).toContain('(head:src/services/orders.ts#L10-L13)');
    expect(text).not.toContain('Peeled off');
    expect(doc.generator.notes.join(' ')).toContain('vg module install arch');
    expect(validateReviewDoc(doc, resolve)).toEqual([]);
  });

  it('says plainly when there is nothing to review', () => {
    const empty = { ...change, files: [] };
    const doc = buildReviewDoc({ change: empty, groups: groupChangeSet(empty), repoKey: null, resolve });
    expect(doc.sections).toHaveLength(1);
    expect(validateReviewDoc(doc, resolve)).toEqual([]);
  });
});

describe('validateReviewDoc — the evidence rule', () => {
  it('rejects a pin past the end of the file, on a missing file, or reaching outside the repo', () => {
    const doc = docWith([
      {
        kind: 'implementation',
        blocks: [
          { type: 'code_peek', pin: pin(39, 41) },
          { type: 'code_peek', pin: pin(1, 1, 'lib/nope.ts') },
          { type: 'code_peek', pin: pin(1, 1, '../etc/passwd') },
          { type: 'code_peek', pin: { side: 'head', path: 'src/a.ts', start: 5, end: 2 } },
        ],
      },
    ]);
    expect(codes(doc)).toEqual(['pin_out_of_range', 'pin_missing_file', 'pin_path', 'pin_range']);
  });

  it('checks base-side pins against the base', () => {
    const doc = docWith([{ kind: 'implementation', blocks: [{ type: 'code_peek', pin: pin(25, 31, 'src/services/orders.ts', 'base') }] }]);
    expect(codes(doc)).toEqual(['pin_out_of_range']);
  });

  it('checks evidence links inside Markdown, and rejects malformed ones', () => {
    const doc = docWith([
      { kind: 'what_why', blocks: [{ type: 'markdown', text: 'See [ok](head:src/a.ts#L2-L3), [bad](head:src/a.ts#L2-L99) and [junk](head:src/a.ts)' }] },
    ]);
    expect(codes(doc)).toEqual(['pin_out_of_range', 'pin_link']);
  });

  it('skips pin landing checks without a resolver, but still checks shape', () => {
    const doc = docWith([{ kind: 'implementation', blocks: [{ type: 'code_peek', pin: pin(999, 999) }] }]);
    expect(codes(doc, null)).toEqual([]);
  });
});

describe('validateReviewDoc — document structure', () => {
  it('enforces section order and no repeats', () => {
    const md: DocBlock = { type: 'markdown', text: 'x' };
    expect(codes(docWith([{ kind: 'implementation', blocks: [md] }, { kind: 'what_why', blocks: [md] }]))).toEqual(['section_order']);
    expect(codes(docWith([{ kind: 'what_why', blocks: [md] }, { kind: 'what_why', blocks: [md] }]))).toEqual(['duplicate_section']);
  });

  it('requires exactly one primary diagram in design, and none elsewhere', () => {
    expect(codes(docWith([{ kind: 'design', blocks: [flow()] }]))).toEqual([]);
    expect(codes(docWith([{ kind: 'design', blocks: [flow({ primary: false })] }]))).toEqual(['primary_diagram']);
    expect(codes(docWith([{ kind: 'design', blocks: [flow(), flow()] }]))).toEqual(['primary_diagram']);
    expect(codes(docWith([{ kind: 'implementation', blocks: [flow()] }]))).toEqual(['primary_outside_design']);
    expect(codes(docWith([{ kind: 'design', blocks: [{ type: 'markdown', text: 'x', primary: true } as DocBlock] }]))).toContain('primary_type');
  });

  it('rejects duplicate block ids and unknown block types', () => {
    const doc = docWith([
      { kind: 'implementation', blocks: [{ type: 'markdown', id: 'a', text: 'x' }, { type: 'markdown', id: 'a', text: 'y' }, { type: 'chart' } as unknown as DocBlock] },
    ]);
    expect(codes(doc)).toEqual(['duplicate_id', 'unknown_block']);
  });
});

describe('validateReviewDoc — diagrams', () => {
  const design = (b: DocBlock) => docWith([{ kind: 'design', blocks: [b] }]);

  it('flow: dangling edges, duplicate keys, unpinned process nodes, branches from a non-decision', () => {
    const f = flow({
      nodes: [
        { key: 'a', label: 'A', kind: 'terminal' },
        { key: 'a', label: 'dup', kind: 'terminal' },
        { key: 'p', label: 'does work' },
      ],
      edges: [
        { from: 'a', to: 'ghost' },
        { from: 'a', to: 'p', kind: 'branch_true' },
      ],
    });
    expect(codes(design(f))).toEqual(['duplicate_key', 'unpinned_node', 'dangling_edge', 'branch_from_non_decision']);
  });

  it('flow: caps nodes at 100', () => {
    const nodes = Array.from({ length: 101 }, (_, i) => ({ key: `n${i}`, label: `N${i}`, kind: 'terminal' as const }));
    expect(codes(design(flow({ nodes, edges: [] })))).toEqual(['too_many']);
  });

  it('sequence: steps between known actors, each pinned or explained', () => {
    const s: DocBlock = {
      type: 'sequence',
      title: 'Checkout',
      primary: true,
      actors: [{ key: 'ui', label: 'Cart UI' }, { key: 'api', label: 'Orders API' }],
      steps: [
        { from: 'ui', to: 'api', label: 'POST /orders', pins: [pin(1, 2, 'src/controllers/orders.ts')] },
        { from: 'api', to: 'ui', label: '201', style: 'return', note: 'framework serializes the response' },
        { from: 'api', to: 'db', label: 'insert' },
      ],
    };
    expect(codes(design(s))).toEqual(['unknown_actor', 'unpinned_step']);
  });

  it('call_stack_diff: an uncomputed or absent before side must be empty, and statuses are checked', () => {
    const c = (over: object): DocBlock => ({ type: 'call_stack_diff', title: 'x', primary: true, base: [], head: [{ key: 'a', pin: pin(1, 2) }], ...over }) as DocBlock;
    expect(codes(design(c({ base_status: 'not_computed' })))).toEqual([]);
    expect(codes(design(c({ base_status: 'absent', base: [{ pin: pin(1, 2, 'src/services/orders.ts', 'base') }] })))).toEqual(['base_status']);
    expect(codes(design(c({ base_status: 'maybe' })))).toEqual(['enum']);
    expect(codes(design(c({ head: [{ key: 'a', pin: pin(1, 2), status: 'new' }] })))).toEqual(['enum']);
  });

  it('call_stack_diff: parents must come first; keys unique per side', () => {
    const c: DocBlock = {
      type: 'call_stack_diff',
      title: 'Order path',
      primary: true,
      base: [{ key: 'h', pin: pin(1, 2, 'src/services/orders.ts', 'base') }],
      head: [
        { key: 'c', parent_key: 'h2', pin: pin(3, 4) },
        { key: 'h2', pin: pin(1, 2), via: { kind: 'queue', reason: 'outbox' } },
        { key: 'h2', pin: pin(5, 6) },
      ],
    };
    expect(codes(design(c))).toEqual(['parent_order', 'duplicate_key']);
  });

  it('data_store: operations and foreign keys must resolve, nested fields by dotted path', () => {
    const d: DocBlock = {
      type: 'data_store',
      title: 'Orders data',
      primary: true,
      actors: [{ key: 'svc', label: 'Order service' }],
      stores: [
        {
          key: 'pg',
          label: 'Postgres',
          storage: 'relational',
          collections: [
            { key: 'users', label: 'users', fields: [{ key: 'id', label: 'id', data_type: 'uuid', primary_key: true }] },
            {
              key: 'orders',
              label: 'orders',
              fields: [
                { key: 'user_id', label: 'user', data_type: 'uuid', references: { store: 'pg', collection: 'users', field: 'id' } },
                { key: 'addr', label: 'address', data_type: 'jsonb', fields: [{ key: 'city', label: 'city', data_type: 'text' }] },
                { key: 'bad', label: 'bad', data_type: 'uuid', references: { store: 'pg', collection: 'carts', field: 'id' } },
              ],
            },
          ],
        },
      ],
      use_cases: [
        {
          label: 'Place order',
          operations: [
            { kind: 'write', store: 'pg', collection: 'orders', field: 'addr.city', actor: 'svc', label: 'insert', pin: pin(12, 13) },
            { kind: 'read', store: 'pg', collection: 'users', field: 'email', actor: 'svc', label: 'lookup', pin: pin(10, 10) },
            { kind: 'read', store: 'pg', collection: 'users', actor: 'ghost', label: 'who', pin: pin(10, 10) },
          ],
        },
      ],
    };
    expect(codes(design(d))).toEqual(['dangling_reference', 'dangling_reference', 'unknown_actor']);
  });

  it('system_map: dotted hierarchy needs its parent, relationships need both ends', () => {
    const m: DocBlock = {
      type: 'system_map',
      title: 'Shop',
      primary: true,
      elements: [
        { path: 'shop', label: 'Shop', type: 'system' },
        { path: 'shop.api', label: 'API', type: 'container', status: 'modified' },
        { path: 'shop.api.orders', label: 'Orders', type: 'component', origin: 'graph' },
        { path: 'billing.worker', label: 'Worker', type: 'container' },
      ],
      relationships: [
        { from: 'shop.api', to: 'shop.api.orders', kind: 'call' },
        { from: 'shop.api', to: 'shop.db', kind: 'call' },
      ],
    };
    expect(codes(design(m))).toEqual(['map_parent', 'dangling_edge']);
  });
});

describe('targetIssues', () => {
  it('flags a document written for another change', () => {
    const doc = built();
    expect(targetIssues(doc, change)).toEqual([]);
    expect(targetIssues(doc, { ...change, headSha: 'd'.repeat(40) })[0].code).toBe('stale_target');
  });
});

describe('pins and ids', () => {
  it('round-trips a pin link', () => {
    const p = pin(3, 9);
    expect(parsePinLink(pinLink(p))).toEqual(p);
    expect(parsePinLink('base:src/a.ts#L7')).toEqual({ side: 'base', path: 'src/a.ts', start: 7, end: 7 });
    expect(parsePinLink('https://example.com')).toBeNull();
    expect(markdownPinLinks('[a](head:x.ts#L1) [b](https://e.com) [c](base:y.ts#L2-L3)')).toHaveLength(2);
  });

  it('derives block ids from content, ignoring any id already set', () => {
    const b: DocBlock = { type: 'markdown', text: 'same' };
    expect(blockId(b)).toBe(blockId({ ...b, id: 'whatever' }));
    expect(blockId(b)).not.toBe(blockId({ type: 'markdown', text: 'other' }));
  });

  it('reseals the digest after an edit', () => {
    const doc = built();
    const edited = sealReviewDoc({ ...doc, title: 'Edited' });
    expect(edited.digest).not.toBe(doc.digest);
    expect(sealReviewDoc(edited).digest).toBe(edited.digest);
  });
});

describe('renderReviewDocMarkdown', () => {
  it('renders sections, hunks, and a Mermaid flowchart with change colouring', () => {
    const doc = docWith([...built().sections.slice(0, 1), { kind: 'design', blocks: [flow()] }, ...built().sections.slice(1)]);
    expect(validateReviewDoc(doc, resolve)).toEqual([]);
    const md = renderReviewDocMarkdown(doc);
    expect(md).toContain('### What and why');
    expect(md).toContain('### Design');
    expect(md).toContain('```mermaid\nflowchart LR');
    expect(md).toContain('n_valid{"Valid?"}');
    expect(md).toContain('n_valid -->|"yes"| n_save');
    expect(md).toContain('class n_save added');
    expect(md).toContain('`L10–13`');
    expect(md).not.toContain('head:src/');
  });

  it('escapes quotes in Mermaid labels', () => {
    const doc = docWith([{ kind: 'design', blocks: [flow({ nodes: [{ key: 'q', label: 'say "hi"', kind: 'terminal' }], edges: [] })] }]);
    expect(renderReviewDocMarkdown(doc)).toContain('n_q(["say #quot;hi#quot;"])');
  });
});
