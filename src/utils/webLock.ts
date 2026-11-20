/** Run `work` holding a named Web Lock, which is exclusive across every tab and
 *  worker of this origin. A concurrent caller queues behind the holder. Runs
 *  `work` directly where `navigator.locks` is absent. */
export const withLock = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  return locks?.request ? locks.request(name, work) : work()
}
