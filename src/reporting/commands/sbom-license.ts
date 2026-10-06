/**
 * Declared-license projection for SBOM export.
 *
 * CycloneDX 1.5 `license.id` is an identifier from the SPDX license list.
 * A `LicenseRef-*` is not on that list, and neither is a compound expression
 * (`OR` / `AND` / `WITH` / a trailing `+`). Both are SPDX license expressions,
 * so they are emitted as one `licenses[].expression` entry. One entry keeps
 * an `OR` as a choice; a list of `license` objects would mean every license
 * applies.
 */
import { declaredLicenseSnippet } from '../../core-open/licenses/diagnostic.js';
import { isExplicitUnknownLicense, isSpdxLicenseRef, normalizeLicense } from '../../core-open/licenses/normalize.js';
import { getLicenseRecord } from '../../core-open/licenses/spdx-catalog.js';
import type { DependencyLicense } from '../../core-open/types.js';

/** Scan did not capture the custom license text. Not a guess at the terms. */
export const EXTRACTED_LICENSE_TEXT = 'No license text was recorded for this custom license reference.';

const ID_CHAR = /[A-Za-z0-9.-]/;

type Token =
  | { type: 'ID'; value: string }
  | { type: 'OR' | 'AND' | 'WITH' | 'PLUS' | 'LP' | 'RP' };

interface TermNode {
  kind: 'term';
  text: string;
  refs: string[];
}

interface BinNode {
  kind: 'or' | 'and';
  left: ExprNode;
  right: ExprNode;
}

type ExprNode = TermNode | BinNode;

export type CycloneLicenseEntry = { license: { id: string } } | { expression: string };

export interface ComponentLicense {
  /** Present only when the declaration is a schema-valid license or expression. */
  cycloneLicenses?: CycloneLicenseEntry[];
  /** SPDX `licenseDeclared`. `NOASSERTION` when nothing is asserted. Never empty. */
  licenseDeclared: string;
  /** `LicenseRef-*` ids used in `licenseDeclared`, in expression order. */
  licenseRefs: string[];
  warning: string | null;
}

export interface ExtractedLicensingInfo {
  licenseId: string;
  extractedText: string;
  name: string;
}

/**
 * Why a declared license was left off the component. Names the package and
 * version. The declared text is redacted and truncated the same way a
 * license-parse diagnostic is. No filesystem path.
 */
export function describeUnrepresentableLicense(ecosystem: string, name: string, version: string, declared: string): string {
  const shown = declaredLicenseSnippet(declared);
  return (
    `Declared license for ${ecosystem} package "${name}" version ${version} cannot be represented in an SBOM: "${shown}". ` +
    'The component is included with no license assertion. Use a canonical SPDX license id, a LicenseRef made of letters, digits, ".", and "-", or an SPDX expression of those.'
  );
}

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ type: 'LP' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'RP' });
      i += 1;
      continue;
    }
    if (ch === '+') {
      tokens.push({ type: 'PLUS' });
      i += 1;
      continue;
    }
    if (!ID_CHAR.test(ch)) return null;
    let j = i + 1;
    while (j < input.length && ID_CHAR.test(input[j]!)) j += 1;
    const word = input.slice(i, j);
    const upper = word.toUpperCase();
    if (upper === 'AND' || upper === 'OR' || upper === 'WITH') tokens.push({ type: upper });
    else tokens.push({ type: 'ID', value: word });
    i = j;
  }
  return tokens;
}

function canonicalLicenseId(token: string): { id: string; refs: string[] } | null {
  if (isSpdxLicenseRef(token)) return { id: token, refs: [token] };
  const recorded = getLicenseRecord(token);
  if (recorded) {
    if (isSpdxLicenseRef(recorded.spdxId)) return { id: recorded.spdxId, refs: [recorded.spdxId] };
    return { id: recorded.spdxId, refs: [] };
  }
  // A single alias ("Apache2") is a declared id, not a guess. Fuzzy matches
  // are not: those stay unrepresentable.
  const verdict = normalizeLicense(token);
  if ((verdict.matchStatus === 'exact' || verdict.matchStatus === 'alias') && verdict.spdxId !== 'NOASSERTION') {
    if (isSpdxLicenseRef(verdict.spdxId)) return { id: verdict.spdxId, refs: [verdict.spdxId] };
    return { id: verdict.spdxId, refs: [] };
  }
  return null;
}

function canonicalException(token: string): { text: string; refs: string[] } | null {
  if (isSpdxLicenseRef(token)) return { text: token, refs: [token] };
  if (!/^[A-Za-z0-9.-]+$/.test(token)) return null;
  return { text: token, refs: [] };
}

