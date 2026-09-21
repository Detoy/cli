/**
 * Findings → propose handoff: current change set, explicit findings JSON,
 * then the last findings-from-diff document. No git, no model.
 */

import { describe, expect, it } from 'vitest';
import { FINDINGS_SCHEMA } from './schemas.js';
import { capsule, finding, findings } from './test-fixtures.js';
import {
  PROPOSE_HANDOFF_SCHEMA,
  findingsDocumentFromUnknown,
  missingProposeFindingMessage,
  parseProposeHandoff,
  resolveProposeFinding,
} from './propose-handoff.js';

const blast = finding({
  id: 'blast:n1',
  kind: 'correctness',
  producer: 'blast_radius',
  paths: ['src/services/invoices.ts'],
  claim: 'listInvoices has a cross-file dependent.',
});

const otherCapsule = capsule({
  identity: {
    repo_pseudonym: 'sha256:handoff',
    language: 'typescript',
    graph_schema: 'vg-graph/1.1',
    analyzer_versions: { graph: '1', scanners: '1' },
    profile: 'ci-wide',
  },
});

describe('findingsDocumentFromUnknown', () => {
  it('accepts findings-from-diff JSON (plus publishable) and a receipt wrapper', () => {
    const doc = {
      schema_version: FINDINGS_SCHEMA,
      architecture_findings: [blast],
      security_findings: [],
      unknowns: [],
      publishable: [{ id: blast.id, kind: 'correctness' }],
    };
    expect(findingsDocumentFromUnknown(doc)?.architecture_findings[0]?.id).toBe('blast:n1');
    expect(
      findingsDocumentFromUnknown({ schema_version: 'vg.review.receipt.v1', findings: doc })?.architecture_findings[0]
        ?.id,
    ).toBe('blast:n1');
    expect(findingsDocumentFromUnknown({ hello: true })).toBeNull();
  });
});

describe('resolveProposeFinding', () => {
  const empty = findings();
  const reviewed = findings({ architecture_findings: [blast] });

  it('prefers the current change set', () => {
    const r = resolveProposeFinding({
      findingId: 'blast:n1',
      reviewedFindings: reviewed,
      reviewedCapsule: capsule(),
      handoff: {
        schema_version: PROPOSE_HANDOFF_SCHEMA,
        findings: findings({ architecture_findings: [finding({ id: 'blast:n1', claim: 'stale' })] }),
        capsule: otherCapsule,
        change: { base: 'origin/main' },
      },
    });
    expect(r?.source).toBe('change-set');
    expect(r?.finding.claim).toBe(blast.claim);
    expect(r?.capsule.identity.repo_pseudonym).toBe('sha256:abc');
  });

  it('uses --findings JSON when the current change set misses the id', () => {
    const r = resolveProposeFinding({
      findingId: 'blast:n1',
      reviewedFindings: empty,
      reviewedCapsule: capsule(),
      findingsFile: { architecture_findings: [blast], security_findings: [] },
    });
    expect(r?.source).toBe('findings-file');
    expect(r?.finding.id).toBe('blast:n1');
  });

  it('falls back to the last findings-from-diff handoff', () => {
    const r = resolveProposeFinding({
      findingId: 'blast:n1',
      reviewedFindings: empty,
      reviewedCapsule: capsule(),
      handoff: {
        schema_version: PROPOSE_HANDOFF_SCHEMA,
        findings: reviewed,
        capsule: otherCapsule,
        change: { base: 'origin/main' },
      },
    });
    expect(r?.source).toBe('handoff');
    expect(r?.capsule.identity.profile).toBe('ci-wide');
  });

  it('returns null when no source has the id', () => {
    expect(
      resolveProposeFinding({
        findingId: 'blast:missing',
        reviewedFindings: empty,
        reviewedCapsule: capsule(),
      }),
    ).toBeNull();
  });
});

describe('parseProposeHandoff / miss message', () => {
  it('rejects a document that is not the handoff schema', () => {
    expect(parseProposeHandoff({ schema_version: FINDINGS_SCHEMA, findings: findings() })).toBeNull();
    expect(
      parseProposeHandoff({
        schema_version: PROPOSE_HANDOFF_SCHEMA,
        findings: findings({ architecture_findings: [blast] }),
        capsule: capsule(),
        change: { base: 'origin/main' },
      })?.change.base,
    ).toBe('origin/main');
  });

  it('names --base / --findings and last ids', () => {
    const msg = missingProposeFindingMessage('blast:missing', {
      schema_version: PROPOSE_HANDOFF_SCHEMA,
      findings: findings({ architecture_findings: [blast] }),
      capsule: capsule(),
      change: { base: 'origin/main' },
    });
    expect(msg).toContain('blast:missing');
    expect(msg).toContain('--base origin/main');
    expect(msg).toContain('--findings');
    expect(msg).toContain('blast:n1');
    expect(msg).not.toMatch(/github app|check run/i);
  });
});
