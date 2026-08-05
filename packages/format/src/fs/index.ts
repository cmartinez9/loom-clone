/**
 * `@loom/format/fs` — the filesystem half of the format.
 *
 * Split from `@loom/format` on purpose. Architecture report §0, rule 2: *"Main is
 * the only writer. Renderers propose; main persists. This is what makes crash
 * survival a property of the architecture rather than a feature someone has to
 * remember."*
 *
 * Anything imported from here pulls in `node:fs`, so importing it is a visible act.
 * Renderers cannot: they run with `sandbox: true` and `nodeIntegration: false`, so
 * there is no `require` to reach it with. Within main, the lint rule in
 * `eslint.config.mjs` restricts the write-side exports to `ProjectStore`.
 */

export { TEMP_PREFIX, isTempArtifact, writeAtomic, writeJsonAtomic } from './write-atomic.ts';

export {
  DocumentReadError,
  MigrationError,
  loadAndUpgradeDocument,
  loadDocument,
  readJsonFile,
  type LoadedDocument,
} from './documents.ts';

export { EventLogWriter } from './event-log.ts';

export {
  JournalWriter,
  journalHeaderLine,
  readJournal,
  removeJournal,
  type JournalOpenOptions,
} from './journal-file.ts';

export { BundleLock, BundleLockedError, type LockInfo } from './lock.ts';

export {
  bundlePaths,
  createBundle,
  directorySize,
  listBundles,
  readBundle,
  recordingDuration,
  summarizeBundle,
  sweepTempArtifacts,
  type BundlePaths,
  type CreateBundleInput,
  type CreatedBundle,
  type OpenedBundle,
} from './bundle.ts';