function parseExpression(input: string): ExprNode | null {
  const tokens = tokenize(input);
  if (!tokens || tokens.length === 0) return null;
  let i = 0;
  const peek = (): Token | undefined => tokens[i];
  const take = (): Token | undefined => tokens[i++];

  function parseOr(): ExprNode | null {
    let left = parseAnd();
    if (!left) return null;
    while (peek()?.type === 'OR') {
      take();
      const right = parseAnd();
      if (!right) return null;
      left = { kind: 'or', left, right };
    }
    return left;
  }

  function parseAnd(): ExprNode | null {
    let left = parseSimple();
    if (!left) return null;
    while (peek()?.type === 'AND') {
      take();
      const right = parseSimple();
      if (!right) return null;
      left = { kind: 'and', left, right };
    }
    return left;
  }

  function parseSimple(): ExprNode | null {
    const tok = peek();
    if (!tok) return null;
    if (tok.type === 'LP') {
      take();
      const inner = parseOr();
      if (!inner || peek()?.type !== 'RP') return null;
      take();
      return inner;
    }
    if (tok.type !== 'ID') return null;
    take();
    const canon = canonicalLicenseId(tok.value);
    if (!canon) return null;
    let text = canon.id;
    const refs = [...canon.refs];
    if (peek()?.type === 'PLUS') {
      take();
      text += '+';
    }
    if (peek()?.type === 'WITH') {
      take();
      const exc = peek();
      if (!exc || exc.type !== 'ID') return null;
      take();
      const exception = canonicalException(exc.value);
      if (!exception) return null;
      text += ` WITH ${exception.text}`;
      refs.push(...exception.refs);
    }
    return { kind: 'term', text, refs };
  }

  const node = parseOr();
  if (!node || i !== tokens.length) return null;
  return node;
}

function renderExpr(node: ExprNode, parent?: 'or' | 'and'): string {
  if (node.kind === 'term') return node.text;
  const op = node.kind === 'or' ? 'OR' : 'AND';
  const inner = `${renderExpr(node.left, node.kind)} ${op} ${renderExpr(node.right, node.kind)}`;
  // AND binds tighter than OR. Parentheses keep an OR inside an AND.
  if (parent === 'and' && node.kind === 'or') return `(${inner})`;
  return inner;
}

function collectRefs(node: ExprNode): string[] {
  if (node.kind === 'term') return node.refs;
  return [...collectRefs(node.left), ...collectRefs(node.right)];
}

function declaredText(license: DependencyLicense | undefined): string | null {
  if (!license || typeof license !== 'object') return null;
  const raw = typeof license.raw === 'string' ? license.raw.trim() : '';
  if (raw) return raw;
  const spdxId = typeof license.spdxId === 'string' ? license.spdxId.trim() : '';
  return spdxId || null;
}

function fromExpression(node: ExprNode): ComponentLicense {
  if (node.kind === 'term' && !node.text.includes(' ') && !node.text.endsWith('+') && !isSpdxLicenseRef(node.text)) {
    return {
      cycloneLicenses: [{ license: { id: node.text } }],
      licenseDeclared: node.text,
      licenseRefs: [],
      warning: null,
    };
  }
  const expression = renderExpr(node);
  return {
    cycloneLicenses: [{ expression }],
    licenseDeclared: expression,
    licenseRefs: collectRefs(node),
    warning: null,
  };
}

function absentLicense(): ComponentLicense {
  return { licenseDeclared: 'NOASSERTION', licenseRefs: [], warning: null };
}

/**
 * Project one dependency's declared license onto CycloneDX and SPDX fields.
 * Absent and explicit-unknown declarations assert nothing. A string that is
 * not a valid SPDX id, LicenseRef, or expression is a warning, not a guess.
 */
export function componentLicense(
  ecosystem: string,
  name: string,
  version: string,
  license: DependencyLicense | undefined,
): ComponentLicense {
  const declared = declaredText(license);
  if (declared === null || isExplicitUnknownLicense(declared)) return absentLicense();

  const parsed = parseExpression(declared);
  if (parsed) return fromExpression(parsed);

  // The whole declaration may be a single alias ("The MIT License") that the
  // expression tokenizer cannot keep as one id. Still not a guess.
  const verdict = normalizeLicense(declared);
  if ((verdict.matchStatus === 'exact' || verdict.matchStatus === 'alias') && verdict.spdxId !== 'NOASSERTION') {
    if (isSpdxLicenseRef(verdict.spdxId)) {
      return {
        cycloneLicenses: [{ expression: verdict.spdxId }],
        licenseDeclared: verdict.spdxId,
        licenseRefs: [verdict.spdxId],
        warning: null,
      };
    }
    return {
      cycloneLicenses: [{ license: { id: verdict.spdxId } }],
      licenseDeclared: verdict.spdxId,
      licenseRefs: [],
      warning: null,
    };
  }

  return {
    licenseDeclared: 'NOASSERTION',
    licenseRefs: [],
    warning: describeUnrepresentableLicense(ecosystem, name, version, declared),
  };
}

/** Document-level SPDX extracted-licensing infos. Sorted by id, duplicates removed. */
export function extractedLicensingInfos(refs: readonly string[]): ExtractedLicensingInfo[] {
  return [...new Set(refs)].sort().map((licenseId) => {
    const recorded = getLicenseRecord(licenseId);
    const name = recorded && recorded.spdxId === licenseId ? recorded.name : licenseId;
    return {
      licenseId,
      extractedText: EXTRACTED_LICENSE_TEXT,
      name,
    };
  });
}
