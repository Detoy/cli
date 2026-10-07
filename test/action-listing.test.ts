import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const actionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../action.yml');

describe('GitHub Action Marketplace listing', () => {
  const action = parse(readFileSync(actionPath, 'utf8')) as { description?: string };
  const description = action.description ?? '';

  it('leads with drift and exposure scoring and keeps the pull-request SARIF fact', () => {
    expect(description.startsWith('Your dependencies age quietly')).toBe(true);
    expect(description).toContain('DriftScore');
    expect(description).toContain('RiskScore');
    expect(description).toMatch(/pull request/i);
    expect(description).toContain('SARIF');
  });

  it('stays under the Marketplace 125-character limit', () => {
    expect(description.length).toBeLessThan(125);
  });
});
