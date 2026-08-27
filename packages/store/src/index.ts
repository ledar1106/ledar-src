export * from './types.js';
export {
  IDENTITY_LIMITS,
  assertNoCredentials,
  assertSampleIsRedacted,
  databaseFingerprint,
  findingKey,
  structureHash,
} from './identity.js';
export { SCHEMA_VERSION } from './schema.js';
export { AnswerCache } from './answer-cache.js';
export type { CacheKey } from './answer-cache.js';
export { ScanStore } from './store.js';
export { openHistory, retiredName } from './retire.js';
export { RetiredHistoryReader } from './legacy.js';
export { HistoryTimeline, handlePrefix, retiredSiblings } from './timeline.js';
export type { TimelineEntry } from './timeline.js';
export { diffRuns } from './diff.js';
// Moved out of apps/cli on 2026-08-27 so the desktop can write runs to the
// SAME history file the CLI writes to. Two surfaces with two histories is a
// timeline with an unmarked seam in it.
export { RunHistory, identityFrom } from './run-history.js';
export { dataDir, ledarDir, historyFile } from './paths.js';
export type {
  Absence,
  ChangeVerdict,
  Comparability,
  FindingChange,
  RuleGap,
  RunDiff,
} from './diff.js';
export type { OpenedHistory, RetiredHistory } from './retire.js';
