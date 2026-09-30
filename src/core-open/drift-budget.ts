// VENDORED from @vibgrate/core-open (packages/vibgrate-core-open) by
// scripts/vendor-core-open.mjs. Do not edit here — change the source package
// and re-run the vendor script. Apache-2.0.
/**
 * Drift budget — the `driftBudget` block of the project config
 * (`.vibgrate/config.yml` or `vibgrate.config.json`).
 *
 * One schema, one evaluator, three surfaces: `vg scan`, the GitHub App's
 * `Vibgrate DriftScore` check, and Vibgrate Cloud. The GitHub App keeps a
 * Worker-safe mirror (`packages/vibgrate-api/src/lib/github-app/drift-budget.ts`)
 * with a parity test against this file — change both together.
 *
 *   driftBudget:
 *     mode: warn                # warn (default) | enforce | shadow
 *     maxScore: 40              # DriftScore ceiling, 0–100 (lower is better)
 *     maxWorseningPercent: 5    # how much one change may worsen drift
 *     agents:
 *       maxWorseningPercent: 0  # stricter limit for bot / coding-agent PRs
 *
 * Semantics match the historic flags: `maxScore` fails only when DriftScore is
 * strictly above it (`--drift-budget`), and worsening is
 * `delta / max(|base|, 0.0001) * 100`, counted only when drift got worse
 * (`--drift-worsening`). A missing base is "not evaluated", never zero.
 *
 * Pure: no I/O, no Node APIs — safe in the Cloudflare Worker.
 */

export type DriftBudgetMode = 'warn' | 'enforce' | 'shadow';
export type AuthorClass = 'agent' | 'human' | 'unknown';

/** The `driftBudget` block as written in the config file. */
export interface DriftBudgetConfig {
  mode?: DriftBudgetMode;
  maxScore?: number;
  maxWorseningPercent?: number;
  agents?: { maxWorseningPercent?: number };
}

/** A validated budget. Every limit is optional; at least one is set. */
export interface DriftBudget {
  mode: DriftBudgetMode;
  maxScore: number | null;
  maxWorseningPercent: number | null;
  agentMaxWorseningPercent: number | null;
}

export type DriftBudgetParse = { ok: true; budget: DriftBudget } | { ok: false; errors: string[] };

export type DriftBudgetRuleId = 'maxScore' | 'maxWorseningPercent' | 'agents.maxWorseningPercent';
export type DriftBudgetRuleStatus = 'pass' | 'breach' | 'not_evaluated';

export interface DriftBudgetRuleResult {
  id: DriftBudgetRuleId;
  status: DriftBudgetRuleStatus;
  /** One line: the limit, the actual value, and on a breach the smallest passing change. */
  message: string;
}

export interface DriftBudgetVerdict {
  mode: DriftBudgetMode;
  /** No rule breached. */
  withinBudget: boolean;
  /** A breach that gates: `enforce` mode and at least one rule breached. */
  blocking: boolean;
  /** head − base. Positive means drift got worse. Null when the base is unknown. */
  delta: number | null;
  rules: DriftBudgetRuleResult[];
  authorClass: AuthorClass;
}

export interface DriftBudgetInput {
  headScore: number;
  /** DriftScore before the change (PR base or baseline). Null = unknown, not 0. */
  baseScore: number | null;
  budget: DriftBudget;
  authorClass?: AuthorClass;
}

const MODES: readonly DriftBudgetMode[] = ['warn', 'enforce', 'shadow'];
const TOP_KEYS = new Set(['mode', 'maxScore', 'maxWorseningPercent', 'agents']);
const AGENT_KEYS = new Set(['maxWorseningPercent']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readLimit(value: unknown, key: string, errors: string[], max?: number): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (max !== undefined && value > max)) {
    errors.push(`driftBudget.${key} must be a number from 0${max !== undefined ? ` to ${max}` : ' or more'}.`);
    return null;
  }
  return value;
}

/**
 * Validate a `driftBudget` block. Unknown keys are errors, not ignored: a
 * misspelt limit on a merge gate must not silently pass. Returns null when the
 * config has no `driftBudget` at all.
 */
