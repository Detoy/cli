import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readConfigExcludes } from '../engine/discover.js';
import { areaSkillsEnabled } from '../install/area-skills.js';
import { configNotes } from './doctor.js';

const roots: string[] = [];
function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-config-readers-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('settings read outside a scan follow the one config file', () => {
  it('reads exclude and areaSkills from .vibgrate/config.yml', () => {
    const root = project({ '.vibgrate/config.yml': 'areaSkills: true\nexclude:\n  - legacy/**\n' });
    expect(readConfigExcludes(root)).toEqual(['legacy/**']);
    expect(areaSkillsEnabled(root)).toBe(true);
  });

  it('ignores vibgrate.config.json when a YAML config exists', () => {
    const root = project({
      '.vibgrate/config.yml': 'exclude: []\n',
      'vibgrate.config.json': '{"areaSkills":true,"exclude":["from-json/**"]}',
    });
    expect(readConfigExcludes(root)).toEqual([]);
    expect(areaSkillsEnabled(root)).toBe(false);
  });

  it('still reads vibgrate.config.json on its own', () => {
    const root = project({ 'vibgrate.config.json': '{"areaSkills":true,"exclude":["legacy/**"]}' });
    expect(readConfigExcludes(root)).toEqual(['legacy/**']);
    expect(areaSkillsEnabled(root)).toBe(true);
  });
});

describe('vg doctor config notes', () => {
  it('is quiet for a single config', () => {
    expect(configNotes(project({ '.vibgrate/config.yml': 'exclude: []\n' }))).toEqual([]);
    expect(configNotes(project({}))).toEqual([]);
  });

  it('names a shadowed config file', () => {
    const root = project({ '.vibgrate/config.yml': 'exclude: []\n', 'vibgrate.config.json': '{}' });
    expect(configNotes(root)).toEqual(['vibgrate.config.json is ignored: .vibgrate/config.yml is the config in use']);
  });

  it('names legacy review files a review block replaces', () => {
    const root = project({
      'vibgrate.config.json': '{"review":{"enforcement":"advisory"}}',
      '.vibgrate/review.toml': '[review]\n',
      '.vibgrate/review/settings.md': 'mode: precise\n',
    });
    expect(configNotes(root)).toEqual([
      '.vibgrate/review.toml is ignored: review settings come from the review block in vibgrate.config.json',
      '.vibgrate/review/settings.md is ignored: review settings come from the review block in vibgrate.config.json',
    ]);
  });

  it('surfaces a config that does not parse', () => {
    const root = project({ '.vibgrate/config.yml': 'exclude: [unclosed\n' });
    expect(configNotes(root)[0]).toMatch(/\.vibgrate\/config\.yml is not valid YAML/);
  });
});
