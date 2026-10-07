import * as path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { ensureDir, pathExists } from '../utils/fs.js';
import { writeDefaultConfig } from '../../core-open/index.js';
import { usageError } from '../../util/exit.js';
import { BASELINE_PATH, CI_PROVIDERS, isCiProvider, writeCiWorkflow } from './ci-workflow.js';

export const initCommand = new Command('init')
  .description('Initialize vibgrate in a project')
  .argument('[path]', 'Path to initialize', '.')
  .option('--baseline', 'Create initial baseline after init')
  .option('--ci <provider>', `Also write a CI workflow that scans every pull request (${CI_PROVIDERS.join(', ')})`)
  .option('--yes', 'Skip confirmation prompts')
  .action(async (targetPath: string, opts: { baseline?: boolean; yes?: boolean; ci?: string }) => {
    if (opts.ci !== undefined && !isCiProvider(opts.ci)) {
      throw usageError(`Unknown CI provider '${opts.ci}'. Supported: ${CI_PROVIDERS.join(', ')}. Example: vg init --ci github`);
    }
    const rootDir = path.resolve(targetPath);
    const vibgrateDir = path.join(rootDir, '.vibgrate');

    await ensureDir(vibgrateDir);
    console.log(chalk.green('✔') + ` Created ${chalk.bold('.vibgrate/')} directory`);

    const configPath = path.join(rootDir, 'vibgrate.config.ts');
    if (await pathExists(configPath)) {
      console.log(chalk.dim('  vibgrate.config.ts already exists, skipping'));
    } else {
      await writeDefaultConfig(rootDir);
      console.log(chalk.green('✔') + ` Created ${chalk.bold('vibgrate.config.ts')}`);
    }

    if (opts.baseline) {
      const { runBaseline } = await import('./baseline.js');
      await runBaseline(rootDir);
    }

    // After the baseline, so a workflow written in the same run can reference it.
    if (opts.ci !== undefined && isCiProvider(opts.ci)) {
      const baselineFile = path.join(rootDir, BASELINE_PATH);
      const hasBaseline = await pathExists(baselineFile);
      const { file, created } = await writeCiWorkflow(rootDir, opts.ci, { baseline: hasBaseline });
      const rel = path.relative(rootDir, file).split(path.sep).join('/');
      console.log(created
        ? chalk.green('✔') + ` Created ${chalk.bold(rel)}`
        : chalk.dim(`  ${rel} already exists, skipping`));
      if (created && hasBaseline) {
        console.log(chalk.yellow('!') + ` Commit ${chalk.bold(BASELINE_PATH)} so CI can compare against it.`);
      }
    }

    console.log('');
    console.log(chalk.bold('Next steps:'));
    console.log(`  ${chalk.cyan('vg scan')}            Scan for upgrade drift`);
    console.log(`  ${chalk.cyan('vg baseline')}        Create a drift baseline`);
    if (opts.ci === undefined) {
      console.log(`  ${chalk.cyan('vg init --ci github')}  Scan every pull request in GitHub Actions`);
    }
    console.log('');
  });