export function parseDriftBudget(raw: unknown): DriftBudgetParse | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return { ok: false, errors: ['driftBudget must be a mapping of settings.'] };

  const errors: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) errors.push(`driftBudget.${key} is not a known setting.`);
  }

  let mode: DriftBudgetMode = 'warn';
  if (raw.mode !== undefined) {
    if (typeof raw.mode === 'string' && (MODES as readonly string[]).includes(raw.mode)) mode = raw.mode as DriftBudgetMode;
    else errors.push('driftBudget.mode must be "warn", "enforce", or "shadow".');
  }

  const maxScore = readLimit(raw.maxScore, 'maxScore', errors, 100);
  const maxWorseningPercent = readLimit(raw.maxWorseningPercent, 'maxWorseningPercent', errors);

  let agentMaxWorseningPercent: number | null = null;
  if (raw.agents !== undefined) {
    if (!isRecord(raw.agents)) {
      errors.push('driftBudget.agents must be a mapping of settings.');
    } else {
      for (const key of Object.keys(raw.agents)) {
        if (!AGENT_KEYS.has(key)) errors.push(`driftBudget.agents.${key} is not a known setting.`);
      }
      agentMaxWorseningPercent = readLimit(raw.agents.maxWorseningPercent, 'agents.maxWorseningPercent', errors);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  if (maxScore === null && maxWorseningPercent === null && agentMaxWorseningPercent === null) {
    return {
      ok: false,
      errors: ['driftBudget sets no limit. Add maxScore, maxWorseningPercent, or agents.maxWorseningPercent.'],
    };
  }
  return { ok: true, budget: { mode, maxScore, maxWorseningPercent, agentMaxWorseningPercent } };
}

/** Same arithmetic as `--drift-worsening`: only worsening counts; a zero base is guarded. */
export function worseningPercent(headScore: number, baseScore: number): number {
  const delta = headScore - baseScore;
  if (delta <= 0) return 0;
  return (delta / Math.max(Math.abs(baseScore), 0.0001)) * 100;
}

function pct(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

function worseningRule(
  id: 'maxWorseningPercent' | 'agents.maxWorseningPercent',
  limit: number,
  headScore: number,
  baseScore: number | null,
): DriftBudgetRuleResult {
  const label = id === 'agents.maxWorseningPercent' ? 'Agent change worsened drift by' : 'Drift worsened by';
  if (baseScore == null) {
    return {
      id,
      status: 'not_evaluated',
      message: `Worsening limit ${pct(limit)} not evaluated: there was no earlier DriftScore to compare against.`,
    };
  }
  const actual = worseningPercent(headScore, baseScore);
  const move = `DriftScore ${baseScore} → ${headScore}`;
  if (actual <= limit) {
    return { id, status: 'pass', message: `${label} ${pct(actual)} (limit ${pct(limit)}); ${move}.` };
  }
  const allowed = Math.floor(baseScore + (Math.max(Math.abs(baseScore), 0.0001) * limit) / 100);
  return {
    id,
    status: 'breach',
    message: `${label} ${pct(actual)}, over the ${pct(limit)} limit; ${move}. Bring DriftScore to ${allowed} or lower to pass.`,
  };
}

export function evaluateDriftBudget(input: DriftBudgetInput): DriftBudgetVerdict {
  const { budget, headScore, baseScore } = input;
  const authorClass = input.authorClass ?? 'unknown';
  const rules: DriftBudgetRuleResult[] = [];

  if (budget.maxScore !== null) {
    if (headScore > budget.maxScore) {
      const over = Math.ceil((headScore - budget.maxScore) * 100) / 100;
      rules.push({
        id: 'maxScore',
        status: 'breach',
        message: `DriftScore ${headScore} is above the budget of ${budget.maxScore}. Lower it by ${over} point${over === 1 ? '' : 's'} to pass.`,
      });
    } else {
      const headroom = Math.round((budget.maxScore - headScore) * 100) / 100;
      rules.push({ id: 'maxScore', status: 'pass', message: `DriftScore ${headScore} of ${budget.maxScore}, headroom ${headroom}.` });
    }
  }

  if (budget.maxWorseningPercent !== null) {
    rules.push(worseningRule('maxWorseningPercent', budget.maxWorseningPercent, headScore, baseScore));
  }

  if (budget.agentMaxWorseningPercent !== null) {
    if (authorClass === 'agent') {
      rules.push(worseningRule('agents.maxWorseningPercent', budget.agentMaxWorseningPercent, headScore, baseScore));
    } else if (authorClass === 'unknown') {
      rules.push({
        id: 'agents.maxWorseningPercent',
        status: 'not_evaluated',
        message: 'Agent limit not evaluated: the author of this change could not be identified.',
      });
    }
  }

  const withinBudget = rules.every((r) => r.status !== 'breach');
  return {
    mode: budget.mode,
    withinBudget,
    blocking: budget.mode === 'enforce' && !withinBudget,
    delta: baseScore == null ? null : headScore - baseScore,
    rules,
    authorClass,
  };
}
