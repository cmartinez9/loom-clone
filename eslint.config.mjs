/**
 * Lint.
 *
 * Beyond ordinary hygiene, three rules here are **architecture enforcement** and
 * should not be relaxed without a decision above the implementation worker:
 *
 * 1. **`node:fs` is import-restricted inside `apps/main`.** "Main is the only
 *    writer" (architecture report §0, rule 2) is narrowed further: within main,
 *    only `project-store.ts` may write, and only `media-reader.ts` may additionally
 *    read. Every other file in main reaches the disk through the store or not at
 *    all.
 * 2. **`@loom/format/fs` is import-restricted to the store.** The pure
 *    `@loom/format` entry point stays importable everywhere; the filesystem half
 *    has exactly one caller.
 * 3. **Renderers may import no `node:`, no `electron`, and no `@loom/format/fs`.**
 *    They are sandboxed and have nothing to reach with; an import that looked like
 *    it worked would be a bug waiting for a packaging change.
 *
 * Together with sandboxed renderers, those make the sole-writer rule structural
 * rather than a convention someone has to remember.
 */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'release/**',
      'node_modules/**',
      'coverage/**',
      'shots/**',
      '**/*.d.ts',
      '**/*.d.mts',
    ],
  },

  js.configs.recommended,

  // ---- plain JS: scripts and config. No type-aware linting; there is no project.
  {
    files: ['**/*.mjs', '**/*.cjs', '**/*.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // ---- TypeScript, type-aware --------------------------------------------
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `void promise` is how this codebase says "deliberately not awaited".
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The format layer is full of `Record<string, unknown>` walks over untrusted
      // JSON, where a "provably unnecessary" check is the whole point.
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // `doc['schema']` on an index signature is deliberate: bracket notation is
      // how this codebase says "this key may not be there". `tsconfig.json` sets
      // `noPropertyAccessFromIndexSignature`, so the compiler agrees.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      // A number in a template literal has one unambiguous rendering; requiring
      // String() around every one of them is noise, not safety.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error', 'log'] }],
    },
  },

  // ---- architecture enforcement: the sole writer ----------------------------
  {
    files: ['apps/main/src/**/*.ts'],
    ignores: ['apps/main/src/project-store.ts', 'apps/main/src/media-reader.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:fs',
              message:
                'Only ProjectStore writes to disk and only media-reader.ts reads. ' +
                'Go through ProjectStore (architecture report §0, rule 2).',
            },
            {
              name: 'node:fs/promises',
              message:
                'Only ProjectStore writes to disk and only media-reader.ts reads. ' +
                'Go through ProjectStore (architecture report §0, rule 2).',
            },
            {
              name: '@loom/format/fs',
              message:
                'The filesystem half of @loom/format has exactly one caller: ProjectStore. ' +
                'Import the pure @loom/format entry point instead.',
            },
            {
              name: '@loom/mux/fs',
              message:
                'The filesystem half of @loom/mux has exactly one caller: ProjectStore. ' +
                'Capture writes reach the disk through it like every other write.',
            },
          ],
        },
      ],
    },
  },

  // media-reader.ts may read bytes; bundle I/O is still the store's.
  {
    files: ['apps/main/src/media-reader.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@loom/format/fs',
              message: 'media-reader.ts reads bytes; bundle I/O belongs to ProjectStore.',
            },
            {
              name: '@loom/mux/fs',
              message: 'media-reader.ts reads bytes; capture writes belong to ProjectStore.',
            },
          ],
        },
      ],
    },
  },

  // ---- renderers have no Node at all ---------------------------------------
  {
    files: ['apps/renderer/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'electron', '@loom/format/fs'],
              message:
                'Renderers are sandboxed and have no Node. Everything a window can do ' +
                'is window.loom, defined in @loom/ipc.',
            },
          ],
        },
      ],
    },
  },

  // ---- the pure packages stay pure -----------------------------------------
  {
    files: ['packages/format/src/**/*.ts', 'packages/mux/src/**/*.ts'],
    ignores: ['packages/format/src/fs/**/*.ts', 'packages/mux/src/fs/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'electron', '@loom/format/fs'],
              message:
                'The @loom/format and @loom/mux entry points are pure: no node, no DOM, ' +
                'no I/O. Filesystem code belongs in src/fs (architecture report §1.3).',
            },
          ],
        },
      ],
    },
  },

  // ---- edl, decode and compositor stay framework-free ------------------------
  // Architecture report §1.3: *"`edl` and `compositor` being framework-free is what
  // lets a headless test render frame 1,234 of a fixture project and compare it
  // byte-for-byte against the exporter's frame 1,234."* `decode` is the same bargain
  // for the other half of §4.5: one decode path, reachable from preview, from export
  // and from a test, because it can reach nothing itself. `decode` and `compositor`
  // use DOM *types* (`VideoFrame`, `WebGL2RenderingContext`) and one DOM *value*
  // each — `fetch` and the GL context they are handed. `edl` uses neither: it is
  // arithmetic over an `EditDocument` and reaches a recording only through the two
  // stream interfaces it declares.
  {
    files: [
      'packages/decode/src/**/*.ts',
      'packages/compositor/src/**/*.ts',
      'packages/edl/src/**/*.ts',
    ],
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'electron', '@loom/format/fs', '@loom/ipc'],
              message:
                'edl, decode and compositor are pure: no node, no electron, no I/O. They ' +
                'reach the world through the seams they declare — a ByteRangeReader, a ' +
                'DecoderFactory, a GL context, a CursorEventStream (architecture report §1.3).',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['packages/design/src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // The phase 6 gate harness: a renderer half and an Electron-main half.
  {
    files: ['test/gate/harness.ts', 'test/gate/fixture.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },

  prettier,
);
