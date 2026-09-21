/**
 * Findings → propose handoff.
 *
 * `vg review findings-from-diff --base …` reasons over the merge-base change
 * set. `vg review propose <id>` used to re-collect the *current* working-tree
 * change set and miss those ids. This module is the smallest handoff: persist
 * the last findings document + capsule, accept the same `--base` / `--diff`
 * as findings-from-diff, and accept an explicit findings JSON. Propose still
 * calls {@link proposeFindingFix} — no second loop.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CAPSULE_SCHEMA,
  FINDINGS_SCHEMA,
  RECEIPT_SCHEMA,
  type AnalysisCapsule,
  type ReviewFinding,
  type ReviewFindings,
} from './schemas.js';

export const PROPOSE_HANDOFF_SCHEMA = 'vg.review.propose-handoff.v1' as const;
export const PROPOSE_HANDOFF_REL = '.vibgrate/review-propose-handoff.json';

export type ProposeFindingSource = 'change-set' | 'findings-file' | 'handoff';

export interface ProposeHandoffChange {
  base?: string;
  inPlace?: boolean;
  hasDiff?: boolean;
}

export interface ProposeHandoff {
  schema_version: typeof PROPOSE_HANDOFF_SCHEMA;
  findings: ReviewFindings;
  capsule: AnalysisCapsule;
  change: ProposeHandoffChange;
}

export interface ResolvedProposeFinding {
  finding: ReviewFinding;
  capsule: AnalysisCapsule;
  source: ProposeFindingSource;
}

export function listReviewFindings(findings: ReviewFindings): ReviewFinding[] {
  return [...findings.architecture_findings, ...findings.security_findings];
}

export function findReviewFinding(findings: ReviewFindings, id: string): ReviewFinding | undefined {
  return listReviewFindings(findings).find((f) => f.id === id);
}

export function proposeHandoffPath(root: string): string {
  return path.join(root, PROPOSE_HANDOFF_REL);
}

/** Best-effort write. A failed write must not fail findings-from-diff. */
export function writeProposeHandoff(root: string, handoff: ProposeHandoff): string | null {
  try {
    const dest = proposeHandoffPath(root);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, `${JSON.stringify(handoff, null, 2)}\n`, 'utf8');
    return dest;
  } catch {
    return null;
  }
}

export function readProposeHandoff(root: string): ProposeHandoff | null {
  const dest = proposeHandoffPath(root);
  if (!fs.existsSync(dest)) return null;
  try {
    return parseProposeHandoff(JSON.parse(fs.readFileSync(dest, 'utf8')));
  } catch {
    return null;
  }
}

export function parseProposeHandoff(raw: unknown): ProposeHandoff | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== PROPOSE_HANDOFF_SCHEMA) return null;
  const findings = findingsDocumentFromUnknown(o.findings);
  const capsule = capsuleFromUnknown(o.capsule);
  if (!findings || !capsule) return null;
  const changeRaw = o.change && typeof o.change === 'object' ? (o.change as Record<string, unknown>) : {};
  const change: ProposeHandoffChange = {};
  if (typeof changeRaw.base === 'string' && changeRaw.base) change.base = changeRaw.base;
  if (changeRaw.inPlace === true) change.inPlace = true;
  if (changeRaw.hasDiff === true) change.hasDiff = true;
  return { schema_version: PROPOSE_HANDOFF_SCHEMA, findings, capsule, change };
}

/** Findings-from-diff JSON, a receipt, or a handoff document. */
export function findingsDocumentFromUnknown(raw: unknown): ReviewFindings | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.schema_version === RECEIPT_SCHEMA && o.findings) {
    return findingsDocumentFromUnknown(o.findings);
  }
  if (o.schema_version === PROPOSE_HANDOFF_SCHEMA && o.findings) {
    return findingsDocumentFromUnknown(o.findings);
  }
  if (!Array.isArray(o.architecture_findings) && !Array.isArray(o.security_findings)) return null;
  const architecture = asFindings(o.architecture_findings);
  const security = asFindings(o.security_findings);
  if (architecture === null || security === null) return null;
  return {
    schema_version: FINDINGS_SCHEMA,
    change_class: Array.isArray(o.change_class)
      ? (o.change_class.filter((c) => c === 'architecture' || c === 'security' || c === 'none') as ReviewFindings['change_class'])
      : [],
    architecture_findings: architecture,
    security_findings: security,
    unknowns: Array.isArray(o.unknowns) ? o.unknowns.filter((u): u is string => typeof u === 'string') : [],
    required_checks: Array.isArray(o.required_checks)
      ? o.required_checks.filter((u): u is string => typeof u === 'string')
      : [],
  };
}

export function capsuleFromUnknown(raw: unknown): AnalysisCapsule | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.schema_version === PROPOSE_HANDOFF_SCHEMA) return capsuleFromUnknown(o.capsule);
  if (o.schema_version !== CAPSULE_SCHEMA) return null;
  return o as unknown as AnalysisCapsule;
}

function asFindings(raw: unknown): ReviewFinding[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: ReviewFinding[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const f = row as Partial<ReviewFinding>;
    if (typeof f.id !== 'string' || !f.id) continue;
    out.push(row as ReviewFinding);
  }
  return out;
}

/**
 * Look up a finding id. Current change set first, then an explicit findings
 * JSON, then the last findings-from-diff handoff.
 */
export function resolveProposeFinding(opts: {
  findingId: string;
  reviewedFindings: ReviewFindings;
  reviewedCapsule: AnalysisCapsule;
  findingsFile?: unknown;
  handoff?: ProposeHandoff | null;
}): ResolvedProposeFinding | null {
  const current = findReviewFinding(opts.reviewedFindings, opts.findingId);
  if (current) {
    return { finding: current, capsule: opts.reviewedCapsule, source: 'change-set' };
  }
  if (opts.findingsFile !== undefined) {
    const fileFindings = findingsDocumentFromUnknown(opts.findingsFile);
    const hit = fileFindings ? findReviewFinding(fileFindings, opts.findingId) : undefined;
    if (hit) {
      const fileCapsule = capsuleFromUnknown(opts.findingsFile) ?? opts.handoff?.capsule ?? opts.reviewedCapsule;
      return { finding: hit, capsule: fileCapsule, source: 'findings-file' };
    }
  }
  if (opts.handoff) {
    const hit = findReviewFinding(opts.handoff.findings, opts.findingId);
    if (hit) {
      return { finding: hit, capsule: opts.handoff.capsule, source: 'handoff' };
    }
  }
  return null;
}

/** Actionable miss — name the flags that match findings-from-diff. */
export function missingProposeFindingMessage(findingId: string, handoff: ProposeHandoff | null): string {
  const ids = handoff ? listReviewFindings(handoff.findings).map((f) => f.id) : [];
  const known = ids.length ? ` Last findings-from-diff had: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? '…' : ''}.` : '';
  const baseHint = handoff?.change.base ? ` --base ${handoff.change.base}` : '';
  return (
    `no finding "${findingId}" in this change set — run \`vg review findings-from-diff\`${baseHint}` +
    ` then \`vg review propose ${findingId}\`, or pass the same \`--base\` / \`--diff\` / \`--findings <file.json\`.${known}`
  );
}
