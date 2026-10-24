/** Runtime stand-in for the app's `@/utils/dialogs.js`.
 *
 *  The real facade queues a component and resolves when the user answers it.
 *  Under test nobody answers, so the queue would hang the caller forever —
 *  and the caller here is `finish()`, whose remaining work (the status
 *  message) is exactly what we want to observe. So this
 *  answers immediately with whatever the test has armed.
 *
 *  Aliased in `vitest.config.ts`; `src/` still imports the real path. */

let answer: unknown = null

/** Arm the next `openDialog` call. `null` (the default) is "dismissed". */
export const setDialogAnswer = (value: unknown): void => {
  answer = value
}

export const openDialog = async (): Promise<unknown> => answer
