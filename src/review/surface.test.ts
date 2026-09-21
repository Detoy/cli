import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { langForExtension } from '../engine/languages.js';
import { isDependencyManifest, isNonCodePath } from './surface.js';

describe('isNonCodePath', () => {
  it.each([
    '.gitignore',
    'packages/app/.gitignore',
    '.dockerignore',
    '.npmignore',
    '.eslintignore',
    '.prettierignore',
    '.vscodeignore',
    '.gitattributes',
    'src/empty/.gitkeep',
    '.mailmap',
    '.editorconfig',
    '.browserslistrc',
    '.nvmrc',
    '.node-version',
    '.python-version',
    '.tool-versions',
    'LICENSE',
    'LICENSE.md',
    'LICENCE.txt',
    'NOTICE',
    'COPYING',
    '.github/CODEOWNERS',
    'AUTHORS',
    'CHANGELOG',
    'CITATION.cff',
    '.vscode/settings.json',
    '.idea/workspace.xml',
  ])('treats repository scaffolding as non-code: %s', (p) => {
    expect(isNonCodePath(p)).toBe(true);
  });

  it.each(['README.md', 'docs/guide.md', 'assets/logo.png', 'changelog/unreleased/cli/x.md', 'src/__snapshots__/a.snap'])(
    'still treats prose, assets and generated output as non-code: %s',
    (p) => {
      expect(isNonCodePath(p)).toBe(true);
    },
  );

  it.each([
    'src/a.ts',
    'src/ignore.ts',
    'src/gitignore-parser.ts',
    'lib/license.ts',
    'src/changelog.ts',
    // Supply-chain surface: these decide where code comes from, so they earn
    // the normal path rather than a quick pass.
    '.npmrc',
    '.yarnrc.yml',
    '.gitmodules',
    '.pnpmfile.cjs',
    '.github/workflows/ci.yml',
    '.github/dependabot.yml',
    'Dockerfile',
    'tsconfig.json',
    'package.json',
  ])('keeps everything else on the normal path: %s', (p) => {
    expect(isNonCodePath(p)).toBe(false);
  });
});

describe('scaffolding basenames never collide with a scanned language', () => {
  // The scaffolding basenames are exempt from a coverage verdict on the theory
  // that no parser will ever attach a call-graph node to them — the same fact
  // `engine/discover.ts` relies on when it walks the repo (a file only joins
  // the graph if `langForExtension` recognises its extension). If a future
  // language ever claimed one of these extensions, `isNonCodePath` and the
  // scanner would quietly disagree about whether the file carries a call path.
  // Pinning both signals together, the way `discover-skips.test.ts` pins
  // `SKIP_DIRS` against the scanner's own list, keeps that impossible.
  it.each([
    '.gitignore',
    '.dockerignore',
    '.npmignore',
    '.eslintignore',
    '.gitattributes',
    '.gitkeep',
    'src/empty-dir/.keep',
    '.mailmap',
    '.editorconfig',
    '.browserslistrc',
    '.nvmrc',
    '.node-version',
    '.python-version',
    '.ruby-version',
    '.tool-versions',
    'LICENSE',
    'LICENSE.md',
    'LICENCE.txt',
    'NOTICE',
    'COPYING',
    'PATENTS',
    'CODEOWNERS',
    'AUTHORS',
    'CONTRIBUTORS',
    'CHANGELOG',
    'CITATION.cff',
  ])('%s has no extension the scanner recognises as a language', (name) => {
    expect(isNonCodePath(name)).toBe(true);
    expect(langForExtension(path.extname(name))).toBeUndefined();
  });
});

describe('isDependencyManifest', () => {
  it('recognises manifests and lockfiles across ecosystems', () => {
    for (const p of ['package.json', 'sub/pnpm-lock.yaml', 'go.mod', 'Cargo.lock', 'pyproject.toml', 'Gemfile.lock']) {
      expect(isDependencyManifest(p)).toBe(true);
    }
  });

  it('never mistakes scaffolding for a manifest', () => {
    for (const p of ['.gitignore', '.npmignore', 'LICENSE', '.editorconfig']) {
      expect(isDependencyManifest(p)).toBe(false);
    }
  });
});
