/**
 * Lint.
 *
 * Beyond ordinary hygiene, five rules here are **architecture enforcement** and
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
 * 4. **`systemPreferences` is import-restricted to `apps/main/src/permissions.ts`.**
 *    A grant read anywhere else escapes the provenance rule that decides whether
 *    macOS was talking about us at all, and it fails silently.
 * 5. **`packages/permissions` stays pure.** It is the policy — what each grant is
 *    for, what may be concluded from a set of answers — and it is unit-testable
 *    without an app only for as long as it cannot ask one.
 *
 * Together with sandboxed renderers, those make the sole-writer rule structural
 * rather than a convention someone has to remember.
 */

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * The sole-writer restrictions, shared because `no-restricted-imports` is configured
 * per file rather than accumulated: a later block naming the same file replaces this
 * rule's whole configuration, so every block that restricts anything inside
 * `apps/main` has to restate what it still restricts.
 */
const MAIN_DISK_IMPORTS = [
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
];

/**
 * Within `apps/main/src`, only `permissions.ts` may ask macOS about a grant. That
 * file's header states the boundary and its one deliberate exception; this is the
 * half that enforces it.
 *
 * Not style: a second caller reads TCC without the trust rule `isTrustworthy()`
 * states, and the failure is silent — a raw `getMediaAccessStatus` cast is what wrote
 * an out-of-type value into a user's `recording.json`. Everything else takes the
 * answer from `readMediaStatus`/`readAxTrusted` or from a `PermissionReport`.
 */
const SYSTEM_PREFERENCES_IMPORT = {
  name: 'electron',
  importNames: ['systemPreferences'],
  message:
    'apps/main/src/permissions.ts is the only file under apps/main/src that calls ' +
    'systemPreferences. Use readMediaStatus/readAxTrusted from it, or a PermissionReport.',
};

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

  // ---- architecture enforcement: the sole writer, and the sole TCC caller -----
  {
    files: ['apps/main/src/**/*.ts'],
    ignores: [
      'apps/main/src/project-store.ts',
      'apps/main/src/media-reader.ts',
      'apps/main/src/permissions.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [...MAIN_DISK_IMPORTS, SYSTEM_PREFERENCES_IMPORT] },
      ],
    },
  },

  // permissions.ts is the one TCC caller, and still writes nothing.
  {
    files: ['apps/main/src/permissions.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: MAIN_DISK_IMPORTS }],
    },
  },

  // project-store.ts writes; it has no business asking macOS about a grant.
  {
    files: ['apps/main/src/project-store.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [SYSTEM_PREFERENCES_IMPORT] }],
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
            SYSTEM_PREFERENCES_IMPORT,
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

  // ---- the permission model is policy, not a probe ---------------------------
  // `packages/permissions/src/index.ts`: *"This entry point is **pure**: no
  // `electron`, no `node:`, no DOM."* The split is what keeps the trust rule
  // (`isTrustworthy`) unit-testable without launching an app, and what keeps the
  // probes on the far side of the boundary `apps/main/src/permissions.ts`'s header
  // states. An `electron` import here would move a probe into the policy and take
  // both of those with it.
  {
    files: ['packages/permissions/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'electron', '@loom/format/fs', '@loom/mux/fs', '@loom/ipc'],
              message:
                '@loom/permissions is pure: no electron, no node, no DOM. Asking macOS ' +
                'belongs in apps/main/src/permissions.ts.',
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
  //
  // `@loom/compositor/raster` (`packages/compositor/src/raster/`) is the one
  // exception, and it is the `@loom/format/fs` bargain rather than a hole: glyph
  // rasterisation needs an `OffscreenCanvas`, so it lives behind its own subpath
  // export with its own module docblock saying who may call it and why there must be
  // exactly one caller. It imports nothing this rule forbids, so the restriction
  // below still applies to it unchanged.
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

  // The phase 11 golden gate harness, same split. `fixture.ts` is browser-side
  // because it paints the source picture into an `OffscreenCanvas`; `main.ts` reads
  // its two constants and is bundled for node, which is why the module has no other
  // DOM value in it.
  {
    files: ['test/golden/harness.ts', 'test/golden/fixture.ts'],
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
