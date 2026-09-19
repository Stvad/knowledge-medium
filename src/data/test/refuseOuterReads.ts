/**
 * Run `body` with reads on the REPO's database handle refused for as long as a
 * write transaction is open.
 *
 * What it models: PowerSync opens a second connection only for
 * `OPFSWriteAheadVFS` (`@/data/localDbVfs`), so on every other browser the pool
 * has ONE connection and a read taken on the Repo's handle from inside a write
 * transaction is never served — the tab hangs, holding the writer, and every
 * later write queues behind it. `Repo.assertBackfillMayWrite` states the rule.
 *
 * A THROW rather than a hang, deliberately: "never served" is not expressible
 * in a suite that has to terminate, and the node test harness cannot produce it
 * anyway (`@powersync/node` always opens separate read connections). The throw
 * turns a would-be hang into a named failure at the offending call site.
 *
 * `execute` is refused alongside the three read methods — it takes the write
 * lock and deadlocks identically, and an ad-hoc statement on the Repo handle is
 * the likelier shape of a future regression than a read.
 */
export const withOuterReadsRefused = async <T>(
  db: {
    get: (sql: string, params?: unknown[]) => Promise<unknown>
    getAll: (sql: string, params?: unknown[]) => Promise<unknown>
    getOptional: (sql: string, params?: unknown[]) => Promise<unknown>
    execute: (sql: string, params?: unknown[]) => Promise<unknown>
    writeTransaction: (...args: never[]) => Promise<unknown>
  },
  body: () => Promise<T>,
): Promise<T> => {
  const outer = {
    get: db.get.bind(db),
    getAll: db.getAll.bind(db),
    getOptional: db.getOptional.bind(db),
    execute: db.execute.bind(db),
  }
  const realWriteTransaction = db.writeTransaction.bind(db)
  // A DEPTH counter, not a flag: a nested or overlapping write transaction
  // would otherwise clear the flag on its own exit and silently disarm the
  // refusal for the rest of the outer one.
  let depth = 0
  const refuseWhileWriting = (name: keyof typeof outer) =>
    (async (sql: string, params?: unknown[]) => {
      if (depth > 0) throw new Error(`[test] ${name} on the Repo handle under the write lock`)
      return outer[name](sql, params)
    })
  db.writeTransaction = (async (...args: never[]) => {
    depth += 1
    try { return await realWriteTransaction(...args) } finally { depth -= 1 }
  }) as typeof db.writeTransaction
  for (const name of Object.keys(outer) as (keyof typeof outer)[]) {
    (db as Record<string, unknown>)[name] = refuseWhileWriting(name)
  }
  try {
    return await body()
  } finally {
    db.writeTransaction = realWriteTransaction as typeof db.writeTransaction
    Object.assign(db, outer)
  }
}
