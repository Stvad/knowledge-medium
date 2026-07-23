/**
 * Type declarations for the plain-JS recognizer in
 * `syncedTableSqlRecognizer.js`. Kept separate (rather than converting that
 * file to `.ts`) so `eslint-rules/no-raw-synced-table-writes.js` can import
 * the implementation directly, with no transpile step — ESLint loads rule
 * files untranspiled. TypeScript consumers (`syncedTableWriteGuard.ts`)
 * resolve this declaration file for the `.js` import with no `allowJs`
 * needed, the same as any other untyped-JS dependency.
 *
 * Only the module's public surface is declared — the internal helpers
 * (`blankCommentsAndStrings`, the pattern tables, …) are module-private on
 * the JS side and have no reason to be typed.
 */

/** App-visible / synced tables whose changes must propagate through the
 *  upload path. See the doc comment on the JS export for what's deliberately
 *  excluded. */
export declare const SYNCED_TABLES: ReadonlySet<string>

/** Every table `sql` writes to, lowercased and unqualified, in the order
 *  found. */
export declare const writeTargets: (sql: string) => string[]

/** The first table in {@link SYNCED_TABLES} that `sql` writes to, or `null`. */
export declare const syncedWriteTarget: (sql: string) => string | null
