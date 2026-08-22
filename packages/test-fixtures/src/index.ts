/**
 * Shared access to the local fixture databases.
 *
 * Test-only, and `private` in package.json so it can never be published. It
 * exists because the alternative had become worse: the Pagila gate lived in
 * `packages/packs-layer-a/test/`, and six suites across five packages reached
 * into it with relative paths that climbed out of their own package
 * (`../../../packages/packs-layer-a/test/pagila-fixture.js`).
 *
 * Sharing it was always right — a DSN and a fixture table list copied into six
 * files is how a suite starts checking the wrong database without anyone
 * noticing. Where it lived was the part that was wrong: changing one package's
 * test helper broke the tests of four packages that have nothing to do with
 * it, and nothing in the layout said so.
 */
export * from './pagila.js';
export * from './legacy-history.js';
