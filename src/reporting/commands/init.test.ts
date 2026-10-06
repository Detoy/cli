import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initCommand } from './init.js';

describe('vg init', () => {
  let dir: string;
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    spy?.mockRestore();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<void> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-init-'));
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(' '));
    });
    await initCommand.parseAsync([dir, ...args], { from: 'user' });
  }

  it('scaffolds .vibgrate/ and vibgrate.config.ts and names the next commands as vg', async () => {
    await run(['--yes']);
    expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(true);
    const config = fs.readFileSync(path.join(dir, 'vibgrate.config.ts'), 'utf8');
    expect(config).toContain("from '@vibgrate/cli'");
    expect(config).toContain('eolDays: 180');
    const text = logs.join('\n');
    expect(text).toContain('Created');
    expect(text).toContain('.vibgrate/');
    expect(text).toContain('vibgrate.config.ts');
    expect(text).toContain('vg scan');
    expect(text).toContain('vg baseline');
    expect(text).not.toContain('vibgrate scan');
    expect(text).not.toContain('vibgrate baseline');
  });

  it('leaves an existing config file in place', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-init-'));
    const configPath = path.join(dir, 'vibgrate.config.ts');
    fs.writeFileSync(configPath, 'export default { thresholds: {} };\n');
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(' '));
    });
    await initCommand.parseAsync([dir], { from: 'user' });
    expect(fs.readFileSync(configPath, 'utf8')).toBe('export default { thresholds: {} };\n');
    expect(logs.join('\n')).toMatch(/already exists, skipping/);
    expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(true);
  });
  // Keep the --ci cases last: commander retains option values across parseAsync
  // calls on the shared command object, so --ci would leak into later cases.
  it('--ci github writes the workflow using the vibgrate/cli Action', async () => {
    await run(['--ci', 'github']);
    const file = path.join(dir, '.github', 'workflows', 'vibgrate.yml');
    const yml = fs.readFileSync(file, 'utf8');
    expect(yml).toContain('uses: vibgrate/cli@v1');
    expect(yml).toContain('upload-sarif: true');
    expect(yml).toContain('security-events: write');
    expect(logs.join('\n')).toContain('.github/workflows/vibgrate.yml');
  });

  it('--ci github never overwrites an existing workflow', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-init-'));
    const file = path.join(dir, '.github', 'workflows', 'vibgrate.yml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'name: mine\n');
    logs = [];
    spy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      logs.push(parts.map(String).join(' '));
    });
    await initCommand.parseAsync([dir, '--ci', 'github'], { from: 'user' });
    expect(fs.readFileSync(file, 'utf8')).toBe('name: mine\n');
    expect(logs.join('\n')).toMatch(/already exists, skipping/);
  });

  it('rejects an unknown CI provider with an actionable message before writing anything', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-init-'));
    await expect(initCommand.parseAsync([dir, '--ci', 'travis'], { from: 'user' })).rejects.toThrow(
      /Unknown CI provider 'travis'.*Supported: github/,
    );
    expect(fs.existsSync(path.join(dir, '.vibgrate'))).toBe(false);
  });
});
