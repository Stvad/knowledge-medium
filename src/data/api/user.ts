/** Tx-context user. Kept minimal — engine writes `user.id` into
 *  `tx_context.user_id` and into the per-row `created_by` / `updated_by`
 *  columns. Display-side User shape lives in `src/types.ts`; the data
 *  layer doesn't depend on it. */
export interface User {
  id: string
  name?: string
}
